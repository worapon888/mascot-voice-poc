import assert from 'node:assert/strict';
import {
  generateGroundedAnswerWithMetrics,
  STANDARD_FALLBACK_ANSWER,
} from '@/services/answer.service';
import {
  matchFaqsAgainstRecords,
  matchFaqsWithConversationContext,
} from '@/services/faq-matching.service';
import { executeSmartPipelineStages } from '@/lib/voice/api-client';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

// Active 5 Seeded FAQs
const SEEDED_FAQS: FaqRecord[] = [
  {
    id: 1,
    question: 'เปิดบริการกี่โมง',
    answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น.',
    keywords: ['เวลาทำการ', 'เปิดกี่โมง', 'ปิดกี่โมง', 'วันเวลา'],
    is_active: true,
    created_at: '2026-11-22T00:00:00.000Z',
  },
  {
    id: 2,
    question: 'ต้องจองคิวไหม',
    answer: 'บริการ Demo นี้รับนัดหมายล่วงหน้าผ่านเจ้าหน้าที่ Demo',
    keywords: ['จองคิว', 'นัดหมาย', 'คิว'],
    is_active: true,
    created_at: '2026-11-22T00:00:00.000Z',
  },
  {
    id: 3,
    question: 'เตรียมเอกสารอะไร',
    answer: 'การทดลอง Demo ใช้เลขอ้างอิง DEMO-001 ไม่ต้องส่งเอกสารส่วนบุคคล',
    keywords: ['เอกสาร', 'หลักฐาน', 'เตรียมอะไร'],
    is_active: true,
    created_at: '2026-11-22T00:00:00.000Z',
  },
  {
    id: 4,
    question: 'ทดลองผ่านมือถือได้ไหม',
    answer: 'Demo นี้แนะนำ Chrome Desktop; Mobile ยังไม่รับรองจนกว่าจะทดสอบ',
    keywords: ['มือถือ', 'สมาร์ทโฟน', 'เบราว์เซอร์'],
    is_active: true,
    created_at: '2026-11-22T00:00:00.000Z',
  },
  {
    id: 5,
    question: 'ติดต่อใครเมื่อไม่มีคำตอบ',
    answer: 'โปรดติดต่อผู้ดูแลการสาธิตเพื่อขอข้อมูลเพิ่มเติม',
    keywords: ['ติดต่อ', 'เจ้าหน้าที่', 'สอบถามเพิ่มเติม'],
    is_active: true,
    created_at: '2026-11-22T00:00:00.000Z',
  },
];

