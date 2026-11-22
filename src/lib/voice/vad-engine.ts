export interface VadThresholdConfig {
  /** Minimum baseline RMS required to consider audio as potential speech (default: 0.022). */
  minSpeechRms: number;
  /** Multiplier above adaptive ambient noise floor to trigger speech start (default: 2.6). */
  noiseFloorSpeechMultiplier: number;
  /** Minimum baseline RMS for silence/end-of-turn detection (default: 0.015). */
  minSilenceRms: number;
  /** Multiplier above adaptive ambient noise floor below which audio is treated as silence (default: 1.75). */
  noiseFloorSilenceMultiplier: number;
  /** Minimum human voice-band spectral energy ratio (85 Hz - 3400 Hz) when frequency data is available (default: 0.32). */
  minVoiceBandRatio: number;
  /** Continuous speech duration (ms) required before confirming Speech Start (default: 200 ms). */
  speechStartHoldMs: number;
  /** Continuous silence duration (ms) after speech start required to trigger End-of-Turn (default: 1050 ms). */
  silenceEndOfTurnMs: number;
  /** Minimum valid total utterance duration (ms) to submit to STT; shorter noises are discarded (default: 400 ms). */
  minValidUtteranceMs: number;
  /** Maximum single utterance recording duration (ms) before auto-submitting (default: 20000 ms). */
  maxUtteranceMs: number;
  /** Continuous idle listening duration (ms) with no speech before auto-sleeping the session (default: 30000 ms). */
  idleTimeoutMs: number;
  /** Pre-speech rolling buffer duration (ms) kept so first syllable is never clipped (default: 400 ms). */
  preSpeechBufferMs: number;
  /** Cooldown tail duration (ms) after mascot audio playback ends before re-arming microphone VAD (default: 350 ms). */
  postPlaybackCooldownMs: number;
  /** Adaptive noise floor EMA update alpha during quiet frames (default: 0.06). */
  noiseFloorAlpha: number;
  /** Initial noise floor RMS estimate before calibration settles (default: 0.008). */
  initialNoiseFloorRms: number;
  /** Maximum capped noise floor RMS so loud transient noise does not permanently deafen VAD (default: 0.045). */
  maxNoiseFloorRms: number;
  /** Minimum baseline RMS required to consider audio as a Barge-in candidate while mascot is speaking (default: 0.036). */
  bargeInMinRms: number;
  /** Multiplier above adaptive noise floor required during mascot speech for Barge-in (default: 3.4). */
  bargeInNoiseFloorMultiplier: number;
  /** Additional RMS margin scaled by `mascotOutputAmplitude` (0..1) to reject speaker acoustic bleed (default: 0.18). */
  bargeInOutputEchoMultiplier: number;
  /** Stricter minimum human voice-band energy ratio (85 Hz - 3400 Hz) required for Barge-in (default: 0.38). */
  bargeInMinVoiceBandRatio: number;
  /** Continuous speech hold duration (ms) required during mascot playback before confirming Barge-in (default: 300 ms). */
  bargeInHoldMs: number;
  /** Maximum mascot output amplitude (0..1) above which Barge-in is suppressed to prevent clipped speaker self-interruption (default: 0.92). */
  maxSafeBargeInOutputAmplitude: number;
}

export const DEFAULT_VAD_CONFIG: VadThresholdConfig = {
  minSpeechRms: 0.022,
  noiseFloorSpeechMultiplier: 2.6,
  minSilenceRms: 0.015,
  noiseFloorSilenceMultiplier: 1.75,
  minVoiceBandRatio: 0.32,
  speechStartHoldMs: 200,
  silenceEndOfTurnMs: 1_050,
  minValidUtteranceMs: 400,
  maxUtteranceMs: 20_000,
  idleTimeoutMs: 30_000,
  preSpeechBufferMs: 400,
  postPlaybackCooldownMs: 350,
  noiseFloorAlpha: 0.06,
  initialNoiseFloorRms: 0.008,
  maxNoiseFloorRms: 0.045,
  bargeInMinRms: 0.036,
  bargeInNoiseFloorMultiplier: 3.4,
  bargeInOutputEchoMultiplier: 0.18,
  bargeInMinVoiceBandRatio: 0.38,
  bargeInHoldMs: 300,
  maxSafeBargeInOutputAmplitude: 0.92,
};

