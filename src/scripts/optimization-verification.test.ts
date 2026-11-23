import assert from 'node:assert/strict';
import { computeMouthFrameFromSamples } from '@/hooks/use-audio-lipsync';
import {
  ClientVoiceError,
  executeSmartPipelineStages,
  type RetrySessionSnapshot,
} from '@/lib/voice/api-client';
import { normalizeThaiSpeech } from '@/lib/voice/thai-speech-normalizer';
import {
  formatCanonicalFaqAnswer,
  generateGroundedAnswerWithMetrics,
} from '@/services/answer.service';
import { matchFaqsAgainstRecords } from '@/services/faq-matching.service';
import {
  buildTtsCacheKey,
  clearTtsAudioCache,
  getTtsCacheStats,
  MAX_TTS_CACHE_ENTRIES,
  synthesizeSpeechMp3WithMetrics,
} from '@/services/speech.service';
import { detectAudioFormatFromSignature } from '@/services/transcription.service';
import type { AnswerResponse } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

const SEEDED_DEMO_FAQS: FaqRecord[] = [
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
  // Valid ID3 header: 0x49 ('I'), 0x44 ('D'), 0x33 ('3') + payload >= 12 bytes
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
  ]);
  const payload = Buffer.from(`SYNTHETIC_MP3_${tagText}_PADDING_BYTES`, 'utf8');
  return Buffer.concat([header, payload]);
}

