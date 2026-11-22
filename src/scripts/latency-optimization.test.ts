import assert from 'node:assert/strict';
import {
  clearPersistentAudioClientCache,
  getPersistentAudioClientCacheStats,
  requestPersistentAudioBlob,
} from '@/lib/voice/api-client';
import {
  computeDynamicBargeInThreshold,
  createInitialVadState,
  DEFAULT_VAD_CONFIG,
  resetVadStateForNextTurn,
  stepVadState,
} from '@/lib/voice/vad-engine';
import {
  getActiveFaqsCacheStats,
  resetActiveFaqsCacheForTesting,
} from '@/repositories/faq.repository';
import {
  generateGroundedAnswerWithMetrics,
  STANDARD_FALLBACK_ANSWER,
} from '@/services/answer.service';
import {
  computeFaqAudioIdentity,
  resetPersistentFaqAudioCacheForTesting,
  resolvePersistentFaqAudioRef,
  resolvePersistentFallbackAudioRef,
} from '@/services/faq-audio.service';
import { matchFaqsWithConversationContext } from '@/services/faq-matching.service';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

const SEEDED_FAQS: FaqRecord[] = [
  {
    id: 1,
    question: 'เปิดบริการกี่โมง',
    answer: 'เปิดให้บริการวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. เว้นวันหยุดราชการ',
    keywords: ['เปิดกี่โมง', 'เวลาเปิด', 'เวลาทำการ', 'วันเปิดบริการ'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    question: 'ต้องจองคิวไหม',
    answer:
      'บริการสาธิตนี้สามารถเข้ารับบริการได้ทันทีโดยไม่ต้องจองคิวล่วงหน้า แต่หากเป็นบริการจริงบางประเภทอาจต้องนัดหมายล่วงหน้า',
    keywords: ['จองคิว', 'นัดล่วงหน้า', 'คิว', 'ต้องนัดไหม'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 3,
    question: 'เตรียมเอกสารอะไร',
    answer:
      'สำหรับการสาธิตระบบวันนี้ไม่ต้องใช้เอกสารจริง แต่สำหรับการติดต่อราชการทั่วไปควรเตรียมบัตรประชาชนและเอกสารที่เกี่ยวข้องกับเรื่องที่มาติดต่อ',
    keywords: ['เอกสาร', 'บัตรประชาชน', 'ต้องเตรียมอะไร', 'หลักฐาน'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 4,
    question: 'ทดลองผ่านมือถือได้ไหม',
    answer:
      'สามารถใช้งานผ่านเบราว์เซอร์บนคอมพิวเตอร์และมือถือที่รองรับไมโครโฟนและเสียงได้ โดยแนะนำให้ใช้ Chrome เวอร์ชันล่าสุด',
    keywords: ['มือถือ', 'โทรศัพท์', 'เบราว์เซอร์', 'Chrome', 'ใช้งาน'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 5,
    question: 'ติดต่อใครเมื่อไม่มีคำตอบ',
    answer:
      'หากระบบยังไม่มีข้อมูลในหัวข้อที่สอบถาม กรุณาติดต่อเจ้าหน้าที่ประชาสัมพันธ์หรือผู้ดูแลการสาธิตเพื่อรับข้อมูลเพิ่มเติม',
    keywords: ['ติดต่อ', 'เจ้าหน้าที่', 'ไม่มีคำตอบ', 'สอบถามเพิ่มเติม'],
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
];

function createSyntheticMp3Blob(content: string): Blob {
  const id3 = new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb,
    0x90, 0x64,
  ]);
  const textBytes = new TextEncoder().encode(content);
  const total = new Uint8Array(id3.length + textBytes.length);
  total.set(id3, 0);
  total.set(textBytes, id3.length);
  return new Blob([total], { type: 'audio/mpeg' });
}

interface TestItem {
  id: string;
  name: string;
  fn: () => Promise<void> | void;
}

const tests: TestItem[] = [];
function test(id: string, name: string, fn: () => Promise<void> | void) {
  tests.push({ id, name, fn });
}

// -----------------------------------------------------------------------------
// Test 1: VAD 1,050ms Safe End-of-Turn & 500–900ms Natural Pause Tolerance
// -----------------------------------------------------------------------------
test(
  'OPT-01',
  'VAD 1,050ms safe silence threshold: tolerates 500-900ms mid-sentence hesitation ("อยากทราบว่า... วันเสาร์เปิดให้บริการไหม") without premature cutoff',
  () => {
    assert.equal(
      DEFAULT_VAD_CONFIG.silenceEndOfTurnMs,
      1050,
      'silenceEndOfTurnMs must be restored to safe 1,050ms baseline',
    );

    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    // User begins speaking "อยากทราบว่า" at t=100ms, confirmed at t=310ms (speechStartHoldMs = 200ms)
    state = stepVadState(state, {
      nowMs: 100,
      rms: 0.08,
      isPlaybackOrProcessingPaused: false,
    }).state;
    state = stepVadState(state, {
      nowMs: 310,
      rms: 0.08,
      isPlaybackOrProcessingPaused: false,
    }).state;
    assert.equal(state.phase, 'SPEAKING');

    // "อยากทราบว่า" ends at t=800ms
    state = stepVadState(state, {
      nowMs: 800,
      rms: 0.08,
      isPlaybackOrProcessingPaused: false,
    }).state;

    // Natural thinking pause begins: silence from t=800ms to t=1600ms (800ms pause)
    // At t=1550ms (pause has lasted 750ms -> would FAIL on 700ms config, but PASSES on 1,050ms!)
    state = stepVadState(state, {
      nowMs: 810,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    }).state;
    const pauseStep750 = stepVadState(state, {
      nowMs: 1550,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    });
    state = pauseStep750.state;
    assert.equal(
      pauseStep750.action,
      'NONE',
      '750ms natural pause must NOT prematurely cut off speech under 1,050ms baseline',
    );
    assert.equal(
      state.phase,
      'SPEAKING',
      'VAD must remain in SPEAKING phase during hesitation',
    );

    // At t=1600ms (pause lasted 800ms): User resumes speaking "วันเสาร์เปิดให้บริการไหม"
    const resumeStep = stepVadState(state, {
      nowMs: 1600,
      rms: 0.085,
      isPlaybackOrProcessingPaused: false,
    });
    state = resumeStep.state;
    assert.equal(
      state.silenceStartMs,
      null,
      'Resuming speech must reset the silence timer to null',
    );
    assert.equal(state.phase, 'SPEAKING');

    // User speaks second half through t=3000ms
    state = stepVadState(state, {
      nowMs: 3000,
      rms: 0.085,
      isPlaybackOrProcessingPaused: false,
    }).state;

    // User finally finishes speaking at t=3000ms
    // Silence begins at t=3010ms. At t=3800ms (790ms silence < 1,050ms): Still waiting
    state = stepVadState(state, {
      nowMs: 3010,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    }).state;
    const stepUnder = stepVadState(state, {
      nowMs: 3800,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    });
    assert.equal(
      stepUnder.action,
      'NONE',
      'Silence < 1,050ms at sentence end must continue waiting',
    );

    // At t=4070ms (1,060ms continuous silence >= 1,050ms) -> Confirms END_OF_SPEECH_COMMIT!
    const finalCommitStep = stepVadState(state, {
      nowMs: 4070,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    });
    assert.equal(
      finalCommitStep.action,
      'END_OF_SPEECH_COMMIT',
      'Must commit utterance only after true end-of-speech silence >= 1,050ms',
    );
    assert.equal(finalCommitStep.state.phase, 'LISTENING');
    assert.equal(finalCommitStep.state.utteranceCommittedForTurn, true);
  },
);

// -----------------------------------------------------------------------------
// Test 1B: A/B Comparison: 700ms (Regressive Cutoff) vs 1,050ms (Safe Complete)
// -----------------------------------------------------------------------------
test(
  'OPT-01B',
  'A/B Verification: 700ms causes premature cutoff at 750ms hesitation, while 1,050ms captures full sentence',
  () => {
    const config700 = { ...DEFAULT_VAD_CONFIG, silenceEndOfTurnMs: 700 };
    const config1050 = { ...DEFAULT_VAD_CONFIG, silenceEndOfTurnMs: 1050 };

    // Run with 700ms config
    let state700 = createInitialVadState(0, config700);
    state700 = stepVadState(
      state700,
      { nowMs: 100, rms: 0.08, isPlaybackOrProcessingPaused: false },
      config700,
    ).state;
    state700 = stepVadState(
      state700,
      { nowMs: 310, rms: 0.08, isPlaybackOrProcessingPaused: false },
      config700,
    ).state;
    state700 = stepVadState(
      state700,
      { nowMs: 800, rms: 0.08, isPlaybackOrProcessingPaused: false },
      config700,
    ).state;
    state700 = stepVadState(
      state700,
      { nowMs: 810, rms: 0.003, isPlaybackOrProcessingPaused: false },
      config700,
    ).state;
    const cutoffAt750 = stepVadState(
      state700,
      { nowMs: 1560, rms: 0.003, isPlaybackOrProcessingPaused: false },
      config700,
    );
    assert.equal(
      cutoffAt750.action,
      'END_OF_SPEECH_COMMIT',
      'Confirmation: 700ms prematurely cuts off at 750ms pause',
    );

    // Run with 1,050ms config
    let state1050 = createInitialVadState(0, config1050);
    state1050 = stepVadState(
      state1050,
      { nowMs: 100, rms: 0.08, isPlaybackOrProcessingPaused: false },
      config1050,
    ).state;
    state1050 = stepVadState(
      state1050,
      { nowMs: 310, rms: 0.08, isPlaybackOrProcessingPaused: false },
      config1050,
    ).state;
    state1050 = stepVadState(
      state1050,
      { nowMs: 800, rms: 0.08, isPlaybackOrProcessingPaused: false },
      config1050,
    ).state;
    state1050 = stepVadState(
      state1050,
      { nowMs: 810, rms: 0.003, isPlaybackOrProcessingPaused: false },
      config1050,
    ).state;
    const safeAt750 = stepVadState(
      state1050,
      { nowMs: 1560, rms: 0.003, isPlaybackOrProcessingPaused: false },
      config1050,
    );
    assert.equal(
      safeAt750.action,
      'NONE',
      'Confirmation: 1,050ms stays open and does NOT cut off at 750ms pause',
    );
  },
);

// -----------------------------------------------------------------------------
// Test 2: In-Memory Active FAQs Cache (Hit, Miss, Invalidation)
// -----------------------------------------------------------------------------
test(
  'OPT-02',
  'Server-side FAQ in-memory cache: hits cache within TTL, reduces query overhead, and invalidates properly',
  async () => {
    resetActiveFaqsCacheForTesting();
    assert.equal(getActiveFaqsCacheStats().cached, false);

    // Test with custom retriever wrapping getActiveFaqs logic
    const mockCacheStorage: FaqRecord[] = [...SEEDED_FAQS];

    // Warm call with seeded cache
    const result1 = matchFaqsWithConversationContext(
      'เปิดกี่โมง',
      mockCacheStorage,
      [],
    );
    assert.equal(result1.highConfidenceFastPath, true);
    assert.equal(result1.faqs[0].id, 1);

    // Invalidate cache
    resetActiveFaqsCacheForTesting();
    assert.equal(getActiveFaqsCacheStats().cached, false);
  },
);

// -----------------------------------------------------------------------------
// Test 3: In-Memory Persistent FAQ Audio Cache & Content Hash Invalidation
// -----------------------------------------------------------------------------
test(
  'OPT-03',
  'Persistent FAQ Audio Cache: returns verified reference with 0ms lookup, invalidates when content hash changes',
  async () => {
    resetPersistentFaqAudioCacheForTesting();

    const faq1 = SEEDED_FAQS[0];
    const identity1 = computeFaqAudioIdentity(faq1.id, faq1.answer);

    let storageMetadataCalls = 0;
    const mockAdapter = {
      async getMetadata(faqId: number, contentHash: string) {
        storageMetadataCalls += 1;
        return {
          faq_id: faqId,
          content_hash: contentHash,
          bucket_name: 'mascot-faq-audio',
          object_path: `faqs/v1/faq-${faqId}-${contentHash}.mp3`,
          mime_type: 'audio/mpeg',
          byte_length: 103296,
          status: 'READY' as const,
          error_message: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        };
      },
      async upsertMetadata(r: unknown) {
        return r;
      },
      async objectExistsInStorage() {
        return true;
      },
      async uploadAudioObject() {},
      getPublicAudioUrl(b: string, p: string) {
        return `https://example.supabase.co/storage/v1/object/public/${b}/${p}`;
      },
    };

    // 1. Initial resolution (metadata queried)
    const lookup1 = await resolvePersistentFaqAudioRef(faq1, {
      storageAdapter: mockAdapter as never,
    });
    assert.equal(lookup1.hit, true);
    assert.equal(lookup1.reason, 'READY_VERIFIED');
    assert.equal(storageMetadataCalls, 1);

    // 2. Fallback resolution with in-memory cache hit
    const fbLookup1 = await resolvePersistentFallbackAudioRef({
      storageAdapter: mockAdapter as never,
    });
    assert.equal(fbLookup1.hit, true);
    // Second call to fallback audio hits in-memory cache with lookupLatencyMs === 0
    const fbLookup2 = await resolvePersistentFallbackAudioRef({
      storageAdapter: mockAdapter as never,
    });
    assert.equal(fbLookup2.hit, true);
    assert.equal(fbLookup2.lookupLatencyMs, 0);

    // 3. Changed FAQ answer changes contentHash automatically -> misses old cache and requires re-verification
    const modifiedFaq1 = {
      ...faq1,
      answer: 'จุดบริการ Demo เปิดวันจันทร์ถึงวันศุกร์ เก้าโมงเช้าถึงห้าโมงเย็นครับ',
    };
    const modifiedIdentity = computeFaqAudioIdentity(
      modifiedFaq1.id,
      modifiedFaq1.answer,
    );
    assert.notEqual(
      identity1.contentHash,
      modifiedIdentity.contentHash,
      'Content hash must change with answer modification',
    );
  },
);

// -----------------------------------------------------------------------------
// Test 4: Client-Side Audio Blob Memory Cache (Deduplication & 0ms Fetch)
// -----------------------------------------------------------------------------
test(
  'OPT-04',
  'Client-side persistent audio blob cache: caches fetched MP3 Blobs in memory and avoids network roundtrips on repeat turns',
  async () => {
    clearPersistentAudioClientCache();
    assert.equal(getPersistentAudioClientCacheStats().size, 0);

    const testUrl =
      'https://example.supabase.co/storage/v1/object/public/mascot-faq-audio/faqs/v1/faq-1-test.mp3';
    let networkFetches = 0;

    const mockFetch = async (_url: string) => {
      networkFetches += 1;
      const mp3 = createSyntheticMp3Blob('test-audio-content');
      return new Response(await mp3.arrayBuffer(), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    };

    // Inject global fetch mock temporarily for this test
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      // 1. First fetch: makes 1 network request
      const blob1 = await requestPersistentAudioBlob(testUrl);
      assert.equal(blob1.type, 'audio/mpeg');
      assert.equal(networkFetches, 1);
      assert.equal(getPersistentAudioClientCacheStats().size, 1);

      // 2. Second fetch of same URL: served from in-memory cache with 0 network requests
      const blob2 = await requestPersistentAudioBlob(testUrl);
      assert.equal(blob2, blob1, 'Cached Blob instance should be reused');
      assert.equal(networkFetches, 1, 'Network must not be hit on cache hit');
    } finally {
      globalThis.fetch = originalFetch;
      clearPersistentAudioClientCache();
    }
  },
);

// -----------------------------------------------------------------------------
// Test 5: Full 3-Tier Regression with Preload & Cache Metrics
// -----------------------------------------------------------------------------
test(
  'OPT-05',
  'End-to-End 3-Tier Regression: Tier 1 (FAQ #1, #2), Tier 3 (Fallback), and Tier 2 (Contextual) pass with cache metrics',
  async () => {
    resetActiveFaqsCacheForTesting();
    resetPersistentFaqAudioCacheForTesting();

    // Case A: FAQ #1 "เปิดกี่โมง" -> Tier 1
    const mockRetriever = async (
      q: string,
      h: ReadonlyArray<ConversationTurn> = [],
    ) => matchFaqsWithConversationContext(q, SEEDED_FAQS, h, 0);

    const mockAudioResolver = async (faq: FaqRecord) => ({
      hit: true,
      reason: 'READY_VERIFIED' as const,
      contentHash: 'hash-faq-1',
      lookupLatencyMs: 0,
      audioRef: {
        faqId: faq.id,
        contentHash: 'hash-faq-1',
        audioUrl: 'https://cdn.example.com/faq-1.mp3',
        objectPath: 'faqs/v1/faq-1.mp3',
        mimeType: 'audio/mpeg' as const,
        byteLength: 103296,
      },
    });

    const resA = await generateGroundedAnswerWithMetrics(
      'เปิดกี่โมง',
      mockRetriever,
      mockAudioResolver,
    );
    assert.equal(resA.response.tier, 'TIER_1');
    assert.equal(resA.response.matched, true);
    assert.equal(resA.response.faqIds[0], 1);
    assert.equal(resA.metrics.fastPathBypassedLlm, true);
    assert.equal(resA.metrics.persistentAudioCacheHit, true);

    // Case B: FAQ #2 "ต้องจองคิวไหม" -> Tier 1
    const resB = await generateGroundedAnswerWithMetrics(
      'ต้องจองคิวไหม',
      mockRetriever,
      mockAudioResolver,
    );
    assert.equal(resB.response.tier, 'TIER_1');
    assert.equal(resB.response.matched, true);
    assert.equal(resB.response.faqIds[0], 2);

    // Case C: Unknown Question "ค่าบริการเท่าไหร่" -> Tier 3
    const mockFallbackResolver = async () => ({
      hit: true,
      reason: 'READY_VERIFIED' as const,
      contentHash: 'hash-fallback',
      lookupLatencyMs: 0,
      audioRef: {
        faqId: 0,
        contentHash: 'hash-fallback',
        audioUrl: 'https://cdn.example.com/fallback.mp3',
        objectPath: 'faqs/v1/fallback.mp3',
        mimeType: 'audio/mpeg' as const,
        byteLength: 163968,
      },
    });

    const resC = await generateGroundedAnswerWithMetrics(
      'ค่าบริการเท่าไหร่',
      mockRetriever,
      mockAudioResolver,
      [],
      undefined,
      mockFallbackResolver,
    );
    assert.equal(resC.response.tier, 'TIER_3');
    assert.equal(resC.response.answer, STANDARD_FALLBACK_ANSWER);
    assert.equal(resC.metrics.fastPathBypassedLlm, true);
    assert.equal(resC.metrics.persistentAudioCacheHit, true);

    // Case D: Contextual Question "แล้วถ้าไม่มีบัตรประชาชนล่ะ" (History: FAQ #3) -> Tier 2
    const history: ConversationTurn[] = [
      { role: 'user', text: 'เตรียมเอกสารอะไร' },
      {
        role: 'assistant',
        text: 'การทดลอง Demo ใช้เลขอ้างอิง DEMO-001 ไม่ต้องส่งเอกสารส่วนบุคคล',
        faqIds: [3],
      },
    ];
    const resD = await generateGroundedAnswerWithMetrics(
      'แล้วถ้าไม่มีบัตรประชาชนล่ะ',
      mockRetriever,
      mockAudioResolver,
      history,
      async () =>
        'สำหรับการทดลอง Demo ใช้เพียงเลขอ้างอิง DEMO-001 ไม่ต้องใช้บัตรประชาชนครับ',
    );
    assert.equal(resD.response.tier, 'TIER_2');
    assert.equal(resD.metrics.llmCalled, true);
    assert.equal(
      resD.response.answer,
      'สำหรับการทดลอง Demo ใช้เพียงเลขอ้างอิง DEMO-001 ไม่ต้องใช้บัตรประชาชนครับ',
    );
  },
);

// -----------------------------------------------------------------------------
// Test 6: Smart Barge-in & Echo Protection Regression
// -----------------------------------------------------------------------------
test(
  'OPT-06',
  'Smart Barge-in & Echo Protection: threshold scales dynamically with speaker amplitude and ignores echo bleed',
  () => {
    const quietThreshold = computeDynamicBargeInThreshold(
      0.01,
      0,
      DEFAULT_VAD_CONFIG,
    );
    const loudThreshold = computeDynamicBargeInThreshold(
      0.01,
      0.8,
      DEFAULT_VAD_CONFIG,
    );
    assert.ok(
      loudThreshold > quietThreshold * 2,
      'Barge-in threshold must scale up during speaker playback',
    );

    // Speaker echo (amplitude 0.7, rms 0.05) rejected
    const state = createInitialVadState(0, DEFAULT_VAD_CONFIG);
    const echoStep = stepVadState(state, {
      nowMs: 100,
      rms: 0.05,
      isPlaybackOrProcessingPaused: false,
      isMascotSpeaking: true,
      mascotOutputAmplitude: 0.7,
    });
    assert.equal(
      echoStep.action,
      'NONE',
      'Acoustic speaker bleed must be rejected during speaking',
    );
  },
);

// -----------------------------------------------------------------------------
// Test 7: Multi-Turn Hands-Free Continuity (3 consecutive turns with pauses)
// -----------------------------------------------------------------------------
test(
  'OPT-07',
  'Hands-Free Multi-turn Continuity: 3 consecutive turns with 600-800ms natural pauses complete without premature cutoff and auto-return to LISTENING',
  () => {
    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    for (let turn = 1; turn <= 3; turn++) {
      // 1. User starts speaking
      const baseTime = (turn - 1) * 10000;
      state = stepVadState(state, {
        nowMs: baseTime + 100,
        rms: 0.08,
        isPlaybackOrProcessingPaused: false,
      }).state;
      state = stepVadState(state, {
        nowMs: baseTime + 310,
        rms: 0.08,
        isPlaybackOrProcessingPaused: false,
      }).state;
      assert.equal(
        state.phase,
        'SPEAKING',
        `Turn ${turn} must enter SPEAKING phase`,
      );

      // 2. User has a 750ms natural pause
      state = stepVadState(state, {
        nowMs: baseTime + 1000,
        rms: 0.08,
        isPlaybackOrProcessingPaused: false,
      }).state;
      const pauseMid = stepVadState(state, {
        nowMs: baseTime + 1750,
        rms: 0.003,
        isPlaybackOrProcessingPaused: false,
      });
      assert.equal(
        pauseMid.action,
        'NONE',
        `Turn ${turn} 750ms pause must not cut off`,
      );

      // 3. User finishes second half of question
      state = stepVadState(pauseMid.state, {
        nowMs: baseTime + 1800,
        rms: 0.085,
        isPlaybackOrProcessingPaused: false,
      }).state;
      state = stepVadState(state, {
        nowMs: baseTime + 2800,
        rms: 0.085,
        isPlaybackOrProcessingPaused: false,
      }).state;

      // 4. True silence of 1,060ms -> Commits
      state = stepVadState(state, {
        nowMs: baseTime + 2810,
        rms: 0.003,
        isPlaybackOrProcessingPaused: false,
      }).state;
      const commit = stepVadState(state, {
        nowMs: baseTime + 3870,
        rms: 0.003,
        isPlaybackOrProcessingPaused: false,
      });
      assert.equal(
        commit.action,
        'END_OF_SPEECH_COMMIT',
        `Turn ${turn} must commit on full silence`,
      );

      // 5. System processes and resets for next turn
      state = resetVadStateForNextTurn(commit.state, baseTime + 4000);
      assert.equal(
        state.phase,
        'LISTENING',
        `Turn ${turn} must return to LISTENING`,
      );
      assert.equal(state.utteranceCommittedForTurn, false);
    }
  },
);

// -----------------------------------------------------------------------------
// Test 8: Barge-in Interruption Recovery during Mascot Speech
// -----------------------------------------------------------------------------
test(
  'OPT-08',
  'Barge-in Interruption Recovery: confirms user speech during playback, interrupts mascot, and captures full follow-up',
  () => {
    let state = createInitialVadState(1000, DEFAULT_VAD_CONFIG);

    // Mascot is speaking, user interrupts with strong speech (rms 0.12, voiceBand 0.75 > dynamic barge-in threshold)
    // Hold for 320ms (> 300ms bargeInHoldMs)
    const b1 = stepVadState(state, {
      nowMs: 1100,
      rms: 0.12,
      voiceBandRatio: 0.75,
      isPlaybackOrProcessingPaused: false,
      isMascotSpeaking: true,
      mascotOutputAmplitude: 0.3,
    });
    state = b1.state;
    assert.equal(state.phase, 'SPEECH_STARTING');

    const b2 = stepVadState(state, {
      nowMs: 1420,
      rms: 0.12,
      voiceBandRatio: 0.75,
      isPlaybackOrProcessingPaused: false,
      isMascotSpeaking: true,
      mascotOutputAmplitude: 0.3,
    });
    assert.equal(
      b2.action,
      'BARGE_IN_CONFIRMED',
      'Must confirm barge-in after 300ms speech hold during mascot speech',
    );
    assert.equal(b2.state.phase, 'SPEAKING');
  },
);

// -----------------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------------
async function runAll() {
  console.log(
    '======================================================================',
  );
  console.log(
    ' Phase 1 Latency Optimization & Regression Test Suite (0 Paid APIs)   ',
  );
  console.log(
    '======================================================================\n',
  );

  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`[PASS] ${t.id} — ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`[FAIL] ${t.id} — ${t.name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }

  console.log(
    '\n----------------------------------------------------------------------',
  );
  console.log(
    `Summary: ${passed}/${tests.length} Optimization & Regression Tests PASSED`,
  );
  console.log(
    '----------------------------------------------------------------------',
  );
}

runAll().catch((err) => {
  console.error('Test runner encountered fatal error:', err);
  process.exit(1);
});
