'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClientVoiceError,
  MAX_BROWSER_AUDIO_BYTES,
  MAX_RECORDING_SECONDS,
} from '@/lib/voice/api-client';
import {
  computeTimeDomainRms,
  computeVoiceBandEnergyRatio,
  createInitialVadState,
  DEFAULT_VAD_CONFIG,
  resetVadStateForNextTurn,
  selectUtteranceChunksWithPreRoll,
  stepVadState,
  type TimestampedAudioChunk,
  type VadEngineState,
  type VadThresholdConfig,
} from '@/lib/voice/vad-engine';

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

const RECORDER_TIMESLICE_MS = 100;

export interface RecordedAudioPayload {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

export function detectSupportedRecordingMimeType(): string | null {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return null;
  }

  for (const candidate of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return '';
}

interface UseVoiceRecorderOptions {
  /** Called in Push-to-Talk mode when the 20s automatic cap stops recording. */
  onAutoStopComplete?: (payload: RecordedAudioPayload) => void;
  /** Called in Hands-Free mode when VAD detects confirmed Speech Start (~200 ms hold). */
  onVadSpeechStart?: () => void;
  /** Called in Hands-Free mode when a short noise is discarded and VAD returns to listening. */
  onVadSpeechDiscarded?: () => void;
  /** Called in Hands-Free mode when VAD detects Silence End-of-Turn or 20s max utterance cap. */
  onVadUtteranceComplete?: (payload: RecordedAudioPayload) => void;
  /** Called in Hands-Free mode when no user speech is detected for `idleTimeoutMs` (30s) in non-kiosk mode. */
  onHandsFreeIdleTimeout?: () => void;
  /** Called in KIOSK_MODE when 30s of visitor silence elapses and the kiosk resets to standby for the next visitor without closing the microphone. */
  onKioskStandbyReset?: () => void;
  /** When true (KIOSK_MODE), keeps the microphone in continuous listening standby across visitor idle periods. */
  kioskMode?: boolean;
  /** Called when a microphone or recorder runtime error occurs. */
  onRecorderError?: (error: ClientVoiceError) => void;
  /** Optional custom VAD thresholds override. */
  vadConfig?: Partial<VadThresholdConfig>;
}

export function useVoiceRecorder(options: UseVoiceRecorderOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isHandsFreeSessionActive, setIsHandsFreeSessionActive] =
    useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [micAmplitude, setMicAmplitude] = useState(0);

  const vadConfigRef = useRef<VadThresholdConfig>({
    ...DEFAULT_VAD_CONFIG,
    ...options.vadConfig,
  });

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const supportedMimeRef = useRef<string>('');
  const chunksRef = useRef<TimestampedAudioChunk<Blob>[]>([]);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postPlaybackCooldownTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const startTimeMsRef = useRef<number>(0);
  const isCancelledRef = useRef<boolean>(false);
  const isHandsFreeModeRef = useRef<boolean>(false);
  const isVadPausedRef = useRef<boolean>(false);
  const isDiscardRestartRef = useRef<boolean>(false);
  const vadSpeechOriginMsRef = useRef<number>(0);

  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micAnalyserNodeRef = useRef<AnalyserNode | null>(null);
  const vadRafIdRef = useRef<number | null>(null);
  const vadStateRef = useRef<VadEngineState>(createInitialVadState(0));
  const startHandsFreeSegmentRef = useRef<() => void>(() => {});

  const stopResolverRef = useRef<
    ((payload: RecordedAudioPayload | null) => void) | null
  >(null);

  const onAutoStopRef = useRef(options.onAutoStopComplete);
  const onVadSpeechStartRef = useRef(options.onVadSpeechStart);
  const onVadSpeechDiscardedRef = useRef(options.onVadSpeechDiscarded);
  const onVadUtteranceCompleteRef = useRef(options.onVadUtteranceComplete);
  const onHandsFreeIdleTimeoutRef = useRef(options.onHandsFreeIdleTimeout);
  const onKioskStandbyResetRef = useRef(options.onKioskStandbyReset);
  const kioskModeRef = useRef(Boolean(options.kioskMode));
  const isStartingHandsFreeRef = useRef(false);
  const onErrorRef = useRef(options.onRecorderError);

