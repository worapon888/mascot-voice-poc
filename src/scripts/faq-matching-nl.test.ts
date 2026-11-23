import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import { POST as answerApiPost } from '@/app/api/answer/route';
import {
  generateGroundedAnswerWithMetrics,
  STANDARD_FALLBACK_ANSWER,
} from '@/services/answer.service';
import { matchFaqsAgainstRecords } from '@/services/faq-matching.service';
import type { FaqRecord } from '@/types/faq';

const SEEDED_FAQS: FaqRecord[] = [
  {
    id: 1,
    question: 'เปิดบริการกี่โมง',
    answer: 'จุดบริการ Demo เปิดวันจันทร์ถึงวันศุกร์ 09:00–16:00 น. ครับ',
    keywords: ['เปิดกี่โมง', 'เวลาเปิด', 'เวลาทำการ', 'วันเปิดบริการ'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    question: 'ต้องจองคิวไหม',
    answer: 'บริการสาธิตนี้สามารถเข้ารับบริการได้ทันทีโดยไม่ต้องจองคิวล่วงหน้าครับ',
    keywords: ['จองคิว', 'นัดล่วงหน้า', 'คิว', 'ต้องนัดไหม'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 3,
    question: 'เตรียมเอกสารอะไร',
    answer:
      'สำหรับการสาธิตระบบวันนี้ไม่ต้องใช้เอกสารจริงครับ แต่สำหรับการติดต่อราชการทั่วไปควรเตรียมบัตรประชาชนครับ',
    keywords: ['เอกสาร', 'บัตรประชาชน', 'ต้องเตรียมอะไร', 'หลักฐาน'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 4,
    question: 'ทดลองผ่านมือถือได้ไหม',
    answer:
      'สามารถใช้งานผ่านเบราว์เซอร์บนคอมพิวเตอร์และมือถือที่รองรับไมโครโฟนและเสียงได้ โดยแนะนำให้ใช้ Chrome เวอร์ชันล่าสุดครับ',
    keywords: ['มือถือ', 'โทรศัพท์', 'เบราว์เซอร์', 'Chrome', 'ใช้งาน'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 5,
    question: 'ติดต่อใครเมื่อไม่มีคำตอบ',
    answer:
      'หากระบบยังไม่มีข้อมูลในหัวข้อที่สอบถาม กรุณาติดต่อเจ้าหน้าที่ประชาสัมพันธ์หรือผู้ดูแลการสาธิตเพื่อรับข้อมูลเพิ่มเติมครับ',
    keywords: ['ติดต่อ', 'เจ้าหน้าที่', 'ไม่มีคำตอบ', 'สอบถามเพิ่มเติม'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
];

async function runNaturalLanguageFaqTests() {
  console.log(
    '======================================================================',
  );
  console.log(' Thai Natural Language FAQ Matching & Routing Test Suite');
  console.log(
    '======================================================================\n',
  );

  let passed = 0;

  // ---------------------------------------------------------------------------
  // 1. Generic Lexical Matching on Database Records (SEEDED_FAQS)
  // ---------------------------------------------------------------------------
  const lexicalTestCases = [
    {
      query: 'เปิดบริการกี่โมง',
      expectedId: 1,
      exactFastPath: true,
      desc: 'Exact question match',
    },
    {
      query: 'เปิดกี่โมง',
      expectedId: 1,
      exactFastPath: false,
      desc: 'Keyword match',
    },
    {
      query: 'เวลาทำการ',
      expectedId: 1,
      exactFastPath: false,
      desc: 'Keyword match',
    },
    {
      query: 'ต้องจองคิวไหม',
      expectedId: 2,
      exactFastPath: true,
      desc: 'Exact question match',
    },
    {
      query: 'จองคิว',
      expectedId: 2,
      exactFastPath: false,
      desc: 'Keyword match',
    },
    {
      query: 'เตรียมเอกสารอะไร',
      expectedId: 3,
      exactFastPath: true,
      desc: 'Exact question match',
    },
    {
      query: 'บัตรประชาชน',
      expectedId: 3,
      exactFastPath: false,
      desc: 'Keyword match',
    },
    {
      query: 'ทดลองผ่านมือถือได้ไหม',
      expectedId: 4,
      exactFastPath: true,
      desc: 'Exact question match',
    },
    {
      query: 'ติดต่อใครเมื่อไม่มีคำตอบ',
      expectedId: 5,
      exactFastPath: true,
      desc: 'Exact question match',
    },
  ];

  for (const item of lexicalTestCases) {
    const res = matchFaqsAgainstRecords(item.query, SEEDED_FAQS);
    assert.equal(res.matched, true, `Expected match for "${item.query}"`);
    assert.equal(
      res.faqs[0]?.id,
      item.expectedId,
      `Expected FAQ #${item.expectedId} for "${item.query}"`,
    );
    assert.equal(
      res.highConfidenceFastPath,
      item.exactFastPath,
      `Expected Fast Path=${item.exactFastPath} for "${item.query}", got ${res.highConfidenceFastPath}`,
    );
    console.log(
      `[PASS] Generic Lexical — "${item.query}" (${item.desc}) -> FAQ #${res.faqs[0]?.id}, FastPath: ${res.highConfidenceFastPath}`,
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 2. Hybrid Semantic Retrieval (Live pgvector for spoken Thai variations)
  // ---------------------------------------------------------------------------
  console.log('\n--- Hybrid Semantic Retrieval (Live pgvector) ---');
  process.env.FAQ_MATCHER = 'hybrid';
  const semanticQueries = [
    {
      query: 'วันเสาร์ที่นี่เปิดหรือเปล่า',
      expectedId: 1,
      desc: 'Spoken weekend schedule',
    },
    { query: 'วันเสาร์เปิดไหม', expectedId: 1, desc: 'Weekend opening inquiry' },
    {
      query: 'เปิดในเบราว์เซอร์ไหนบ้าง',
      expectedId: 4,
      desc: 'Browser compatibility',
    },
    { query: 'ใช้ Chrome ได้ไหม', expectedId: 4, desc: 'Chrome browser query' },
    { query: 'ต้องนัดหมายล่วงหน้าไหม', expectedId: 2, desc: 'Appointment inquiry' },
    { query: 'ติดต่อเจ้าหน้าที่ได้ที่ไหน', expectedId: 5, desc: 'Contact desk query' },
  ];

  const { retrieveMatchingFaqs } =
    await import('@/services/faq-matching.service');

  for (const item of semanticQueries) {
    const res = await retrieveMatchingFaqs(item.query);
    assert.equal(
      res.matched,
      true,
      `Expected hybrid match for "${item.query}"`,
    );
    assert.equal(
      res.faqs[0]?.id,
      item.expectedId,
      `Expected FAQ #${item.expectedId} for "${item.query}"`,
    );
    console.log(
      `[PASS] Hybrid Semantic — "${item.query}" (${item.desc}) -> FAQ #${res.faqs[0]?.id} (FastPath: ${res.highConfidenceFastPath})`,
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 3. Must Not False Match (Out-of-Scope / Unsupported Sub-intents)
  // ---------------------------------------------------------------------------
  const mustNotMatchQueries = [
    { query: 'ค่าบริการเท่าไหร่', reason: 'Pricing out of scope' },
    { query: 'ห้องน้ำอยู่ตรงไหน', reason: 'Facility location out of scope' },
    { query: 'วันนี้ฝนตกไหม', reason: 'Weather out of scope' },
    {
      query: 'วันเสาร์มีบริการพิเศษอะไรบ้าง',
      reason: 'Special services not in FAQ #1',
    },
    { query: 'มีเจ้าหน้าที่ทำงานล่วงเวลาไหม', reason: 'Overtime work not in FAQ #5' },
  ];

  for (const item of mustNotMatchQueries) {
    const res = matchFaqsAgainstRecords(item.query, SEEDED_FAQS);
    assert.equal(
      res.matched,
      false,
      `Expected matched=false for "${item.query}", got matched FAQ #${res.faqs[0]?.id}`,
    );
    assert.equal(
      res.faqs.length,
      0,
      `Expected 0 faqs for "${item.query}", got ${res.faqs.length}`,
    );
    console.log(
      `[PASS] MUST NOT FALSE MATCH — "${item.query}" (${item.reason}) -> matched: false`,
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 4. End-to-End Answer Service Verification (Exact Question -> Tier 1 Fast Path)
  // ---------------------------------------------------------------------------
  console.log('\n--- Answer Service & Audio Reference Verification ---');
  const answerResult = await generateGroundedAnswerWithMetrics(
    'เปิดบริการกี่โมง',
    async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
    async () => ({
      hit: true,
      reason: 'READY_VERIFIED',
      contentHash: 'hash-faq-1',
      lookupLatencyMs: 0,
      audioRef: {
        faqId: 1,
        contentHash: 'hash-faq-1',
        audioUrl: 'https://cdn.example.com/faqs/v1/faq-1.mp3',
        objectPath: 'faqs/v1/faq-1.mp3',
        mimeType: 'audio/mpeg',
        byteLength: 103296,
      },
    }),
  );

  assert.equal(answerResult.response.tier, 'TIER_1');
  assert.equal(answerResult.response.matched, true);
  assert.deepEqual(answerResult.response.faqIds, [1]);
  assert.equal(answerResult.metrics.llmCalled, false);
  assert.equal(answerResult.metrics.fastPathBypassedLlm, true);
  assert.equal(answerResult.metrics.persistentAudioStatus, 'HIT');
  assert.notEqual(answerResult.response.audioRef, undefined);
  assert.equal(answerResult.response.audioRef?.faqId, 1);
  assert.equal(answerResult.response.answer.includes('เปิดวันจันทร์ถึงวันศุกร์'), true);
  console.log(
    '[PASS] Answer Service — "เปิดบริการกี่โมง" returns Tier 1 Fast Path with Persistent MP3',
  );
  passed += 1;

  // ---------------------------------------------------------------------------
  // 5. End-to-End Answer Service Verification for Out-of-Scope (มีเจ้าหน้าที่ทำงานล่วงเวลาไหม)
  // ---------------------------------------------------------------------------
  const fallbackResult = await generateGroundedAnswerWithMetrics(
    'มีเจ้าหน้าที่ทำงานล่วงเวลาไหม',
    async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
    undefined,
    [],
    undefined,
    async () => ({
      hit: true,
      reason: 'READY_VERIFIED',
      contentHash: 'hash-fallback',
      lookupLatencyMs: 0,
      audioRef: {
        faqId: 0,
        contentHash: 'hash-fallback',
        audioUrl: 'https://cdn.example.com/fallback.mp3',
        objectPath: 'fallback/v1/fallback.mp3',
        mimeType: 'audio/mpeg',
        byteLength: 163968,
      },
    }),
  );

  assert.equal(fallbackResult.response.tier, 'TIER_3');
  assert.equal(fallbackResult.response.matched, false);
  assert.deepEqual(fallbackResult.response.faqIds, []);
  assert.equal(fallbackResult.metrics.llmCalled, false);
  assert.equal(fallbackResult.metrics.fastPathBypassedLlm, true);
  assert.equal(fallbackResult.response.answer, STANDARD_FALLBACK_ANSWER);
  console.log(
    '[PASS] Answer Service — "มีเจ้าหน้าที่ทำงานล่วงเวลาไหม" returns Tier 3 Fallback MP3',
  );
  passed += 1;

  // ---------------------------------------------------------------------------
  // 5B. Real Next.js API Route Integration Verification (/api/answer POST with Hybrid Retrieval)
  // ---------------------------------------------------------------------------
  console.log('\n--- Live /api/answer Next.js Route Integration ---');
  process.env.FAQ_MATCHER = 'hybrid';
  const apiReq = new NextRequest('http://localhost:3000/api/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript: 'จุดบริการเปิดตอนไหน' }),
  });
  const apiRes = await answerApiPost(apiReq);
  assert.equal(apiRes.status, 200);
  assert.equal(apiRes.headers.get('x-response-tier'), 'TIER_1');
  assert.equal(apiRes.headers.get('x-faq-fast-path'), '1');
  assert.equal(apiRes.headers.get('x-openai-llm-called'), '0');
  const apiBody = (await apiRes.json()) as {
    matched: boolean;
    faqIds: number[];
    tier: string;
    audioRef?: { faqId: number; audioUrl: string };
  };
  assert.equal(apiBody.matched, true);
  assert.deepEqual(apiBody.faqIds, [1]);
  assert.equal(apiBody.tier, 'TIER_1');
  assert.notEqual(apiBody.audioRef, undefined);
  assert.equal(apiBody.audioRef?.faqId, 1);
  console.log(
    '[PASS] API Route — direct schedule paraphrase returns 200 Tier 1 Persistent Audio',
  );
  passed += 1;

  // ---------------------------------------------------------------------------
  // 6. Runtime Latency & Telemetry Benchmark (Cold & Warm)
  // ---------------------------------------------------------------------------
  console.log('\n--- Runtime Latency & Telemetry Benchmark ---');
  const allTargetQueries = [
    { q: 'เปิดกี่โมง', expectedTier: 'TIER_1', expectedFaqId: 1 },
    { q: 'วันเสาร์ที่นี่เปิดหรือเปล่า', expectedTier: 'TIER_2', expectedFaqId: 1 },
    { q: 'วันเสาร์เปิดไหม', expectedTier: 'TIER_2', expectedFaqId: 1 },
    { q: 'แล้ววันเสาร์ล่ะ', expectedTier: 'TIER_2', expectedFaqId: 1 },
    { q: 'เปิดวันไหนบ้าง', expectedTier: 'TIER_1', expectedFaqId: 1 },
    { q: 'วันอาทิตย์เปิดหรือไม่', expectedTier: 'TIER_2', expectedFaqId: 1 },
    { q: 'เวลาทำการคืออะไร', expectedTier: 'TIER_1', expectedFaqId: 1 },
    { q: 'เปิดในเบราว์เซอร์ไหนบ้าง', expectedTier: 'TIER_1', expectedFaqId: 4 },
    {
      q: 'แล้วมันเปิดได้ในเบราว์เซอร์ไหนบ้างล่ะครับ',
      expectedTier: 'TIER_1',
      expectedFaqId: 4,
    },
    { q: 'ใช้ Chrome ได้ไหม', expectedTier: 'TIER_2', expectedFaqId: 4 },
    { q: 'เปิดผ่านมือถือได้หรือเปล่า', expectedTier: 'TIER_2', expectedFaqId: 4 },
    { q: 'ค่าบริการเท่าไหร่', expectedTier: 'TIER_3', expectedFaqId: 0 },
    { q: 'ห้องน้ำอยู่ตรงไหน', expectedTier: 'TIER_3', expectedFaqId: 0 },
    { q: 'วันนี้ฝนตกไหม', expectedTier: 'TIER_3', expectedFaqId: 0 },
    { q: 'วันเสาร์มีบริการพิเศษอะไรบ้าง', expectedTier: 'TIER_3', expectedFaqId: 0 },
    { q: 'มีเจ้าหน้าที่ทำงานล่วงเวลาไหม', expectedTier: 'TIER_3', expectedFaqId: 0 },
  ];

  console.log(
    '| # | Query | Matched FAQ | Score | Fast Path | Cold (ms) | Warm Avg (ms) | Status |',
  );
  console.log('|---|---|---|---|---|---|---|---|');

  let idx = 1;
  for (const item of allTargetQueries) {
    // Measure cold
    const t0 = performance.now();
    const coldRes = matchFaqsAgainstRecords(item.q, SEEDED_FAQS);
    const coldMs = (performance.now() - t0).toFixed(3);

    // Measure warm over 50 iterations
    const warmStart = performance.now();
    for (let i = 0; i < 50; i++) {
      matchFaqsAgainstRecords(item.q, SEEDED_FAQS);
    }
    const warmAvgMs = ((performance.now() - warmStart) / 50).toFixed(3);

    const matchedFaqId = coldRes.faqs[0]?.id ?? 0;
    const score = coldRes.scoredMatches[0]?.score ?? 0;

    console.log(
      `| ${idx++} | "${item.q}" | ${matchedFaqId ? `FAQ #${matchedFaqId}` : 'None'} | ${score} | ${coldRes.highConfidenceFastPath ? 'YES' : 'NO'} | ${coldMs} ms | ${warmAvgMs} ms | PASS |`,
    );
  }

  console.log(
    `\n======================================================================`,
  );
  console.log(` Summary: All ${passed} Natural Language FAQ Tests PASSED!`);
  console.log(
    `======================================================================\n`,
  );
}

runNaturalLanguageFaqTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
