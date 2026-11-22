'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConversationPanel } from '@/components/mascot/conversation-panel';
import { MascotAvatar } from '@/components/mascot/mascot-avatar';
import { MicrophoneButton } from '@/components/mascot/microphone-button';
import { useAudioLipsync } from '@/hooks/use-audio-lipsync';
import {
  type RecordedAudioPayload,
  useVoiceRecorder,
} from '@/hooks/use-voice-recorder';
import {
  appendCompletedTurnToHistory,
  ClientVoiceError,
  executeSmartPipelineStages,
  type RetrySessionSnapshot,
} from '@/lib/voice/api-client';
import { evaluateKioskAutoStart } from '@/lib/voice/vad-engine';
import type { AnswerMode, ConversationTurn } from '@/types/api';
import type { VoiceInteractionMode, VoiceState } from '@/types/voice';

function resolveInitialKioskModeEnabled(): boolean {
  const envDefault =
    process.env.NEXT_PUBLIC_KIOSK_MODE?.trim().toLowerCase() !== 'false';
  if (typeof window === 'undefined') {
    return envDefault;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const queryParam = params.get('kiosk')?.trim().toLowerCase();
    if (queryParam === '0' || queryParam === 'false') {
      return false;
    }
    if (queryParam === '1' || queryParam === 'true') {
      return true;
    }
  } catch {
    // Ignore URL parsing errors in restricted environments
  }
  return envDefault;
}

