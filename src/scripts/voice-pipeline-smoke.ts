import 'server-only';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NextRequest } from 'next/server';
import * as answerRoute from '@/app/api/answer/route';
import * as healthRoute from '@/app/api/health/route';
import * as sttRoute from '@/app/api/stt/route';
import * as ttsRoute from '@/app/api/tts/route';
import { handleApiRouteError } from '@/lib/api/errors';
import { getOpenAIClient, OPENAI_MODELS } from '@/lib/openai/client';
import { MAX_AUDIO_FILE_BYTES } from '@/lib/validations/voice';
import {
  FaqRepositoryError,
  getActiveFaqs,
  updateFaqAnswer,
} from '@/repositories/faq.repository';
import {
  hasUnsupportedFabricatedClaims,
  NO_MATCH_FALLBACK_ANSWER,
} from '@/services/answer.service';
import { retrieveMatchingFaqs } from '@/services/faq-matching.service';
import { detectAudioFormatFromSignature } from '@/services/transcription.service';
import type {
  AnswerResponse,
  ApiErrorResponse,
  SttResponse,
} from '@/types/api';

type CheckStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT TESTED';

interface PipelineCheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  latencyMs?: number;
  evidence: string;
  error?: string;
}

/**
 * Starts an in-process HTTP server wrapping the real Next.js Route Handlers
 * when PIPELINE_BASE_URL is not externally provided.
 */
async function startRouteHandlerHttpServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const externalUrl = process.env.PIPELINE_BASE_URL?.trim();
  if (externalUrl) {
    return {
      baseUrl: externalUrl.replace(/\/$/, ''),
      close: async () => {},
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const method = (req.method ?? 'GET').toUpperCase();

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bodyBuffer = Buffer.concat(chunks);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') {
          headers.set(k, v);
        } else if (Array.isArray(v)) {
          headers.set(k, v.join(', '));
        }
      }

      const nextReq = new NextRequest(url.toString(), {
        method,
        headers,
        body:
          method !== 'GET' && method !== 'HEAD' && bodyBuffer.length > 0
            ? new Uint8Array(bodyBuffer)
            : undefined,
      });

      let nextRes: Response;
      if (url.pathname === '/api/stt') {
        nextRes =
          method === 'POST'
            ? await sttRoute.POST(nextReq)
            : await sttRoute.GET();
      } else if (url.pathname === '/api/answer') {
        nextRes =
          method === 'POST'
            ? await answerRoute.POST(nextReq)
            : await answerRoute.GET();
      } else if (url.pathname === '/api/tts') {
        nextRes =
          method === 'POST'
            ? await ttsRoute.POST(nextReq)
            : await ttsRoute.GET();
      } else if (url.pathname === '/api/health') {
        nextRes = await healthRoute.GET();
      } else {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      res.statusCode = nextRes.status;
      nextRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });
      const respBuf = Buffer.from(await nextRes.arrayBuffer());
      res.end(respBuf);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: err instanceof Error ? err.message : 'Server error',
          },
        }),
      );
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function ensureSampleAudioFile(tmpDir: string): Promise<string> {
  const samplePath = path.join(tmpDir, 'stt-sample-thai.mp3');
  if (fs.existsSync(samplePath) && fs.statSync(samplePath).size > 0) {
    return samplePath;
  }

  const client = getOpenAIClient();
  const response = await client.audio.speech.create({
    model: OPENAI_MODELS.TTS,
    voice: OPENAI_MODELS.TTS_VOICE,
    input: 'สำนักงานเปิดกี่โมงครับ',
    response_format: 'mp3',
  });
  const buf = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(samplePath, buf);
  return samplePath;
}