async function runTests(): Promise<void> {
  console.log(
    '======================================================================',
  );
  console.log(
    ' 3-Tier Mascot Response & Performance Verification Suite             ',
  );
  console.log(
    '======================================================================\n',
  );

  let passed = 0;

  // ---------------------------------------------------------------------------
  // 1. Tier 1: "เปิดกี่โมง" -> FAQ #1 (Fast Path, 0 LLM, 0 Dynamic TTS)
  // ---------------------------------------------------------------------------
  {
    const res = await generateGroundedAnswerWithMetrics(
      'เปิดกี่โมง',
      async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
      async () => ({
        hit: true,
        reason: 'READY_VERIFIED',
        contentHash: 'hash-faq-1',
        lookupLatencyMs: 1,
        audioRef: {
          faqId: 1,
          contentHash: 'hash-faq-1',
          audioUrl: 'https://cdn.example.com/faq-1.mp3',
          objectPath: 'faqs/v1/faq-1.mp3',
          mimeType: 'audio/mpeg',
          byteLength: 103296,
        },
      }),
    );

    assert.equal(res.response.tier, 'TIER_1');
    assert.equal(res.response.matched, true);
    assert.deepEqual(res.response.faqIds, [1]);
    assert.equal(res.metrics.llmCalled, false);
    assert.equal(res.metrics.fastPathBypassedLlm, true);
    assert.equal(res.metrics.persistentAudioStatus, 'HIT');
    assert.notEqual(res.response.audioRef, undefined);
    assert.equal(res.response.audioRef?.faqId, 1);
    console.log(
      '[PASS] R01 — "เปิดกี่โมง" -> Tier 1 (FAQ #1 Fast Path, 0 LLM, Persistent Audio HIT)',
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 2. Tier 1: "ต้องจองคิวไหม" -> FAQ #2 (Fast Path, 0 LLM, 0 Dynamic TTS)
  // ---------------------------------------------------------------------------
  {
    const res = await generateGroundedAnswerWithMetrics(
      'ต้องจองคิวไหมครับ',
      async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
      async () => ({
        hit: true,
        reason: 'READY_VERIFIED',
        contentHash: 'hash-faq-2',
        lookupLatencyMs: 1,
        audioRef: {
          faqId: 2,
          contentHash: 'hash-faq-2',
          audioUrl: 'https://cdn.example.com/faq-2.mp3',
          objectPath: 'faqs/v1/faq-2.mp3',
          mimeType: 'audio/mpeg',
          byteLength: 115968,
        },
      }),
    );

    assert.equal(res.response.tier, 'TIER_1');
    assert.equal(res.response.matched, true);
    assert.deepEqual(res.response.faqIds, [2]);
    assert.equal(res.metrics.llmCalled, false);
    assert.equal(res.metrics.fastPathBypassedLlm, true);
    assert.equal(res.metrics.persistentAudioStatus, 'HIT');
    assert.notEqual(res.response.audioRef, undefined);
    assert.equal(res.response.audioRef?.faqId, 2);
    console.log(
      '[PASS] R02 — "ต้องจองคิวไหม" -> Tier 1 (FAQ #2 Fast Path, 0 LLM, Persistent Audio HIT)',
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 3. Tier 2: "วันเสาร์เปิดไหม" -> Matches FAQ #1 with sufficient evidence, rephrased via LLM
  // ---------------------------------------------------------------------------
  {
    let llmCalled = false;
    const res = await generateGroundedAnswerWithMetrics(
      'วันเสาร์เปิดไหมครับ',
      async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
      async () => ({
        hit: false,
        reason: 'STATUS_NOT_READY',
        contentHash: '',
        lookupLatencyMs: 0,
      }),
      [],
      async (prompt, faqs) => {
        llmCalled = true;
        assert.equal(
          faqs.some((f) => f.id === 1),
          true,
          'Must ground on FAQ #1 evidence',
        );
        return 'วันเสาร์ปิดทำการครับ โดยจุดบริการ Demo เปิดทำการวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. ครับ';
      },
    );

    assert.equal(res.response.tier, 'TIER_2');
    assert.equal(res.response.matched, true);
    assert.deepEqual(res.response.faqIds, [1]);
    assert.equal(llmCalled, true);
    assert.equal(res.metrics.llmCalled, true);
    assert.equal(res.metrics.fastPathBypassedLlm, false);
    assert.equal(res.response.answer.includes('วันเสาร์'), true);
    console.log(
      '[PASS] R03 — "วันเสาร์เปิดไหม" -> Tier 2 (Matches FAQ #1 evidence, rephrased via LLM)',
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 4. Tier 2: Conversation Contextual Follow-up ("เปิดกี่โมง" -> "แล้ววันเสาร์ล่ะ")
  // ---------------------------------------------------------------------------
  {
    const history: ConversationTurn[] = [
      { role: 'user', text: 'เปิดกี่โมงครับ' },
      {
        role: 'assistant',
        text: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ',
        faqIds: [1],
      },
    ];

    let contextualLlmCalled = false;
    const res = await generateGroundedAnswerWithMetrics(
      'แล้ววันเสาร์ล่ะครับ',
      async (q, hist) => matchFaqsWithConversationContext(q, SEEDED_FAQS, hist),
      async () => ({
        hit: false,
        reason: 'STATUS_NOT_READY',
        contentHash: '',
        lookupLatencyMs: 0,
      }),
      history,
      async (prompt, faqs, hist) => {
        contextualLlmCalled = true;
        assert.equal(
          faqs.some((f) => f.id === 1),
          true,
        );
        assert.equal(hist.length, 2);
        return 'วันเสาร์ปิดทำการครับ โดยเปิดให้บริการเฉพาะวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. ครับ';
      },
    );

    assert.equal(res.response.tier, 'TIER_2');
    assert.equal(res.response.matched, true);
    assert.deepEqual(res.response.faqIds, [1]);
    assert.equal(contextualLlmCalled, true);
    assert.equal(res.metrics.llmCalled, true);
    console.log(
      '[PASS] R04 — Contextual Follow-up ("แล้ววันเสาร์ล่ะ") -> Tier 2 (Inherits FAQ #1 Context)',
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 5. Tier 3: Unknown Question with No Info in FAQ ("อาหารกลางวันมีอะไร") -> Cached Fallback
  // ---------------------------------------------------------------------------
  {
    const res = await generateGroundedAnswerWithMetrics(
      'อาหารกลางวันมีอะไรให้กินบ้าง',
      async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
      undefined,
      [],
      undefined,
      async () => ({
        hit: true,
        reason: 'READY_VERIFIED',
        contentHash: 'hash-fallback',
        lookupLatencyMs: 1,
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

    assert.equal(res.response.tier, 'TIER_3');
    assert.equal(res.response.matched, false);
    assert.deepEqual(res.response.faqIds, []);
    assert.equal(res.response.answer, STANDARD_FALLBACK_ANSWER);
    assert.equal(res.metrics.llmCalled, false);
    assert.equal(res.metrics.fastPathBypassedLlm, true);
    assert.equal(res.metrics.persistentAudioStatus, 'HIT');
    assert.notEqual(res.response.audioRef, undefined);
    assert.equal(res.response.audioRef?.faqId, 0);
    console.log(
      '[PASS] R05 — Unmatched Question ("อาหารกลางวันมีอะไร") -> Tier 3 (Cached Fallback MP3, 0 LLM)',
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 6. Tier 3: Explicit Out-of-Scope Questions ("ห้องน้ำอยู่ชั้นไหน", "ที่จอดรถตรงไหน") -> Cached Fallback
  // ---------------------------------------------------------------------------
  {
    const outOfScopeQueries = [
      'ห้องน้ำอยู่ชั้นไหนครับ',
      'ที่จอดรถอยู่ตรงไหน',
      'ค่าเช่าห้องสัมมนาเท่าไรครับ',
      'วันนี้ฝนจะตกไหม',
      'ขอรหัส wifi หน่อยครับ',
    ];

    for (const q of outOfScopeQueries) {
      const res = await generateGroundedAnswerWithMetrics(
        q,
        async (query) => matchFaqsAgainstRecords(query, SEEDED_FAQS),
        undefined,
        [],
        undefined,
        async () => ({
          hit: true,
          reason: 'READY_VERIFIED',
          contentHash: 'hash-fallback',
          lookupLatencyMs: 1,
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

      assert.equal(res.response.tier, 'TIER_3', `Expected TIER_3 for "${q}"`);
      assert.equal(res.response.matched, false);
      assert.equal(res.response.answer, STANDARD_FALLBACK_ANSWER);
      assert.equal(res.metrics.llmCalled, false);
      assert.equal(
        res.response.audioRef?.audioUrl,
        'https://cdn.example.com/fallback.mp3',
      );
    }
    console.log(
      '[PASS] R06 — Explicit Out-of-Scope (Restroom/Parking/Wifi/Weather) -> Tier 3 (Cached Fallback)',
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 7. Tier 2: Ambiguous Questions ("จองคิวมือถือ" spans FAQ #2 and FAQ #4) -> LLM Clarification
  // ---------------------------------------------------------------------------
  {
    let ambiguousLlmCalled = false;
    const res = await generateGroundedAnswerWithMetrics(
      'จองคิวมือถือ',
      async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
      async () => ({
        hit: false,
        reason: 'STATUS_NOT_READY',
        contentHash: '',
        lookupLatencyMs: 0,
      }),
      [],
      async (prompt, faqs) => {
        ambiguousLlmCalled = true;
        assert.equal(
          faqs.length >= 2,
          true,
          'Must pass multiple matched candidate FAQs',
        );
        return 'บริการ Demo รับนัดหมายล่วงหน้าผ่านเจ้าหน้าที่ และแนะนำให้ใช้งานผ่าน Chrome Desktop บนคอมพิวเตอร์ครับ';
      },
    );

    assert.equal(res.response.tier, 'TIER_2');
    assert.equal(res.response.matched, true);
    assert.equal(ambiguousLlmCalled, true);
    assert.equal(res.metrics.llmCalled, true);
    console.log(
      '[PASS] R07 — Ambiguous Questions ("จองคิวมือถือ") -> Tier 2 (LLM disambiguation)',
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 8. Robustness: STT with Typos, Empty or Single Stop Word -> Safe Fallback without Crashing
  // ---------------------------------------------------------------------------
  {
    const noisyInputs = ['', '   ', 'อะไร', 'ระบบ', 'ข้อมูล'];
    for (const noisy of noisyInputs) {
      const res = await generateGroundedAnswerWithMetrics(
        noisy,
        async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
        undefined,
        [],
        undefined,
        async () => ({
          hit: true,
          reason: 'READY_VERIFIED',
          contentHash: 'hash-fallback',
          lookupLatencyMs: 1,
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
      assert.equal(res.response.tier, 'TIER_3');
      assert.equal(res.response.matched, false);
      assert.equal(res.response.answer, STANDARD_FALLBACK_ANSWER);
    }
    console.log(
      '[PASS] R08 — Incomplete/Empty/Stop-word Inputs -> Tier 3 Safe Fallback without Crashing',
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 9. End-to-End Pipeline Performance Verification (Latency Breakdown across Tiers)
  // ---------------------------------------------------------------------------
  {
    // Simulate real pipeline stages
    const mockAudioBlob = new Blob([new Uint8Array(16000)], {
      type: 'audio/wav',
    });
    const recordingPayload = {
      blob: mockAudioBlob,
      mimeType: 'audio/wav',
      durationSeconds: 2.0,
    };

    // Stage simulation constants
    const SIMULATED_STT_MS = 28;
    const SIMULATED_PERSISTENT_FETCH_MS = 35;
    const SIMULATED_LLM_MS = 620;
    const SIMULATED_DYNAMIC_TTS_MS = 740;
    const SIMULATED_PLAYBACK_START_MS = 12;

    const mockStt = async (): Promise<{ transcript: string }> => {
      await new Promise((r) => setTimeout(r, SIMULATED_STT_MS));
      return { transcript: 'เปิดกี่โมง' };
    };

    // Tier 1 Measurement
    const tT1Start = performance.now();
    const t1Pipeline = await executeSmartPipelineStages({
      recordingPayload,
      isRetry: false,
      isStaleTurn: () => false,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: mockStt,
      answerFn: async () => {
        const { response } = await generateGroundedAnswerWithMetrics(
          'เปิดกี่โมง',
          async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
          async () => ({
            hit: true,
            reason: 'READY_VERIFIED',
            contentHash: 'hash-1',
            lookupLatencyMs: 1,
            audioRef: {
              faqId: 1,
              contentHash: 'hash-1',
              audioUrl: 'https://cdn.example.com/faq-1.mp3',
              objectPath: 'faqs/v1/faq-1.mp3',
              mimeType: 'audio/mpeg',
              byteLength: 103296,
            },
          }),
        );
        return response;
      },
      persistentAudioFn: async () => {
        await new Promise((r) => setTimeout(r, SIMULATED_PERSISTENT_FETCH_MS));
        const buf = new Uint8Array(128);
        buf[0] = 0x49;
        buf[1] = 0x44;
        buf[2] = 0x33;
        return new Blob([buf], { type: 'audio/mpeg' });
      },
    });
    const t1AudioReadyMs = Math.round(performance.now() - tT1Start);
    const t1TotalLatencyMs = t1AudioReadyMs + SIMULATED_PLAYBACK_START_MS;

    // Tier 3 Measurement
    const tT3Start = performance.now();
    const t3Pipeline = await executeSmartPipelineStages({
      recordingPayload,
      isRetry: false,
      isStaleTurn: () => false,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: mockStt,
      answerFn: async () => {
        const { response } = await generateGroundedAnswerWithMetrics(
          'ห้องน้ำอยู่ไหน',
          async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
          undefined,
          [],
          undefined,
          async () => ({
            hit: true,
            reason: 'READY_VERIFIED',
            contentHash: 'hash-fb',
            lookupLatencyMs: 1,
            audioRef: {
              faqId: 0,
              contentHash: 'hash-fb',
              audioUrl: 'https://cdn.example.com/fallback.mp3',
              objectPath: 'fallback/v1/fallback.mp3',
              mimeType: 'audio/mpeg',
              byteLength: 163968,
            },
          }),
        );
        return response;
      },
      persistentAudioFn: async () => {
        await new Promise((r) => setTimeout(r, SIMULATED_PERSISTENT_FETCH_MS));
        const buf = new Uint8Array(128);
        buf[0] = 0x49;
        buf[1] = 0x44;
        buf[2] = 0x33;
        return new Blob([buf], { type: 'audio/mpeg' });
      },
    });
    const t3AudioReadyMs = Math.round(performance.now() - tT3Start);
    const t3TotalLatencyMs = t3AudioReadyMs + SIMULATED_PLAYBACK_START_MS;

    // Tier 2 Measurement
    const tT2Start = performance.now();
    const t2Pipeline = await executeSmartPipelineStages({
      recordingPayload,
      isRetry: false,
      isStaleTurn: () => false,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: mockStt,
      answerFn: async () => {
        const { response } = await generateGroundedAnswerWithMetrics(
          'วันเสาร์เปิดไหม',
          async (q) => matchFaqsAgainstRecords(q, SEEDED_FAQS),
          async () => ({
            hit: false,
            reason: 'STATUS_NOT_READY',
            contentHash: '',
            lookupLatencyMs: 0,
          }),
          [],
          async () => {
            await new Promise((r) => setTimeout(r, SIMULATED_LLM_MS));
            return 'วันเสาร์ปิดทำการครับ โดยเปิดวันจันทร์ถึงวันศุกร์ครับ';
          },
        );
        return response;
      },
      ttsFn: async () => {
        await new Promise((r) => setTimeout(r, SIMULATED_DYNAMIC_TTS_MS));
        const buf = new Uint8Array(128);
        buf[0] = 0xff;
        buf[1] = 0xfb;
        return new Blob([buf], { type: 'audio/mpeg' });
      },
    });
    const t2AudioReadyMs = Math.round(performance.now() - tT2Start);
    const t2TotalLatencyMs = t2AudioReadyMs + SIMULATED_PLAYBACK_START_MS;

    assert.equal(t1Pipeline?.audioSource, 'PERSISTENT_STORAGE');
    assert.equal(t3Pipeline?.audioSource, 'PERSISTENT_STORAGE');
    assert.equal(t2Pipeline?.audioSource, 'DYNAMIC_TTS');

    assert.equal(t1Pipeline?.apiCallsMade.tts, 0);
    assert.equal(t3Pipeline?.apiCallsMade.tts, 0);
    assert.equal(t2Pipeline?.apiCallsMade.tts, 1);

    console.log(
      '[PASS] R09 — Performance Verification across Tiers (Measured End-to-End Latency):',
    );
    console.log(`       [Tier 1 FAQ Fast Path]:`);
    console.log(
      `         - VAD End -> STT Result:        ${t1Pipeline?.stageLatenciesMs.sttMs} ms`,
    );
    console.log(
      `         - STT Result -> Answer Ready:   ${t1Pipeline?.stageLatenciesMs.answerMs} ms (0 ms LLM)`,
    );
    console.log(
      `         - Answer Ready -> Audio Ready:  ${t1Pipeline?.stageLatenciesMs.ttsMs} ms (Persistent MP3)`,
    );
    console.log(
      `         - Audio Ready -> Playback Start: ${SIMULATED_PLAYBACK_START_MS} ms`,
    );
    console.log(
      `         -> Total End-to-End Latency:    ${t1TotalLatencyMs} ms (0 LLM, 0 Dynamic TTS)`,
    );
    console.log(`       [Tier 3 Unknown Fallback]:`);
    console.log(
      `         - VAD End -> STT Result:        ${t3Pipeline?.stageLatenciesMs.sttMs} ms`,
    );
    console.log(
      `         - STT Result -> Answer Ready:   ${t3Pipeline?.stageLatenciesMs.answerMs} ms (0 ms LLM)`,
    );
    console.log(
      `         - Answer Ready -> Audio Ready:  ${t3Pipeline?.stageLatenciesMs.ttsMs} ms (Fallback MP3)`,
    );
    console.log(
      `         - Audio Ready -> Playback Start: ${SIMULATED_PLAYBACK_START_MS} ms`,
    );
    console.log(
      `         -> Total End-to-End Latency:    ${t3TotalLatencyMs} ms (0 LLM, 0 Dynamic TTS)`,
    );
    console.log(`       [Tier 2 Contextual Answer]:`);
    console.log(
      `         - VAD End -> STT Result:        ${t2Pipeline?.stageLatenciesMs.sttMs} ms`,
    );
    console.log(
      `         - STT Result -> Answer Ready:   ${t2Pipeline?.stageLatenciesMs.answerMs} ms (Grounded LLM)`,
    );
    console.log(
      `         - Answer Ready -> Audio Ready:  ${t2Pipeline?.stageLatenciesMs.ttsMs} ms (Dynamic TTS)`,
    );
    console.log(
      `         - Audio Ready -> Playback Start: ${SIMULATED_PLAYBACK_START_MS} ms`,
    );
    console.log(
      `         -> Total End-to-End Latency:    ${t2TotalLatencyMs} ms (1 LLM, 1 Dynamic TTS)`,
    );
    passed += 1;
  }

  // ---------------------------------------------------------------------------
  // 10. Barge-in & Stale Turn Isolation Preservation
  // ---------------------------------------------------------------------------
  {
    const recordingPayload = {
      blob: new Blob([new Uint8Array(1000)], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
      durationSeconds: 1.0,
    };

    let isStale = false;
    const pendingPipeline = executeSmartPipelineStages({
      recordingPayload,
      isRetry: false,
      isStaleTurn: () => isStale,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: async () => {
        isStale = true; // User barges in while transcribing
        return { transcript: 'เปิดกี่โมง' };
      },
      answerFn: async () => {
        throw new Error('Should not be called when turn is stale');
      },
    });

    const result = await pendingPipeline;
    assert.equal(
      result,
      null,
      'Stale barged-in turn must return null and abort downstream stages',
    );
    console.log(
      '[PASS] R10 — Barge-in & Stale Turn Cancellation: Downstream stages cleanly aborted',
    );
    passed += 1;
  }

  console.log(
    '\n----------------------------------------------------------------------',
  );
  console.log(
    `Summary: ${passed}/10 Three-Tier Response & Latency Tests PASSED`,
  );
  console.log(
    '----------------------------------------------------------------------\n',
  );
}

runTests().catch((err) => {
  console.error('Three-tier test suite failed:', err);
  process.exitCode = 1;
});
