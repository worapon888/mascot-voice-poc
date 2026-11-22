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
  ClientVoiceError,
  executeSmartPipelineStages,
  type RetrySessionSnapshot,
} from '@/lib/voice/api-client';
import type { AnswerMode } from '@/types/api';
import type { VoiceState } from '@/types/voice';

export function VoiceChat() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
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
  const pendingAudioBlobRef = useRef<Blob | null>(null);

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

        // Step D: Audio Playback + Real Web Audio API Lip-Sync
        setVoiceState('speaking');
        const outcome = await playAudioBlob(ttsBlob);
        if (currentTurnId !== turnIdRef.current) {
          return;
        }

        if (outcome === 'autoplay-blocked') {
          pendingAudioBlobRef.current = ttsBlob;
          setAutoplayBlocked(true);
          setErrorMessage(
            'เบราว์เซอร์บล็อกการเล่นเสียงอัตโนมัติ กรุณากดปุ่ม "เล่นเสียงตอบกลับ" ด้านบนเพื่อฟังเสียง',
          );
          setVoiceState('idle');
          return;
        }

        setVoiceState('idle');
      } catch (err) {
        if (currentTurnId !== turnIdRef.current) {
          return;
        }
        if (err instanceof Error && err.name === 'AbortError') {
          setVoiceState('idle');
          return;
        }

        stopAudio(true);
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
      setErrorMessage(error.message);
      setVoiceState('error');
    },
    [abortActiveRequest, stopAudio],
  );

  const {
    elapsedSeconds,
    maxRecordingSeconds,
    startRecording,
    stopAndSubmitRecording,
    cancelRecording,
  } = useVoiceRecorder({
    onAutoStopComplete: (payload) => {
      void executeVoicePipeline(payload);
    },
    onRecorderError: handleRecorderError,
  });

  useEffect(() => {
    return () => {
      turnIdRef.current += 1;
      abortActiveRequest();
      stopAudio(true);
    };
  }, [abortActiveRequest, stopAudio]);

  const handleStartRecording = useCallback(async () => {
    turnIdRef.current += 1;
    abortActiveRequest();
    stopAudio(true);
    pendingAudioBlobRef.current = null;
    setAutoplayBlocked(false);
    setErrorMessage(null);

    // Unlock Web Audio API context from this direct user click gesture
    await unlockAudioContext();

    try {
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
  }, [abortActiveRequest, startRecording, stopAudio, unlockAudioContext]);

  const handleStopAndSubmit = useCallback(async () => {
    await unlockAudioContext();
    const payload = await stopAndSubmitRecording();
    if (!payload) {
      setVoiceState((prev) => (prev === 'recording' ? 'idle' : prev));
      return;
    }
    await executeVoicePipeline(payload);
  }, [executeVoicePipeline, stopAndSubmitRecording, unlockAudioContext]);

  const handleCancelRecording = useCallback(() => {
    turnIdRef.current += 1;
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
    setVoiceState('idle');
  }, [abortActiveRequest, stopAudio]);

  const handleStopAudio = useCallback(() => {
    turnIdRef.current += 1;
    stopAudio(true);
    pendingAudioBlobRef.current = null;
    setAutoplayBlocked(false);
    setVoiceState('idle');
  }, [stopAudio]);

  const handlePlayBlockedAudio = useCallback(async () => {
    const blob = pendingAudioBlobRef.current;
    if (!blob) {
      return;
    }
    const currentTurnId = ++turnIdRef.current;
    setAutoplayBlocked(false);
    setErrorMessage(null);
    try {
      await unlockAudioContext();
      setVoiceState('speaking');
      const outcome = await playAudioBlob(blob);
      if (currentTurnId !== turnIdRef.current) {
        return;
      }
      if (outcome === 'completed' || outcome === 'stopped') {
        pendingAudioBlobRef.current = null;
      }
      setVoiceState('idle');
    } catch (err) {
      if (currentTurnId !== turnIdRef.current) {
        return;
      }
      const message =
        err instanceof ClientVoiceError
          ? err.message
          : 'ไม่สามารถเล่นเสียงตอบกลับได้ กรุณาลองใหม่อีกครั้ง';
      setErrorMessage(message);
      setVoiceState('error');
    }
  }, [playAudioBlob, unlockAudioContext]);

  const handleRetry = useCallback(() => {
    if (!lastRecordingRef.current) {
      setErrorMessage(null);
      setVoiceState('idle');
      return;
    }
    void executeVoicePipeline(lastRecordingRef.current, true);
  }, [executeVoicePipeline]);

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
        {/* Voice Controls & Soundwave Bars */}
        <div className="my-auto w-full py-1">
          <MicrophoneButton
            voiceState={voiceState}
            amplitude={amplitude}
            elapsedSeconds={elapsedSeconds}
            maxRecordingSeconds={maxRecordingSeconds}
            autoplayBlocked={autoplayBlocked}
            onStartRecording={handleStartRecording}
            onStopAndSubmit={handleStopAndSubmit}
            onCancelRecording={handleCancelRecording}
            onStopAudio={handleStopAudio}
            onCancelProcessing={handleCancelProcessing}
            onPlayBlockedAudio={handlePlayBlockedAudio}
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