export interface VadFrameInput {
  nowMs: number;
  rms: number;
  voiceBandRatio?: number;
  /** True when mascot is transcribing, thinking, synthesizing, or in post-playback tail cooldown (or when Barge-in is disabled during speaking). */
  isPlaybackOrProcessingPaused: boolean;
  /** When true (KIOSK_MODE), the microphone remains continuously in LISTENING standby for the next visitor instead of auto-terminating after idleTimeoutMs. */
  kioskStandbyMode?: boolean;
  /** True when mascot is actively speaking (`voiceState === 'speaking'`) and Smart Barge-in monitoring is active. */
  isMascotSpeaking?: boolean;
  /** Current normalized mascot speaker output amplitude (0..1) from Web Audio lip-sync analyser. */
  mascotOutputAmplitude?: number;
}

export type VadDetectorPhase = 'LISTENING' | 'SPEECH_STARTING' | 'SPEAKING';

export type VadTransitionAction =
  | 'NONE'
  | 'SPEECH_START_CONFIRMED'
  | 'BARGE_IN_CONFIRMED'
  | 'END_OF_SPEECH_COMMIT'
  | 'DISCARD_SHORT_NOISE'
  | 'MAX_UTTERANCE_COMMIT'
  | 'IDLE_TIMEOUT'
  | 'KIOSK_STANDBY_RESET';

export interface VadEngineState {
  phase: VadDetectorPhase;
  noiseFloorRms: number;
  speechCandidateStartMs: number | null;
  confirmedSpeechStartMs: number | null;
  silenceStartMs: number | null;
  listeningIdleStartMs: number;
  lastFrameMs: number;
  currentSpeechThreshold: number;
  currentSilenceThreshold: number;
  utteranceCommittedForTurn: boolean;
}

export interface VadStepResult {
  state: VadEngineState;
  action: VadTransitionAction;
  utteranceDurationMs: number;
  idleElapsedMs: number;
}

/**
 * Computes time-domain RMS from unsigned 8-bit Web Audio AnalyserNode samples (centered at 128).
 */
export function computeTimeDomainRms(timeDomainData: Uint8Array): number {
  const len = timeDomainData.length;
  if (len === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let i = 0; i < len; i++) {
    const norm = (timeDomainData[i] - 128) / 128;
    sumSquares += norm * norm;
  }
  return Math.sqrt(sumSquares / len);
}

/**
 * Computes the ratio of spectral energy concentrated in the human speech frequency band (85 Hz - 3400 Hz)
 * relative to total energy across all FFT bins. Helps reject low-frequency rumble and high-frequency clicks.
 */
export function computeVoiceBandEnergyRatio(
  frequencyData: Uint8Array,
  sampleRate = 48_000,
  fftSize = 1024,
): number {
  const binCount = frequencyData.length;
  if (binCount === 0 || sampleRate <= 0 || fftSize <= 0) {
    return 1;
  }

  const hzPerBin = sampleRate / fftSize;
  const minVoiceBin = Math.max(1, Math.floor(85 / hzPerBin));
  const maxVoiceBin = Math.min(binCount - 1, Math.ceil(3_400 / hzPerBin));

  let voiceBandSum = 0;
  let totalSum = 0;

  for (let i = 1; i < binCount; i++) {
    const magnitude = frequencyData[i];
    totalSum += magnitude;
    if (i >= minVoiceBin && i <= maxVoiceBin) {
      voiceBandSum += magnitude;
    }
  }

  if (totalSum === 0) {
    return 0;
  }

  return voiceBandSum / totalSum;
}

/**
 * Creates the initial deterministic VAD engine state at timestamp `nowMs`.
 */