async function runTests(): Promise<void> {
  console.log(
    '======================================================================',
  );
  console.log(
    ' Latency & Cost Optimization Verification Suite (Zero Paid API Calls) ',
  );
  console.log(
    '======================================================================\n',
  );

  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    total += 1;
    await fn();
    passed += 1;
    console.log(`[PASS] T${String(total).padStart(2, '0')} — ${name}`);
  }

  // -------------------------------------------------------------------------
  // 1. Exact FAQ Fast Path Tests
  // -------------------------------------------------------------------------
  await test('Exact FAQ questions qualify for Safe High-Confidence Fast Path (EXACT_QUESTION)', () => {
    for (const faq of SEEDED_DEMO_FAQS) {
      const res = matchFaqsAgainstRecords(faq.question, SEEDED_DEMO_FAQS);
      assert.equal(res.matched, true);
      assert.equal(res.ambiguous, false);
      assert.equal(res.faqs.length, 1);
      assert.equal(res.faqs[0].id, faq.id);
      assert.equal(
        res.highConfidenceFastPath,
        true,
        `Expected highConfidenceFastPath=true for exact question "${faq.question}", got disqualifier=${res.fastPathDisqualifier}`,
      );
      assert.equal(res.fastPathMatchReason, 'EXACT_QUESTION');

      const canonical = formatCanonicalFaqAnswer(faq.answer);
      assert.equal(canonical.endsWith('ครับ'), true);
      assert.equal(canonical.includes(faq.answer), true);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Approved Alias Fast Path Tests
  // -------------------------------------------------------------------------
  await test('Approved intent aliases qualify for Safe Fast Path without calling LLM', () => {
    const approvedCases: Array<{ query: string; expectedFaqId: number }> = [
      { query: 'สำนักงานเปิดกี่โมงครับ', expectedFaqId: 1 },
      { query: 'ขอทราบเวลาทำการหน่อยนะคะ', expectedFaqId: 1 },
      { query: 'ต้องนัดล่วงหน้าหรือเปล่าครับ', expectedFaqId: 2 },
      { query: 'ต้องจองคิวล่วงหน้าไหมคะ', expectedFaqId: 2 },
      { query: 'ถ้าจะไปใช้บริการต้องเอาอะไรไปบ้างครับ', expectedFaqId: 3 },
      { query: 'ต้องเตรียมเอกสารอะไรบ้างครับ', expectedFaqId: 3 },
      { query: 'ใช้มือถือได้ไหมครับ', expectedFaqId: 4 },
      { query: 'สอบถามเพิ่มเติมได้ที่ไหนครับ', expectedFaqId: 5 },
    ];

    for (const tc of approvedCases) {
      const res = matchFaqsAgainstRecords(tc.query, SEEDED_DEMO_FAQS);
      assert.equal(res.matched, true, `Expected match for "${tc.query}"`);
      assert.equal(res.faqs[0]?.id, tc.expectedFaqId);
      assert.equal(
        res.highConfidenceFastPath,
        true,
        `Expected highConfidenceFastPath=true for "${tc.query}", got disqualifier=${res.fastPathDisqualifier}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // 3. False Positive Prevention Tests (Weak Keyword / Out-of-Scope / Negation)
  // -------------------------------------------------------------------------
  await test('False-positive trap queries with single keywords or out-of-scope topics MUST NOT bypass LLM', () => {
    const falsePositiveTraps: Array<{
      query: string;
      expectedDisqualifier: string;
    }> = [
      {
        query: 'ลืมมือถือไว้ที่เคาน์เตอร์ทำยังไงครับ',
        expectedDisqualifier: 'OUT_OF_SCOPE_SIGNAL',
      },
      {
        query: 'ชาร์จแบตมือถือได้ที่ไหนครับ',
        expectedDisqualifier: 'OUT_OF_SCOPE_SIGNAL',
      },
      {
        query: 'ติดต่อเจ้าหน้าที่เรื่องที่จอดรถได้ที่ไหนครับ',
        expectedDisqualifier: 'OUT_OF_SCOPE_SIGNAL',
      },
      {
        query: 'เจ้าหน้าที่คนไหนรับผิดชอบเรื่องนี้ครับ',
        expectedDisqualifier: 'OUT_OF_SCOPE_SIGNAL',
      },
      {
        query: 'ส่งเอกสารทางไปรษณีย์ได้ไหมครับ',
        expectedDisqualifier: 'OUT_OF_SCOPE_SIGNAL',
      },
      {
        query: 'เปิดในมือถือไม่ได้ ระบบล่มหรือเปล่าครับ',
        expectedDisqualifier: 'NEGATION_OR_CONDITION_SIGNAL',
      },
      {
        query: 'ถ้าไม่มีเอกสารต้องทำยังไงครับ',
        expectedDisqualifier: 'NEGATION_OR_CONDITION_SIGNAL',
      },
      {
        query: 'เปิดบริการช่วงพักเที่ยงไหมครับ',
        expectedDisqualifier: 'REVERSE_OR_SPECIFIC_TIME_ANGLE',
      },
      {
        query: 'เปิดทำการช่วงพักกลางวันไหมครับ',
        expectedDisqualifier: 'REVERSE_OR_SPECIFIC_TIME_ANGLE',
      },
      {
        query: 'อยากติดต่อเจ้าหน้าที่ครับ',
        expectedDisqualifier: 'WEAK_KEYWORD_ONLY',
      },
    ];

    for (const tc of falsePositiveTraps) {
      const res = matchFaqsAgainstRecords(tc.query, SEEDED_DEMO_FAQS);
      assert.equal(
        res.highConfidenceFastPath,
        false,
        `Expected highConfidenceFastPath=false for trap query "${tc.query}"`,
      );
      assert.equal(
        res.fastPathDisqualifier,
        tc.expectedDisqualifier,
        `Unexpected disqualifier for "${tc.query}"`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // 4. Ambiguous & Multi-Intent Question Tests
  // -------------------------------------------------------------------------
  await test('Ambiguous or multi-intent questions spanning multiple FAQs fall back to LLM', () => {
    const multiFaqQuery = 'เปิดบริการกี่โมงและต้องเตรียมเอกสารอะไรบ้างครับ';
    const res1 = matchFaqsAgainstRecords(multiFaqQuery, SEEDED_DEMO_FAQS);
    assert.equal(res1.matched, true);
    assert.equal(res1.faqs.length > 1, true);
    assert.equal(res1.highConfidenceFastPath, false);
    assert.equal(
      res1.fastPathDisqualifier === 'AMBIGUOUS_SCORE' ||
        res1.fastPathDisqualifier === 'MULTIPLE_MATCHED_FAQS',
      true,
    );

    const multiFaqDifferentWeightQuery = 'สำนักงานเปิดบริการกี่โมงและรองรับมือถือ';
    const res2 = matchFaqsAgainstRecords(
      multiFaqDifferentWeightQuery,
      SEEDED_DEMO_FAQS,
    );
    assert.equal(res2.matched, true);
    assert.equal(res2.highConfidenceFastPath, false);
    assert.equal(res2.fastPathDisqualifier, 'MULTIPLE_MATCHED_FAQS');

    const tieQuery = 'จองคิวมือถือ';
    const res3 = matchFaqsAgainstRecords(tieQuery, SEEDED_DEMO_FAQS);
    assert.equal(res3.matched, true);
    assert.equal(res3.ambiguous, true);
    assert.equal(res3.faqs.length, 2);
    assert.equal(res3.highConfidenceFastPath, false);
    assert.equal(res3.fastPathDisqualifier, 'AMBIGUOUS_SCORE');
  });

  // -------------------------------------------------------------------------
  // 5. Out-of-Scope Unmatched Question Tests
  // -------------------------------------------------------------------------
  await test('Completely out-of-scope questions return matched=false and NO_MATCH', () => {
    const outOfScopeQueries = [
      'ค่าเช่าห้องเท่าไรครับ',
      'ห้องน้ำอยู่ชั้นไหนครับ',
      'ที่สูบบุหรี่อยู่ตรงไหน',
      'วันนี้อากาศเป็นยังไง',
      'อะไร',
    ];

    for (const q of outOfScopeQueries) {
      const res = matchFaqsAgainstRecords(q, SEEDED_DEMO_FAQS);
      assert.equal(res.matched, false, `Expected matched=false for "${q}"`);
      assert.equal(res.faqs.length, 0);
      assert.equal(res.highConfidenceFastPath, false);
      assert.equal(res.fastPathDisqualifier, 'NO_MATCH');
    }
  });

  // -------------------------------------------------------------------------
  // 6. Content-Addressed TTS Cache Hit/Miss & Answer Update Invalidation
  // -------------------------------------------------------------------------
  await test('TTS Cache serves HIT without calling OpenAI TTS and automatically invalidates when FAQ answer text changes', async () => {
    clearTtsAudioCache();
    let generatorCallCount = 0;

    const mockGenerator = async (normalizedInput: string): Promise<Buffer> => {
      generatorCallCount += 1;
      return createSyntheticMp3Buffer(normalizedInput);
    };

    const originalFaqAnswer = formatCanonicalFaqAnswer(
      SEEDED_DEMO_FAQS[0].answer,
    );

    // First call -> Cache MISS (calls generator once)
    const firstRes = await synthesizeSpeechMp3WithMetrics(
      originalFaqAnswer,
      mockGenerator,
    );
    assert.equal(firstRes.cacheStatus, 'MISS');
    assert.equal(firstRes.openAiTtsCalled, true);
    assert.equal(generatorCallCount, 1);

    // Second call with identical answer -> Cache HIT (0 new generator calls)
    const secondRes = await synthesizeSpeechMp3WithMetrics(
      originalFaqAnswer,
      mockGenerator,
    );
    assert.equal(secondRes.cacheStatus, 'HIT');
    assert.equal(secondRes.openAiTtsCalled, false);
    assert.equal(generatorCallCount, 1);
    assert.deepEqual(secondRes.buffer, firstRes.buffer);

    // When FAQ answer text changes in Supabase -> New content-addressed key -> Cache MISS (never plays stale audio)
    const updatedFaqAnswer = formatCanonicalFaqAnswer(
      'จุดบริการ Demo เปลี่ยนเวลาเป็น 10:30–17:30 น.',
    );
    const updatedRes = await synthesizeSpeechMp3WithMetrics(
      updatedFaqAnswer,
      mockGenerator,
    );
    assert.equal(updatedRes.cacheStatus, 'MISS');
    assert.equal(updatedRes.openAiTtsCalled, true);
    assert.equal(generatorCallCount, 2);
    assert.notEqual(updatedRes.cacheKey, firstRes.cacheKey);
    assert.notDeepEqual(updatedRes.buffer, firstRes.buffer);

    // Key binding check: changing voice or model or normalized text changes hash
    const k1 = buildTtsCacheKey(
      normalizeThaiSpeech(originalFaqAnswer),
      'gpt-4o-mini-tts',
      'coral',
    );
    const k2 = buildTtsCacheKey(
      normalizeThaiSpeech(originalFaqAnswer),
      'gpt-4o-mini-tts',
      'alloy',
    );
    assert.notEqual(k1, k2);
  });

  // -------------------------------------------------------------------------
  // 7. Concurrent Cache Miss Deduplication (Single-Flight) & Bounded Eviction
  // -------------------------------------------------------------------------
  await test('Concurrent TTS Cache Misses for identical answer coalesce into a single OpenAI TTS call and respect LRU bounds', async () => {
    clearTtsAudioCache();
    let generatorCallCount = 0;

    const slowMockGenerator = async (
      normalizedInput: string,
    ): Promise<Buffer> => {
      generatorCallCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 35));
      return createSyntheticMp3Buffer(normalizedInput);
    };

    const text = formatCanonicalFaqAnswer(SEEDED_DEMO_FAQS[1].answer);

    // Fire 5 concurrent requests before the first completes
    const concurrentResults = await Promise.all([
      synthesizeSpeechMp3WithMetrics(text, slowMockGenerator),
      synthesizeSpeechMp3WithMetrics(text, slowMockGenerator),
      synthesizeSpeechMp3WithMetrics(text, slowMockGenerator),
      synthesizeSpeechMp3WithMetrics(text, slowMockGenerator),
      synthesizeSpeechMp3WithMetrics(text, slowMockGenerator),
    ]);

    assert.equal(
      generatorCallCount,
      1,
      'Expected exactly 1 underlying TTS call for 5 concurrent identical requests',
    );
    const missCount = concurrentResults.filter(
      (r) => r.cacheStatus === 'MISS',
    ).length;
    const coalescedCount = concurrentResults.filter(
      (r) => r.cacheStatus === 'COALESCED',
    ).length;
    assert.equal(missCount, 1);
    assert.equal(coalescedCount, 4);

    // Bounded LRU Eviction check
    for (let i = 0; i < MAX_TTS_CACHE_ENTRIES + 6; i++) {
      await synthesizeSpeechMp3WithMetrics(
        `ข้อความทดสอบแคชลำดับที่ ${i}`,
        async (norm) => createSyntheticMp3Buffer(norm),
      );
    }
    const stats = getTtsCacheStats();
    assert.equal(stats.entryCount <= MAX_TTS_CACHE_ENTRIES, true);
    assert.equal(stats.evictions >= 6, true);
  });

  // -------------------------------------------------------------------------
  // 8. Smart Retry Checkpointing Tests (Skip STT & Skip Answer on Retry)
  // -------------------------------------------------------------------------
  await test('Smart Retry reuses succeeded transcript and answer without re-calling STT or Answer APIs', async () => {
    const fakeRecording = {
      blob: new Blob(
        [new Uint8Array(createSyntheticMp3Buffer('user_speech'))],
        {
          type: 'audio/webm',
        },
      ),
      mimeType: 'audio/webm',
      durationSeconds: 3,
    };

    let sttCallCount = 0;
    let answerCallCount = 0;
    let ttsCallCount = 0;
    let failTtsOnce = true;

    const mockStt = async () => {
      sttCallCount += 1;
      return { transcript: 'สำนักงานเปิดกี่โมงครับ' };
    };

    const mockAnswer = async (): Promise<AnswerResponse> => {
      answerCallCount += 1;
      return {
        answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ',
        faqIds: [1],
        matched: true,
        answerMode: 'FAQ_GROUNDED',
      };
    };

    const mockTts = async () => {
      ttsCallCount += 1;
      if (failTtsOnce) {
        failTtsOnce = false;
        throw new ClientVoiceError(
          'UPSTREAM_TIMEOUT',
          504,
          'Simulated TTS Timeout',
        );
      }
      return new Blob([new Uint8Array(createSyntheticMp3Buffer('tts_audio'))], {
        type: 'audio/mpeg',
      });
    };

    const session: RetrySessionSnapshot = {
      recording: fakeRecording,
      transcript: null,
      answerResult: null,
      ttsBlob: null,
    };

    const controller1 = new AbortController();

    // Turn 1: STT succeeds, Answer succeeds, TTS fails
    await assert.rejects(
      () =>
        executeSmartPipelineStages({
          recordingPayload: fakeRecording,
          existingSession: session,
          isRetry: false,
          isStaleTurn: () => false,
          signal: controller1.signal,
          onStateChange: () => {},
          onTranscriptReady: () => {},
          onAnswerReady: () => {},
          sttFn: mockStt,
          answerFn: mockAnswer,
          ttsFn: mockTts,
        }),
      (err: unknown) =>
        err instanceof ClientVoiceError && err.code === 'UPSTREAM_TIMEOUT',
    );

    assert.equal(sttCallCount, 1);
    assert.equal(answerCallCount, 1);
    assert.equal(ttsCallCount, 1);
    assert.equal(session.transcript, 'สำนักงานเปิดกี่โมงครับ');
    assert.equal(Boolean(session.answerResult), true);

    // Turn 2 (Retry): Must skip STT (0 new calls) and skip Answer (0 new calls), calling only TTS
    const controller2 = new AbortController();
    const retryResult = await executeSmartPipelineStages({
      recordingPayload: fakeRecording,
      existingSession: session,
      isRetry: true,
      isStaleTurn: () => false,
      signal: controller2.signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: mockStt,
      answerFn: mockAnswer,
      ttsFn: mockTts,
    });

    assert.notEqual(retryResult, null);
    assert.equal(sttCallCount, 1, 'STT must NOT be called again on retry');
    assert.equal(
      answerCallCount,
      1,
      'Answer API must NOT be called again on retry',
    );
    assert.equal(ttsCallCount, 2, 'Only failed TTS stage should be retried');
    assert.deepEqual(retryResult?.apiCallsMade, {
      stt: 0,
      answer: 0,
      tts: 1,
      persistentAudioFetch: 0,
    });
  });

  // -------------------------------------------------------------------------
  // 9. Cancel & Stale Turn Request Isolation Tests
  // -------------------------------------------------------------------------
  await test('Cancelling or superseding a turn aborts in-flight requests and prevents downstream stage execution', async () => {
    const fakeRecording = {
      blob: new Blob(
        [new Uint8Array(createSyntheticMp3Buffer('cancel_test'))],
        {
          type: 'audio/webm',
        },
      ),
      mimeType: 'audio/webm',
      durationSeconds: 2,
    };

    const controller = new AbortController();
    let isStale = false;
    let answerCalled = false;
    let ttsCalled = false;

    const result = await executeSmartPipelineStages({
      recordingPayload: fakeRecording,
      isRetry: false,
      isStaleTurn: () => isStale,
      signal: controller.signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: async () => {
        // Simulate user clicking cancel while STT is resolving
        isStale = true;
        return { transcript: 'เปิดบริการกี่โมง' };
      },
      answerFn: async () => {
        answerCalled = true;
        return {
          answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ',
          faqIds: [1],
          matched: true,
          answerMode: 'FAQ_GROUNDED',
        };
      },
      ttsFn: async () => {
        ttsCalled = true;
        return new Blob([new Uint8Array(createSyntheticMp3Buffer('tts'))], {
          type: 'audio/mpeg',
        });
      },
    });

    assert.equal(result, null);
    assert.equal(
      answerCalled,
      false,
      'Answer stage must not run after turn is cancelled/superseded',
    );
    assert.equal(
      ttsCalled,
      false,
      'TTS stage must not run after turn is cancelled/superseded',
    );
  });

  // -------------------------------------------------------------------------
  // 10. Existing Audio Format Signature & Lip-Sync RMS Frame Mapping Tests
  // -------------------------------------------------------------------------
  await test('Audio MP3 format validation and Web Audio lip-sync RMS mouth frame transitions remain intact', () => {
    const mp3Buf = createSyntheticMp3Buffer('playback_check');
    const detected = detectAudioFormatFromSignature(mp3Buf);
    assert.deepEqual(detected, { ext: 'mp3', mime: 'audio/mpeg' });

    // Silence (all samples at 128 center) -> closed mouth
    const silentSamples = new Uint8Array(1024).fill(128);
    const silentFrame = computeMouthFrameFromSamples(silentSamples, 0);
    assert.equal(silentFrame.mouthFrame, 'closed');
    assert.equal(silentFrame.amplitude, 0);

    // Medium speech amplitude -> small mouth
    const mediumSamples = new Uint8Array(1024).fill(138);
    const mediumFrame = computeMouthFrameFromSamples(mediumSamples, 0.03);
    assert.equal(mediumFrame.mouthFrame, 'small');

    // Loud speech amplitude -> open mouth
    const loudSamples = new Uint8Array(1024).fill(165);
    const loudFrame = computeMouthFrameFromSamples(loudSamples, 0.08);
    assert.equal(loudFrame.mouthFrame, 'open');
    assert.equal(loudFrame.amplitude > 0.5, true);
  });

  // -------------------------------------------------------------------------
  // 11. End-to-End Fast Path Answer Service Metrics & Telemetry Verification
  // -------------------------------------------------------------------------
  await test('generateGroundedAnswerWithMetrics bypasses OpenAI LLM (llmCalled=false, llmLatencyMs=0) on Safe Fast Path', async () => {
    const mockRetriever = async (query: string) =>
      matchFaqsAgainstRecords(query, SEEDED_DEMO_FAQS, 12);

    const mockNoPersistentAudio = async () => ({
      hit: false as const,
      reason: 'METADATA_NOT_FOUND' as const,
      contentHash: 'mock_hash',
      lookupLatencyMs: 0,
    });

    const { response, metrics } = await generateGroundedAnswerWithMetrics(
      'สำนักงานเปิดกี่โมงครับ',
      mockRetriever,
      mockNoPersistentAudio,
    );

    assert.equal(response.matched, true);
    assert.equal(response.answerMode, 'FAQ_GROUNDED');
    assert.deepEqual(response.faqIds, [1]);
    assert.equal(
      response.answer,
      'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ',
    );
    assert.equal(metrics.llmCalled, false);
    assert.equal(metrics.fastPathBypassedLlm, true);
    assert.equal(metrics.llmLatencyMs, 0);
    assert.equal(metrics.faqRetrievalLatencyMs, 12);
  });

  // -------------------------------------------------------------------------
  // 12. Measured Mock Benchmark (Before vs After Pipeline Telemetry & TTFA)
  // -------------------------------------------------------------------------
  await test('Measured Pipeline Telemetry: STT, FAQ Retrieval, LLM, TTS, Cache Hit/Miss, TTFA, and Total API Calls per Question', async () => {
    clearTtsAudioCache();

    const SIMULATED_STT_MS = 25;
    const SIMULATED_DB_MS = 15;
    const SIMULATED_LLM_MS = 40;
    const SIMULATED_TTS_MS = 45;

    let paidSttCalls = 0;
    let paidLlmCalls = 0;
    let paidTtsCalls = 0;

    const fakeRecording = {
      blob: new Blob([new Uint8Array(createSyntheticMp3Buffer('bench_mic'))], {
        type: 'audio/webm',
      }),
      mimeType: 'audio/webm',
      durationSeconds: 3,
    };

    const mockStt = async () => {
      paidSttCalls += 1;
      await new Promise((r) => setTimeout(r, SIMULATED_STT_MS));
      return { transcript: 'สำนักงานเปิดกี่โมงครับ' };
    };

    const mockRetriever = async (query: string) => {
      const tDb = performance.now();
      await new Promise((r) => setTimeout(r, SIMULATED_DB_MS));
      const dbMs = Math.round(performance.now() - tDb);
      return matchFaqsAgainstRecords(query, SEEDED_DEMO_FAQS, dbMs);
    };

    const mockAnswer = async (transcript: string): Promise<AnswerResponse> => {
      const { response, metrics } = await generateGroundedAnswerWithMetrics(
        transcript,
        mockRetriever,
        async () => ({
          hit: false,
          reason: 'METADATA_NOT_FOUND',
          contentHash: 'mock_hash',
          lookupLatencyMs: 0,
        }),
      );
      if (metrics.llmCalled) {
        paidLlmCalls += 1;
        await new Promise((r) => setTimeout(r, SIMULATED_LLM_MS));
      }
      return response;
    };

    const mockTts = async (text: string): Promise<Blob> => {
      const ttsRes = await synthesizeSpeechMp3WithMetrics(
        text,
        async (norm) => {
          paidTtsCalls += 1;
          await new Promise((r) => setTimeout(r, SIMULATED_TTS_MS));
          return createSyntheticMp3Buffer(norm);
        },
      );
      return new Blob([new Uint8Array(ttsRes.buffer)], { type: 'audio/mpeg' });
    };

    // Run 1: First time asking a High-Confidence FAQ (Cold TTS Cache -> Fast Path skips LLM, calls TTS once)
    const tTurn1Start = performance.now();
    const turn1 = await executeSmartPipelineStages({
      recordingPayload: fakeRecording,
      isRetry: false,
      isStaleTurn: () => false,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: mockStt,
      answerFn: mockAnswer,
      ttsFn: mockTts,
    });
    const turn1TtfaMs = Math.round(performance.now() - tTurn1Start);

    assert.notEqual(turn1, null);
    assert.equal(paidSttCalls, 1);
    assert.equal(paidLlmCalls, 0, 'Fast Path must make 0 LLM calls on Turn 1');
    assert.equal(paidTtsCalls, 1, 'Cold TTS cache makes 1 TTS call on Turn 1');

    // Run 2: Asking the same High-Confidence FAQ again (Warm TTS Cache -> Fast Path skips LLM AND TTS Cache HIT skips OpenAI TTS)
    const tTurn2Start = performance.now();
    const turn2 = await executeSmartPipelineStages({
      recordingPayload: fakeRecording,
      isRetry: false,
      isStaleTurn: () => false,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: mockStt,
      answerFn: mockAnswer,
      ttsFn: mockTts,
    });
    const turn2TtfaMs = Math.round(performance.now() - tTurn2Start);

    assert.notEqual(turn2, null);
    assert.equal(paidSttCalls, 2);
    assert.equal(paidLlmCalls, 0, 'Fast Path must make 0 LLM calls on Turn 2');
    assert.equal(
      paidTtsCalls,
      1,
      'Warm TTS cache HIT must make 0 new OpenAI TTS calls on Turn 2',
    );
    assert.equal(
      turn2!.stageLatenciesMs.ttsMs <= 5,
      true,
      `Expected warm TTS cache hit latency <= 5ms, got ${turn2!.stageLatenciesMs.ttsMs}ms`,
    );
    assert.equal(turn2TtfaMs < turn1TtfaMs, true);

    console.log(
      `       [Telemetry] Turn 1 (Cold TTS Cache): TTFA=${turn1TtfaMs}ms (STT=${turn1!.stageLatenciesMs.sttMs}ms, Answer=${turn1!.stageLatenciesMs.answerMs}ms, TTS=${turn1!.stageLatenciesMs.ttsMs}ms) | Paid OpenAI Calls: STT=1, LLM=0, TTS=1 (Total=2)`,
    );
    console.log(
      `       [Telemetry] Turn 2 (Warm TTS Cache): TTFA=${turn2TtfaMs}ms (STT=${turn2!.stageLatenciesMs.sttMs}ms, Answer=${turn2!.stageLatenciesMs.answerMs}ms, TTS=${turn2!.stageLatenciesMs.ttsMs}ms) | Paid OpenAI Calls: STT=1, LLM=0, TTS=0 (Total=1)`,
    );
  });

  console.log(
    '\n----------------------------------------------------------------------',
  );
  console.log(
    `Summary: ${passed}/${total} Optimization & Regression Tests PASSED (0 Paid API Calls)`,
  );
  console.log(
    '----------------------------------------------------------------------',
  );
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exitCode = 1;
});
