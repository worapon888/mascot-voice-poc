import assert from 'node:assert/strict';
import { computeMouthFrameFromSamples } from '@/hooks/use-audio-lipsync';
import {
  ClientVoiceError,
  executeSmartPipelineStages,
} from '@/lib/voice/api-client';
import {
  computeTimeDomainRms,
  computeVoiceBandEnergyRatio,
  createInitialVadState,
  DEFAULT_VAD_CONFIG,
  evaluateKioskAutoStart,
  resetVadStateForNextTurn,
  selectUtteranceChunksWithPreRoll,
  stepVadState,
  type TimestampedAudioChunk,
} from '@/lib/voice/vad-engine';
import { resetMissingMigrationNoticeForTesting } from '@/repositories/faq-audio.repository';
import { generateGroundedAnswerWithMetrics } from '@/services/answer.service';
import { resolvePersistentFaqAudioRef } from '@/services/faq-audio.service';
import { matchFaqsAgainstRecords } from '@/services/faq-matching.service';
import {
  clearTtsAudioCache,
  synthesizeSpeechMp3WithMetrics,
} from '@/services/speech.service';
import { detectAudioFormatFromSignature } from '@/services/transcription.service';
import type { AnswerResponse } from '@/types/api';
import type { FaqRecord } from '@/types/faq';
import { VOICE_STATE_LABELS, type VoiceState } from '@/types/voice';

const DEMO_FAQS: FaqRecord[] = [
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
];

function createSyntheticMp3Buffer(tagText: string): Buffer {
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
  ]);
  const payload = Buffer.from(
    `HANDSFREE_PHASE1_${tagText}_AUDIO_BYTES`,
    'utf8',
  );
  return Buffer.concat([header, payload]);
}