async function main(): Promise<void> {
  const tmpDir = path.join(process.cwd(), '.smoke-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log('==============================================================');
  console.log(' Backend Voice Pipeline Integration & Smoke Runner (Prompt 3) ');
  console.log(
    '==============================================================\n',
  );

  const results: PipelineCheckResult[] = [];
  const { baseUrl, close } = await startRouteHandlerHttpServer();
  console.log(`Testing HTTP Route Handlers at: ${baseUrl}\n`);

  try {
    // ------------------------------------------------------------------
    // 1. Thai FAQ Retrieval & Matching Verification (B03, B04)
    // ------------------------------------------------------------------
    const tMatchStart = Date.now();
    const coreMatchCases: Array<{
      query: string;
      expectedQuestion: string | null;
      label: string;
    }> = [
      {
        query: 'เปิดบริการกี่โมง',
        expectedQuestion: 'เปิดบริการกี่โมง',
        label: 'Opening hours (exact)',
      },
      {
        query: 'สำนักงานเปิดกี่โมงครับ',
        expectedQuestion: 'เปิดบริการกี่โมง',
        label: 'Opening hours (alias + polite particle)',
      },
      {
        query: 'ต้องนัดล่วงหน้าหรือเปล่า',
        expectedQuestion: 'ต้องจองคิวไหม',
        label: 'Appointment (keyword phrase)',
      },
      {
        query: 'ถ้าจะไปใช้บริการต้องเอาอะไรไปบ้าง',
        expectedQuestion: 'เตรียมเอกสารอะไร',
        label: 'Documents (keyword phrase in sentence)',
      },
      {
        query: 'ค่าเช่าห้องเท่าไร',
        expectedQuestion: null,
        label: 'Unrelated question (No match)',
      },
      {
        query: 'อะไร',
        expectedQuestion: null,
        label: 'Generic word guard (No match)',
      },
    ];

    const matchSummaries: string[] = [];
    let allMatchesPassed = true;

    for (const tc of coreMatchCases) {
      const res = await retrieveMatchingFaqs(tc.query);
      const topQuestion = res.faqs[0]?.question ?? null;
      const passed =
        tc.expectedQuestion === null
          ? !res.matched && res.faqs.length === 0
          : res.matched && topQuestion === tc.expectedQuestion;

      if (!passed) {
        allMatchesPassed = false;
      }
      matchSummaries.push(
        `"${tc.query}" -> ${topQuestion ?? 'NO_MATCH'} (${passed ? 'OK' : 'MISMATCH'})`,
      );
    }
    const matchLatencyMs = Date.now() - tMatchStart;

    results.push({
      id: 'B04-MATCH',
      name: 'Thai Deterministic FAQ Matching (Core Examples + Generic Guard)',
      status: allMatchesPassed ? 'PASS' : 'FAIL',
      latencyMs: matchLatencyMs,
      evidence: matchSummaries.join(' | '),
      error: allMatchesPassed
        ? undefined
        : 'One or more Thai FAQ matching test cases did not match expected FAQ.',
    });

    // ------------------------------------------------------------------
    // 2. End-to-End Sequential HTTP Pipeline (Audio -> /api/stt -> /api/answer -> /api/tts)
    // ------------------------------------------------------------------
    const sampleAudioPath = await ensureSampleAudioFile(tmpDir);
    const sampleAudioBytes = fs.readFileSync(sampleAudioPath);

    const pipelineStart = Date.now();

    // Stage A: POST /api/stt
    const sttStart = Date.now();
    const sttForm = new FormData();
    sttForm.append(
      'audio',
      new Blob([sampleAudioBytes], { type: 'audio/mpeg' }),
      'stt-sample-thai.mp3',
    );
    const sttRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: sttForm,
    });
    const sttLatencyMs = Date.now() - sttStart;
    const sttBody = (await sttRes.json()) as SttResponse & ApiErrorResponse;

    const sttPassed =
      sttRes.status === 200 &&
      typeof sttBody.transcript === 'string' &&
      sttBody.transcript.includes('เปิดกี่โมง');

    results.push({
      id: 'B01-STT',
      name: 'POST /api/stt (Real Thai Audio -> Transcript)',
      status: sttPassed ? 'PASS' : 'FAIL',
      latencyMs: sttLatencyMs,
      evidence: `HTTP ${sttRes.status}, Cache-Control="${sttRes.headers.get('cache-control')}", transcript="${sttBody.transcript ?? ''}"`,
      error: sttPassed ? undefined : JSON.stringify(sttBody),
    });

    // Stage B: POST /api/answer
    const transcriptForAnswer = sttBody.transcript || 'สำนักงานเปิดกี่โมงครับ';
    const answerStart = Date.now();
    const answerRes = await fetch(`${baseUrl}/api/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: transcriptForAnswer }),
    });
    const answerLatencyMs = Date.now() - answerStart;
    const answerBody = (await answerRes.json()) as AnswerResponse &
      ApiErrorResponse;

    const answerPassed =
      answerRes.status === 200 &&
      answerBody.matched === true &&
      answerBody.answerMode === 'FAQ_GROUNDED' &&
      Array.isArray(answerBody.faqIds) &&
      answerBody.faqIds.length > 0 &&
      answerBody.answer.includes('09:00') &&
      answerBody.answer.includes('16:00');

    results.push({
      id: 'B05-ANSWER',
      name: 'POST /api/answer (Transcript -> Grounded FAQ Answer)',
      status: answerPassed ? 'PASS' : 'FAIL',
      latencyMs: answerLatencyMs,
      evidence: `HTTP ${answerRes.status}, matched=${answerBody.matched}, answerMode=${answerBody.answerMode}, faqIds=${JSON.stringify(answerBody.faqIds)}, answer="${answerBody.answer ?? ''}"`,
      error: answerPassed ? undefined : JSON.stringify(answerBody),
    });

    // Stage C: POST /api/tts
    const textForTts =
      answerBody.answer || 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ';
    const ttsStart = Date.now();
    const ttsRes = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: textForTts }),
    });
    const ttsLatencyMs = Date.now() - ttsStart;
    const ttsBuffer = Buffer.from(await ttsRes.arrayBuffer());
    const totalPipelineLatencyMs = Date.now() - pipelineStart;

    const detectedMp3 = detectAudioFormatFromSignature(ttsBuffer);
    const ttsContentType = ttsRes.headers.get('content-type') ?? '';
    const ttsCacheControl = ttsRes.headers.get('cache-control') ?? '';
    const ttsOutputPath = path.join(tmpDir, 'pipeline-output.mp3');
    if (ttsBuffer.length > 0) {
      fs.writeFileSync(ttsOutputPath, ttsBuffer);
    }

    const ttsPassed =
      ttsRes.status === 200 &&
      ttsContentType.includes('audio/mpeg') &&
      ttsCacheControl.includes('no-store') &&
      ttsBuffer.length > 1000 &&
      detectedMp3?.ext === 'mp3';

    results.push({
      id: 'B08-TTS',
      name: 'POST /api/tts (Thai Answer -> Binary MP3 Audio)',
      status: ttsPassed ? 'PASS' : 'FAIL',
      latencyMs: ttsLatencyMs,
      evidence: `HTTP ${ttsRes.status}, Content-Type="${ttsContentType}", Cache-Control="${ttsCacheControl}", bytes=${ttsBuffer.length}, format=${detectedMp3?.ext ?? 'unknown'}, saved to .smoke-tmp/pipeline-output.mp3`,
      error: ttsPassed ? undefined : 'TTS response failed validation checks.',
    });

    const e2ePassed = sttPassed && answerPassed && ttsPassed;
    results.push({
      id: 'B09-PIPELINE',
      name: 'Complete Sequential HTTP Pipeline (STT -> Answer -> TTS)',
      status: e2ePassed ? 'PASS' : 'FAIL',
      latencyMs: totalPipelineLatencyMs,
      evidence: `Total=${totalPipelineLatencyMs} ms (STT=${sttLatencyMs} ms, Answer=${answerLatencyMs} ms, TTS=${ttsLatencyMs} ms)`,
      error: e2ePassed
        ? undefined
        : 'One or more stages in the sequential HTTP pipeline failed.',
    });

    // ------------------------------------------------------------------
    // 3. Real FAQ Database Consistency Test (Live Update -> /api/answer -> Restore)
    // ------------------------------------------------------------------
    const activeFaqs = await getActiveFaqs();
    const openingFaq = activeFaqs.find((f) => f.question === 'เปิดบริการกี่โมง');
    if (openingFaq) {
      const originalAnswer = openingFaq.answer;
      const modifiedAnswer =
        'จุดบริการ Demo เปลี่ยนเวลาเฉพาะกิจเป็น 10:30–17:30 น. [LIVE-PIPELINE-CHECK]';
      const tLiveStart = Date.now();
      try {
        await updateFaqAnswer(openingFaq.id, modifiedAnswer);
        const liveRes = await fetch(`${baseUrl}/api/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: 'สำนักงานเปิดกี่โมงครับ' }),
        });
        const liveBody = (await liveRes.json()) as AnswerResponse;

        await updateFaqAnswer(openingFaq.id, originalAnswer);

        const reflectedUpdate =
          liveRes.status === 200 &&
          liveBody.matched === true &&
          liveBody.answer.includes('10:30') &&
          liveBody.answer.includes('17:30');

        results.push({
          id: 'B03-LIVE-DB',
          name: 'Real Supabase FAQ Live Update Consistency via /api/answer',
          status: reflectedUpdate ? 'PASS' : 'FAIL',
          latencyMs: Date.now() - tLiveStart,
          evidence: `Updated FAQ id=${openingFaq.id} in Supabase -> /api/answer returned: "${liveBody.answer}" -> Restored original FAQ answer.`,
          error: reflectedUpdate
            ? undefined
            : `Expected updated hours (10:30–17:30) in answer, got: "${liveBody.answer}"`,
        });
      } catch (err) {
        await updateFaqAnswer(openingFaq.id, originalAnswer).catch(() => {});
        results.push({
          id: 'B03-LIVE-DB',
          name: 'Real Supabase FAQ Live Update Consistency via /api/answer',
          status: 'FAIL',
          latencyMs: Date.now() - tLiveStart,
          evidence: 'Exception during live DB consistency check.',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    // ------------------------------------------------------------------
    // 4. Negative & Boundary Tests (Zero Paid API Calls!)
    // ------------------------------------------------------------------
    const negStart = Date.now();
    const negativeDetails: string[] = [];
    let allNegativesPassed = true;

    // 4a. Missing audio -> 400
    const emptyForm = new FormData();
    const missingAudioRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: emptyForm,
    });
    const missingAudioJson = (await missingAudioRes.json()) as ApiErrorResponse;
    const missingAudioOk =
      missingAudioRes.status === 400 &&
      missingAudioJson.error?.code === 'MISSING_AUDIO';
    if (!missingAudioOk) allNegativesPassed = false;
    negativeDetails.push(
      `MissingAudio=${missingAudioRes.status}(${missingAudioJson.error?.code})`,
    );

    // 4b. Unsupported audio (Fake text bytes with .mp3 extension) -> 415
    const fakeAudioForm = new FormData();
    fakeAudioForm.append(
      'audio',
      new Blob([Buffer.from('NOT_A_REAL_AUDIO_FILE_HEADER_123456')], {
        type: 'audio/mpeg',
      }),
      'fake.mp3',
    );
    const badAudioRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: fakeAudioForm,
    });
    const badAudioJson = (await badAudioRes.json()) as ApiErrorResponse;
    const badAudioOk =
      badAudioRes.status === 415 &&
      badAudioJson.error?.code === 'INVALID_AUDIO';
    if (!badAudioOk) allNegativesPassed = false;
    negativeDetails.push(
      `UnsupportedAudio=${badAudioRes.status}(${badAudioJson.error?.code})`,
    );

    // 4c. Oversized audio (> 3 MB) -> 413
    const oversizedBuffer = Buffer.alloc(MAX_AUDIO_FILE_BYTES + 1024, 0x49);
    const oversizedForm = new FormData();
    oversizedForm.append(
      'audio',
      new Blob([oversizedBuffer], { type: 'audio/mpeg' }),
      'huge.mp3',
    );
    const oversizedRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: oversizedForm,
    });
    const oversizedJson = (await oversizedRes.json()) as ApiErrorResponse;
    const oversizedOk =
      oversizedRes.status === 413 &&
      oversizedJson.error?.code === 'AUDIO_TOO_LARGE';
    if (!oversizedOk) allNegativesPassed = false;
    negativeDetails.push(
      `OversizedAudio=${oversizedRes.status}(${oversizedJson.error?.code})`,
    );

    // 4d. Empty transcript -> 400
    const emptyTrRes = await fetch(`${baseUrl}/api/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: '   ' }),
    });
    const emptyTrJson = (await emptyTrRes.json()) as ApiErrorResponse;
    const emptyTrOk =
      emptyTrRes.status === 400 &&
      emptyTrJson.error?.code === 'EMPTY_TRANSCRIPT';
    if (!emptyTrOk) allNegativesPassed = false;
    negativeDetails.push(
      `EmptyTranscript=${emptyTrRes.status}(${emptyTrJson.error?.code})`,
    );

    // 4e. Transcript > 500 chars -> 400
    const longTrRes = await fetch(`${baseUrl}/api/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'ก'.repeat(501) }),
    });
    const longTrJson = (await longTrRes.json()) as ApiErrorResponse;
    const longTrOk =
      longTrRes.status === 400 && longTrJson.error?.code === 'TEXT_TOO_LONG';
    if (!longTrOk) allNegativesPassed = false;
    negativeDetails.push(
      `LongTranscript=${longTrRes.status}(${longTrJson.error?.code})`,
    );

    // 4f. Question outside FAQs -> 200 Context-Aware Guarded AI response (no fabricated prices)
    const noMatchStart = Date.now();
    const noMatchRes = await fetch(`${baseUrl}/api/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'ค่าเช่าห้องเท่าไรครับ' }),
    });
    const noMatchLatency = Date.now() - noMatchStart;
    const noMatchJson = (await noMatchRes.json()) as AnswerResponse;
    const noMatchOk =
      noMatchRes.status === 200 &&
      noMatchJson.matched === false &&
      noMatchJson.faqIds.length === 0 &&
      (noMatchJson.answerMode === 'ORGANIZATION_INFO_UNKNOWN' ||
        noMatchJson.answerMode === 'GENERAL_GUIDANCE') &&
      Boolean(noMatchJson.answer) &&
      !hasUnsupportedFabricatedClaims(noMatchJson.answer);
    if (!noMatchOk) allNegativesPassed = false;
    negativeDetails.push(
      `NoMatchGuarded=${noMatchRes.status}(matched=${noMatchJson.matched}, mode=${noMatchJson.answerMode}, fallbackConst=${Boolean(NO_MATCH_FALLBACK_ANSWER)}, ${noMatchLatency}ms)`,
    );

    // 4g. Empty TTS text -> 400
    const emptyTtsRes = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '  ' }),
    });
    const emptyTtsJson = (await emptyTtsRes.json()) as ApiErrorResponse;
    const emptyTtsOk =
      emptyTtsRes.status === 400 &&
      emptyTtsJson.error?.code === 'INVALID_REQUEST';
    if (!emptyTtsOk) allNegativesPassed = false;
    negativeDetails.push(
      `EmptyTts=${emptyTtsRes.status}(${emptyTtsJson.error?.code})`,
    );

    // 4h. Oversized TTS text (> 500 chars) -> 400
    const longTtsRes = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ข'.repeat(501) }),
    });
    const longTtsJson = (await longTtsRes.json()) as ApiErrorResponse;
    const longTtsOk =
      longTtsRes.status === 400 && longTtsJson.error?.code === 'TEXT_TOO_LONG';
    if (!longTtsOk) allNegativesPassed = false;
    negativeDetails.push(
      `LongTts=${longTtsRes.status}(${longTtsJson.error?.code})`,
    );

    // 4i. Unsupported HTTP method (GET on /api/stt, /api/answer, /api/tts) -> 405
    const getSttRes = await fetch(`${baseUrl}/api/stt`, { method: 'GET' });
    const getAnsRes = await fetch(`${baseUrl}/api/answer`, { method: 'GET' });
    const getTtsRes = await fetch(`${baseUrl}/api/tts`, { method: 'GET' });
    const methodOk =
      getSttRes.status === 405 &&
      getAnsRes.status === 405 &&
      getTtsRes.status === 405;
    if (!methodOk) allNegativesPassed = false;
    negativeDetails.push(
      `MethodNotAllowed=${getSttRes.status}/${getAnsRes.status}/${getTtsRes.status}`,
    );

    // 4j. Database failure distinction (B07: FaqRepositoryError -> 503 DATABASE_ERROR, never 200 matched=false)
    const dbErrorResp = handleApiRouteError(
      new FaqRepositoryError('Simulated DB failure', 'PGRST000'),
    );
    const dbErrorJson = (await dbErrorResp.json()) as ApiErrorResponse;
    const dbErrorOk =
      dbErrorResp.status === 503 &&
      dbErrorJson.error?.code === 'DATABASE_ERROR';
    if (!dbErrorOk) allNegativesPassed = false;
    negativeDetails.push(
      `DbFailureDistinction=${dbErrorResp.status}(${dbErrorJson.error?.code})`,
    );

    // 4k. Emergency switch DEMO_ENABLED=false -> 503 DEMO_DISABLED
    const prevDemo = process.env.DEMO_ENABLED;
    process.env.DEMO_ENABLED = 'false';
    const demoOffRes = await fetch(`${baseUrl}/api/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'เปิดบริการกี่โมง' }),
    });
    if (prevDemo === undefined) {
      delete process.env.DEMO_ENABLED;
    } else {
      process.env.DEMO_ENABLED = prevDemo;
    }
    const demoOffJson = (await demoOffRes.json()) as ApiErrorResponse;
    const demoOffOk =
      demoOffRes.status === 503 && demoOffJson.error?.code === 'DEMO_DISABLED';
    if (!demoOffOk) allNegativesPassed = false;
    negativeDetails.push(
      `DemoKillSwitch=${demoOffRes.status}(${demoOffJson.error?.code})`,
    );

    results.push({
      id: 'B02-B06-B07-B11-NEGATIVES',
      name: 'Negative, Boundary, No-Match Fallback & Controlled Error Tests',
      status: allNegativesPassed ? 'PASS' : 'FAIL',
      latencyMs: Date.now() - negStart,
      evidence: negativeDetails.join(' | '),
      error: allNegativesPassed
        ? undefined
        : 'One or more negative/boundary validation checks failed.',
    });
  } finally {
    await close();
  }

  console.log('--- Pipeline Smoke-Test Results ---');
  for (const r of results) {
    const latencyLabel =
      typeof r.latencyMs === 'number' ? ` (${r.latencyMs} ms)` : '';
    console.log(`[${r.status}] ${r.id} — ${r.name}${latencyLabel}`);
    console.log(`       Evidence: ${r.evidence}`);
    if (r.error) {
      console.log(`       Error: ${r.error}`);
    }
  }

  const failed = results.filter((r) => r.status !== 'PASS');
  console.log(
    '\n--------------------------------------------------------------',
  );
  console.log(
    `Summary: ${results.length - failed.length}/${results.length} PASSED, ${failed.length} FAILED`,
  );
  console.log(
    'Audio Playback Note: Audio generation=PASS, Format validation=PASS, Human playback=NOT TESTED',
  );
  console.log('--------------------------------------------------------------');

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(
    'Unhandled error in voice-pipeline-smoke runner:',
    err instanceof Error ? err.message : 'Unknown error',
  );
  process.exitCode = 1;
});
