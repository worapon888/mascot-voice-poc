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
  requestGroundedAnswer,
  requestSpeechToText,
  requestTextToSpeechBlob,
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

  const turnIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastRecordingRef = useRef<RecordedAudioPayload | null>(null);
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
    async (recordingPayload: RecordedAudioPayload) => {
      abortActiveRequest();
      stopAudio(true);

      const currentTurnId = ++turnIdRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      lastRecordingRef.current = recordingPayload;
      setHasRetryPayload(true);
      pendingAudioBlobRef.current = null;
      setAutoplayBlocked(false);
      setErrorMessage(null);

      try {
        // Step A: Speech-to-Text (/api/stt)
        setVoiceState('transcribing');
        const sttResult = await requestSpeechToText(
          recordingPayload.blob,
          recordingPayload.mimeType,
          controller.signal,
        );
        if (currentTurnId !== turnIdRef.current) {
          return;
        }
        setTranscript(sttResult.transcript);

        // Step B: Grounded FAQ Answer (/api/answer)
        setVoiceState('thinking');
        const answerResult = await requestGroundedAnswer(
          sttResult.transcript,
          controller.signal,
        );
        if (currentTurnId !== turnIdRef.current) {
          return;
        }
        setAnswer(answerResult.answer);
        setMatchedFaqIds(answerResult.faqIds);
        setMatched(answerResult.matched);
        setAnswerMode(
          answerResult.answerMode ??
            (answerResult.matched
              ? 'FAQ_GROUNDED'
              : 'ORGANIZATION_INFO_UNKNOWN'),
        );

        // Step C: Text-to-Speech (/api/tts)
        setVoiceState('synthesizing');
        const ttsBlob = await requestTextToSpeechBlob(
          answerResult.answer,
          controller.signal,
        );
        if (currentTurnId !== turnIdRef.current) {
          return;
        }

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
    void executeVoicePipeline(lastRecordingRef.current);
  }, [executeVoicePipeline]);

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center rounded-3xl border border-sky-100 bg-white p-6 shadow-lg sm:p-8">
      {/* Header */}
      <div className="mb-5 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-[#173c5c] sm:text-3xl">
          ผู้ช่วยมาสคอต AI ถาม–ตอบด้วยเสียง
        </h1>
        <p className="mt-1.5 text-sm text-slate-600">
          สวัสดีค่ะ! กดปุ่มไมโครโฟนด้านล่างเพื่อพูดสอบถามข้อมูลสาธิตเป็นภาษาไทย
        </p>
      </div>

      {/* Original 2D Mascot Stage */}
      <MascotAvatar
        voiceState={voiceState}
        mouthFrame={mouthFrame}
        amplitude={amplitude}
      />

      {/* Voice Controls */}
      <div className="my-5 w-full">
        <MicrophoneButton
          voiceState={voiceState}
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

      {/* Transcript, Answer & Notices */}
      <ConversationPanel
        transcript={transcript}
        answer={answer}
        matchedFaqIds={matchedFaqIds}
        matched={matched}
        answerMode={answerMode}
        errorMessage={errorMessage}
        canRetry={voiceState === 'error' && hasRetryPayload}
        onRetry={handleRetry}
      />
    </section>
  );
}