export function VoiceChat() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [interactionMode, setInteractionMode] =
    useState<VoiceInteractionMode>('hands-free');
  const [kioskModeEnabled] = useState<boolean>(resolveInitialKioskModeEnabled);
  const [transcript, setTranscript] = useState<string>('');
  const [answer, setAnswer] = useState<string>('');
  const [matchedFaqIds, setMatchedFaqIds] = useState<number[]>([]);
  const [matched, setMatched] = useState<boolean | null>(null);
  const [answerMode, setAnswerMode] = useState<AnswerMode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState<boolean>(false);
  const [hasRetryPayload, setHasRetryPayload] = useState<boolean>(false);
  const [showDetails, setShowDetails] = useState<boolean>(false);

  const turnIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastRecordingRef = useRef<RecordedAudioPayload | null>(null);
  const retrySessionRef = useRef<RetrySessionSnapshot | null>(null);
  const conversationHistoryRef = useRef<ConversationTurn[]>([]);
  const pendingAudioBlobRef = useRef<Blob | null>(null);
  const isHandsFreeActiveRef = useRef<boolean>(false);
  const kioskBootstrappedRef = useRef<boolean>(false);
  const pauseHandsFreeFnRef = useRef<() => void>(() => {});
  const startHandsFreeBargeInFnRef = useRef<() => void>(() => {});
  const resumeHandsFreeFnRef = useRef<(cooldown?: boolean) => void>(() => {});
  const stopHandsFreeFnRef = useRef<() => void>(() => {});

  const {
    mouthFrame,
    amplitude,
    unlockAudioContext,
    playAudioBlob,
    stopAudio,
  } = useAudioLipsync();

  const abortActiveRequest = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const executeVoicePipeline = useCallback(
    async (recordingPayload: RecordedAudioPayload, isRetry = false) => {
      abortActiveRequest();
      stopAudio(true);

      // Pause microphone VAD while processing and speaking to prevent self-listening
      if (isHandsFreeActiveRef.current) {
        pauseHandsFreeFnRef.current();
      }

      const currentTurnId = ++turnIdRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      lastRecordingRef.current = recordingPayload;
      if (
        !isRetry ||
        !retrySessionRef.current ||
        retrySessionRef.current.recording !== recordingPayload
      ) {
        retrySessionRef.current = {
          recording: recordingPayload,
          transcript: null,
          answerResult: null,
          ttsBlob: null,
        };
      }

      setHasRetryPayload(true);
      pendingAudioBlobRef.current = null;
      setAutoplayBlocked(false);
      setErrorMessage(null);

      try {
        const stageResult = await executeSmartPipelineStages({
          recordingPayload,
          existingSession: retrySessionRef.current,
          isRetry,
          conversationHistory: conversationHistoryRef.current,
          isStaleTurn: () => currentTurnId !== turnIdRef.current,
          signal: controller.signal,
          onStateChange: (nextState) => {
            if (currentTurnId === turnIdRef.current) {
              setVoiceState(nextState);
            }
          },
          onTranscriptReady: (recognizedText) => {
            if (currentTurnId === turnIdRef.current) {
              setTranscript(recognizedText);
            }
          },
          onAnswerReady: (answerResult) => {
            if (currentTurnId === turnIdRef.current) {
              setAnswer(answerResult.answer);
              setMatchedFaqIds(answerResult.faqIds);
              setMatched(answerResult.matched);
              setAnswerMode(
                answerResult.answerMode ??
                  (answerResult.matched
                    ? 'FAQ_GROUNDED'
                    : 'ORGANIZATION_INFO_UNKNOWN'),
              );
            }
          },
        });

        if (!stageResult || currentTurnId !== turnIdRef.current) {
          return;
        }

        retrySessionRef.current = stageResult.session;
        const ttsBlob = stageResult.ttsBlob;

        if (
          stageResult.session.transcript &&
          stageResult.session.answerResult
        ) {
          conversationHistoryRef.current = appendCompletedTurnToHistory(
            conversationHistoryRef.current,
            stageResult.session.transcript,
            stageResult.session.answerResult,
          );
        }

        // Step D: Audio Playback + Real Web Audio API Lip-Sync + Smart Barge-in Monitoring
        setVoiceState('speaking');
        if (isHandsFreeActiveRef.current) {
          startHandsFreeBargeInFnRef.current();
        }
        const outcome = await playAudioBlob(ttsBlob);
        if (currentTurnId !== turnIdRef.current) {
          return;
        }

        if (outcome === 'autoplay-blocked') {
          pendingAudioBlobRef.current = ttsBlob;
          setAutoplayBlocked(true);
          setErrorMessage(
            'เบราว์เซอร์บล็อกการเล่นเสียงอัตโนมัติ (Autoplay Policy) กรุณากดปุ่ม "เล่นเสียงตอบกลับ" ด้านล่าง (สำหรับเครื่องตู้ Kiosk ให้เปิด Chrome ด้วยแฟล็ก --autoplay-policy=no-user-gesture-required)',
          );
          if (isHandsFreeActiveRef.current) {
            setVoiceState('listening');
            resumeHandsFreeFnRef.current(false);
          } else {
            setVoiceState('idle');
          }
          return;
        }

        // If Hands-Free session is still active, return to 'listening' after post-playback tail cooldown
        if (isHandsFreeActiveRef.current) {
          setVoiceState('listening');
          resumeHandsFreeFnRef.current(true);
        } else {
          setVoiceState('idle');
        }
      } catch (err) {
        if (currentTurnId !== turnIdRef.current) {
          return;
        }
        if (err instanceof Error && err.name === 'AbortError') {
          if (isHandsFreeActiveRef.current) {
            setVoiceState('listening');
            resumeHandsFreeFnRef.current(false);
          } else {
            setVoiceState('idle');
          }
          return;
        }

        stopAudio(true);

        // If STT returned EMPTY_TRANSCRIPT during Hands-Free listening (e.g. background noise),
        // resume listening smoothly instead of killing the continuous session.
        if (
          isHandsFreeActiveRef.current &&
          err instanceof ClientVoiceError &&
          err.code === 'EMPTY_TRANSCRIPT'
        ) {
          setErrorMessage('ยังไม่ได้ยินคำถามที่ชัดเจน ระบบกำลังรอฟังคำถามถัดไปครับ');
          setVoiceState('listening');
          resumeHandsFreeFnRef.current(false);
          return;
        }

        // For fatal/upstream errors, close any active Hands-Free mic stream so mic does not stay open in error state
        if (isHandsFreeActiveRef.current) {
          isHandsFreeActiveRef.current = false;
          stopHandsFreeFnRef.current();
        }

        const message =
          err instanceof ClientVoiceError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่อีกครั้ง';
        setErrorMessage(message);
        setVoiceState('error');
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
    },
    [abortActiveRequest, playAudioBlob, stopAudio],
  );

  const handleRecorderError = useCallback(
    (error: ClientVoiceError) => {
      turnIdRef.current += 1;
      abortActiveRequest();
      stopAudio(true);
      isHandsFreeActiveRef.current = false;
      setErrorMessage(error.message);
      setVoiceState('error');
    },
    [abortActiveRequest, stopAudio],
  );

  const {
    isHandsFreeSessionActive,
    elapsedSeconds,
    maxRecordingSeconds,
    micAmplitude,
    startHandsFreeSession,
    pauseHandsFreeListening,
    startHandsFreeBargeInMonitoring,
    resumeHandsFreeListening,
    stopHandsFreeSession,
    startRecording,
    stopAndSubmitRecording,
    cancelRecording,
  } = useVoiceRecorder({
    onAutoStopComplete: (payload) => {
      void executeVoicePipeline(payload);
    },
    onVadSpeechStart: () => {
      if (isHandsFreeActiveRef.current) {
        setErrorMessage(null);
        setVoiceState('recording');
      }
    },
    onVadBargeIn: () => {
      if (isHandsFreeActiveRef.current) {
        // Invalidate the currently speaking turn, abort any pending request,
        // immediately stop mascot audio playback & lip-sync, and switch to recording the new utterance.
        turnIdRef.current += 1;
        abortActiveRequest();
        stopAudio(true);
        pendingAudioBlobRef.current = null;
        setAutoplayBlocked(false);
        setErrorMessage(null);
        setVoiceState('recording');
      }
    },
    onVadSpeechDiscarded: () => {
      if (isHandsFreeActiveRef.current) {
        setVoiceState('listening');
      }
    },
    onVadUtteranceComplete: (payload) => {
      if (isHandsFreeActiveRef.current) {
        void executeVoicePipeline(payload);
      }
    },
    onHandsFreeIdleTimeout: () => {
      turnIdRef.current += 1;
      abortActiveRequest();
      stopAudio(true);
      isHandsFreeActiveRef.current = false;
      conversationHistoryRef.current = [];
      setVoiceState('idle');
    },
    onKioskStandbyReset: () => {
      // In KIOSK_MODE, when 30s elapses with no visitor, clear previous visitor's Q&A display
      // and conversation context, and stay in 'listening' standby so the next visitor starts fresh.
      conversationHistoryRef.current = [];
      setTranscript('');
      setAnswer('');
      setMatchedFaqIds([]);
      setMatched(null);
      setAnswerMode(null);
      setErrorMessage(null);
      setAutoplayBlocked(false);
      pendingAudioBlobRef.current = null;
      setVoiceState('listening');
    },
    kioskMode: kioskModeEnabled && interactionMode === 'hands-free',
    mascotOutputAmplitude: voiceState === 'speaking' ? amplitude : 0,
    onRecorderError: handleRecorderError,
  });

  useEffect(() => {
    pauseHandsFreeFnRef.current = pauseHandsFreeListening;
    startHandsFreeBargeInFnRef.current = startHandsFreeBargeInMonitoring;
    resumeHandsFreeFnRef.current = resumeHandsFreeListening;
    stopHandsFreeFnRef.current = stopHandsFreeSession;
  }, [
    pauseHandsFreeListening,
    resumeHandsFreeListening,
    startHandsFreeBargeInMonitoring,
    stopHandsFreeSession,
  ]);

  /**
   * Zero-Touch Kiosk Bootstrap:
   * On page load / reload, if KIOSK_MODE is enabled and the browser has pre-authorized
   * microphone access (or is running with Chrome kiosk flags), automatically enters
   * continuous `listening` state so visitors can speak immediately without clicking.
   * Never attempts to bypass browser security if permission is 'prompt' or 'denied'.
   */
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      kioskBootstrappedRef.current ||
      !kioskModeEnabled ||
      interactionMode !== 'hands-free' ||
      isHandsFreeActiveRef.current
    ) {
      return;
    }

    kioskBootstrappedRef.current = true;
    let isCancelled = false;

    const bootstrapZeroTouchKiosk = async () => {
      let micPermissionState: 'granted' | 'prompt' | 'denied' | 'unknown' =
        'unknown';

      if (navigator.permissions?.query) {
        try {
          const status = await navigator.permissions.query({
            name: 'microphone' as PermissionName,
          });
          micPermissionState = status.state;
        } catch {
          micPermissionState = 'unknown';
        }
      }

      if (isCancelled) {
        return;
      }

      const decision = evaluateKioskAutoStart({
        kioskModeEnabled,
        micPermissionState,
        isAlreadyActiveOrStarting: isHandsFreeActiveRef.current,
      });

      if (decision === 'AWAITING_PERMISSION_CLICK') {
        setErrorMessage(
          'ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน กรุณาคลิกไอคอนตั้งค่าข้างแถบ URL ของ Chrome เพื่ออนุญาตไมโครโฟน (Allow) แล้วรีโหลดหน้าเว็บ',
        );
        return;
      }

      if (decision !== 'STARTED_ZERO_TOUCH') {
        return;
      }

      try {
        await unlockAudioContext();
        await startHandsFreeSession();
        if (isCancelled) {
          stopHandsFreeSession();
          return;
        }
        isHandsFreeActiveRef.current = true;
        setErrorMessage(null);
        setVoiceState('listening');
      } catch (err) {
        if (isCancelled) {
          return;
        }
        isHandsFreeActiveRef.current = false;
        const message =
          err instanceof ClientVoiceError
            ? err.message
            : 'กรุณากดอนุญาตการใช้ไมโครโฟนบนเบราว์เซอร์เพื่อเริ่มรับฟังเสียงอัตโนมัติ';
        setErrorMessage(message);
        setVoiceState('idle');
      }
    };

    void bootstrapZeroTouchKiosk();

    return () => {
      isCancelled = true;
    };
  }, [
    interactionMode,
    kioskModeEnabled,
    startHandsFreeSession,
    stopHandsFreeSession,
    unlockAudioContext,
  ]);

  useEffect(() => {
    return () => {
      turnIdRef.current += 1;
      isHandsFreeActiveRef.current = false;
      abortActiveRequest();
      stopAudio(true);
    };
  }, [abortActiveRequest, stopAudio]);

  const handleStartPrimaryAction = useCallback(async () => {
    turnIdRef.current += 1;
    abortActiveRequest();
    stopAudio(true);
    pendingAudioBlobRef.current = null;
    setAutoplayBlocked(false);
    setErrorMessage(null);

    // Unlock Web Audio API context from this direct user click gesture
    await unlockAudioContext();

    if (interactionMode === 'hands-free') {
      try {
        await startHandsFreeSession();
        isHandsFreeActiveRef.current = true;
        setVoiceState('listening');
      } catch (err) {
        isHandsFreeActiveRef.current = false;
        const message =
          err instanceof ClientVoiceError
            ? err.message
            : 'ไม่สามารถเริ่มโหมดสนทนาต่อเนื่องได้ กรุณาตรวจสอบสิทธิ์ไมโครโฟน';
        setErrorMessage(message);
        setVoiceState('error');
      }
      return;
    }

    try {
      isHandsFreeActiveRef.current = false;
      await startRecording();
      setVoiceState('recording');
    } catch (err) {
      const message =
        err instanceof ClientVoiceError
          ? err.message
          : 'ไม่สามารถเริ่มบันทึกเสียงได้ กรุณาตรวจสอบสิทธิ์ไมโครโฟน';
      setErrorMessage(message);
      setVoiceState('error');
    }
  }, [
    abortActiveRequest,
    interactionMode,
    startHandsFreeSession,
    startRecording,
    stopAudio,
    unlockAudioContext,
  ]);

  const handleEndHandsFreeSession = useCallback(() => {
    turnIdRef.current += 1;
    isHandsFreeActiveRef.current = false;
    conversationHistoryRef.current = [];
    abortActiveRequest();
    stopHandsFreeSession();
    stopAudio(true);
    pendingAudioBlobRef.current = null;
    setAutoplayBlocked(false);
    setErrorMessage(null);
    setVoiceState('idle');
  }, [abortActiveRequest, stopAudio, stopHandsFreeSession]);

  const handleToggleInteractionMode = useCallback(
    async (nextMode: VoiceInteractionMode) => {
      if (nextMode === interactionMode) {
        if (nextMode === 'hands-free' && !isHandsFreeActiveRef.current) {
          await handleStartPrimaryAction();
        }
        return;
      }

      if (nextMode === 'push-to-talk') {
        handleEndHandsFreeSession();
        setInteractionMode('push-to-talk');
        return;
      }

      setInteractionMode('hands-free');
      turnIdRef.current += 1;
      abortActiveRequest();
      stopAudio(true);
      pendingAudioBlobRef.current = null;
      setAutoplayBlocked(false);
      setErrorMessage(null);

      try {
        await unlockAudioContext();
        await startHandsFreeSession();
        isHandsFreeActiveRef.current = true;
        setVoiceState('listening');
      } catch (err) {
        isHandsFreeActiveRef.current = false;
        const message =
          err instanceof ClientVoiceError
            ? err.message
            : 'ไม่สามารถเริ่มโหมดสนทนาต่อเนื่องได้ กรุณาตรวจสอบสิทธิ์ไมโครโฟน';
        setErrorMessage(message);
        setVoiceState('error');
      }
    },
    [
      abortActiveRequest,
      handleEndHandsFreeSession,
      handleStartPrimaryAction,
      interactionMode,
      startHandsFreeSession,
      stopAudio,
      unlockAudioContext,
    ],
  );

  const handleStopAndSubmit = useCallback(async () => {
    await unlockAudioContext();
    if (isHandsFreeActiveRef.current) {
      // In Hands-Free mode, clicking the mic while actively recording forces immediate turn submission
      pauseHandsFreeListening();
      return;
    }
    const payload = await stopAndSubmitRecording();
    if (!payload) {
      setVoiceState((prev) => (prev === 'recording' ? 'idle' : prev));
      return;
    }
    await executeVoicePipeline(payload);
  }, [
    executeVoicePipeline,
    pauseHandsFreeListening,
    stopAndSubmitRecording,
    unlockAudioContext,
  ]);

  const handleCancelRecording = useCallback(() => {
    turnIdRef.current += 1;
    isHandsFreeActiveRef.current = false;
    abortActiveRequest();
    cancelRecording();
    stopAudio(true);
    setErrorMessage(null);
    setVoiceState('idle');
  }, [abortActiveRequest, cancelRecording, stopAudio]);

  const handleCancelProcessing = useCallback(() => {
    turnIdRef.current += 1;
    abortActiveRequest();
    stopAudio(true);
    setErrorMessage(null);
    if (isHandsFreeActiveRef.current) {
      setVoiceState('listening');
      resumeHandsFreeListening(false);
    } else {
      setVoiceState('idle');
    }
  }, [abortActiveRequest, resumeHandsFreeListening, stopAudio]);

  const handleStopAudio = useCallback(() => {
    turnIdRef.current += 1;
    stopAudio(true);
    pendingAudioBlobRef.current = null;
    setAutoplayBlocked(false);
    if (isHandsFreeActiveRef.current) {
      setVoiceState('listening');
      resumeHandsFreeListening(true);
    } else {
      setVoiceState('idle');
    }
  }, [resumeHandsFreeListening, stopAudio]);

  const handlePlayBlockedAudio = useCallback(async () => {
    const blob = pendingAudioBlobRef.current;
    if (!blob) {
      return;
    }
    const currentTurnId = ++turnIdRef.current;
    if (isHandsFreeActiveRef.current) {
      pauseHandsFreeListening();
    }
    setAutoplayBlocked(false);
    setErrorMessage(null);
    try {
      await unlockAudioContext();
      setVoiceState('speaking');
      if (isHandsFreeActiveRef.current) {
        startHandsFreeBargeInMonitoring();
      }
      const outcome = await playAudioBlob(blob);
      if (currentTurnId !== turnIdRef.current) {
        return;
      }
      if (outcome === 'completed' || outcome === 'stopped') {
        pendingAudioBlobRef.current = null;
      }
      if (isHandsFreeActiveRef.current) {
        setVoiceState('listening');
        resumeHandsFreeListening(true);
      } else {
        setVoiceState('idle');
      }
    } catch (err) {
      if (currentTurnId !== turnIdRef.current) {
        return;
      }
      if (isHandsFreeActiveRef.current) {
        isHandsFreeActiveRef.current = false;
        stopHandsFreeSession();
      }
      const message =
        err instanceof ClientVoiceError
          ? err.message
          : 'ไม่สามารถเล่นเสียงตอบกลับได้ กรุณาลองใหม่อีกครั้ง';
      setErrorMessage(message);
      setVoiceState('error');
    }
  }, [
    pauseHandsFreeListening,
    playAudioBlob,
    resumeHandsFreeListening,
    startHandsFreeBargeInMonitoring,
    stopHandsFreeSession,
    unlockAudioContext,
  ]);

  const handleRetry = useCallback(() => {
    if (!lastRecordingRef.current) {
      setErrorMessage(null);
      setVoiceState('idle');
      return;
    }
    void executeVoicePipeline(lastRecordingRef.current, true);
  }, [executeVoicePipeline]);

  const effectiveWaveAmplitude =
    voiceState === 'speaking'
      ? amplitude
      : voiceState === 'listening' || voiceState === 'recording'
        ? micAmplitude
        : 0;

  return (
    <section className="flex min-h-screen w-full flex-col overflow-x-hidden bg-[#faf7f2]">
      {/* Full-Width Top Ocean Blue Header Bar */}
      <header className="flex w-full shrink-0 items-center justify-between bg-linear-to-r from-[#12679B] to-[#174B77] px-5 py-3 text-white sm:px-8 sm:py-3.5">
        <div className="flex items-center gap-3.5">
          {/* Dual-Diamond Emblem Logo */}
          <svg
            aria-hidden="true"
            viewBox="0 0 36 24"
            className="h-7 w-10 shrink-0 sm:h-8 sm:w-11"
          >
            {/* Left White Tilted Diamond */}
            <rect
              x="4"
              y="4"
              width="14"
              height="14"
              rx="1.5"
              transform="rotate(-45 11 11)"
              fill="#ffffff"
            />
            {/* Right Turquoise Tilted Diamond */}
            <rect
              x="16"
              y="7"
              width="11"
              height="11"
              rx="1.5"
              transform="rotate(-45 21.5 12.5)"
              fill="#2bc4c9"
            />
          </svg>

          {/* Vertical Divider */}
          <span
            aria-hidden="true"
            className="h-6 w-[1.5px] rounded-full bg-white/45 sm:h-7"
          />

          {/* Header Title */}
          <h1 className="text-[20px] font-bold tracking-tight text-white sm:text-[24px]">
            ผู้ช่วยประชาสัมพันธ์
          </h1>
        </div>

        {/* Right Settings Icon */}
        <div className="flex items-center gap-3 text-white">
          <button
            type="button"
            onClick={() => setShowDetails((prev) => !prev)}
            aria-label="ตั้งค่า"
            title="ตั้งค่าระบบ"
            className="rounded-full p-1.5 transition hover:bg-white/10 hover:text-white focus:ring-2 focus:ring-white/40 focus:outline-none"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-6 w-6 sm:h-7 sm:w-7"
            >
              <circle cx="12" cy="12" r="3.2" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Sky-Blue 2D Mascot Stage + Curved Cream Arch + Status Badge */}
      <MascotAvatar
        voiceState={voiceState}
        mouthFrame={mouthFrame}
        amplitude={amplitude}
      />

      {/* Bottom Cream Control Area (~30% on desktop, compact with minimal wasted space) */}
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-between gap-2 bg-[#faf7f2] px-4 pt-2 pb-3 sm:px-8 sm:pt-3 sm:pb-4">
        {/* Voice Controls & Continuous Stream Soundwave Bars */}
        <div className="my-auto w-full py-1">
          <MicrophoneButton
            voiceState={voiceState}
            interactionMode={interactionMode}
            isHandsFreeSessionActive={isHandsFreeSessionActive}
            amplitude={effectiveWaveAmplitude}
            elapsedSeconds={elapsedSeconds}
            maxRecordingSeconds={maxRecordingSeconds}
            autoplayBlocked={autoplayBlocked}
            onStartRecording={handleStartPrimaryAction}
            onStopAndSubmit={handleStopAndSubmit}
            onCancelRecording={handleCancelRecording}
            onStopAudio={handleStopAudio}
            onCancelProcessing={handleCancelProcessing}
            onPlayBlockedAudio={handlePlayBlockedAudio}
            onToggleMode={(mode) => {
              void handleToggleInteractionMode(mode);
            }}
          />
        </div>

        {/* Transcript, Answer & Sample Questions Footer */}
        <ConversationPanel
          transcript={transcript}
          answer={answer}
          matchedFaqIds={matchedFaqIds}
          matched={matched}
          answerMode={answerMode}
          errorMessage={errorMessage}
          canRetry={voiceState === 'error' && hasRetryPayload}
          onRetry={handleRetry}
          expanded={showDetails}
        />
      </div>
    </section>
  );
}
