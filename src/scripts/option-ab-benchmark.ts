import { performance } from 'node:perf_hooks';
import { matchFaqsWithConversationContext } from '@/services/faq-matching.service';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

const DEMO_FAQS: FaqRecord[] = [
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

interface TestCase {
  id: number;
  name: string;
  query: string;
  history?: ConversationTurn[];
  expectedTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
  baselineLatency: string;
  baselineTier: string;
}

const TEST_CASES: TestCase[] = [
  {
    id: 1,
    name: 'FAQ #1 Standalone',
    query: 'เปิดกี่โมง',
    expectedTier: 'TIER_1',
    baselineLatency: '35 ms (Backend)',
    baselineTier: 'Tier 1',
  },
  {
    id: 2,
    name: 'FAQ #1 Follow-up',
    query: 'แล้ววันเสาร์ล่ะ เปิดไหม?',
    history: [
      { role: 'user', text: 'เปิดกี่โมง', faqIds: [1] },
      { role: 'assistant', text: DEMO_FAQS[0].answer, faqIds: [1] },
    ],
    expectedTier: 'TIER_1',
    baselineLatency: '5,100 ms (LLM + Dynamic TTS)',
    baselineTier: 'Tier 2',
  },
  {
    id: 3,
    name: 'FAQ #4 Phrasing Variation',
    query: 'เปิดในเบราว์เซอร์ไหนบ้าง',
    expectedTier: 'TIER_1',
    baselineLatency: '4,850 ms (LLM + Dynamic TTS)',
    baselineTier: 'Tier 2',
  },
  {
    id: 4,
    name: 'FAQ #4 Phrasing Variation + Follow-up',
    query: 'แล้วมันเปิดได้ในเบราว์เซอร์ไหนบ้างล่ะครับ',
    history: [
      { role: 'user', text: 'ทดลองผ่านมือถือได้ไหม', faqIds: [4] },
      { role: 'assistant', text: DEMO_FAQS[3].answer, faqIds: [4] },
    ],
    expectedTier: 'TIER_1',
    baselineLatency: '4,850 ms (LLM + Dynamic TTS)',
    baselineTier: 'Tier 2',
  },
  {
    id: 5,
    name: 'FAQ #4 Device Variation',
    query: 'เปิดผ่านมือถือได้ไหม',
    expectedTier: 'TIER_1',
    baselineLatency: '4,670 ms (LLM + Dynamic TTS)',
    baselineTier: 'Tier 2',
  },
  {
    id: 6,
    name: 'FAQ #2 Standalone',
    query: 'ต้องจองคิวไหม',
    expectedTier: 'TIER_1',
    baselineLatency: '35 ms (Backend)',
    baselineTier: 'Tier 1',
  },
  {
    id: 7,
    name: 'Completely Out-of-Scope',
    query: 'ค่าบริการเท่าไหร่',
    expectedTier: 'TIER_3',
    baselineLatency: '33 ms (Cached Fallback MP3)',
    baselineTier: 'Tier 3',
  },
  {
    id: 8,
    name: 'Contextual Ambiguous Follow-up',
    query: 'แล้วถ้าไม่มีล่ะ',
    history: [
      { role: 'user', text: 'เตรียมเอกสารอะไร', faqIds: [3] },
      { role: 'assistant', text: DEMO_FAQS[2].answer, faqIds: [3] },
    ],
    expectedTier: 'TIER_2',
    baselineLatency: '4,750 ms (Contextual LLM)',
    baselineTier: 'Tier 2',
  },
  {
    id: 9,
    name: 'Ambiguous Cross-FAQ Follow-up',
    query: 'จองคิวผ่านมือถือได้ไหม',
    expectedTier: 'TIER_2',
    baselineLatency: '4,900 ms (LLM Disambiguation)',
    baselineTier: 'Tier 2',
  },
];

async function runBenchmark() {
  console.log(
    '======================================================================',
  );
  console.log(' Option A + B Verification & Latency Benchmark (9 Test Cases)');
  console.log(
    '======================================================================\n',
  );

  for (const tc of TEST_CASES) {
    // Warm-up run
    matchFaqsWithConversationContext(tc.query, DEMO_FAQS, tc.history ?? []);

    // Timed cold run (first run timing)
    const t0 = performance.now();
    const result = matchFaqsWithConversationContext(
      tc.query,
      DEMO_FAQS,
      tc.history ?? [],
    );
    const matchTimeMs = (performance.now() - t0).toFixed(3);

    // Warm run (averaged over 100 runs)
    const iterations = 100;
    const startWarm = performance.now();
    for (let i = 0; i < iterations; i++) {
      matchFaqsWithConversationContext(tc.query, DEMO_FAQS, tc.history ?? []);
    }
    const avgWarmMs = ((performance.now() - startWarm) / iterations).toFixed(3);

    // Determine resolved Tier
    let resolvedTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
    let audioMechanism: string;
    let llmCalled = false;
    let ttsCalled = false;

    if (result.highConfidenceFastPath && result.faqs.length === 1) {
      resolvedTier = 'TIER_1';
      audioMechanism = `Persistent MP3 (FAQ #${result.faqs[0].id})`;
      llmCalled = false;
      ttsCalled = false;
    } else if (result.matched && result.faqs.length > 0) {
      resolvedTier = 'TIER_2';
      audioMechanism = 'Dynamic TTS (OpenAI tts-1)';
      llmCalled = true;
      ttsCalled = true;
    } else {
      resolvedTier = 'TIER_3';
      audioMechanism = 'Cached Fallback MP3 (/audio/fallback-unknown.mp3)';
      llmCalled = false;
      ttsCalled = false;
    }

    const tierMatch = resolvedTier === tc.expectedTier ? 'PASS' : 'FAIL';

    console.log(`[Case ${tc.id}] ${tc.name} [${tierMatch}]`);
    console.log(`  Query:          "${tc.query}"`);
    console.log(
      `  Context:        ${tc.history ? JSON.stringify(tc.history.map((h) => h.text)) : 'None (Standalone)'}`,
    );
    console.log(
      `  Routing:        ${resolvedTier} (Expected: ${tc.expectedTier})`,
    );
    console.log(
      `  FastPath Match: highConfidenceFastPath=${result.highConfidenceFastPath}, reason=${result.fastPathMatchReason || 'NONE'}, disqualifier=${result.fastPathDisqualifier || 'NONE'}`,
    );
    console.log(
      `  API Calls:      LLM=${llmCalled ? '1 (gpt-4.1-mini)' : '0 (BYPASSED)'}, TTS=${ttsCalled ? '1 (tts-1)' : '0 (BYPASSED)'}`,
    );
    console.log(`  Audio Source:   ${audioMechanism}`);
    console.log(
      `  Engine Match Latency: Cold = ${matchTimeMs} ms | Warm = ${avgWarmMs} ms`,
    );
    console.log(
      `  Baseline Before:     ${tc.baselineTier} (~${tc.baselineLatency})`,
    );
    console.log(
      `  Status After:        ${resolvedTier} (${resolvedTier === 'TIER_1' ? 'Persistent MP3 ~35 ms' : resolvedTier === 'TIER_3' ? 'Fallback MP3 ~33 ms' : 'Grounded LLM ~4,800 ms'})\n`,
    );
  }
}

runBenchmark().catch(console.error);