export function createInitialVadState(
  nowMs: number,
  config: VadThresholdConfig = DEFAULT_VAD_CONFIG,
): VadEngineState {
  const noiseFloor = config.initialNoiseFloorRms;
  return {
    phase: 'LISTENING',
    noiseFloorRms: noiseFloor,
    speechCandidateStartMs: null,
    confirmedSpeechStartMs: null,
    silenceStartMs: null,
    listeningIdleStartMs: nowMs,
    lastFrameMs: nowMs,
    currentSpeechThreshold: Math.max(
      config.minSpeechRms,
      noiseFloor * config.noiseFloorSpeechMultiplier,
    ),
    currentSilenceThreshold: Math.max(
      config.minSilenceRms,
      noiseFloor * config.noiseFloorSilenceMultiplier,
    ),
    utteranceCommittedForTurn: false,
  };
}

/**
 * Resets the VAD state when returning to `listening` after mascot playback finishes
 * and the post-playback audio tail cooldown has settled.
 */
export function resetVadStateForNextTurn(
  prevState: VadEngineState,
  nowMs: number,
  config: VadThresholdConfig = DEFAULT_VAD_CONFIG,
): VadEngineState {
  const preservedNoiseFloor = prevState.noiseFloorRms;
  return {
    phase: 'LISTENING',
    noiseFloorRms: preservedNoiseFloor,
    speechCandidateStartMs: null,
    confirmedSpeechStartMs: null,
    silenceStartMs: null,
    listeningIdleStartMs: nowMs,
    lastFrameMs: nowMs,
    currentSpeechThreshold: Math.max(
      config.minSpeechRms,
      preservedNoiseFloor * config.noiseFloorSpeechMultiplier,
    ),
    currentSilenceThreshold: Math.max(
      config.minSilenceRms,
      preservedNoiseFloor * config.noiseFloorSilenceMultiplier,
    ),
    utteranceCommittedForTurn: false,
  };
}

/**
 * Computes the dynamic microphone RMS threshold required to trigger Smart Barge-in
 * while the mascot is actively speaking. Scales upward with both the ambient noise floor
 * and the current mascot speaker output amplitude (`mascotOutputAmplitude`).
 */
export function computeDynamicBargeInThreshold(
  noiseFloorRms: number,
  mascotOutputAmplitude = 0,
  config: VadThresholdConfig = DEFAULT_VAD_CONFIG,
): number {
  const safeOutputAmp = Math.max(0, Math.min(1, mascotOutputAmplitude));
  return Math.max(
    config.bargeInMinRms,
    noiseFloorRms * config.bargeInNoiseFloorMultiplier,
    config.minSpeechRms + safeOutputAmp * config.bargeInOutputEchoMultiplier,
  );
}

/**
 * Pure, deterministic step function for Local Browser Voice Activity Detection (Phase 1 + Phase 2 Smart Barge-in).
 *
 * Guarantees:
 * - While `isPlaybackOrProcessingPaused === true` (transcribing, thinking, synthesizing, or audio tail),
 *   the detector NEVER triggers speech start, NEVER submits self-audio to STT, and pauses the user idle timeout clock.
 * - While `isMascotSpeaking === true` (and `isPlaybackOrProcessingPaused === false`), enforces Echo-Aware Dynamic Barge-in:
 *   requires `rms >= computeDynamicBargeInThreshold(...)`, `voiceBandRatio >= bargeInMinVoiceBandRatio`,
 *   `mascotOutputAmplitude <= maxSafeBargeInOutputAmplitude`, and continuous speech hold for `bargeInHoldMs` (~300 ms)
 *   before emitting `'BARGE_IN_CONFIRMED'`.
 * - Adapts speech and silence thresholds dynamically to the ambient noise floor.
 * - Requires continuous speech energy for `speechStartHoldMs` (~200 ms) before confirming normal Speech Start.
 * - Requires continuous silence for `silenceEndOfTurnMs` (~1,050 ms) before committing End-of-Turn.
 * - Discards brief noises shorter than `minValidUtteranceMs` without calling STT.
 * - Prevents duplicate STT submissions for the same turn via `utteranceCommittedForTurn`.
 */