  useEffect(() => {
    onAutoStopRef.current = options.onAutoStopComplete;
    onVadSpeechStartRef.current = options.onVadSpeechStart;
    onVadSpeechDiscardedRef.current = options.onVadSpeechDiscarded;
    onVadUtteranceCompleteRef.current = options.onVadUtteranceComplete;
    onHandsFreeIdleTimeoutRef.current = options.onHandsFreeIdleTimeout;
    onKioskStandbyResetRef.current = options.onKioskStandbyReset;
    kioskModeRef.current = Boolean(options.kioskMode);
    onErrorRef.current = options.onRecorderError;
  }, [
    options.onAutoStopComplete,
    options.onVadSpeechStart,
    options.onVadSpeechDiscarded,
    options.onVadUtteranceComplete,
    options.onHandsFreeIdleTimeout,
    options.onKioskStandbyReset,
    options.kioskMode,
    options.onRecorderError,
  ]);

  const clearTimers = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (autoStopTimeoutRef.current) {
      clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }
    if (postPlaybackCooldownTimeoutRef.current) {
      clearTimeout(postPlaybackCooldownTimeoutRef.current);
      postPlaybackCooldownTimeoutRef.current = null;
    }
  }, []);

  const stopVadLoop = useCallback(() => {
    if (vadRafIdRef.current !== null) {
      cancelAnimationFrame(vadRafIdRef.current);
      vadRafIdRef.current = null;
    }
    setMicAmplitude(0);
  }, []);

  const disconnectMicAudioGraph = useCallback(() => {
    stopVadLoop();
    if (micSourceNodeRef.current) {
      try {
        micSourceNodeRef.current.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      micSourceNodeRef.current = null;
    }
    micAnalyserNodeRef.current = null;
  }, [stopVadLoop]);

  const stopMediaTracks = useCallback(() => {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors
        }
      }
      mediaStreamRef.current = null;
    }
  }, []);

  const cleanupRecorder = useCallback(() => {
    clearTimers();
    disconnectMicAudioGraph();
    stopMediaTracks();
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    isHandsFreeModeRef.current = false;
    isVadPausedRef.current = false;
    isDiscardRestartRef.current = false;
    setIsRecording(false);
    setIsHandsFreeSessionActive(false);
    setElapsedSeconds(0);
    setMicAmplitude(0);
  }, [clearTimers, disconnectMicAudioGraph, stopMediaTracks]);

  useEffect(() => {
    return () => {
      isCancelledRef.current = true;
      isHandsFreeModeRef.current = false;
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore stop errors during unmount
        }
      }
      clearTimers();
      disconnectMicAudioGraph();
      stopMediaTracks();
      if (
        micAudioContextRef.current &&
        micAudioContextRef.current.state !== 'closed'
      ) {
        micAudioContextRef.current.close().catch(() => {});
        micAudioContextRef.current = null;
      }
    };
  }, [clearTimers, disconnectMicAudioGraph, stopMediaTracks]);

  const requestMicrophoneStream =
    useCallback(async (): Promise<MediaStream> => {
      if (
        typeof window === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === 'undefined'
      ) {
        throw new ClientVoiceError(
          'MIC_UNSUPPORTED',
          400,
          'เบราว์เซอร์นี้ไม่รองรับการบันทึกเสียงผ่านไมโครโฟน กรุณาใช้งานผ่าน Google Chrome',
        );
      }

      const supportedMime = detectSupportedRecordingMimeType();
      if (supportedMime === null) {
        throw new ClientVoiceError(
          'MIME_UNSUPPORTED',
          415,
          'เบราว์เซอร์ไม่รองรับรูปแบบการบันทึกเสียงที่ระบบต้องการ',
        );
      }
      supportedMimeRef.current = supportedMime;

      // Always stop any lingering previous MediaStream to prevent duplicate open mic streams
      stopMediaTracks();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        mediaStreamRef.current = stream;
        return stream;
      } catch (err) {
        const domErrorName = err instanceof Error ? err.name : '';
        if (
          domErrorName === 'NotAllowedError' ||
          domErrorName === 'PermissionDeniedError'
        ) {
          throw new ClientVoiceError(
            'MIC_PERMISSION_DENIED',
            403,
            'ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน กรุณากดอนุญาตการใช้ไมโครโฟนบนแถบที่อยู่ของเบราว์เซอร์แล้วลองใหม่',
          );
        }
        if (
          domErrorName === 'NotFoundError' ||
          domErrorName === 'DevicesNotFoundError'
        ) {
          throw new ClientVoiceError(
            'MIC_NOT_FOUND',
            404,
            'ไม่พบอุปกรณ์ไมโครโฟนในเครื่องของคุณ กรุณาเชื่อมต่อไมโครโฟนแล้วลองใหม่',
          );
        }
        throw new ClientVoiceError(
          'MIC_ERROR',
          500,
          'ไม่สามารถเปิดใช้งานไมโครโฟนได้ กรุณาตรวจสอบอุปกรณ์แล้วลองใหม่',
        );
      }
    }, [stopMediaTracks]);

  /**
   * Starts a fresh MediaRecorder segment on the active Hands-Free `MediaStream`
   * so each utterance gets a valid container header and bounded rolling pre-roll chunks.
   */
  const startHandsFreeRecorderSegment = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream || !isHandsFreeModeRef.current) {
      return;
    }

    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      return;
    }

    const supportedMime = supportedMimeRef.current;
    let recorder: MediaRecorder;
    try {
      recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);
    } catch {
      cleanupRecorder();
      onErrorRef.current?.(
        new ClientVoiceError(
          'RECORDER_INIT_FAILED',
          415,
          'ไม่สามารถเริ่มต้นตัวบันทึกเสียงในโหมดสนทนาต่อเนื่องได้',
        ),
      );
      return;
    }

    chunksRef.current = [];
    isCancelledRef.current = false;
    isDiscardRestartRef.current = false;
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) {
        return;
      }
      const nowMs = performance.now();
      chunksRef.current.push({
        chunk: event.data,
        timestampMs: nowMs,
        byteSize: event.data.size,
      });

      // While waiting in LISTENING phase, prune old chunks beyond 1.5s while keeping chunk[0] (container header)
      // so idle listening never accumulates unbounded memory.
      if (
        vadStateRef.current.phase === 'LISTENING' &&
        chunksRef.current.length > 18
      ) {
        const headerChunk = chunksRef.current[0];
        const cutoff = nowMs - 1_200;
        const recent = chunksRef.current
          .slice(1)
          .filter((c) => c.timestampMs >= cutoff);
        chunksRef.current = [headerChunk, ...recent];
      }
    };

    recorder.onerror = () => {
      cleanupRecorder();
      onErrorRef.current?.(
        new ClientVoiceError(
          'RECORDER_RUNTIME_ERROR',
          500,
          'เกิดข้อผิดพลาดระหว่างการฟังเสียงสนทนา กรุณาเริ่มสนทนาใหม่อีกครั้ง',
        ),
      );
    };

    recorder.onstop = () => {
      mediaRecorderRef.current = null;
      setIsRecording(false);
      setElapsedSeconds(0);

      if (isCancelledRef.current || !isHandsFreeModeRef.current) {
        chunksRef.current = [];
        return;
      }

      if (isDiscardRestartRef.current) {
        isDiscardRestartRef.current = false;
        chunksRef.current = [];
        if (isHandsFreeModeRef.current && !isVadPausedRef.current) {
          startHandsFreeSegmentRef.current();
        }
        return;
      }

      const actualMimeType = recorder.mimeType || supportedMime || 'audio/webm';
      const selectedBlobs = selectUtteranceChunksWithPreRoll(
        chunksRef.current,
        vadSpeechOriginMsRef.current,
        vadConfigRef.current.preSpeechBufferMs,
      );
      chunksRef.current = [];

      const blob = new Blob(selectedBlobs, { type: actualMimeType });
      if (blob.size === 0) {
        // Empty blob -> silently resume listening segment without calling STT
        if (isHandsFreeModeRef.current && !isVadPausedRef.current) {
          startHandsFreeSegmentRef.current();
        }
        return;
      }

      if (blob.size > MAX_BROWSER_AUDIO_BYTES) {
        onErrorRef.current?.(
          new ClientVoiceError(
            'AUDIO_TOO_LARGE',
            413,
            'ไฟล์เสียงที่บันทึกมีขนาดเกิน 3 MB กรุณาพูดให้กระชับขึ้น',
          ),
        );
        return;
      }

      const durationSeconds = Math.max(
        1,
        Math.round((performance.now() - vadSpeechOriginMsRef.current) / 1000),
      );

      onVadUtteranceCompleteRef.current?.({
        blob,
        mimeType: actualMimeType,
        durationSeconds,
      });
    };

    try {
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch {
      cleanupRecorder();
    }
  }, [cleanupRecorder]);

  useEffect(() => {
    startHandsFreeSegmentRef.current = startHandsFreeRecorderSegment;
  }, [startHandsFreeRecorderSegment]);

  /**
   * Starts the Web Audio API AnalyserNode loop for Local Browser VAD.
   */
  const startVadSamplingLoop = useCallback(
    (stream: MediaStream) => {
      stopVadLoop();

      if (!micAudioContextRef.current) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        micAudioContextRef.current = new AudioCtx();
      }

      const audioCtx = micAudioContextRef.current;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      if (micSourceNodeRef.current) {
        try {
          micSourceNodeRef.current.disconnect();
        } catch {
          // Ignore
        }
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser);

      micSourceNodeRef.current = source;
      micAnalyserNodeRef.current = analyser;

      const timeDomainData = new Uint8Array(analyser.fftSize);
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      vadStateRef.current = createInitialVadState(
        performance.now(),
        vadConfigRef.current,
      );

      const sampleMicFrame = () => {
        if (!isHandsFreeModeRef.current || !mediaStreamRef.current) {
          return;
        }

        const nowMs = performance.now();
        analyser.getByteTimeDomainData(timeDomainData);
        analyser.getByteFrequencyData(frequencyData);

        const rms = computeTimeDomainRms(timeDomainData);
        const voiceBandRatio = computeVoiceBandEnergyRatio(
          frequencyData,
          audioCtx.sampleRate,
          analyser.fftSize,
        );

        if (isVadPausedRef.current) {
          setMicAmplitude(0);
        } else {
          setMicAmplitude(Math.min(1, rms * 10));
        }

        const step = stepVadState(
          vadStateRef.current,
          {
            nowMs,
            rms,
            voiceBandRatio,
            isPlaybackOrProcessingPaused: isVadPausedRef.current,
            kioskStandbyMode: kioskModeRef.current,
          },
          vadConfigRef.current,
        );
        vadStateRef.current = step.state;

        if (step.state.phase === 'SPEAKING') {
          const secs = Math.min(
            MAX_RECORDING_SECONDS,
            Math.floor(step.utteranceDurationMs / 1000),
          );
          setElapsedSeconds(secs);
        }

        if (step.action === 'SPEECH_START_CONFIRMED') {
          vadSpeechOriginMsRef.current =
            step.state.confirmedSpeechStartMs ?? nowMs;
          setIsRecording(true);
          setElapsedSeconds(0);
          onVadSpeechStartRef.current?.();
        } else if (step.action === 'DISCARD_SHORT_NOISE') {
          setIsRecording(false);
          setElapsedSeconds(0);
          onVadSpeechDiscardedRef.current?.();
        } else if (
          step.action === 'END_OF_SPEECH_COMMIT' ||
          step.action === 'MAX_UTTERANCE_COMMIT'
        ) {
          // Pause VAD immediately so no duplicate STT requests can fire while processing
          isVadPausedRef.current = true;
          setIsRecording(false);
          setMicAmplitude(0);

          const recorder = mediaRecorderRef.current;
          if (recorder && recorder.state !== 'inactive') {
            try {
              recorder.stop();
            } catch {
              // Ignore stop errors
            }
          }
        } else if (step.action === 'KIOSK_STANDBY_RESET') {
          // In KIOSK_MODE, keep microphone open and ready for the next visitor
          onKioskStandbyResetRef.current?.();
        } else if (step.action === 'IDLE_TIMEOUT') {
          // Auto-sleep session after 30s of user silence (when not in KIOSK_MODE)
          isCancelledRef.current = true;
          isHandsFreeModeRef.current = false;
          const recorder = mediaRecorderRef.current;
          if (recorder && recorder.state !== 'inactive') {
            try {
              recorder.stop();
            } catch {
              // Ignore
            }
          }
          cleanupRecorder();
          onHandsFreeIdleTimeoutRef.current?.();
          return;
        }

        vadRafIdRef.current = requestAnimationFrame(sampleMicFrame);
      };

      vadRafIdRef.current = requestAnimationFrame(sampleMicFrame);
    },
    [cleanupRecorder, stopVadLoop],
  );

  /**
   * Starts a continuous Hands-Free / Kiosk conversation session.
   * Guarded by `isStartingHandsFreeRef` so React StrictMode double-mounts or rapid calls
   * never open duplicate MediaStreams.
   */
  const startHandsFreeSession = useCallback(async (): Promise<void> => {
    if (
      isStartingHandsFreeRef.current ||
      (isHandsFreeModeRef.current && mediaStreamRef.current)
    ) {
      return;
    }

    isStartingHandsFreeRef.current = true;
    try {
      clearTimers();
      isCancelledRef.current = false;
      isHandsFreeModeRef.current = true;
      isVadPausedRef.current = false;

      const stream = await requestMicrophoneStream();
      setIsHandsFreeSessionActive(true);
      setIsRecording(false);
      setElapsedSeconds(0);

      startHandsFreeRecorderSegment();
      startVadSamplingLoop(stream);
    } catch (err) {
      isHandsFreeModeRef.current = false;
      setIsHandsFreeSessionActive(false);
      throw err;
    } finally {
      isStartingHandsFreeRef.current = false;
    }
  }, [
    clearTimers,
    requestMicrophoneStream,
    startHandsFreeRecorderSegment,
    startVadSamplingLoop,
  ]);

  /**
   * Pauses VAD listening during STT, LLM, TTS, and Mascot Audio Playback
   * so mascot speaker output is NEVER captured as a new user utterance (Phase 1 Self-Listening Prevention).
   */
  const pauseHandsFreeListening = useCallback(() => {
    if (!isHandsFreeModeRef.current) {
      return;
    }
    if (postPlaybackCooldownTimeoutRef.current) {
      clearTimeout(postPlaybackCooldownTimeoutRef.current);
      postPlaybackCooldownTimeoutRef.current = null;
    }
    isVadPausedRef.current = true;
    setIsRecording(false);
    setElapsedSeconds(0);
    setMicAmplitude(0);

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      isDiscardRestartRef.current = true;
      try {
        recorder.stop();
      } catch {
        // Ignore
      }
    }
  }, []);

  /**
   * Resumes Hands-Free listening after mascot audio playback finishes and
   * waits for the post-playback acoustic tail (`postPlaybackCooldownMs`, default 350 ms) to settle.
   */
  const resumeHandsFreeListening = useCallback(
    (applyPostPlaybackTailCooldown = true) => {
      if (!isHandsFreeModeRef.current || !mediaStreamRef.current) {
        return;
      }

      if (postPlaybackCooldownTimeoutRef.current) {
        clearTimeout(postPlaybackCooldownTimeoutRef.current);
        postPlaybackCooldownTimeoutRef.current = null;
      }

      const activateListening = () => {
        if (!isHandsFreeModeRef.current || !mediaStreamRef.current) {
          return;
        }
        vadStateRef.current = resetVadStateForNextTurn(
          vadStateRef.current,
          performance.now(),
          vadConfigRef.current,
        );
        isVadPausedRef.current = false;
        setIsRecording(false);
        setElapsedSeconds(0);
        startHandsFreeRecorderSegment();
      };

      if (applyPostPlaybackTailCooldown) {
        isVadPausedRef.current = true;
        postPlaybackCooldownTimeoutRef.current = setTimeout(() => {
          postPlaybackCooldownTimeoutRef.current = null;
          activateListening();
        }, vadConfigRef.current.postPlaybackCooldownMs);
      } else {
        activateListening();
      }
    },
    [startHandsFreeRecorderSegment],
  );

  /**
   * Ends the Hands-Free conversation session and immediately closes the OS microphone stream.
   */
  const stopHandsFreeSession = useCallback(() => {
    isCancelledRef.current = true;
    isHandsFreeModeRef.current = false;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Ignore stop errors
      }
    }
    cleanupRecorder();
  }, [cleanupRecorder]);

  // ===========================================================================
  // Existing Push-to-Talk Mode (100% Preserved for Regression & Manual Toggle)
  // ===========================================================================
  const startRecording = useCallback(async (): Promise<void> => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      return;
    }

    isHandsFreeModeRef.current = false;
    setIsHandsFreeSessionActive(false);

    const stream = await requestMicrophoneStream();
    const supportedMime = supportedMimeRef.current;

    chunksRef.current = [];
    isCancelledRef.current = false;
    stopResolverRef.current = null;

    let recorder: MediaRecorder;
    try {
      recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);
    } catch {
      stopMediaTracks();
      throw new ClientVoiceError(
        'RECORDER_INIT_FAILED',
        415,
        'ไม่สามารถเริ่มต้นตัวบันทึกเสียงในรูปแบบที่รองรับได้',
      );
    }

    mediaRecorderRef.current = recorder;
    startTimeMsRef.current = Date.now();
    setElapsedSeconds(0);
    setIsRecording(true);

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push({
          chunk: event.data,
          timestampMs: performance.now(),
          byteSize: event.data.size,
        });
      }
    };

    recorder.onerror = () => {
      cleanupRecorder();
      onErrorRef.current?.(
        new ClientVoiceError(
          'RECORDER_RUNTIME_ERROR',
          500,
          'เกิดข้อผิดพลาดระหว่างการบันทึกเสียง กรุณาลองใหม่อีกครั้ง',
        ),
      );
    };

    recorder.onstop = () => {
      clearTimers();
      stopMediaTracks();
      setIsRecording(false);

      const wasCancelled = isCancelledRef.current;
      const recordedChunks = chunksRef.current.map((c) => c.chunk);
      const actualMimeType = recorder.mimeType || supportedMime || 'audio/webm';
      const durationSeconds = Math.max(
        1,
        Math.round((Date.now() - startTimeMsRef.current) / 1000),
      );

      chunksRef.current = [];
      mediaRecorderRef.current = null;
      setElapsedSeconds(0);

      if (wasCancelled) {
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        resolver?.(null);
        return;
      }

      const blob = new Blob(recordedChunks, { type: actualMimeType });
      if (blob.size === 0) {
        const emptyError = new ClientVoiceError(
          'EMPTY_RECORDING',
          400,
          'ไม่พบสัญญาณเสียงที่บันทึก กรุณาพูดหลังกดปุ่มไมโครโฟน',
        );
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        if (resolver) {
          resolver(null);
        }
        onErrorRef.current?.(emptyError);
        return;
      }

      if (blob.size > MAX_BROWSER_AUDIO_BYTES) {
        const sizeError = new ClientVoiceError(
          'AUDIO_TOO_LARGE',
          413,
          'ไฟล์เสียงที่บันทึกมีขนาดเกิน 3 MB กรุณาบันทึกเสียงให้สั้นลง',
        );
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        if (resolver) {
          resolver(null);
        }
        onErrorRef.current?.(sizeError);
        return;
      }

      const payload: RecordedAudioPayload = {
        blob,
        mimeType: actualMimeType,
        durationSeconds,
      };

      const resolver = stopResolverRef.current;
      stopResolverRef.current = null;
      if (resolver) {
        resolver(payload);
      } else {
        onAutoStopRef.current?.(payload);
      }
    };

    recorder.start(200);

    timerIntervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeMsRef.current) / 1000);
      setElapsedSeconds(Math.min(elapsed, MAX_RECORDING_SECONDS));
    }, 250);

    autoStopTimeoutRef.current = setTimeout(() => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === 'recording'
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          cleanupRecorder();
        }
      }
    }, MAX_RECORDING_SECONDS * 1000);
  }, [cleanupRecorder, clearTimers, requestMicrophoneStream, stopMediaTracks]);

  const stopAndSubmitRecording =
    useCallback((): Promise<RecordedAudioPayload | null> => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        cleanupRecorder();
        return Promise.resolve(null);
      }

      isCancelledRef.current = false;
      return new Promise<RecordedAudioPayload | null>((resolve) => {
        stopResolverRef.current = resolve;
        try {
          recorder.stop();
        } catch {
          cleanupRecorder();
          resolve(null);
        }
      });
    }, [cleanupRecorder]);

  const cancelRecording = useCallback(() => {
    isCancelledRef.current = true;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Ignore stop errors on cancel
      }
    }
    cleanupRecorder();
  }, [cleanupRecorder]);

  return {
    isRecording,
    isHandsFreeSessionActive,
    elapsedSeconds,
    maxRecordingSeconds: MAX_RECORDING_SECONDS,
    micAmplitude,
    startHandsFreeSession,
    pauseHandsFreeListening,
    resumeHandsFreeListening,
    stopHandsFreeSession,
    startRecording,
    stopAndSubmitRecording,
    cancelRecording,
  };
}
