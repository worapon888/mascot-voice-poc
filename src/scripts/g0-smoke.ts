import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { getOpenAIClient, OPENAI_MODELS } from '@/lib/openai/client';
import {
  getActiveFaqs,
  setFaqActiveStatus,
  updateFaqAnswer,
} from '@/repositories/faq.repository';
import type { FaqRecord } from '@/types/faq';

type SmokeStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT TESTED';

interface SmokeCheckResult {
  id: string;
  name: string;
  status: SmokeStatus;
  latencyMs?: number;
  evidence: string;
  error?: string;
}

const EXPECTED_KEYWORDS_BY_QUESTION: Record<string, string[]> = {
  เปิดบริการกี่โมง: ['เปิดบริการ', 'เวลาทำการ', 'เปิดกี่โมง', 'สำนักงานเปิดกี่โมง'],
  ต้องจองคิวไหม: ['จองคิว', 'นัดหมาย', 'นัดล่วงหน้า', 'ต้องนัด'],
  เตรียมเอกสารอะไร: ['เอกสาร', 'เตรียมเอกสาร', 'เอาอะไรไปบ้าง'],
  ทดลองผ่านมือถือได้ไหม: ['มือถือ', 'เบราว์เซอร์'],
  ติดต่อใครเมื่อไม่มีคำตอบ: ['ติดต่อ', 'เจ้าหน้าที่'],
};

const THAI_CHAR_REGEX = /[\u0E00-\u0E7F]/;