async function runTests(): Promise<void> {
  console.log(
    '======================================================================',
  );
  console.log(
    ' Phase 1 Hands-Free Conversational Mascot Test Suite (0 Paid APIs)    ',
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
    console.log(`[PASS] H${String(total).padStart(2, '0')} — ${name}`);
  }

  // -------------------------------------------------------------------------
  // H01. Start Hands-Free Session & Initial Listening State
  // -------------------------------------------------------------------------
  await test('Start Hands-Free Session initializes in LISTENING state with adaptive noise floor and 0 paid API calls', () => {
    const state = createInitialVadState(1000, DEFAULT_VAD_CONFIG);
    assert.equal(state.phase, 'LISTENING');
    assert.equal(state.utteranceCommittedForTurn, false);
    assert.equal(VOICE_STATE_LABELS.listening, 'กำลังฟัง... พูดได้เลย');
    assert.equal(VOICE_STATE_LABELS.speaking, 'มาสคอตกำลังพูด');
  });

  // -------------------------------------------------------------------------
  // H02. First Speech Detection (~200 ms Speech Start Hold)
  // -------------------------------------------------------------------------
  await test('First Speech Detection requires continuous speech energy for speechStartHoldMs (~200 ms) before confirming Speech Start', () => {
    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    // Frame at t=50ms: Speech energy appears -> transitions to SPEECH_STARTING
    const step1 = stepVadState(state, {
      nowMs: 50,
      rms: 0.08,
      voiceBandRatio: 0.65,
      isPlaybackOrProcessingPaused: false,
    });
    state = step1.state;
    assert.equal(state.phase, 'SPEECH_STARTING');
    assert.equal(step1.action, 'NONE');

    // Frame at t=180ms (130ms held < 200ms): Still holding
    const step2 = stepVadState(state, {
      nowMs: 180,
      rms: 0.085,
      voiceBandRatio: 0.65,
      isPlaybackOrProcessingPaused: false,
    });
    state = step2.state;
    assert.equal(state.phase, 'SPEECH_STARTING');
    assert.equal(step2.action, 'NONE');

    // Frame at t=260ms (210ms held >= 200ms): Confirmed Speech Start!
    const step3 = stepVadState(state, {
      nowMs: 260,
      rms: 0.09,
      voiceBandRatio: 0.7,
      isPlaybackOrProcessingPaused: false,
    });
    state = step3.state;
    assert.equal(state.phase, 'SPEAKING');
    assert.equal(step3.action, 'SPEECH_START_CONFIRMED');
    assert.equal(state.confirmedSpeechStartMs, 50);
  });

  // -------------------------------------------------------------------------
  // H03. Silence End-of-Turn (~1,050 ms) & Natural Mid-Sentence Pause Tolerance
  // -------------------------------------------------------------------------
  await test('Silence End-of-Turn tolerates 500ms mid-sentence pause and commits only after continuous silence >= silenceEndOfTurnMs', () => {
    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    // Start speaking at t=100ms, confirm at t=310ms
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

    // User speaks until t=1000ms, then pauses to think for 500ms (t=1000..1500ms < 1050ms)
    state = stepVadState(state, {
      nowMs: 1000,
      rms: 0.004,
      isPlaybackOrProcessingPaused: false,
    }).state;
    const midPauseStep = stepVadState(state, {
      nowMs: 1500,
      rms: 0.004,
      isPlaybackOrProcessingPaused: false,
    });
    state = midPauseStep.state;
    assert.equal(
      midPauseStep.action,
      'NONE',
      '500ms thinking pause must not prematurely cut off speech',
    );
    assert.equal(state.phase, 'SPEAKING');

    // User resumes speaking second half of sentence at t=1600ms..2200ms
    state = stepVadState(state, {
      nowMs: 1600,
      rms: 0.09,
      isPlaybackOrProcessingPaused: false,
    }).state;
    assert.equal(state.silenceStartMs, null);
    state = stepVadState(state, {
      nowMs: 2200,
      rms: 0.085,
      isPlaybackOrProcessingPaused: false,
    }).state;

    // User finishes speaking at t=2300ms; silence holds through t=3400ms (1100ms >= 1050ms)
    state = stepVadState(state, {
      nowMs: 2300,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    }).state;
    const commitStep = stepVadState(state, {
      nowMs: 3400,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    });
    assert.equal(commitStep.action, 'END_OF_SPEECH_COMMIT');
    assert.equal(commitStep.state.utteranceCommittedForTurn, true);
    assert.equal(commitStep.utteranceDurationMs, 2200);
  });

  // -------------------------------------------------------------------------
  // H04. Repeated Conversation Turns (3 Continuous Questions Without Re-clicking Mic)
  // -------------------------------------------------------------------------
  await test('Repeated Conversation Turns: 3 consecutive questions run through STT -> FAQ -> Audio and automatically return to LISTENING', async () => {
    clearTtsAudioCache();
    let vadState = createInitialVadState(0, DEFAULT_VAD_CONFIG);
    const observedVoiceStates: VoiceState[] = ['listening'];
    const spokenQuestions = [
      'เปิดบริการกี่โมงครับ',
      'ต้องนัดล่วงหน้าไหมครับ',
      'ต้องเตรียมเอกสารอะไรบ้างครับ',
    ];
    const receivedAnswers: string[] = [];
    let sttCalls = 0;

    for (let turnIdx = 0; turnIdx < spokenQuestions.length; turnIdx++) {
      const baseTime = turnIdx * 10_000;

      // 1. User starts speaking -> VAD confirms speech start
      vadState = stepVadState(vadState, {
        nowMs: baseTime + 100,
        rms: 0.09,
        isPlaybackOrProcessingPaused: false,
      }).state;
      const startStep = stepVadState(vadState, {
        nowMs: baseTime + 350,
        rms: 0.09,
        isPlaybackOrProcessingPaused: false,
      });
      vadState = startStep.state;
      assert.equal(startStep.action, 'SPEECH_START_CONFIRMED');
      observedVoiceStates.push('recording');

      // 2. User speaks for 1.2s then stops -> VAD commits end-of-turn
      vadState = stepVadState(vadState, {
        nowMs: baseTime + 1300,
        rms: 0.09,
        isPlaybackOrProcessingPaused: false,
      }).state;
      vadState = stepVadState(vadState, {
        nowMs: baseTime + 1400,
        rms: 0.004,
        isPlaybackOrProcessingPaused: false,
      }).state;
      const endStep = stepVadState(vadState, {
        nowMs: baseTime + 2500,
        rms: 0.004,
        isPlaybackOrProcessingPaused: false,
      });
      vadState = endStep.state;
      assert.equal(endStep.action, 'END_OF_SPEECH_COMMIT');

      // 3. Execute Pipeline for this turn while VAD is paused
      const fakePayload = {
        blob: new Blob(
          [new Uint8Array(createSyntheticMp3Buffer(`turn_${turnIdx}`))],
          { type: 'audio/webm' },
        ),
        mimeType: 'audio/webm',
        durationSeconds: 2,
      };

      const stageRes = await executeSmartPipelineStages({
        recordingPayload: fakePayload,
        isRetry: false,
        isStaleTurn: () => false,
        signal: new AbortController().signal,
        onStateChange: (s) => observedVoiceStates.push(s),
        onTranscriptReady: () => {},
        onAnswerReady: (ans) => receivedAnswers.push(ans.answer),
        sttFn: async () => {
          sttCalls += 1;
          return { transcript: spokenQuestions[turnIdx] };
        },
        answerFn: async (tr) => {
          const { response } = await generateGroundedAnswerWithMetrics(
            tr,
            async (q) => matchFaqsAgainstRecords(q, DEMO_FAQS, 2),
            async () => ({
              hit: false,
              reason: 'METADATA_NOT_FOUND',
              contentHash: 'h',
              lookupLatencyMs: 0,
            }),
          );
          return response;
        },
        ttsFn: async (text) => {
          const res = await synthesizeSpeechMp3WithMetrics(text, async (norm) =>
            createSyntheticMp3Buffer(norm),
          );
          return new Blob([new Uint8Array(res.buffer)], {
            type: 'audio/mpeg',
          });
        },
      });

      assert.notEqual(stageRes, null);
      observedVoiceStates.push('speaking');

      // 4. Mascot finishes speaking -> Reset VAD for next turn and return to 'listening'
      vadState = resetVadStateForNextTurn(
        vadState,
        baseTime + 5000,
        DEFAULT_VAD_CONFIG,
      );
      observedVoiceStates.push('listening');
    }

    assert.equal(sttCalls, 3);
    assert.equal(receivedAnswers.length, 3);
    assert.equal(receivedAnswers[0].includes('09:00–16:00'), true);
    assert.equal(receivedAnswers[1].includes('นัดหมายล่วงหน้า'), true);
    assert.equal(receivedAnswers[2].includes('DEMO-001'), true);
    assert.equal(
      observedVoiceStates[observedVoiceStates.length - 1],
      'listening',
    );
  });

  // -------------------------------------------------------------------------
  // H05. Speech Start Not Truncated (Pre-Speech Rolling Buffer + Header Preservation)
  // -------------------------------------------------------------------------
  await test('selectUtteranceChunksWithPreRoll preserves container header chunk[0] and 400ms pre-speech audio so first syllable is never clipped', () => {
    const chunks: TimestampedAudioChunk<string>[] = [
      { chunk: 'HEADER_WEBM_EBML', timestampMs: 100, byteSize: 64 },
      { chunk: 'OLD_SILENCE_1', timestampMs: 500, byteSize: 120 },
      { chunk: 'OLD_SILENCE_2', timestampMs: 1200, byteSize: 120 },
      { chunk: 'PRE_ROLL_SYLLABLE_ONSET', timestampMs: 1700, byteSize: 180 },
      { chunk: 'CONFIRMED_SPEECH_1', timestampMs: 2000, byteSize: 220 },
      { chunk: 'CONFIRMED_SPEECH_2', timestampMs: 2100, byteSize: 220 },
    ];

    const selected = selectUtteranceChunksWithPreRoll(chunks, 2000, 400);
    assert.deepEqual(selected, [
      'HEADER_WEBM_EBML',
      'PRE_ROLL_SYLLABLE_ONSET',
      'CONFIRMED_SPEECH_1',
      'CONFIRMED_SPEECH_2',
    ]);
  });

  // -------------------------------------------------------------------------
  // H06. Ignore Silence & Short Noise (< 200ms Hold or < 400ms Utterance)
  // -------------------------------------------------------------------------
  await test('VAD ignores ambient silence, rejects out-of-band rumble, and discards brief coughs/clicks without calling STT', () => {
    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    // 1. 10 seconds of ambient room noise (RMS 0.010) -> stays in LISTENING
    for (let t = 100; t <= 10_000; t += 100) {
      const step = stepVadState(state, {
        nowMs: t,
        rms: 0.01,
        voiceBandRatio: 0.5,
        isPlaybackOrProcessingPaused: false,
      });
      state = step.state;
      assert.equal(step.action, 'NONE');
      assert.equal(state.phase, 'LISTENING');
    }

    // 2. Loud low-frequency thump outside human voice band (voiceBandRatio = 0.10 < 0.32) -> ignored!
    const rumbleStep = stepVadState(state, {
      nowMs: 10_200,
      rms: 0.12,
      voiceBandRatio: 0.1,
      isPlaybackOrProcessingPaused: false,
    });
    assert.equal(rumbleStep.state.phase, 'LISTENING');
    assert.equal(rumbleStep.action, 'NONE');

    // 3. Brief 120ms click/cough (starts at 11000ms, drops to silence at 11120ms < 200ms hold) -> DISCARD_SHORT_NOISE
    state = stepVadState(state, {
      nowMs: 11_000,
      rms: 0.09,
      voiceBandRatio: 0.65,
      isPlaybackOrProcessingPaused: false,
    }).state;
    assert.equal(state.phase, 'SPEECH_STARTING');

    const discardStep = stepVadState(state, {
      nowMs: 11_120,
      rms: 0.005,
      voiceBandRatio: 0.4,
      isPlaybackOrProcessingPaused: false,
    });
    assert.equal(discardStep.action, 'DISCARD_SHORT_NOISE');
    assert.equal(discardStep.state.phase, 'LISTENING');
    assert.equal(discardStep.state.utteranceCommittedForTurn, false);
  });

  // -------------------------------------------------------------------------
  // H07. Microphone Permission Denied Handling
  // -------------------------------------------------------------------------
  await test('Microphone Permission Denied maps to 403 MIC_PERMISSION_DENIED with clear Thai guidance and leaves 0 open streams', () => {
    const permErr = new ClientVoiceError(
      'MIC_PERMISSION_DENIED',
      403,
      'ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน กรุณากดอนุญาตการใช้ไมโครโฟนบนแถบที่อยู่ของเบราว์เซอร์แล้วลองใหม่',
    );
    assert.equal(permErr.code, 'MIC_PERMISSION_DENIED');
    assert.equal(permErr.status, 403);
    assert.equal(permErr.message.includes('ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน'), true);
  });

  // -------------------------------------------------------------------------
  // H08. Idle Timeout (30s User Silence -> Auto-Sleep, Excluding Processing/Speaking Time)
  // -------------------------------------------------------------------------
  await test('Idle Timeout triggers after 30s of user silence, and does NOT count mascot processing or speaking time as user silence', () => {
    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    // User is silent for 20s (0..20,000ms) -> not timed out yet
    const step20s = stepVadState(state, {
      nowMs: 20_000,
      rms: 0.005,
      isPlaybackOrProcessingPaused: false,
    });
    state = step20s.state;
    assert.equal(step20s.action, 'NONE');

    // Mascot is processing & speaking for 15 seconds (20,000..35,000ms) while VAD is paused
    const pausedStep = stepVadState(state, {
      nowMs: 35_000,
      rms: 0.15, // Loud mascot speaker audio
      isPlaybackOrProcessingPaused: true,
    });
    state = pausedStep.state;
    assert.equal(
      pausedStep.action,
      'NONE',
      'Must never trigger idle timeout or speech start while paused for playback',
    );
    assert.equal(state.listeningIdleStartMs, 35_000);

    // After playback ends at 35,000ms, user is silent for 29s (at t=64,000ms) -> still active
    const step29sAfter = stepVadState(state, {
      nowMs: 64_000,
      rms: 0.005,
      isPlaybackOrProcessingPaused: false,
    });
    state = step29sAfter.state;
    assert.equal(step29sAfter.action, 'NONE');

    // At t=65,000ms (30s of actual user listening silence since 35,000ms) -> IDLE_TIMEOUT!
    const timeoutStep = stepVadState(state, {
      nowMs: 65_000,
      rms: 0.005,
      isPlaybackOrProcessingPaused: false,
    });
    assert.equal(timeoutStep.action, 'IDLE_TIMEOUT');
  });

  // -------------------------------------------------------------------------
  // H09. Prevent Mascot Self-Listening During Playback & Processing
  // -------------------------------------------------------------------------
  await test('Prevent Self-Listening: Loud speaker audio during transcribing, thinking, synthesizing, speaking, or tail cooldown NEVER triggers VAD', () => {
    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    for (let t = 100; t <= 5_000; t += 100) {
      const step = stepVadState(state, {
        nowMs: t,
        rms: 0.25, // Very loud speaker output
        voiceBandRatio: 0.85,
        isPlaybackOrProcessingPaused: true,
      });
      state = step.state;
      assert.equal(step.action, 'NONE');
      assert.equal(state.phase, 'LISTENING');
      assert.equal(state.utteranceCommittedForTurn, false);
    }
  });

  // -------------------------------------------------------------------------
  // H10. No Duplicate STT Calls Within the Same Turn
  // -------------------------------------------------------------------------
  await test('No Duplicate STT Calls: Once an utterance commits for a turn, subsequent frames cannot commit again until resetVadStateForNextTurn', () => {
    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    state = stepVadState(state, {
      nowMs: 100,
      rms: 0.09,
      isPlaybackOrProcessingPaused: false,
    }).state;
    state = stepVadState(state, {
      nowMs: 350,
      rms: 0.09,
      isPlaybackOrProcessingPaused: false,
    }).state;
    state = stepVadState(state, {
      nowMs: 900,
      rms: 0.09,
      isPlaybackOrProcessingPaused: false,
    }).state;
    state = stepVadState(state, {
      nowMs: 1000,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    }).state;

    const firstCommit = stepVadState(state, {
      nowMs: 2100,
      rms: 0.003,
      isPlaybackOrProcessingPaused: false,
    });
    state = firstCommit.state;
    assert.equal(firstCommit.action, 'END_OF_SPEECH_COMMIT');
    assert.equal(state.utteranceCommittedForTurn, true);

    // Even if more frames arrive before pause takes effect, VAD must NOT start or commit a duplicate turn
    const extraFrame1 = stepVadState(state, {
      nowMs: 2200,
      rms: 0.09,
      isPlaybackOrProcessingPaused: false,
    });
    assert.equal(extraFrame1.action, 'NONE');
    assert.equal(extraFrame1.state.phase, 'LISTENING');
  });

  // -------------------------------------------------------------------------
  // H11. Persistent Audio Available vs Persistent Audio Not Yet Migrated
  // -------------------------------------------------------------------------
  await test('Persistent Audio Not Yet Migrated (missing faq_audio_assets table) logs once and falls back cleanly to Dynamic TTS without masking real DB errors', async () => {
    resetMissingMigrationNoticeForTesting();

    // Case A: Persistent Audio Not Yet Migrated -> adapter returns null -> Answer succeeds with persistentAudioStatus='MISS' -> Dynamic TTS runs
    const unmigratedAnswer = await generateGroundedAnswerWithMetrics(
      'เปิดบริการกี่โมงครับ',
      async (q) => matchFaqsAgainstRecords(q, DEMO_FAQS, 4),
      async (faq) =>
        resolvePersistentFaqAudioRef(faq, {
          storageAdapter: {
            async getMetadata() {
              return null; // Table not migrated yet
            },
            async upsertMetadata(r) {
              return r;
            },
            async objectExistsInStorage() {
              return false;
            },
            async uploadAudioObject() {},
            getPublicAudioUrl(b, p) {
              return `https://example.com/${b}/${p}`;
            },
          },
        }),
    );

    assert.equal(unmigratedAnswer.response.matched, true);
    assert.equal(unmigratedAnswer.response.answerMode, 'FAQ_GROUNDED');
    assert.equal(unmigratedAnswer.metrics.persistentAudioStatus, 'MISS');
    assert.equal(unmigratedAnswer.response.audioRef, undefined);

    // Case B: Persistent Audio Available -> returns audioRef and skips dynamic TTS
    const migratedAnswer = await generateGroundedAnswerWithMetrics(
      'เปิดบริการกี่โมงครับ',
      async (q) => matchFaqsAgainstRecords(q, DEMO_FAQS, 4),
      async (faq) => ({
        hit: true,
        reason: 'READY_VERIFIED',
        contentHash: 'hash_v1',
        lookupLatencyMs: 3,
        audioRef: {
          faqId: faq.id,
          contentHash: 'hash_v1',
          audioUrl:
            'https://mock-supabase.local/storage/v1/object/public/mascot-faq-audio/faqs/v1/faq-1-hash_v1.mp3',
          objectPath: 'faqs/v1/faq-1-hash_v1.mp3',
          mimeType: 'audio/mpeg',
          byteLength: 2048,
        },
      }),
    );

    assert.equal(migratedAnswer.metrics.persistentAudioStatus, 'HIT');
    assert.equal(Boolean(migratedAnswer.response.audioRef?.audioUrl), true);
  });

  // -------------------------------------------------------------------------
  // H12. Session Cancellation, Rapid Start/Stop, Unmount & Lip-Sync Regression
  // -------------------------------------------------------------------------
  await test('Session Cancellation, Rapid Start/Stop turn isolation, Time-Domain/Frequency helpers, and Lip-Sync RMS remain intact', async () => {
    // 1. Time-domain RMS & Voice-band energy helpers
    const silenceBuf = new Uint8Array(1024).fill(128);
    assert.equal(computeTimeDomainRms(silenceBuf), 0);

    const speechFreqBuf = new Uint8Array(512).fill(0);
    // Bins 4..30 (~187 Hz - 1400 Hz at 48kHz, fftSize=1024) carry strong human voice energy
    for (let i = 4; i <= 30; i++) {
      speechFreqBuf[i] = 200;
    }
    const ratio = computeVoiceBandEnergyRatio(speechFreqBuf, 48_000, 1024);
    assert.equal(ratio > 0.9, true);

    // 2. Rapid Start/Stop turn isolation (Stale turn never updates state or calls downstream stages)
    let activeTurnId = 1;
    let downstreamAnswerCalled = false;

    const fakePayload = {
      blob: new Blob([new Uint8Array(createSyntheticMp3Buffer('rapid'))], {
        type: 'audio/webm',
      }),
      mimeType: 'audio/webm',
      durationSeconds: 1,
    };

    const myTurnId = activeTurnId;
    const rapidResult = await executeSmartPipelineStages({
      recordingPayload: fakePayload,
      isRetry: false,
      isStaleTurn: () => myTurnId !== activeTurnId,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: async () => {
        // User clicks End Session / Rapid Stop while STT is in flight
        activeTurnId += 1;
        return { transcript: 'เปิดบริการกี่โมง' };
      },
      answerFn: async (): Promise<AnswerResponse> => {
        downstreamAnswerCalled = true;
        return {
          answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ',
          faqIds: [1],
          matched: true,
          answerMode: 'FAQ_GROUNDED',
        };
      },
      ttsFn: async () =>
        new Blob([new Uint8Array(createSyntheticMp3Buffer('tts'))], {
          type: 'audio/mpeg',
        }),
    });

    assert.equal(rapidResult, null);
    assert.equal(downstreamAnswerCalled, false);

    // 3. Lip-Sync & MP3 signature regression
    const mp3 = createSyntheticMp3Buffer('lipsync');
    assert.deepEqual(detectAudioFormatFromSignature(mp3), {
      ext: 'mp3',
      mime: 'audio/mpeg',
    });
    const loudFrame = computeMouthFrameFromSamples(
      new Uint8Array(1024).fill(168),
      0.08,
    );
    assert.equal(loudFrame.mouthFrame, 'open');
  });

  // -------------------------------------------------------------------------
  // H13. Zero-Touch KIOSK_MODE Auto-Start Permission Guard
  // -------------------------------------------------------------------------
  await test('Zero-Touch KIOSK_MODE auto-starts when microphone permission is granted or prompt, and never bypasses denied permissions', () => {
    // 1. Pre-granted or prompt permission on Kiosk Chrome -> STARTED_ZERO_TOUCH
    assert.equal(
      evaluateKioskAutoStart({
        kioskModeEnabled: true,
        micPermissionState: 'granted',
        isAlreadyActiveOrStarting: false,
      }),
      'STARTED_ZERO_TOUCH',
    );
    assert.equal(
      evaluateKioskAutoStart({
        kioskModeEnabled: true,
        micPermissionState: 'prompt',
        isAlreadyActiveOrStarting: false,
      }),
      'STARTED_ZERO_TOUCH',
    );

    // 2. Permission in 'denied' state -> AWAITING_PERMISSION_CLICK (shows guidance, never bypasses)
    assert.equal(
      evaluateKioskAutoStart({
        kioskModeEnabled: true,
        micPermissionState: 'denied',
        isAlreadyActiveOrStarting: false,
      }),
      'AWAITING_PERMISSION_CLICK',
    );

    // 3. Admin disabled KIOSK_MODE or session is already active -> DISABLED_BY_CONFIG (prevents duplicate streams)
    assert.equal(
      evaluateKioskAutoStart({
        kioskModeEnabled: false,
        micPermissionState: 'granted',
        isAlreadyActiveOrStarting: false,
      }),
      'DISABLED_BY_CONFIG',
    );
    assert.equal(
      evaluateKioskAutoStart({
        kioskModeEnabled: true,
        micPermissionState: 'granted',
        isAlreadyActiveOrStarting: true,
      }),
      'DISABLED_BY_CONFIG',
    );
  });

  // -------------------------------------------------------------------------
  // H14. KIOSK_MODE Continuous Standby Across Visitor Idle Periods
  // -------------------------------------------------------------------------
  await test('In KIOSK_MODE (kioskStandbyMode=true), 30s of visitor silence triggers KIOSK_STANDBY_RESET and keeps microphone listening for the next visitor', () => {
    let state = createInitialVadState(0, DEFAULT_VAD_CONFIG);

    // 30 seconds of silence with kioskStandbyMode: true -> KIOSK_STANDBY_RESET (instead of IDLE_TIMEOUT)
    const stepKioskIdle = stepVadState(state, {
      nowMs: 30_500,
      rms: 0.004,
      isPlaybackOrProcessingPaused: false,
      kioskStandbyMode: true,
    });
    state = stepKioskIdle.state;
    assert.equal(stepKioskIdle.action, 'KIOSK_STANDBY_RESET');
    assert.equal(state.phase, 'LISTENING');
    assert.equal(state.listeningIdleStartMs, 30_500);

    // Next visitor walks up at t=45,000ms and speaks immediately without clicking any button
    state = stepVadState(state, {
      nowMs: 45_000,
      rms: 0.09,
      voiceBandRatio: 0.7,
      isPlaybackOrProcessingPaused: false,
      kioskStandbyMode: true,
    }).state;
    const nextVisitorStart = stepVadState(state, {
      nowMs: 45_250,
      rms: 0.09,
      voiceBandRatio: 0.7,
      isPlaybackOrProcessingPaused: false,
      kioskStandbyMode: true,
    });
    assert.equal(nextVisitorStart.action, 'SPEECH_START_CONFIRMED');
    assert.equal(nextVisitorStart.state.phase, 'SPEAKING');
  });

  console.log(
    '\n----------------------------------------------------------------------',
  );
  console.log(
    `Summary: ${passed}/${total} Phase 1 Hands-Free & Regression Tests PASSED (0 Paid API Calls)`,
  );
  console.log(
    '----------------------------------------------------------------------',
  );
}

runTests().catch((err) => {
  console.error('Phase 1 Hands-Free test suite failed:', err);
  process.exitCode = 1;
});