export function stepVadState(
  prevState: VadEngineState,
  input: VadFrameInput,
  config: VadThresholdConfig = DEFAULT_VAD_CONFIG,
): VadStepResult {
  const {
    nowMs,
    rms,
    voiceBandRatio = 1,
    isPlaybackOrProcessingPaused,
    kioskStandbyMode = false,
    isMascotSpeaking = false,
    mascotOutputAmplitude = 0,
  } = input;

  // 1. Self-Listening Prevention & Processing Pause
  if (isPlaybackOrProcessingPaused) {
    const pausedState: VadEngineState = {
      ...prevState,
      phase: 'LISTENING',
      speechCandidateStartMs: null,
      confirmedSpeechStartMs: null,
      silenceStartMs: null,
      // Advance idle start timestamp so processing/speaking time is never counted as user silence
      listeningIdleStartMs: nowMs,
      lastFrameMs: nowMs,
    };
    return {
      state: pausedState,
      action: 'NONE',
      utteranceDurationMs: 0,
      idleElapsedMs: 0,
    };
  }

  // 1B. Phase 2 Smart Barge-in Mode while Mascot is actively speaking
  if (isMascotSpeaking) {
    const preservedNoiseFloor = prevState.noiseFloorRms;
    const bargeInThreshold = computeDynamicBargeInThreshold(
      preservedNoiseFloor,
      mascotOutputAmplitude,
      config,
    );
    const bargeInHoldFloor = Math.max(
      config.minSilenceRms,
      bargeInThreshold * 0.75,
    );
    const isOutputSaturated =
      mascotOutputAmplitude > config.maxSafeBargeInOutputAmplitude;
    const hasBargeInVoiceBand =
      voiceBandRatio >= config.bargeInMinVoiceBandRatio;

    const isBargeInStartFrame =
      !isOutputSaturated && rms >= bargeInThreshold && hasBargeInVoiceBand;
    const isBargeInSustainFrame =
      !isOutputSaturated && rms >= bargeInHoldFloor && hasBargeInVoiceBand;

    if (prevState.phase === 'LISTENING') {
      if (isBargeInStartFrame && !prevState.utteranceCommittedForTurn) {
        return {
          state: {
            ...prevState,
            phase: 'SPEECH_STARTING',
            speechCandidateStartMs: nowMs,
            confirmedSpeechStartMs: null,
            silenceStartMs: null,
            listeningIdleStartMs: nowMs,
            lastFrameMs: nowMs,
            currentSpeechThreshold: bargeInThreshold,
            currentSilenceThreshold: bargeInHoldFloor,
          },
          action: 'NONE',
          utteranceDurationMs: 0,
          idleElapsedMs: 0,
        };
      }

      return {
        state: {
          ...prevState,
          listeningIdleStartMs: nowMs,
          lastFrameMs: nowMs,
          currentSpeechThreshold: bargeInThreshold,
          currentSilenceThreshold: bargeInHoldFloor,
        },
        action: 'NONE',
        utteranceDurationMs: 0,
        idleElapsedMs: 0,
      };
    }

    if (prevState.phase === 'SPEECH_STARTING') {
      const startMs = prevState.speechCandidateStartMs ?? nowMs;
      if (!isBargeInSustainFrame) {
        return {
          state: {
            ...prevState,
            phase: 'LISTENING',
            speechCandidateStartMs: null,
            confirmedSpeechStartMs: null,
            silenceStartMs: null,
            listeningIdleStartMs: nowMs,
            lastFrameMs: nowMs,
            currentSpeechThreshold: bargeInThreshold,
            currentSilenceThreshold: bargeInHoldFloor,
          },
          action: 'DISCARD_SHORT_NOISE',
          utteranceDurationMs: Math.max(0, nowMs - startMs),
          idleElapsedMs: 0,
        };
      }

      const heldDurationMs = Math.max(0, nowMs - startMs);
      if (heldDurationMs >= config.bargeInHoldMs) {
        return {
          state: {
            ...prevState,
            phase: 'SPEAKING',
            confirmedSpeechStartMs: startMs,
            silenceStartMs: null,
            listeningIdleStartMs: nowMs,
            lastFrameMs: nowMs,
            currentSpeechThreshold: Math.max(
              config.minSpeechRms,
              preservedNoiseFloor * config.noiseFloorSpeechMultiplier,
            ),
            currentSilenceThreshold: Math.max(
              config.minSilenceRms,
              preservedNoiseFloor * config.noiseFloorSilenceMultiplier,
            ),
          },
          action: 'BARGE_IN_CONFIRMED',
          utteranceDurationMs: heldDurationMs,
          idleElapsedMs: 0,
        };
      }

      return {
        state: {
          ...prevState,
          listeningIdleStartMs: nowMs,
          lastFrameMs: nowMs,
          currentSpeechThreshold: bargeInThreshold,
          currentSilenceThreshold: bargeInHoldFloor,
        },
        action: 'NONE',
        utteranceDurationMs: heldDurationMs,
        idleElapsedMs: 0,
      };
    }
  }

  let nextNoiseFloor = prevState.noiseFloorRms;
  const speechThreshold = Math.max(
    config.minSpeechRms,
    nextNoiseFloor * config.noiseFloorSpeechMultiplier,
  );
  const silenceThreshold = Math.max(
    config.minSilenceRms,
    nextNoiseFloor * config.noiseFloorSilenceMultiplier,
  );

  const hasVoiceSpectralEnergy = voiceBandRatio >= config.minVoiceBandRatio;
  const isSpeechFrame = rms >= speechThreshold && hasVoiceSpectralEnergy;
  const isSilenceFrame = rms < silenceThreshold;

  // Update adaptive noise floor only while quietly listening (never adapt upward during active speech)
  if (prevState.phase === 'LISTENING' && rms < speechThreshold * 0.85) {
    const updated =
      nextNoiseFloor * (1 - config.noiseFloorAlpha) +
      rms * config.noiseFloorAlpha;
    nextNoiseFloor = Math.min(
      config.maxNoiseFloorRms,
      Math.max(0.002, updated),
    );
  }

  const nextSpeechThreshold = Math.max(
    config.minSpeechRms,
    nextNoiseFloor * config.noiseFloorSpeechMultiplier,
  );
  const nextSilenceThreshold = Math.max(
    config.minSilenceRms,
    nextNoiseFloor * config.noiseFloorSilenceMultiplier,
  );

  // 2. Phase: LISTENING (Waiting for user to start speaking)
  if (prevState.phase === 'LISTENING') {
    if (isSpeechFrame && !prevState.utteranceCommittedForTurn) {
      const nextState: VadEngineState = {
        ...prevState,
        phase: 'SPEECH_STARTING',
        noiseFloorRms: nextNoiseFloor,
        speechCandidateStartMs: nowMs,
        confirmedSpeechStartMs: null,
        silenceStartMs: null,
        lastFrameMs: nowMs,
        currentSpeechThreshold: nextSpeechThreshold,
        currentSilenceThreshold: nextSilenceThreshold,
      };
      return {
        state: nextState,
        action: 'NONE',
        utteranceDurationMs: 0,
        idleElapsedMs: Math.max(0, nowMs - prevState.listeningIdleStartMs),
      };
    }

    const idleElapsedMs = Math.max(0, nowMs - prevState.listeningIdleStartMs);
    if (idleElapsedMs >= config.idleTimeoutMs) {
      if (kioskStandbyMode) {
        return {
          state: {
            ...prevState,
            noiseFloorRms: nextNoiseFloor,
            listeningIdleStartMs: nowMs,
            lastFrameMs: nowMs,
            currentSpeechThreshold: nextSpeechThreshold,
            currentSilenceThreshold: nextSilenceThreshold,
          },
          action: 'KIOSK_STANDBY_RESET',
          utteranceDurationMs: 0,
          idleElapsedMs,
        };
      }

      return {
        state: {
          ...prevState,
          noiseFloorRms: nextNoiseFloor,
          lastFrameMs: nowMs,
          currentSpeechThreshold: nextSpeechThreshold,
          currentSilenceThreshold: nextSilenceThreshold,
        },
        action: 'IDLE_TIMEOUT',
        utteranceDurationMs: 0,
        idleElapsedMs,
      };
    }

    return {
      state: {
        ...prevState,
        noiseFloorRms: nextNoiseFloor,
        lastFrameMs: nowMs,
        currentSpeechThreshold: nextSpeechThreshold,
        currentSilenceThreshold: nextSilenceThreshold,
      },
      action: 'NONE',
      utteranceDurationMs: 0,
      idleElapsedMs,
    };
  }

  // 3. Phase: SPEECH_STARTING (Verifying speech hold duration ~200 ms to filter transient clicks/coughs)
  if (prevState.phase === 'SPEECH_STARTING') {
    const startMs = prevState.speechCandidateStartMs ?? nowMs;

    if (isSilenceFrame) {
      // Transient click/noise dropped back to silence before hold duration elapsed -> return to LISTENING
      return {
        state: {
          ...prevState,
          phase: 'LISTENING',
          speechCandidateStartMs: null,
          confirmedSpeechStartMs: null,
          silenceStartMs: null,
          lastFrameMs: nowMs,
        },
        action: 'DISCARD_SHORT_NOISE',
        utteranceDurationMs: Math.max(0, nowMs - startMs),
        idleElapsedMs: Math.max(0, nowMs - prevState.listeningIdleStartMs),
      };
    }

    const heldDurationMs = Math.max(0, nowMs - startMs);
    if (heldDurationMs >= config.speechStartHoldMs) {
      return {
        state: {
          ...prevState,
          phase: 'SPEAKING',
          confirmedSpeechStartMs: startMs,
          silenceStartMs: null,
          lastFrameMs: nowMs,
        },
        action: 'SPEECH_START_CONFIRMED',
        utteranceDurationMs: heldDurationMs,
        idleElapsedMs: 0,
      };
    }

    return {
      state: {
        ...prevState,
        lastFrameMs: nowMs,
      },
      action: 'NONE',
      utteranceDurationMs: heldDurationMs,
      idleElapsedMs: 0,
    };
  }

  // 4. Phase: SPEAKING (User is actively speaking; monitoring for end-of-turn silence or max duration cap)
  const speechOriginMs =
    prevState.confirmedSpeechStartMs ??
    prevState.speechCandidateStartMs ??
    nowMs;
  const totalUtteranceMs = Math.max(0, nowMs - speechOriginMs);

  // Guard A: Maximum utterance cap (20 seconds)
  if (
    totalUtteranceMs >= config.maxUtteranceMs &&
    !prevState.utteranceCommittedForTurn
  ) {
    return {
      state: {
        ...prevState,
        phase: 'LISTENING',
        speechCandidateStartMs: null,
        confirmedSpeechStartMs: null,
        silenceStartMs: null,
        listeningIdleStartMs: nowMs,
        lastFrameMs: nowMs,
        utteranceCommittedForTurn: true,
      },
      action: 'MAX_UTTERANCE_COMMIT',
      utteranceDurationMs: totalUtteranceMs,
      idleElapsedMs: 0,
    };
  }

  // User continues speaking -> reset silence timer (allows natural mid-sentence thinking pauses < silenceEndOfTurnMs)
  if (!isSilenceFrame) {
    return {
      state: {
        ...prevState,
        silenceStartMs: null,
        lastFrameMs: nowMs,
      },
      action: 'NONE',
      utteranceDurationMs: totalUtteranceMs,
      idleElapsedMs: 0,
    };
  }

  // Frame is below silence threshold -> start or advance silence hold timer
  const silenceOriginMs = prevState.silenceStartMs ?? nowMs;
  const silenceElapsedMs = Math.max(0, nowMs - silenceOriginMs);

  if (
    silenceElapsedMs >= config.silenceEndOfTurnMs &&
    !prevState.utteranceCommittedForTurn
  ) {
    const effectiveSpeechMs = Math.max(0, silenceOriginMs - speechOriginMs);
    if (effectiveSpeechMs < config.minValidUtteranceMs) {
      return {
        state: {
          ...prevState,
          phase: 'LISTENING',
          speechCandidateStartMs: null,
          confirmedSpeechStartMs: null,
          silenceStartMs: null,
          listeningIdleStartMs: nowMs,
          lastFrameMs: nowMs,
        },
        action: 'DISCARD_SHORT_NOISE',
        utteranceDurationMs: effectiveSpeechMs,
        idleElapsedMs: 0,
      };
    }

    return {
      state: {
        ...prevState,
        phase: 'LISTENING',
        speechCandidateStartMs: null,
        confirmedSpeechStartMs: null,
        silenceStartMs: null,
        listeningIdleStartMs: nowMs,
        lastFrameMs: nowMs,
        utteranceCommittedForTurn: true,
      },
      action: 'END_OF_SPEECH_COMMIT',
      utteranceDurationMs: effectiveSpeechMs,
      idleElapsedMs: 0,
    };
  }

  return {
    state: {
      ...prevState,
      silenceStartMs: silenceOriginMs,
      lastFrameMs: nowMs,
    },
    action: 'NONE',
    utteranceDurationMs: totalUtteranceMs,
    idleElapsedMs: 0,
  };
}

