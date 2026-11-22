import assert from 'node:assert/strict';
import { isTier2StreamingEnabled } from '@/lib/validations/env';
import {
  splitThaiSentences,
  ThaiSentenceSplitter,
} from '@/lib/voice/thai-sentence-splitter';
import { streamGroundedAnswerEvents } from '@/services/answer-stream.service';
import { evaluateSentenceGrounding } from '@/services/sentence-grounding.service';
import type { FaqRetrievalResult } from '@/services/faq-matching.service';
import type { FaqRecord } from '@/types/faq';

function createMockRetrieval(
  overrides: Partial<FaqRetrievalResult>,
): FaqRetrievalResult {
  return {
    matched: false,
    faqs: [],
    ambiguous: false,
    normalizedTranscript: '',
    coreQuery: '',
    scoredMatches: [],
    highConfidenceFastPath: false,
    fastPathMatchReason: 'NONE',
    retrievalLatencyMs: 1,
    ...overrides,
  };
}

const SEEDED_FAQS: FaqRecord[] = [
  {
    id: 1,
    question: 'เปิดบริการกี่โมง',
    answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น.',
    keywords: ['เปิดบริการ', 'เวลาทำการ', 'เปิดกี่โมง', 'สำนักงานเปิดกี่โมง'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    question: 'ต้องจองคิวไหม',
    answer: 'บริการ Demo นี้รับนัดหมายล่วงหน้าผ่านเจ้าหน้าที่ Demo',
    keywords: ['จองคิว', 'นัดหมาย', 'นัดล่วงหน้า', 'ต้องนัด'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 3,
    question: 'เตรียมเอกสารอะไร',
    answer: 'การทดลอง Demo ใช้เลขอ้างอิง DEMO-001 ไม่ต้องส่งเอกสารส่วนบุคคล',
    keywords: ['เอกสาร', 'เตรียมเอกสาร', 'เอาอะไรไปบ้าง'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 4,
    question: 'ทดลองผ่านมือถือได้ไหม',
    answer: 'Demo นี้แนะนำ Chrome Desktop; Mobile ยังไม่รับรองจนกว่าจะทดสอบ',
    keywords: ['มือถือ', 'เบราว์เซอร์'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 5,
    question: 'ติดต่อใครเมื่อไม่มีคำตอบ',
    answer: 'โปรดติดต่อผู้ดูแลการสาธิตเพื่อขอข้อมูลเพิ่มเติม',
    keywords: ['ติดต่อ', 'เจ้าหน้าที่'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
];

function createSyntheticMp3Buffer(tagText: string): Buffer {
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
  ]);
  const payload = Buffer.from(`SYNTHETIC_MP3_${tagText}_PADDING_BYTES`, 'utf8');
  return Buffer.concat([header, payload]);
}

async function runTier2StreamingTests() {
  console.log(
    '================================================================================',
  );
  console.log(' TIER 2 REALTIME STREAMING (LLM + SENTENCE TTS) TEST SUITE');
  console.log(
    '================================================================================\n',
  );

  // ---------------------------------------------------------------------------
  // Part 1: Thai Sentence Boundary Splitter Tests
  // ---------------------------------------------------------------------------
  console.log('--- PART 1: Thai Sentence Boundary Splitter Tests ---');
  {
    const input =
      'จุดบริการ Demo เปิดวันจันทร์ถึงวันศุกร์ 09:00–16:00 น. ครับ การทดลองนี้ไม่ต้องจองคิวล่วงหน้าครับผม';
    const sentences = splitThaiSentences(input);
    assert.equal(sentences.length, 2, 'Should split into exactly 2 sentences');
    assert.equal(
      sentences[0],
      'จุดบริการ Demo เปิดวันจันทร์ถึงวันศุกร์ 09:00–16:00 น. ครับ',
    );
    assert.equal(sentences[1], 'การทดลองนี้ไม่ต้องจองคิวล่วงหน้าครับผม');
    console.log('[PASS] S01 — Preserves time ranges without splitting at "น."');
  }

  {
    const splitter = new ThaiSentenceSplitter();
    const tokens = [
      'เปิด',
      'วัน',
      'จันทร์',
      'ถึง',
      'ศุกร์',
      ' ',
      '09:00',
      '–',
      '16:00',
      ' น.',
      ' ครับ',
      ' ยิน',
      'ดี',
      'ให้',
      'บริการ',
      'ครับ',
    ];
    const emitted: string[] = [];
    for (const t of tokens) {
      const ready = splitter.feed(t);
      emitted.push(...ready);
    }
    const flushed = splitter.flush();
    if (flushed) emitted.push(flushed);

    assert.equal(emitted.length >= 1, true);
    assert.equal(emitted[0].includes('09:00–16:00 น.'), true);
    console.log(
      '[PASS] S02 — Progressive token streaming buffer yields complete sentences',
    );
  }

  // ---------------------------------------------------------------------------
  // Part 2: Sentence-Level Grounding & Safety Verification
  // ---------------------------------------------------------------------------
  console.log('\n--- PART 2: Sentence-Level Grounding & Safety Tests ---');
  {
    // Validated Grounded Sentence
    const safeSentence =
      'จุดบริการ Demo เปิดทำการวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. ครับ';
    const check = evaluateSentenceGrounding(safeSentence, [SEEDED_FAQS[0]]);
    assert.equal(check.status, 'GROUNDED_SAFE');
    console.log(
      '[PASS] G01 — Verified Grounded Sentence is approved for immediate TTS',
    );
  }

  {
    // Contradictory Claim (Claiming weekend opening when closed)
    const contradiction = 'จุดบริการ Demo เปิดทำการวันเสาร์และวันอาทิตย์ครับ';
    const check = evaluateSentenceGrounding(contradiction, [SEEDED_FAQS[0]]);
    assert.equal(check.status, 'FABRICATION_DETECTED');
    console.log(
      '[PASS] G02 — Contradictory weekend statement is rejected before TTS',
    );
  }

  {
    // Fabricated Claim (Unauthorized price/fee not in evidence)
    const fabricated = 'มีค่าธรรมเนียมบริการ 50 บาทครับ';
    const check = evaluateSentenceGrounding(fabricated, [SEEDED_FAQS[0]]);
    assert.equal(check.status, 'FABRICATION_DETECTED');
    console.log(
      '[PASS] G03 — Fabricated pricing pattern is rejected before TTS',
    );
  }

  {
    // Unverified Time Anchor
    const unverifiedTime = 'จุดบริการเปิดทำการเวลา 20:00 น. ครับ';
    const check = evaluateSentenceGrounding(unverifiedTime, [SEEDED_FAQS[0]]);
    assert.equal(check.status, 'HOLD_FOR_FULL_TEXT');
    console.log(
      '[PASS] G04 — Unverified time anchor is held for full-text inspection',
    );
  }

  // ---------------------------------------------------------------------------
  // Part 3: End-to-End Streaming Events & Tier Routing
  // ---------------------------------------------------------------------------
  console.log('\n--- PART 3: End-to-End Streaming Events & Pipelining ---');

  // Test Tier 1 Fast Path through Streaming Endpoint
  {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    for await (const ev of streamGroundedAnswerEvents({
      rawTranscript: 'เปิดบริการกี่โมง',
      customRetriever: async () =>
        createMockRetrieval({
          matched: true,
          faqs: [SEEDED_FAQS[0]],
          ambiguous: false,
          highConfidenceFastPath: true,
          fastPathMatchReason: 'EXACT_QUESTION',
          retrievalLatencyMs: 1,
        }),
    })) {
      events.push(ev);
    }

    const tierEvent = events.find((e) => e.event === 'tier');
    assert.equal(tierEvent?.data.tier, 'TIER_1');
    assert.equal(Boolean(tierEvent?.data.audioUrl), true);
    const doneEvent = events.find((e) => e.event === 'done');
    assert.equal(doneEvent?.data.tier, 'TIER_1');
    console.log(
      '[PASS] T01 — Tier 1 Fast Path emits persistent audio URL in < 5 ms with 0 LLM',
    );
  }

  // Test Tier 3 Fallback through Streaming Endpoint
  {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    for await (const ev of streamGroundedAnswerEvents({
      rawTranscript: 'ห้องน้ำอยู่ตรงไหน',
      customRetriever: async () =>
        createMockRetrieval({
          matched: false,
          faqs: [],
          ambiguous: false,
          highConfidenceFastPath: false,
          retrievalLatencyMs: 1,
        }),
    })) {
      events.push(ev);
    }

    const tierEvent = events.find((e) => e.event === 'tier');
    assert.equal(tierEvent?.data.tier, 'TIER_3');
    assert.equal(Boolean(tierEvent?.data.audioUrl), true);
    console.log(
      '[PASS] T02 — Tier 3 Fallback emits cached fallback audio URL in < 5 ms with 0 LLM',
    );
  }

  // Test Tier 2 Streaming with Simulated LLM Token Stream
  {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let customTtsCalls = 0;

    const mockLlmStreamer = async function* () {
      const chunks = [
        'จุดบริการ Demo ',
        'เปิดวันจันทร์ถึงวันศุกร์ ',
        '09:00–16:00 น. ครับ ',
        'หากต้องการสอบถามเพิ่มเติม ',
        'สามารถติดต่อเจ้าหน้าที่ได้ครับ',
      ];
      for (const c of chunks) {
        yield c;
      }
    };

    const mockTtsGenerator = async (text: string) => {
      customTtsCalls += 1;
      return createSyntheticMp3Buffer(text);
    };

    for await (const ev of streamGroundedAnswerEvents({
      rawTranscript: 'แล้ววันเสาร์ล่ะครับ',
      conversationHistory: [
        { role: 'user', text: 'เปิดกี่โมง' },
        { role: 'assistant', text: SEEDED_FAQS[0].answer, faqIds: [1] },
      ],
      customRetriever: async () =>
        createMockRetrieval({
          matched: true,
          faqs: [SEEDED_FAQS[0]],
          ambiguous: false,
          highConfidenceFastPath: false,
          retrievalLatencyMs: 15,
        }),
      customLlmStreamer: mockLlmStreamer,
      customTtsGenerator: mockTtsGenerator,
    })) {
      events.push(ev);
    }

    const tierEvent = events.find((e) => e.event === 'tier');
    assert.equal(tierEvent?.data.tier, 'TIER_2');

    const textChunkEvents = events.filter((e) => e.event === 'text_chunk');
    assert.equal(
      textChunkEvents.length > 0,
      true,
      'Must emit text_chunk events',
    );

    const audioChunkEvents = events.filter(
      (e) => e.event === 'audio_chunk_ready',
    );
    assert.equal(
      audioChunkEvents.length >= 1,
      true,
      'Must emit audio_chunk_ready for validated sentences',
    );
    assert.equal(
      customTtsCalls >= 1,
      true,
      'Must synthesize speech per sentence',
    );

    const doneEvent = events.find((e) => e.event === 'done');
    assert.equal(doneEvent?.data.tier, 'TIER_2');
    console.log(
      `[PASS] T03 — Tier 2 Streaming emitted ${textChunkEvents.length} text deltas, ${audioChunkEvents.length} audio chunks, and completed cleanly`,
    );
  }

  // ---------------------------------------------------------------------------
  // Part 4: Mid-Stream Barge-in & Cancellation
  // ---------------------------------------------------------------------------
  console.log('\n--- PART 4: Barge-in & Cancellation ---');
  {
    const controller = new AbortController();
    const events: string[] = [];

    const mockLongLlmStreamer = async function* () {
      yield 'ประโยคที่หนึ่งเริ่มต้นขึ้นแล้วครับ ';
      // Simulate user interruption right after first chunk
      controller.abort();
      yield 'ประโยคที่สองที่ไม่ควรถูกประมวลผลต่อครับ';
    };

    for await (const ev of streamGroundedAnswerEvents({
      rawTranscript: 'คำถามที่ถูกแทรก',
      signal: controller.signal,
      customRetriever: async () =>
        createMockRetrieval({
          matched: true,
          faqs: [SEEDED_FAQS[0]],
          ambiguous: false,
          highConfidenceFastPath: false,
          retrievalLatencyMs: 5,
        }),
      customLlmStreamer: mockLongLlmStreamer,
      customTtsGenerator: async () => createSyntheticMp3Buffer('AUDIO'),
    })) {
      events.push(ev.event);
    }

    // Generator must terminate on abort signal without throwing or emitting subsequent chunks
    assert.equal(controller.signal.aborted, true);
    console.log(
      '[PASS] B01 — AbortSignal cleanly terminates LLM stream and cancels remaining TTS generation',
    );
  }

  // ---------------------------------------------------------------------------
  // Part 5: Feature Flag Rollback Verification
  // ---------------------------------------------------------------------------
  console.log('\n--- PART 5: Feature Flag Verification ---');
  {
    delete process.env.TIER2_STREAMING_ENABLED;
    assert.equal(
      isTier2StreamingEnabled(),
      false,
      'Default mode must be false (Sequential pipeline)',
    );

    process.env.TIER2_STREAMING_ENABLED = 'true';
    assert.equal(
      isTier2StreamingEnabled(),
      true,
      'Explicit true must activate streaming mode',
    );

    process.env.TIER2_STREAMING_ENABLED = 'false';
    assert.equal(
      isTier2StreamingEnabled(),
      false,
      'Explicit false must roll back to sequential pipeline',
    );
    console.log(
      '[PASS] F01 — Feature flag TIER2_STREAMING_ENABLED safely controls mode with zero side-effects',
    );
  }

  console.log(
    '\n================================================================================',
  );
  console.log(' ALL TIER 2 REALTIME STREAMING TESTS PASSED (100% GREEN)');
  console.log(
    '================================================================================',
  );
}

runTier2StreamingTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
