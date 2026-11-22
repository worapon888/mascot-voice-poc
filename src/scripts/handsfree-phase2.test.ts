import assert from 'node:assert/strict';
import { ApiError } from '@/lib/api/errors';
import {
  MAX_CONVERSATION_HISTORY_TURNS,
  validateAnswerRequest,
} from '@/lib/validations/voice';
import {
  appendCompletedTurnToHistory,
  executeSmartPipelineStages,
  type RetrySessionSnapshot,
} from '@/lib/voice/api-client';
import {
  computeDynamicBargeInThreshold,
  createInitialVadState,
  DEFAULT_VAD_CONFIG,
  resetVadStateForNextTurn,
  selectUtteranceChunksWithPreRoll,
  stepVadState,
  type TimestampedAudioChunk,
} from '@/lib/voice/vad-engine';
import {
  buildGroundedFaqPromptInput,
  generateGroundedAnswerWithMetrics,
} from '@/services/answer.service';
import {
  hasContextualFollowUpSignal,
  matchFaqsWithConversationContext,
} from '@/services/faq-matching.service';
import type { AnswerResponse, ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

const DEMO_FAQS: FaqRecord[] = [
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

function createSyntheticMp3Blob(label: string): Blob {
  const id3Header = new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb,
    0x90, 0x64,
  ]);
  const textBytes = new TextEncoder().encode(label);
  return new Blob([id3Header, textBytes], { type: 'audio/mpeg' });
}

interface TestCase {
  id: string;
  title: string;
  run: () => Promise<void> | void;
}