export type KioskBootstrapOutcome =
  'STARTED_ZERO_TOUCH' | 'AWAITING_PERMISSION_CLICK' | 'DISABLED_BY_CONFIG';

export interface KioskBootstrapCheckInput {
  kioskModeEnabled: boolean;
  micPermissionState: 'granted' | 'prompt' | 'denied' | 'unknown';
  isAlreadyActiveOrStarting: boolean;
}

/**
 * Pure helper that determines whether Zero-Touch Kiosk auto-start should immediately
 * open the microphone stream on page load without a click.
 *
 * Rules:
 * - Never attempts to bypass browser security: if permission is 'denied' or 'prompt',
 *   returns 'AWAITING_PERMISSION_CLICK' so the UI displays clear setup/permission instructions.
 * - When `kioskModeEnabled === true` and `micPermissionState === 'granted'` (or `'unknown'` on
 *   browsers without the Permissions API where pre-configured Kiosk flags are active),
 *   proceeds to start zero-touch listening exactly once (`!isAlreadyActiveOrStarting`).
 */
export function evaluateKioskAutoStart(
  input: KioskBootstrapCheckInput,
): KioskBootstrapOutcome {
  if (!input.kioskModeEnabled || input.isAlreadyActiveOrStarting) {
    return 'DISABLED_BY_CONFIG';
  }

  if (input.micPermissionState === 'denied') {
    return 'AWAITING_PERMISSION_CLICK';
  }

  return 'STARTED_ZERO_TOUCH';
}

export interface TimestampedAudioChunk<TChunk = Blob> {
  chunk: TChunk;
  timestampMs: number;
  byteSize: number;
}

/**
 * Pure helper that assembles an utterance's audio chunks while preserving the media container
 * header chunk (index 0) and a rolling pre-speech buffer (`preSpeechBufferMs`, default 400 ms)
 * so the user's first syllable is never truncated.
 */
export function selectUtteranceChunksWithPreRoll<TChunk>(
  allChunks: ReadonlyArray<TimestampedAudioChunk<TChunk>>,
  speechStartMs: number,
  preSpeechBufferMs: number = DEFAULT_VAD_CONFIG.preSpeechBufferMs,
): TChunk[] {
  if (allChunks.length === 0) {
    return [];
  }

  const cutoffMs = speechStartMs - preSpeechBufferMs;
  const selected: TChunk[] = [];

  for (let i = 0; i < allChunks.length; i++) {
    const item = allChunks[i];
    // Always include chunk 0 (WebM/MP4/OGG container header) OR chunks within the pre-roll window
    if (i === 0 || item.timestampMs >= cutoffMs) {
      selected.push(item.chunk);
    }
  }

  return selected;
}