function parseOnlyFlag(): Set<string> {
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
  if (!onlyArg) {
    return new Set(['db', 'tts', 'stt', 'llm']);
  }
  const value = onlyArg.slice('--only='.length).trim().toLowerCase();
  return new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function checkMissingEnvVars(names: string[]): string[] {
  return names.filter((name) => {
    const val = process.env[name];
    return !val || val.trim().length === 0;
  });
}

function isPublishableSupabaseKey(): boolean {
  const key = process.env.SUPABASE_SECRET_KEY?.trim() ?? '';
  return key.startsWith('sb_publishable_');
}

async function runSupabaseSmokeChecks(
  results: SmokeCheckResult[],
): Promise<FaqRecord[]> {
  const missing = checkMissingEnvVars(['SUPABASE_URL', 'SUPABASE_SECRET_KEY']);
  if (missing.length > 0) {
    for (const [id, name] of [
      ['DB01', 'Supabase Connection'],
      ['DB02', 'Query Active FAQs (5 records)'],
      ['DB03', 'Verify Thai Keywords Aliases'],
      ['DB04', 'Inactive FAQ Exclusion & Restore'],
      ['DB05', 'Live Answer Update & Restore'],
    ] as const) {
      results.push({
        id,
        name,
        status: 'BLOCKED',
        evidence: 'Missing required Supabase environment variables.',
        error: `Missing env vars: ${missing.join(', ')}`,
      });
    }
    return [];
  }

  let activeFaqs: FaqRecord[] = [];

  // DB01 & DB02
  const t0 = Date.now();
  try {
    activeFaqs = await getActiveFaqs();
    const latencyMs = Date.now() - t0;

    results.push({
      id: 'DB01',
      name: 'Supabase Connection',
      status: 'PASS',
      latencyMs,
      evidence: `Connected to Supabase PostgREST endpoint via server-only client (${latencyMs} ms).`,
    });

    if (activeFaqs.length === 5) {
      results.push({
        id: 'DB02',
        name: 'Query Active FAQs (5 records)',
        status: 'PASS',
        latencyMs,
        evidence: `Retrieved ${activeFaqs.length} active FAQs: [${activeFaqs.map((f) => f.question).join(', ')}]`,
      });
    } else if (activeFaqs.length === 0 && isPublishableSupabaseKey()) {
      results.push({
        id: 'DB02',
        name: 'Query Active FAQs (5 records)',
        status: 'BLOCKED',
        latencyMs,
        evidence:
          'Query succeeded with 0 rows returned because RLS is enabled on public.faqs with no anonymous policy.',
        error:
          'SUPABASE_SECRET_KEY in .env.local has prefix "sb_publishable_..." (anon role). Replace it with the Supabase Secret Key ("sb_secret_..." or service_role key) so the server-only client can bypass RLS.',
      });
      for (const [id, name] of [
        ['DB03', 'Verify Thai Keywords Aliases'],
        ['DB04', 'Inactive FAQ Exclusion & Restore'],
        ['DB05', 'Live Answer Update & Restore'],
      ] as const) {
        results.push({
          id,
          name,
          status: 'BLOCKED',
          evidence: 'Blocked until DB02 retrieves the 5 seeded FAQ rows.',
          error:
            'Requires server-side SUPABASE_SECRET_KEY (sb_secret_... / service_role) to read/update RLS-protected public.faqs.',
        });
      }
      return [];
    } else {
      results.push({
        id: 'DB02',
        name: 'Query Active FAQs (5 records)',
        status: 'FAIL',
        latencyMs,
        evidence: `Expected 5 active FAQs, but received ${activeFaqs.length}.`,
        error: `Unexpected row count: ${activeFaqs.length}`,
      });
      return activeFaqs;
    }
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const message = err instanceof Error ? err.message : 'Unknown DB error';
    results.push({
      id: 'DB01',
      name: 'Supabase Connection',
      status: 'FAIL',
      latencyMs,
      evidence: 'Failed while querying public.faqs.',
      error: message,
    });
    for (const [id, name] of [
      ['DB02', 'Query Active FAQs (5 records)'],
      ['DB03', 'Verify Thai Keywords Aliases'],
      ['DB04', 'Inactive FAQ Exclusion & Restore'],
      ['DB05', 'Live Answer Update & Restore'],
    ] as const) {
      results.push({
        id,
        name,
        status: 'BLOCKED',
        evidence: 'Blocked by DB01 failure.',
        error: message,
      });
    }
    return [];
  }

  // DB03 — Verify keywords
  const missingKeywords: string[] = [];
  for (const [question, expectedKeywords] of Object.entries(
    EXPECTED_KEYWORDS_BY_QUESTION,
  )) {
    const record = activeFaqs.find((f) => f.question === question);
    if (!record) {
      missingKeywords.push(`Missing question: "${question}"`);
      continue;
    }
    for (const kw of expectedKeywords) {
      if (!record.keywords.includes(kw)) {
        missingKeywords.push(`Question "${question}" missing keyword "${kw}"`);
      }
    }
  }

  if (missingKeywords.length === 0) {
    results.push({
      id: 'DB03',
      name: 'Verify Thai Keywords Aliases',
      status: 'PASS',
      evidence:
        'All 5 FAQ records contain their exact configured Thai keyword arrays.',
    });
  } else {
    results.push({
      id: 'DB03',
      name: 'Verify Thai Keywords Aliases',
      status: 'FAIL',
      evidence: 'Keyword mismatch detected.',
      error: missingKeywords.join('; '),
    });
  }

  // DB04 — Inactive FAQ Exclusion & Restore
  const targetFaq = activeFaqs[activeFaqs.length - 1];
  const tDb04 = Date.now();
  try {
    await setFaqActiveStatus(targetFaq.id, false);
    const afterDeactivate = await getActiveFaqs();
    const excluded =
      afterDeactivate.length === 4 &&
      !afterDeactivate.some((f) => f.id === targetFaq.id);

    await setFaqActiveStatus(targetFaq.id, true);
    const afterRestore = await getActiveFaqs();
    const restored =
      afterRestore.length === 5 &&
      afterRestore.some((f) => f.id === targetFaq.id);

    const latencyMs = Date.now() - tDb04;
    if (excluded && restored) {
      results.push({
        id: 'DB04',
        name: 'Inactive FAQ Exclusion & Restore',
        status: 'PASS',
        latencyMs,
        evidence: `FAQ id=${targetFaq.id} ("${targetFaq.question}") excluded when is_active=false (4 rows) and restored to is_active=true (5 rows).`,
      });
    } else {
      results.push({
        id: 'DB04',
        name: 'Inactive FAQ Exclusion & Restore',
        status: 'FAIL',
        latencyMs,
        evidence: `excluded=${excluded}, restored=${restored}`,
        error: 'Inactive filtering or restoration did not match expectations.',
      });
    }
  } catch (err) {
    try {
      await setFaqActiveStatus(targetFaq.id, true);
    } catch {
      // Ignore secondary restore failure
    }
    results.push({
      id: 'DB04',
      name: 'Inactive FAQ Exclusion & Restore',
      status: 'FAIL',
      latencyMs: Date.now() - tDb04,
      evidence: 'Failed to toggle is_active status.',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  // DB05 — Live Data Update & Restore
  const tDb05 = Date.now();
  const originalAnswer = targetFaq.answer;
  const tempAnswer = `${originalAnswer} [G0-LIVE-CHECK]`;
  try {
    await updateFaqAnswer(targetFaq.id, tempAnswer);
    const updatedList = await getActiveFaqs();
    const updatedRecord = updatedList.find((f) => f.id === targetFaq.id);
    const sawLiveUpdate = updatedRecord?.answer === tempAnswer;

    await updateFaqAnswer(targetFaq.id, originalAnswer);
    const restoredList = await getActiveFaqs();
    const restoredRecord = restoredList.find((f) => f.id === targetFaq.id);
    const restoredCleanly = restoredRecord?.answer === originalAnswer;

    const latencyMs = Date.now() - tDb05;
    if (sawLiveUpdate && restoredCleanly) {
      results.push({
        id: 'DB05',
        name: 'Live Answer Update & Restore',
        status: 'PASS',
        latencyMs,
        evidence: `FAQ id=${targetFaq.id} updated answer verified live via getActiveFaqs() and restored to original text.`,
      });
    } else {
      results.push({
        id: 'DB05',
        name: 'Live Answer Update & Restore',
        status: 'FAIL',
        latencyMs,
        evidence: `sawLiveUpdate=${sawLiveUpdate}, restoredCleanly=${restoredCleanly}`,
        error: 'Live answer update or restoration check failed.',
      });
    }
  } catch (err) {
    try {
      await updateFaqAnswer(targetFaq.id, originalAnswer);
    } catch {
      // Ignore secondary restore error
    }
    results.push({
      id: 'DB05',
      name: 'Live Answer Update & Restore',
      status: 'FAIL',
      latencyMs: Date.now() - tDb05,
      evidence: 'Failed during live answer update check.',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  return activeFaqs;
}

async function runOpenAITtsSmokeCheck(
  results: SmokeCheckResult[],
  tmpDir: string,
): Promise<void> {
  const missing = checkMissingEnvVars(['OPENAI_API_KEY']);
  if (missing.length > 0) {
    results.push({
      id: 'TTS01',
      name: `OpenAI TTS (${OPENAI_MODELS.TTS} / voice=${OPENAI_MODELS.TTS_VOICE})`,
      status: 'BLOCKED',
      evidence: 'OPENAI_API_KEY is not configured.',
      error: `Missing env vars: ${missing.join(', ')}`,
    });
    return;
  }

  const t0 = Date.now();
  try {
    const client = getOpenAIClient();
    const phrase = 'สวัสดีค่ะ ยินดีต้อนรับสู่ระบบสาธิต';
    const response = await client.audio.speech.create({
      model: OPENAI_MODELS.TTS,
      voice: OPENAI_MODELS.TTS_VOICE,
      input: phrase,
      response_format: 'mp3',
    });

    const latencyMs = Date.now() - t0;
    const buffer = Buffer.from(await response.arrayBuffer());
    const outPath = path.join(tmpDir, 'tts-smoke.mp3');
    fs.writeFileSync(outPath, buffer);

    const requestId = response.headers.get('x-request-id') ?? 'n/a';
    const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
    const hasMp3Header =
      buffer.length > 4 &&
      (buffer.subarray(0, 3).toString('ascii') === 'ID3' ||
        (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0));

    if (buffer.length > 0 && hasMp3Header) {
      results.push({
        id: 'TTS01',
        name: `OpenAI TTS (${OPENAI_MODELS.TTS} / voice=${OPENAI_MODELS.TTS_VOICE})`,
        status: 'PASS',
        latencyMs,
        evidence: `Generated valid MP3 (${buffer.length} bytes, content-type=${contentType}, request_id=${requestId}) saved to .smoke-tmp/tts-smoke.mp3.`,
      });
    } else {
      results.push({
        id: 'TTS01',
        name: `OpenAI TTS (${OPENAI_MODELS.TTS} / voice=${OPENAI_MODELS.TTS_VOICE})`,
        status: 'FAIL',
        latencyMs,
        evidence: `Bytes=${buffer.length}, validMp3Header=${hasMp3Header}`,
        error: 'Returned audio buffer was empty or missing MP3 header.',
      });
    }
  } catch (err) {
    results.push({
      id: 'TTS01',
      name: `OpenAI TTS (${OPENAI_MODELS.TTS} / voice=${OPENAI_MODELS.TTS_VOICE})`,
      status: 'FAIL',
      latencyMs: Date.now() - t0,
      evidence: 'OpenAI TTS request failed.',
      error: err instanceof Error ? err.message : 'Unknown OpenAI TTS error',
    });
  }
}

async function runOpenAISttSmokeCheck(
  results: SmokeCheckResult[],
  tmpDir: string,
): Promise<void> {
  const missing = checkMissingEnvVars(['OPENAI_API_KEY']);
  if (missing.length > 0) {
    results.push({
      id: 'STT01',
      name: `OpenAI STT (${OPENAI_MODELS.STT})`,
      status: 'BLOCKED',
      evidence: 'OPENAI_API_KEY is not configured.',
      error: `Missing env vars: ${missing.join(', ')}`,
    });
    return;
  }

  const client = getOpenAIClient();
  const samplePath = path.join(tmpDir, 'stt-sample-thai.mp3');
  const expectedPhrase = 'สำนักงานเปิดกี่โมงครับ';

  try {
    // Reuse existing synthetic Thai audio sample if present to avoid unnecessary chargeable calls
    if (!fs.existsSync(samplePath) || fs.statSync(samplePath).size === 0) {
      const sampleRes = await client.audio.speech.create({
        model: OPENAI_MODELS.TTS,
        voice: OPENAI_MODELS.TTS_VOICE,
        input: expectedPhrase,
        response_format: 'mp3',
      });
      const sampleBuf = Buffer.from(await sampleRes.arrayBuffer());
      fs.writeFileSync(samplePath, sampleBuf);
    }
  } catch (err) {
    results.push({
      id: 'STT01',
      name: `OpenAI STT (${OPENAI_MODELS.STT})`,
      status: 'BLOCKED',
      evidence: 'Could not prepare synthetic Thai audio sample for STT test.',
      error: err instanceof Error ? err.message : 'Unknown sample prep error',
    });
    return;
  }

  const t0 = Date.now();
  try {
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(samplePath),
      model: OPENAI_MODELS.STT,
      language: 'th',
    });
    const latencyMs = Date.now() - t0;
    const text = (transcription.text ?? '').trim();
    const requestId =
      (transcription as { _request_id?: string })._request_id ?? 'n/a';

    const matchesMeaning =
      THAI_CHAR_REGEX.test(text) &&
      (text.includes('เปิดกี่โมง') || text.includes('สำนักงาน'));

    if (matchesMeaning) {
      results.push({
        id: 'STT01',
        name: `OpenAI STT (${OPENAI_MODELS.STT})`,
        status: 'PASS',
        latencyMs,
        evidence: `Transcript="${text}" (synthetic Thai audio sample "${expectedPhrase}", request_id=${requestId}).`,
      });
    } else {
      results.push({
        id: 'STT01',
        name: `OpenAI STT (${OPENAI_MODELS.STT})`,
        status: 'FAIL',
        latencyMs,
        evidence: `Transcript="${text}" (request_id=${requestId})`,
        error: 'Returned transcript did not match expected Thai meaning.',
      });
    }
  } catch (err) {
    results.push({
      id: 'STT01',
      name: `OpenAI STT (${OPENAI_MODELS.STT})`,
      status: 'FAIL',
      latencyMs: Date.now() - t0,
      evidence: 'OpenAI STT transcription request failed.',
      error: err instanceof Error ? err.message : 'Unknown OpenAI STT error',
    });
  }
}

async function runOpenAILlmSmokeChecks(
  results: SmokeCheckResult[],
  activeFaqs: FaqRecord[],
): Promise<void> {
  const missing = checkMissingEnvVars(['OPENAI_API_KEY']);
  if (missing.length > 0) {
    results.push({
      id: 'LLM01',
      name: `OpenAI LLM (${OPENAI_MODELS.LLM} Responses API)`,
      status: 'BLOCKED',
      evidence: 'OPENAI_API_KEY is not configured.',
      error: `Missing env vars: ${missing.join(', ')}`,
    });
    results.push({
      id: 'LLM02',
      name: `OpenAI LLM Grounded FAQ Check (${OPENAI_MODELS.LLM})`,
      status: 'BLOCKED',
      evidence: 'OPENAI_API_KEY is not configured.',
      error: `Missing env vars: ${missing.join(', ')}`,
    });
    return;
  }

  const client = getOpenAIClient();

  // LLM01 — Direct Thai response check
  const t0 = Date.now();
  try {
    const response = await client.responses.create({
      model: OPENAI_MODELS.LLM,
      input: 'ตอบสั้น ๆ เป็นภาษาไทย: ถ้าระบบมีข้อมูลไม่เพียงพอ ควรตอบผู้ใช้อย่างไร?',
      max_output_tokens: 100,
    });
    const latencyMs = Date.now() - t0;
    const outputText = (response.output_text ?? '').trim();
    const requestId =
      (response as { _request_id?: string })._request_id ?? response.id;
    const usage = response.usage;
    const usageSummary = usage
      ? `in=${usage.input_tokens}, out=${usage.output_tokens}, total=${usage.total_tokens}`
      : 'n/a';

    if (outputText.length > 0 && THAI_CHAR_REGEX.test(outputText)) {
      results.push({
        id: 'LLM01',
        name: `OpenAI LLM (${OPENAI_MODELS.LLM} Responses API)`,
        status: 'PASS',
        latencyMs,
        evidence: `status=${response.status}, request_id=${requestId}, tokens(${usageSummary}), output="${outputText}"`,
      });
    } else {
      results.push({
        id: 'LLM01',
        name: `OpenAI LLM (${OPENAI_MODELS.LLM} Responses API)`,
        status: 'FAIL',
        latencyMs,
        evidence: `output="${outputText}"`,
        error: 'Response was empty or did not contain valid Thai characters.',
      });
    }
  } catch (err) {
    results.push({
      id: 'LLM01',
      name: `OpenAI LLM (${OPENAI_MODELS.LLM} Responses API)`,
      status: 'FAIL',
      latencyMs: Date.now() - t0,
      evidence: 'OpenAI Responses API call failed.',
      error: err instanceof Error ? err.message : 'Unknown OpenAI LLM error',
    });
  }

  // LLM02 — Minimal grounded-answer check using live FAQ record from Supabase
  const openingHoursFaq =
    activeFaqs.find((f) => f.question === 'เปิดบริการกี่โมง') ?? activeFaqs[0];

  if (!openingHoursFaq) {
    results.push({
      id: 'LLM02',
      name: `OpenAI LLM Grounded FAQ Check (${OPENAI_MODELS.LLM})`,
      status: 'BLOCKED',
      evidence:
        'Requires a live FAQ record from Supabase (DB02 must pass first).',
      error: 'No active FAQ records available from Supabase repository.',
    });
    return;
  }

  const tGrounded = Date.now();
  try {
    const response = await client.responses.create({
      model: OPENAI_MODELS.LLM,
      instructions:
        'คุณเป็นผู้ช่วยตอบคำถามภาษาไทย ให้ตอบโดยอ้างอิงจากข้อมูล FAQ ที่กำหนดให้เท่านั้น ห้ามแต่งข้อมูลเพิ่ม',
      input: `ข้อมูล FAQ:\nคำถาม: ${openingHoursFaq.question}\nคำตอบ: ${openingHoursFaq.answer}\n\nคำถามจากผู้ใช้: สำนักงานเปิดบริการกี่โมงครับ?`,
      max_output_tokens: 100,
    });
    const latencyMs = Date.now() - tGrounded;
    const outputText = (response.output_text ?? '').trim();
    const requestId =
      (response as { _request_id?: string })._request_id ?? response.id;
    const usage = response.usage;
    const usageSummary = usage
      ? `in=${usage.input_tokens}, out=${usage.output_tokens}, total=${usage.total_tokens}`
      : 'n/a';

    const groundedMatches =
      THAI_CHAR_REGEX.test(outputText) &&
      (outputText.includes('09:00') || outputText.includes('9:00')) &&
      outputText.includes('16:00');

    if (groundedMatches) {
      results.push({
        id: 'LLM02',
        name: `OpenAI LLM Grounded FAQ Check (${OPENAI_MODELS.LLM})`,
        status: 'PASS',
        latencyMs,
        evidence: `Grounded on FAQ id=${openingHoursFaq.id} ("${openingHoursFaq.question}"), request_id=${requestId}, tokens(${usageSummary}), output="${outputText}"`,
      });
    } else {
      results.push({
        id: 'LLM02',
        name: `OpenAI LLM Grounded FAQ Check (${OPENAI_MODELS.LLM})`,
        status: 'FAIL',
        latencyMs,
        evidence: `output="${outputText}"`,
        error:
          'Grounded answer did not include expected hours from the live FAQ.',
      });
    }
  } catch (err) {
    results.push({
      id: 'LLM02',
      name: `OpenAI LLM Grounded FAQ Check (${OPENAI_MODELS.LLM})`,
      status: 'FAIL',
      latencyMs: Date.now() - tGrounded,
      evidence: 'Grounded LLM request failed.',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}

async function main(): Promise<void> {
  const onlySet = parseOnlyFlag();
  const tmpDir = path.join(process.cwd(), '.smoke-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log('==========================================================');
  console.log(' G0 Technical Readiness Smoke-Test Runner (Developer CLI) ');
  console.log('==========================================================');
  console.log(`Target checks: ${Array.from(onlySet).join(', ')}\n`);

  const results: SmokeCheckResult[] = [];
  let activeFaqs: FaqRecord[] = [];

  if (onlySet.has('db')) {
    activeFaqs = await runSupabaseSmokeChecks(results);
  } else if (onlySet.has('llm')) {
    try {
      activeFaqs = await getActiveFaqs();
    } catch {
      activeFaqs = [];
    }
  }

  if (onlySet.has('tts')) {
    await runOpenAITtsSmokeCheck(results, tmpDir);
  }

  if (onlySet.has('stt')) {
    await runOpenAISttSmokeCheck(results, tmpDir);
  }

  if (onlySet.has('llm')) {
    await runOpenAILlmSmokeChecks(results, activeFaqs);
  }

  console.log('--- Smoke-Test Results ---');
  for (const r of results) {
    const latencyLabel =
      typeof r.latencyMs === 'number' ? ` (${r.latencyMs} ms)` : '';
    console.log(`[${r.status}] ${r.id} — ${r.name}${latencyLabel}`);
    console.log(`       Evidence: ${r.evidence}`);
    if (r.error) {
      console.log(`       Error/Blocker: ${r.error}`);
    }
  }

  const failedOrBlocked = results.filter(
    (r) => r.status === 'FAIL' || r.status === 'BLOCKED',
  );
  console.log('\n----------------------------------------------------------');
  console.log(
    `Summary: ${results.filter((r) => r.status === 'PASS').length}/${results.length} PASSED, ${failedOrBlocked.length} FAILED/BLOCKED`,
  );
  console.log('----------------------------------------------------------');

  if (failedOrBlocked.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(
    'Unhandled error in G0 smoke runner:',
    err instanceof Error ? err.message : 'Unknown error',
  );
  process.exitCode = 1;
});