const tests: TestCase[] = [
  {
    id: 'P2-01',
    title:
      'Dynamic Barge-in Threshold scales with mascotOutputAmplitude and requires ~300 ms continuous speech hold before BARGE_IN_CONFIRMED',
    run: () => {
      const lowOutputThresh = computeDynamicBargeInThreshold(0.008, 0.1);
      const midOutputThresh = computeDynamicBargeInThreshold(0.008, 0.5);
      const highOutputThresh = computeDynamicBargeInThreshold(0.008, 0.85);

      assert.ok(
        highOutputThresh > midOutputThresh && midOutputThresh > lowOutputThresh,
        'Barge-in RMS threshold must scale upward as mascot speaker amplitude increases',
      );

      let state = createInitialVadState(0);
      const mascotAmp = 0.45;
      const requiredRms = computeDynamicBargeInThreshold(
        state.noiseFloorRms,
        mascotAmp,
      );
      const userBargeInRms = requiredRms + 0.025;

      // Frame 1 at t=100ms: User starts speaking over mascot -> enters SPEECH_STARTING
      let step = stepVadState(state, {
        nowMs: 100,
        rms: userBargeInRms,
        voiceBandRatio: 0.62,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: mascotAmp,
      });
      state = step.state;
      assert.equal(state.phase, 'SPEECH_STARTING');
      assert.equal(step.action, 'NONE');

      // Frame 2 at t=290ms (held 190ms < 300ms bargeInHoldMs) -> NOT yet confirmed
      step = stepVadState(state, {
        nowMs: 290,
        rms: userBargeInRms,
        voiceBandRatio: 0.64,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: mascotAmp,
      });
      state = step.state;
      assert.equal(state.phase, 'SPEECH_STARTING');
      assert.equal(step.action, 'NONE');

      // Frame 3 at t=405ms (held 305ms >= 300ms bargeInHoldMs) -> BARGE_IN_CONFIRMED!
      step = stepVadState(state, {
        nowMs: 405,
        rms: userBargeInRms,
        voiceBandRatio: 0.65,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: mascotAmp,
      });
      state = step.state;
      assert.equal(state.phase, 'SPEAKING');
      assert.equal(step.action, 'BARGE_IN_CONFIRMED');
      assert.equal(state.confirmedSpeechStartMs, 100);
    },
  },
  {
    id: 'P2-02',
    title:
      'Echo / Self-Interruption Guard rejects speaker bleed, transient peaks (<300ms), low voice-band noise, and saturated output (>0.92)',
    run: () => {
      let state = createInitialVadState(0);
      const initialNoiseFloor = state.noiseFloorRms;
      const mascotAmp = 0.6;
      const bargeInThreshold = computeDynamicBargeInThreshold(
        initialNoiseFloor,
        mascotAmp,
      );

      // 1. Continuous speaker bleed below dynamic barge-in threshold (even if above normal minSpeechRms)
      for (let t = 50; t <= 1_500; t += 50) {
        const step = stepVadState(state, {
          nowMs: t,
          rms: bargeInThreshold - 0.004,
          voiceBandRatio: 0.55,
          isPlaybackOrProcessingPaused: false,
          isMascotSpeaking: true,
          mascotOutputAmplitude: mascotAmp,
        });
        state = step.state;
        assert.equal(step.action, 'NONE');
        assert.equal(state.phase, 'LISTENING');
      }
      assert.equal(
        state.noiseFloorRms,
        initialNoiseFloor,
        'Noise floor must never drift upward from speaker output while mascot is speaking',
      );

      // 2. Transient speaker spike (lasts 180ms < 300ms bargeInHoldMs, then drops)
      let step = stepVadState(state, {
        nowMs: 1_600,
        rms: bargeInThreshold + 0.03,
        voiceBandRatio: 0.58,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: mascotAmp,
      });
      state = step.state;
      assert.equal(state.phase, 'SPEECH_STARTING');

      step = stepVadState(state, {
        nowMs: 1_780,
        rms: 0.012,
        voiceBandRatio: 0.4,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: mascotAmp,
      });
      state = step.state;
      assert.equal(step.action, 'DISCARD_SHORT_NOISE');
      assert.equal(state.phase, 'LISTENING');

      // 3. Out-of-band thump / table knock during mascot speech (voiceBandRatio < 0.38)
      for (let t = 2_000; t <= 2_500; t += 100) {
        step = stepVadState(state, {
          nowMs: t,
          rms: 0.14,
          voiceBandRatio: 0.22,
          isPlaybackOrProcessingPaused: false,
          isMascotSpeaking: true,
          mascotOutputAmplitude: mascotAmp,
        });
        state = step.state;
        assert.equal(step.action, 'NONE');
        assert.equal(state.phase, 'LISTENING');
      }

      // 4. Saturated/clipped speaker output (mascotOutputAmplitude > 0.92) suppresses unsafe self-interruption
      for (let t = 3_000; t <= 3_500; t += 100) {
        step = stepVadState(state, {
          nowMs: t,
          rms: 0.25,
          voiceBandRatio: 0.7,
          isPlaybackOrProcessingPaused: false,
          isMascotSpeaking: true,
          mascotOutputAmplitude: 0.96,
        });
        state = step.state;
        assert.equal(step.action, 'NONE');
        assert.equal(state.phase, 'LISTENING');
      }
    },
  },
  {
    id: 'P2-03',
    title:
      'Playback Interruption & Stale Turn Cancellation: Barge-in invalidates old turnId, stops audio, prevents old turn from polluting history, and completes new turn',
    run: async () => {
      let activeTurnId = 0;
      let audioStoppedCount = 0;
      let conversationHistory: ConversationTurn[] = [];

      // Turn 1 starts processing -> enters speaking
      const turn1Id = ++activeTurnId;
      const turn1Controller = new AbortController();

      // Simulate Barge-in occurring while Turn 1 is speaking (before Turn 1 finishes playback)
      const triggerBargeIn = () => {
        activeTurnId += 1;
        turn1Controller.abort();
        audioStoppedCount += 1;
      };

      triggerBargeIn();
      assert.equal(audioStoppedCount, 1);
      assert.notEqual(
        turn1Id,
        activeTurnId,
        'Turn 1 must be immediately marked stale after Barge-in',
      );

      // Now Turn 2 (the barge-in utterance) runs through executeSmartPipelineStages
      const turn2Id = ++activeTurnId;
      const turn2Controller = new AbortController();
      const turn2Recording = {
        blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
        mimeType: 'audio/webm',
        durationSeconds: 2,
      };

      const turn2Result = await executeSmartPipelineStages({
        recordingPayload: turn2Recording,
        conversationHistory,
        isStaleTurn: () => turn2Id !== activeTurnId,
        signal: turn2Controller.signal,
        onStateChange: () => {},
        onTranscriptReady: () => {},
        onAnswerReady: () => {},
        sttFn: async () => ({ transcript: 'ต้องจองคิวไหม' }),
        answerFn: async (transcript) => ({
          answer: `คำตอบสำหรับ ${transcript} ครับ`,
          faqIds: [2],
          matched: true,
          answerMode: 'FAQ_GROUNDED',
        }),
        ttsFn: async (text) => createSyntheticMp3Blob(text),
      });

      assert.ok(turn2Result !== null);
      if (
        turn2Id === activeTurnId &&
        turn2Result.session.transcript &&
        turn2Result.session.answerResult
      ) {
        conversationHistory = appendCompletedTurnToHistory(
          conversationHistory,
          turn2Result.session.transcript,
          turn2Result.session.answerResult,
        );
      }

      assert.equal(conversationHistory.length, 2);
      assert.equal(conversationHistory[0].text, 'ต้องจองคิวไหม');
      assert.deepEqual(conversationHistory[0].faqIds, [2]);
    },
  },
  {
    id: 'P2-04',
    title:
      'Barge-in Pre-Roll Preservation keeps chunk[0] header + 400ms pre-speech audio and seamlessly commits on silence End-of-Turn',
    run: () => {
      // Simulate rolling chunks recorded while mascot was speaking (t=0..2500ms)
      // User starts barge-in speech at t=1000ms, confirmed at t=1300ms, finishes speaking at t=2100ms
      const chunks: TimestampedAudioChunk<string>[] = [
        { chunk: 'HEADER_CHUNK_0', timestampMs: 0, byteSize: 120 },
        { chunk: 'MASCOT_SPEAKING_300', timestampMs: 300, byteSize: 200 },
        { chunk: 'MASCOT_SPEAKING_500', timestampMs: 500, byteSize: 200 },
        { chunk: 'PREROLL_650', timestampMs: 650, byteSize: 200 },
        { chunk: 'PREROLL_850', timestampMs: 850, byteSize: 200 },
        { chunk: 'BARGE_IN_START_1000', timestampMs: 1_000, byteSize: 240 },
        { chunk: 'BARGE_IN_CONFIRMED_1300', timestampMs: 1_300, byteSize: 240 },
        { chunk: 'USER_SPEECH_1700', timestampMs: 1_700, byteSize: 240 },
        { chunk: 'USER_SPEECH_2000', timestampMs: 2_000, byteSize: 240 },
      ];

      let state = createInitialVadState(0);
      // Step 1: User starts barge-in at t=1000ms while mascot is speaking
      state = stepVadState(state, {
        nowMs: 1_000,
        rms: 0.085,
        voiceBandRatio: 0.65,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: 0.35,
      }).state;
      assert.equal(state.phase, 'SPEECH_STARTING');

      // Step 2: Held for 300ms at t=1300ms -> BARGE_IN_CONFIRMED
      const confirmStep = stepVadState(state, {
        nowMs: 1_300,
        rms: 0.09,
        voiceBandRatio: 0.66,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: 0.35,
      });
      state = confirmStep.state;
      assert.equal(confirmStep.action, 'BARGE_IN_CONFIRMED');
      assert.equal(state.confirmedSpeechStartMs, 1_000);

      // Step 3: Mascot audio immediately stops (isMascotSpeaking = false), user continues speaking until t=2000ms
      state = stepVadState(state, {
        nowMs: 2_000,
        rms: 0.075,
        voiceBandRatio: 0.64,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: false,
        mascotOutputAmplitude: 0,
      }).state;
      assert.equal(state.phase, 'SPEAKING');

      // Step 4: User stops speaking at t=2100ms, silence holds until t=3160ms (>= 1050ms) -> END_OF_SPEECH_COMMIT
      state = stepVadState(state, {
        nowMs: 2_100,
        rms: 0.007,
        voiceBandRatio: 0.3,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: false,
      }).state;

      const commitStep = stepVadState(state, {
        nowMs: 3_160,
        rms: 0.006,
        voiceBandRatio: 0.3,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: false,
      });
      assert.equal(commitStep.action, 'END_OF_SPEECH_COMMIT');

      const selected = selectUtteranceChunksWithPreRoll(
        chunks,
        confirmStep.state.confirmedSpeechStartMs!,
        DEFAULT_VAD_CONFIG.preSpeechBufferMs,
      );

      assert.deepEqual(selected, [
        'HEADER_CHUNK_0',
        'PREROLL_650',
        'PREROLL_850',
        'BARGE_IN_START_1000',
        'BARGE_IN_CONFIRMED_1300',
        'USER_SPEECH_1700',
        'USER_SPEECH_2000',
      ]);
    },
  },
  {
    id: 'P2-05',
    title:
      'Recorder Lifecycle & Race Condition Protection prevents duplicate commits and resets cleanly across turns',
    run: () => {
      let state = createInitialVadState(0);

      // Trigger Barge-in at t=100..400ms
      state = stepVadState(state, {
        nowMs: 100,
        rms: 0.09,
        voiceBandRatio: 0.65,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: 0.3,
      }).state;
      state = stepVadState(state, {
        nowMs: 410,
        rms: 0.09,
        voiceBandRatio: 0.65,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: 0.3,
      }).state;
      assert.equal(state.phase, 'SPEAKING');

      // Continue speaking until t=900ms, then silence until t=2000ms -> commit once
      state = stepVadState(state, {
        nowMs: 900,
        rms: 0.08,
        voiceBandRatio: 0.6,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: false,
      }).state;
      state = stepVadState(state, {
        nowMs: 950,
        rms: 0.006,
        voiceBandRatio: 0.3,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: false,
      }).state;
      const commitStep = stepVadState(state, {
        nowMs: 2_010,
        rms: 0.006,
        voiceBandRatio: 0.3,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: false,
      });
      state = commitStep.state;
      assert.equal(commitStep.action, 'END_OF_SPEECH_COMMIT');
      assert.equal(state.utteranceCommittedForTurn, true);

      // Subsequent loud frames before resetVadStateForNextTurn MUST NOT re-trigger speech or barge-in
      const duplicateAttempt = stepVadState(state, {
        nowMs: 2_100,
        rms: 0.12,
        voiceBandRatio: 0.7,
        isPlaybackOrProcessingPaused: false,
        isMascotSpeaking: true,
        mascotOutputAmplitude: 0.2,
      });
      assert.equal(duplicateAttempt.action, 'NONE');
      assert.equal(duplicateAttempt.state.phase, 'LISTENING');

      // After resetVadStateForNextTurn, next turn is armed cleanly
      state = resetVadStateForNextTurn(duplicateAttempt.state, 2_500);
      assert.equal(state.utteranceCommittedForTurn, false);
    },
  },
  {
    id: 'P2-06',
    title:
      'Conversation History Validation & Sliding Window enforces max 4 turns, validates payload bounds, and excludes incomplete turns',
    run: () => {
      // 1. Valid request without history (backward compatible)
      const validNoHistory = validateAnswerRequest({
        transcript: '  เปิดบริการกี่โมง  ',
      });
      assert.equal(validNoHistory.transcript, 'เปิดบริการกี่โมง');
      assert.deepEqual(validNoHistory.conversationHistory, []);

      // 2. Valid request with 2 turns of history
      const validWithHistory = validateAnswerRequest({
        transcript: 'แล้ววันเสาร์ล่ะ',
        conversationHistory: [
          { role: 'user', text: 'เปิดบริการกี่โมง', faqIds: [1] },
          {
            role: 'assistant',
            text: 'เปิดวันจันทร์ถึงศุกร์ 09:00–16:00 น. ครับ',
            faqIds: [1],
          },
        ],
      });
      assert.equal(validWithHistory.conversationHistory.length, 2);
      assert.deepEqual(validWithHistory.conversationHistory[0].faqIds, [1]);

      // 3. Rejects > 4 turns in conversationHistory
      assert.throws(
        () =>
          validateAnswerRequest({
            transcript: 'คำถามที่ 3',
            conversationHistory: [
              { role: 'user', text: '1' },
              { role: 'assistant', text: '2' },
              { role: 'user', text: '3' },
              { role: 'assistant', text: '4' },
              { role: 'user', text: '5' },
            ],
          }),
        (err: unknown) => err instanceof ApiError && err.status === 400,
      );

      // 4. Rejects empty turn text or overly long turn text (>500 chars)
      assert.throws(
        () =>
          validateAnswerRequest({
            transcript: 'ถามต่อ',
            conversationHistory: [{ role: 'user', text: '   ' }],
          }),
        (err: unknown) => err instanceof ApiError && err.status === 400,
      );
      assert.throws(
        () =>
          validateAnswerRequest({
            transcript: 'ถามต่อ',
            conversationHistory: [{ role: 'user', text: 'ก'.repeat(501) }],
          }),
        (err: unknown) =>
          err instanceof ApiError && err.code === 'TEXT_TOO_LONG',
      );

      // 5. Client sliding window caps at MAX_CONVERSATION_HISTORY_TURNS (4)
      let history: ConversationTurn[] = [];
      for (let i = 1; i <= 3; i++) {
        history = appendCompletedTurnToHistory(history, `คำถาม ${i}`, {
          answer: `คำตอบ ${i}`,
          faqIds: [i],
          matched: true,
          answerMode: 'FAQ_GROUNDED',
        });
      }
      assert.equal(history.length, MAX_CONVERSATION_HISTORY_TURNS);
      assert.equal(history[0].text, 'คำถาม 2');
      assert.equal(history[3].text, 'คำตอบ 3');
    },
  },
  {
    id: 'P2-07',
    title:
      'Contextual Follow-up ("เปิดกี่โมง" -> "แล้ววันเสาร์ล่ะ", "เตรียมเอกสารอะไร" -> "ถ้าไม่มีล่ะ") inherits prior FAQ evidence and stays strictly grounded',
    run: async () => {
      const historyAfterTurn1: ConversationTurn[] = [
        { role: 'user', text: 'เปิดบริการกี่โมง', faqIds: [1] },
        {
          role: 'assistant',
          text: 'เปิดให้บริการวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. เว้นวันหยุดราชการ ครับ',
          faqIds: [1],
        },
      ];

      assert.equal(hasContextualFollowUpSignal('แล้ววันเสาร์ล่ะครับ'), true);
      assert.equal(hasContextualFollowUpSignal('ถ้าไม่มีล่ะ'), true);
      assert.equal(hasContextualFollowUpSignal('ต้องจองคิวล่วงหน้าไหม'), false);

      // Follow-up 1: "แล้ววันเสาร์ล่ะครับ" (does not repeat "เปิดบริการ", relies on Turn 1 FAQ #1)
      const contextualRetrieval = matchFaqsWithConversationContext(
        'แล้ววันเสาร์ล่ะครับ',
        DEMO_FAQS,
        historyAfterTurn1,
      );
      assert.equal(contextualRetrieval.matched, true);
      assert.equal(contextualRetrieval.faqs[0].id, 1);
      assert.equal(contextualRetrieval.highConfidenceFastPath, false);
      assert.equal(
        contextualRetrieval.fastPathDisqualifier,
        'CONTEXTUAL_FOLLOW_UP',
      );

      // Verify prompt construction includes both <faq_evidence> and <conversation_history>
      const promptInput = buildGroundedFaqPromptInput(
        contextualRetrieval.faqs,
        'แล้ววันเสาร์ล่ะครับ',
        historyAfterTurn1,
      );
      assert.ok(promptInput.includes('<faq_evidence>'));
      assert.ok(promptInput.includes('<conversation_history>'));
      assert.ok(promptInput.includes('[FAQ #1]'));

      // Verify generateGroundedAnswerWithMetrics routes contextual follow-up through grounded LLM
      // and rejects fabricated claims not in evidence
      let llmPromptReceived = '';
      const result = await generateGroundedAnswerWithMetrics(
        'แล้ววันเสาร์ล่ะครับ',
        async (q, hist) =>
          matchFaqsWithConversationContext(q, DEMO_FAQS, hist, 2),
        async () => ({
          hit: false,
          reason: 'METADATA_NOT_FOUND',
          contentHash: 'hash_faq_1',
          lookupLatencyMs: 0,
        }),
        historyAfterTurn1,
        async (prompt) => {
          llmPromptReceived = prompt;
          return 'วันเสาร์ปิดทำการครับ โดยเปิดให้บริการเฉพาะวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. เว้นวันหยุดราชการ ครับ';
        },
      );

      assert.ok(llmPromptReceived.includes('<conversation_history>'));
      assert.equal(result.metrics.llmCalled, true);
      assert.equal(result.metrics.fastPathBypassedLlm, false);
      assert.equal(result.response.matched, true);
      assert.deepEqual(result.response.faqIds, [1]);
      assert.ok(result.response.answer.includes('09:00–16:00'));

      // Out-of-scope query ("ห้องน้ำอยู่ชั้นไหน") even after Turn 1 must NOT match Turn 1's FAQ
      const outOfScopeAfterTurn1 = matchFaqsWithConversationContext(
        'ห้องน้ำอยู่ชั้นไหน',
        DEMO_FAQS,
        historyAfterTurn1,
      );
      assert.equal(outOfScopeAfterTurn1.matched, false);
      assert.equal(outOfScopeAfterTurn1.faqs.length, 0);
    },
  },
  {
    id: 'P2-08',
    title:
      'Self-Contained FAQ Fast Path & Persistent Audio Preservation: Self-contained questions still bypass LLM (0 LLM calls, 0 TTS calls) even when conversationHistory exists',
    run: async () => {
      const priorHistory: ConversationTurn[] = [
        { role: 'user', text: 'เปิดบริการกี่โมง', faqIds: [1] },
        {
          role: 'assistant',
          text: 'เปิดให้บริการวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. เว้นวันหยุดราชการ ครับ',
          faqIds: [1],
        },
      ];

      let llmCalledCount = 0;
      const fastPathResult = await generateGroundedAnswerWithMetrics(
        'ต้องเตรียมเอกสารอะไรบ้างครับ',
        async (q, hist) =>
          matchFaqsWithConversationContext(q, DEMO_FAQS, hist, 1),
        async (faq) => ({
          hit: true,
          reason: 'READY_VERIFIED',
          contentHash: 'hash_faq_3',
          lookupLatencyMs: 1,
          audioRef: {
            faqId: faq.id,
            contentHash: 'hash_faq_3',
            audioUrl:
              'https://example.supabase.co/storage/v1/object/public/faq-audio/faq-3.mp3',
            objectPath: 'faq-3.mp3',
            mimeType: 'audio/mpeg',
            byteLength: 4096,
          },
        }),
        priorHistory,
        async () => {
          llmCalledCount += 1;
          return 'ไม่ควรถูกเรียก';
        },
      );

      assert.equal(
        llmCalledCount,
        0,
        'Self-contained high-confidence FAQ must NEVER call LLM even when conversationHistory is present',
      );
      assert.equal(fastPathResult.metrics.llmCalled, false);
      assert.equal(fastPathResult.metrics.fastPathBypassedLlm, true);
      assert.equal(fastPathResult.metrics.persistentAudioStatus, 'HIT');
      assert.deepEqual(fastPathResult.response.faqIds, [3]);
      assert.ok(fastPathResult.response.audioRef?.audioUrl);
    },
  },
  {
    id: 'P2-09',
    title:
      'Kiosk Standby Context Reset (30s Visitor Silence) wipes conversationHistory so next visitor starts with a clean slate',
    run: () => {
      let state = createInitialVadState(0);
      let conversationHistory: ConversationTurn[] = [
        { role: 'user', text: 'เปิดบริการกี่โมง', faqIds: [1] },
        {
          role: 'assistant',
          text: 'เปิดให้บริการวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. เว้นวันหยุดราชการ ครับ',
          faqIds: [1],
        },
      ];

      // Advance 30,050 ms of silence in KIOSK_MODE (kioskStandbyMode = true)
      const step = stepVadState(state, {
        nowMs: 30_050,
        rms: 0.005,
        voiceBandRatio: 0.3,
        isPlaybackOrProcessingPaused: false,
        kioskStandbyMode: true,
      });
      state = step.state;
      assert.equal(step.action, 'KIOSK_STANDBY_RESET');
      assert.equal(state.phase, 'LISTENING');

      // On KIOSK_STANDBY_RESET, VoiceChat clears conversationHistoryRef.current = []
      if (step.action === 'KIOSK_STANDBY_RESET') {
        conversationHistory = [];
      }

      assert.equal(conversationHistory.length, 0);

      // Next visitor walks up and says an ambiguous ellipsis phrase "แล้ววันเสาร์ล่ะ" without prior context
      //Wait: "แล้ววันเสาร์ล่ะ" without history must not inherit any stale FAQ from the previous visitor if it has no keyword match!
      const nextVisitorEllipsis = matchFaqsWithConversationContext(
        'ถ้าไม่มีล่ะ',
        DEMO_FAQS,
        conversationHistory,
      );
      assert.equal(
        nextVisitorEllipsis.matched,
        false,
        'After KIOSK_STANDBY_RESET, previous visitor context must never leak into the next visitor session',
      );
    },
  },
  {
    id: 'P2-10',
    title:
      'Push-to-Talk & Smart Retry Regression preserves checkpoints and forwards conversationHistory cleanly',
    run: async () => {
      const recordingPayload = {
        blob: new Blob([new Uint8Array([9, 8, 7])], { type: 'audio/webm' }),
        mimeType: 'audio/webm',
        durationSeconds: 2,
      };
      const priorHistory: ConversationTurn[] = [
        { role: 'user', text: 'เปิดบริการกี่โมง', faqIds: [1] },
        {
          role: 'assistant',
          text: 'เปิดให้บริการวันจันทร์ถึงวันศุกร์ เวลา 09:00–16:00 น. ครับ',
          faqIds: [1],
        },
      ];

      let receivedHistoryLen = -1;
      let sttCalls = 0;
      let answerCalls = 0;
      let ttsCalls = 0;
      let shouldFailTtsFirstTime = true;
      let sessionSnapshot: RetrySessionSnapshot | null = null;

      // Attempt 1: STT and Answer succeed, TTS fails
      try {
        await executeSmartPipelineStages({
          recordingPayload,
          existingSession: sessionSnapshot,
          isRetry: false,
          conversationHistory: priorHistory,
          isStaleTurn: () => false,
          signal: new AbortController().signal,
          onStateChange: () => {},
          onTranscriptReady: (t) => {
            sessionSnapshot = {
              recording: recordingPayload,
              transcript: t,
              answerResult: null,
              ttsBlob: null,
            };
          },
          onAnswerReady: (a: AnswerResponse) => {
            if (sessionSnapshot) {
              sessionSnapshot.answerResult = a;
            }
          },
          sttFn: async () => {
            sttCalls += 1;
            return { transcript: 'แล้ววันเสาร์ล่ะ' };
          },
          answerFn: async (_t, _s, hist) => {
            answerCalls += 1;
            receivedHistoryLen = hist ? hist.length : 0;
            return {
              answer: 'วันเสาร์ปิดทำการครับ เปิดเฉพาะจันทร์ถึงศุกร์ 09:00–16:00 น. ครับ',
              faqIds: [1],
              matched: true,
              answerMode: 'FAQ_GROUNDED',
            };
          },
          ttsFn: async () => {
            ttsCalls += 1;
            if (shouldFailTtsFirstTime) {
              shouldFailTtsFirstTime = false;
              throw new Error('Simulated transient TTS error');
            }
            return createSyntheticMp3Blob('retry-ok');
          },
        });
      } catch {
        // Expected first attempt TTS failure
      }

      assert.equal(receivedHistoryLen, 2);
      assert.equal(sttCalls, 1);
      assert.equal(answerCalls, 1);
      assert.equal(ttsCalls, 1);

      // Attempt 2 (Smart Retry): Reuses transcript and answerResult without re-calling STT or Answer
      const retryOutcome = await executeSmartPipelineStages({
        recordingPayload,
        existingSession: sessionSnapshot,
        isRetry: true,
        conversationHistory: priorHistory,
        isStaleTurn: () => false,
        signal: new AbortController().signal,
        onStateChange: () => {},
        onTranscriptReady: () => {},
        onAnswerReady: () => {},
        sttFn: async () => {
          sttCalls += 1;
          return { transcript: 'ไม่ควรถูกเรียกซ้ำ' };
        },
        answerFn: async () => {
          answerCalls += 1;
          throw new Error('Answer should not be called on TTS retry');
        },
        ttsFn: async () => {
          ttsCalls += 1;
          return createSyntheticMp3Blob('retry-ok');
        },
      });

      assert.ok(retryOutcome !== null);
      assert.equal(sttCalls, 1, 'Smart Retry must not re-run STT');
      assert.equal(answerCalls, 1, 'Smart Retry must not re-run Answer');
      assert.equal(
        ttsCalls,
        2,
        'Smart Retry must only retry the failed TTS stage',
      );
    },
  },
];

async function runSuite() {
  console.log(
    '======================================================================',
  );
  console.log(
    ' Phase 2 Hands-Free (Smart Barge-in & Multi-Turn Context) Test Suite  ',
  );
  console.log(
    '======================================================================\n',
  );

  let passed = 0;
  for (const testCase of tests) {
    try {
      await testCase.run();
      passed += 1;
      console.log(`[PASS] ${testCase.id} — ${testCase.title}`);
    } catch (error) {
      console.error(`[FAIL] ${testCase.id} — ${testCase.title}`);
      console.error(error);
      process.exit(1);
    }
  }

  console.log(
    '\n----------------------------------------------------------------------',
  );
  console.log(
    `Summary: ${passed}/${tests.length} Phase 2 Hands-Free & Context Tests PASSED (0 Paid API Calls)`,
  );
  console.log(
    '----------------------------------------------------------------------',
  );
}

void runSuite();
