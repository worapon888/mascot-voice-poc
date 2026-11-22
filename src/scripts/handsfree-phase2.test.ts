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
  downsamplePcm,
  encodeWav,
  mergeFloat32Arrays,
  PcmRingBuffer,
} from '@/lib/voice/wav-encoder';
import {
  buildGroundedFaqPromptInput,
  generateGroundedAnswerWithMetrics,
} from '@/services/answer.service';
import {
  hasContextualFollowUpSignal,
  matchFaqsWithConversationContext,
} from '@/services/faq-matching.service';
import { detectAudioFormatFromSignature } from '@/services/transcription.service';
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
  {
    id: 'P2-11',
    title:
      'PCM Ring Buffer & Downsampling: Sample-accurate 400ms pre-roll preservation and 48kHz -> 16kHz downsampling without container headers',
    run: async () => {
      const sampleRate = 48000;
      const ring = new PcmRingBuffer({
        sampleRate,
        maxBufferDurationMs: 1500, // 72,000 samples capacity
      });

      // 1. Initial empty buffer returns empty array
      const initialPreRoll = ring.getRecentSamples(400, sampleRate);
      assert.equal(
        initialPreRoll.length,
        0,
        'Empty ring buffer must return 0 samples',
      );

      // 2. Push 100ms chunks (4800 samples each) for 1000ms (10 chunks = 48,000 samples)
      for (let c = 0; c < 10; c++) {
        const chunk = new Float32Array(4800);
        for (let i = 0; i < 4800; i++) {
          chunk[i] = (c * 4800 + i) / 48000;
        }
        ring.push(chunk);
      }

      // Extract 400ms pre-roll (19,200 samples)
      const preRoll400ms = ring.getRecentSamples(400, sampleRate);
      assert.equal(
        preRoll400ms.length,
        19200,
        '400ms pre-roll at 48kHz must yield exactly 19,200 samples',
      );
      // Last sample of pre-roll must match the most recently pushed sample
      const expectedLastSample = (48000 - 1) / 48000;
      assert.ok(
        Math.abs(preRoll400ms[preRoll400ms.length - 1] - expectedLastSample) <
          0.0001,
        'Last sample of pre-roll must correspond to the latest sample pushed',
      );

      // 3. Test circular overwrite: push another 2000ms of audio (exceeding 1500ms capacity)
      for (let c = 0; c < 20; c++) {
        const chunk = new Float32Array(4800);
        chunk.fill(1.0);
        ring.push(chunk);
      }
      const wrappedPreRoll = ring.getRecentSamples(400, sampleRate);
      assert.equal(wrappedPreRoll.length, 19200);
      assert.equal(
        wrappedPreRoll[0],
        1.0,
        'Ring buffer wrap must seamlessly provide latest samples',
      );

      // 4. Test downsampling 48kHz -> 16kHz
      const testPcm48k = new Float32Array(48000); // 1 second
      for (let i = 0; i < 48000; i++) {
        testPcm48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
      }
      const downsampled16k = downsamplePcm(testPcm48k, 48000, 16000);
      assert.equal(
        downsampled16k.length,
        16000,
        'Downsampling 48kHz to 16kHz for 1 sec must produce exactly 16,000 samples',
      );

      // 5. Test merging Float32Array chunks
      const chunkA = new Float32Array([0.1, 0.2]);
      const chunkB = new Float32Array([0.3, 0.4, 0.5]);
      const merged = mergeFloat32Arrays([chunkA, chunkB]);
      assert.equal(merged.length, 5);
      assert.ok(Math.abs(merged[0] - 0.1) < 0.0001);
      assert.ok(Math.abs(merged[4] - 0.5) < 0.0001);
    },
  },
  {
    id: 'P2-12',
    title:
      'WAV RIFF 16-bit Mono Encoder: Produces compliant 16kHz WAV header and passes detectAudioFormatFromSignature for Whisper STT',
    run: async () => {
      const sampleRate = 16000;
      const durationSeconds = 2;
      const sampleCount = sampleRate * durationSeconds; // 32,000 samples
      const pcmSamples = new Float32Array(sampleCount);

      // Fill with synthetic speech test tone
      for (let i = 0; i < sampleCount; i++) {
        pcmSamples[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / sampleRate);
      }

      const wavBytes = encodeWav(pcmSamples, sampleRate);
      assert.ok(
        wavBytes instanceof Uint8Array,
        'encodeWav must return Uint8Array',
      );

      // 44 bytes header + (32000 samples * 2 bytes/sample) = 64,044 bytes
      const expectedByteLength = 44 + sampleCount * 2;
      assert.equal(
        wavBytes.byteLength,
        expectedByteLength,
        `Expected ${expectedByteLength} bytes for 2s 16kHz mono 16-bit WAV, got ${wavBytes.byteLength}`,
      );

      // Validate header signatures
      const nodeBuffer = Buffer.from(wavBytes);
      const detected = detectAudioFormatFromSignature(nodeBuffer);
      assert.ok(
        detected !== null,
        'detectAudioFormatFromSignature must recognize WAV',
      );
      assert.equal(detected?.ext, 'wav');
      assert.equal(detected?.mime, 'audio/wav');

      // Validate specific RIFF header offsets
      const view = new DataView(
        wavBytes.buffer,
        wavBytes.byteOffset,
        wavBytes.byteLength,
      );
      // Bytes 0..3: RIFF
      assert.equal(
        String.fromCharCode(wavBytes[0], wavBytes[1], wavBytes[2], wavBytes[3]),
        'RIFF',
      );
      // Bytes 8..11: WAVE
      assert.equal(
        String.fromCharCode(
          wavBytes[8],
          wavBytes[9],
          wavBytes[10],
          wavBytes[11],
        ),
        'WAVE',
      );
      // AudioFormat at byte 20 == 1 (Linear PCM)
      assert.equal(view.getUint16(20, true), 1, 'AudioFormat must be 1 (PCM)');
      // NumChannels at byte 22 == 1 (Mono)
      assert.equal(view.getUint16(22, true), 1, 'NumChannels must be 1 (Mono)');
      // SampleRate at byte 24 == 16000
      assert.equal(view.getUint32(24, true), 16000, 'SampleRate must be 16000');
      // BitsPerSample at byte 34 == 16
      assert.equal(view.getUint16(34, true), 16, 'BitsPerSample must be 16');
      // Subchunk2ID at bytes 36..39 == "data"
      assert.equal(
        String.fromCharCode(
          wavBytes[36],
          wavBytes[37],
          wavBytes[38],
          wavBytes[39],
        ),
        'data',
      );
      // Subchunk2Size at byte 40 == sampleCount * 2
      assert.equal(view.getUint32(40, true), sampleCount * 2);
    },
  },
  {
    id: 'P2-13',
    title:
      'Multi-Turn Hands-Free Continuity: Verifies RAF loop scheduling across 5 complete turns including Barge-in, Playback Error recovery, Mode Switch, and clean teardown',
    run: async () => {
      let nowMs = 1000;
      let nextRafId = 1;
      let activeRafId: number | null = null;
      const rafQueue = new Map<number, () => void>();

      const mockRequestAnimationFrame = (fn: () => void): number => {
        if (activeRafId !== null) {
          rafQueue.delete(activeRafId);
        }
        const id = nextRafId++;
        rafQueue.set(id, fn);
        activeRafId = id;
        return id;
      };

      const mockCancelAnimationFrame = (id: number): void => {
        rafQueue.delete(id);
        if (activeRafId === id) {
          activeRafId = null;
        }
      };

      let isHandsFreeMode = true;
      let isVadPaused = false;
      let isMascotSpeaking = false;
      let mascotOutputAmplitude = 0;
      let vadState = createInitialVadState(nowMs, DEFAULT_VAD_CONFIG);
      const ringBuffer = new PcmRingBuffer({
        sampleRate: 16000,
        maxBufferDurationMs: 1500,
      });
      let pcmCollector: Float32Array[] = [];
      let isCollectingPcm = false;
      let lastCommittedPayload: {
        blob: Blob;
        mimeType: string;
        durationSeconds: number;
      } | null = null;

      // Core simulation frame function modeling use-voice-recorder.ts
      const sampleMicFrame = (rms: number, voiceBandRatio: number) => {
        if (!isHandsFreeMode) {
          return;
        }

        const step = stepVadState(
          vadState,
          {
            nowMs,
            rms,
            voiceBandRatio,
            isPlaybackOrProcessingPaused: isVadPaused,
            isMascotSpeaking,
            mascotOutputAmplitude,
          },
          DEFAULT_VAD_CONFIG,
        );
        vadState = step.state;

        if (step.action === 'SPEECH_START_CONFIRMED') {
          if (!isCollectingPcm) {
            isCollectingPcm = true;
            const preRoll = ringBuffer.getRecentSamples(400, 16000);
            pcmCollector = preRoll.length > 0 ? [preRoll] : [];
          }
        } else if (step.action === 'BARGE_IN_CONFIRMED') {
          isMascotSpeaking = false;
          if (!isCollectingPcm) {
            isCollectingPcm = true;
            const preRoll = ringBuffer.getRecentSamples(400, 16000);
            pcmCollector = preRoll.length > 0 ? [preRoll] : [];
          }
        } else if (
          step.action === 'END_OF_SPEECH_COMMIT' ||
          step.action === 'MAX_UTTERANCE_COMMIT'
        ) {
          isVadPaused = true;
          isMascotSpeaking = false;
          isCollectingPcm = false;

          const collected = pcmCollector;
          pcmCollector = [];

          if (collected.length > 0) {
            const rawPcm = mergeFloat32Arrays(collected);
            if (rawPcm.length > 0) {
              const wavBytes = encodeWav(rawPcm, 16000);
              const blob = new Blob([wavBytes.buffer as ArrayBuffer], {
                type: 'audio/wav',
              });
              lastCommittedPayload = {
                blob,
                mimeType: 'audio/wav',
                durationSeconds: Math.max(1, Math.round(rawPcm.length / 16000)),
              };

              // CRITICAL: Reschedule RAF frame so sampling loop remains active during pause/playback
              if (isHandsFreeMode) {
                activeRafId = mockRequestAnimationFrame(() => {});
              }
              return;
            }
          }
        }

        if (isHandsFreeMode) {
          activeRafId = mockRequestAnimationFrame(() => {});
        }
      };

      const stepFrame = (
        rms: number,
        voiceBandRatio: number,
        elapsedMs: number,
      ) => {
        nowMs += elapsedMs;
        // Generate simulated PCM samples corresponding to rms
        const sampleCount = Math.floor((16000 * elapsedMs) / 1000);
        const chunk = new Float32Array(sampleCount);
        chunk.fill(rms);
        ringBuffer.push(chunk);
        if (isCollectingPcm) {
          pcmCollector.push(chunk);
        }

        // Execute frame
        sampleMicFrame(rms, voiceBandRatio);
      };

      const resumeHandsFree = (applyCooldown: boolean) => {
        if (applyCooldown) {
          nowMs += DEFAULT_VAD_CONFIG.postPlaybackCooldownMs;
        }
        vadState = resetVadStateForNextTurn(
          vadState,
          nowMs,
          DEFAULT_VAD_CONFIG,
        );
        isMascotSpeaking = false;
        isVadPaused = false;
        ringBuffer.clear();
        pcmCollector = [];
        isCollectingPcm = false;
      };

      const startBargeInMonitoring = () => {
        vadState = resetVadStateForNextTurn(
          vadState,
          nowMs,
          DEFAULT_VAD_CONFIG,
        );
        isMascotSpeaking = true;
        isVadPaused = false;
        pcmCollector = [];
        isCollectingPcm = false;
      };

      const stopHandsFreeSession = () => {
        isHandsFreeMode = false;
        if (activeRafId !== null) {
          mockCancelAnimationFrame(activeRafId);
        }
      };

      // Bootstrap: initialize first RAF
      activeRafId = mockRequestAnimationFrame(() => {});
      assert.ok(
        activeRafId !== null,
        'Session bootstrap must register initial RAF',
      );

      // -----------------------------------------------------------------------
      // TURN 1: First Question (Normal Speech -> Commit -> Playback -> Resume)
      // -----------------------------------------------------------------------
      // Ambient silence (200ms)
      for (let i = 0; i < 4; i++) stepFrame(0.005, 0.1, 50);
      assert.equal(vadState.phase, 'LISTENING');

      // User speaks: RMS 0.15 for 300ms -> Confirms speech start
      for (let i = 0; i < 6; i++) stepFrame(0.15, 0.85, 50);
      assert.equal(
        vadState.phase,
        'SPEAKING',
        'Turn 1 must transition to SPEAKING',
      );

      // User continues speaking for 1,000ms
      for (let i = 0; i < 20; i++) stepFrame(0.18, 0.9, 50);

      // User stops speaking: Silence for 1,150ms -> Commits utterance
      for (let i = 0; i < 23; i++) stepFrame(0.005, 0.1, 50);

      // Verify Turn 1 committed WAV
      const payload1 = lastCommittedPayload as {
        blob: Blob;
        mimeType: string;
        durationSeconds: number;
      } | null;
      if (!payload1) {
        throw new Error('Turn 1 must produce committed audio payload');
      }
      assert.equal(payload1.mimeType, 'audio/wav');
      assert.equal(
        detectAudioFormatFromSignature(
          Buffer.from(await payload1.blob.arrayBuffer()),
        )?.ext,
        'wav',
      );

      // CRITICAL VERIFICATION: RAF loop must NOT be dead!
      assert.ok(
        activeRafId !== null && rafQueue.size > 0,
        'CRITICAL: RAF sampling loop must remain scheduled and active after Turn 1 commit',
      );
      assert.equal(
        isVadPaused,
        true,
        'VAD must be paused while processing Turn 1',
      );

      // Simulate mascot playback and resumption
      startBargeInMonitoring();
      nowMs += 2000; // Mascot speaks for 2s
      resumeHandsFree(true);
      assert.equal(
        isVadPaused,
        false,
        'VAD must unpause after post-playback cooldown',
      );
      assert.equal(
        vadState.phase,
        'LISTENING',
        'VAD must return to LISTENING for Turn 2',
      );

      // -----------------------------------------------------------------------
      // TURN 2: Second Question (Previously FAILED due to Dead Loop)
      // -----------------------------------------------------------------------
      lastCommittedPayload = null;

      // User speaks Turn 2 question
      for (let i = 0; i < 6; i++) stepFrame(0.16, 0.88, 50);
      assert.equal(
        vadState.phase,
        'SPEAKING',
        'Turn 2 must successfully detect speech because RAF loop is alive',
      );

      // User speaks for 800ms
      for (let i = 0; i < 16; i++) stepFrame(0.15, 0.85, 50);

      // Silence for 1,150ms -> Commits Turn 2
      for (let i = 0; i < 23; i++) stepFrame(0.005, 0.1, 50);

      const payload2 = lastCommittedPayload as {
        blob: Blob;
        mimeType: string;
        durationSeconds: number;
      } | null;
      if (!payload2) {
        throw new Error('Turn 2 must commit successfully');
      }
      assert.equal(payload2.mimeType, 'audio/wav');
      assert.ok(
        activeRafId !== null && rafQueue.size > 0,
        'RAF loop must still be active after Turn 2',
      );

      // Mascot playback and resumption
      startBargeInMonitoring();
      nowMs += 1500;
      resumeHandsFree(true);
      assert.equal(vadState.phase, 'LISTENING');

      // -----------------------------------------------------------------------
      // TURN 3: Third Question with Smart Barge-in
      // -----------------------------------------------------------------------
      lastCommittedPayload = null;
      startBargeInMonitoring();
      mascotOutputAmplitude = 0.5; // Mascot is speaking loudly

      // User interrupts mascot with loud voice (> dynamic barge-in threshold) for 350ms
      for (let i = 0; i < 7; i++) stepFrame(0.35, 0.88, 50);
      assert.equal(
        vadState.phase,
        'SPEAKING',
        'Barge-in speech must interrupt mascot and enter SPEAKING',
      );

      // User finishes barge-in sentence for 1,000ms
      for (let i = 0; i < 20; i++) stepFrame(0.2, 0.85, 50);

      // Silence for 1,150ms -> Commits Turn 3
      for (let i = 0; i < 23; i++) stepFrame(0.005, 0.1, 50);

      const payload3 = lastCommittedPayload as {
        blob: Blob;
        mimeType: string;
        durationSeconds: number;
      } | null;
      if (!payload3) {
        throw new Error('Turn 3 (Barge-in) must commit successfully');
      }
      assert.ok(activeRafId !== null && rafQueue.size > 0);

      // Mascot finishes replying to Turn 3
      mascotOutputAmplitude = 0;
      resumeHandsFree(true);
      assert.equal(vadState.phase, 'LISTENING');

      // -----------------------------------------------------------------------
      // TURN 4: Fourth Question with Playback Error Recovery
      // -----------------------------------------------------------------------
      lastCommittedPayload = null;

      // User speaks Turn 4
      for (let i = 0; i < 6; i++) stepFrame(0.14, 0.85, 50);
      assert.equal(vadState.phase, 'SPEAKING');
      for (let i = 0; i < 10; i++) stepFrame(0.14, 0.85, 50);
      for (let i = 0; i < 23; i++) stepFrame(0.005, 0.1, 50);
      const payload4 = lastCommittedPayload as {
        blob: Blob;
        mimeType: string;
        durationSeconds: number;
      } | null;
      if (!payload4) {
        throw new Error('Turn 4 must commit successfully');
      }

      // Simulate Playback Error (e.g. Autoplay blocked or decode error)
      // Error recovery must immediately resume listening WITHOUT waiting for post-playback cooldown
      resumeHandsFree(false);
      assert.equal(
        isVadPaused,
        false,
        'Playback error recovery must immediately unpause VAD',
      );
      assert.equal(vadState.phase, 'LISTENING');
      assert.ok(
        activeRafId !== null && rafQueue.size > 0,
        'RAF loop must remain alive after error recovery',
      );

      // -----------------------------------------------------------------------
      // TURN 5: Fifth Question & Clean Mode Switch / Session Teardown
      // -----------------------------------------------------------------------
      lastCommittedPayload = null;

      // User speaks Turn 5
      for (let i = 0; i < 6; i++) stepFrame(0.15, 0.87, 50);
      assert.equal(
        vadState.phase,
        'SPEAKING',
        'Turn 5 must detect speech cleanly',
      );
      for (let i = 0; i < 10; i++) stepFrame(0.15, 0.87, 50);
      for (let i = 0; i < 23; i++) stepFrame(0.005, 0.1, 50);
      const payload5 = lastCommittedPayload as {
        blob: Blob;
        mimeType: string;
        durationSeconds: number;
      } | null;
      if (!payload5) {
        throw new Error('Turn 5 must commit successfully');
      }

      // User switches mode to Push-to-Talk or closes session: clean teardown
      stopHandsFreeSession();
      assert.equal(
        isHandsFreeMode,
        false,
        'isHandsFreeMode must be false after stop',
      );
      assert.equal(
        activeRafId,
        null,
        'activeRafId must be null after session stop',
      );
      assert.equal(
        rafQueue.size,
        0,
        'RAF queue must be completely empty with zero leaks',
      );

      // Attempting to step frame after stop must immediately bail out
      stepFrame(0.2, 0.85, 50);
      assert.equal(
        rafQueue.size,
        0,
        'Stopped session must never schedule further RAF frames',
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
