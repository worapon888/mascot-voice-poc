'use client';

import type { VoiceState } from '@/types/voice';

interface MicrophoneButtonProps {
  voiceState: VoiceState;
  elapsedSeconds: number;
  maxRecordingSeconds: number;
  autoplayBlocked: boolean;
  onStartRecording: () => void;
  onStopAndSubmit: () => void;
  onCancelRecording: () => void;
  onStopAudio: () => void;
  onCancelProcessing: () => void;
  onPlayBlockedAudio: () => void;
}

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

export function MicrophoneButton({
  voiceState,
  elapsedSeconds,
  maxRecordingSeconds,
  autoplayBlocked,
  onStartRecording,
  onStopAndSubmit,
  onCancelRecording,
  onStopAudio,
  onCancelProcessing,
  onPlayBlockedAudio,
}: MicrophoneButtonProps) {
  const isProcessing =
    voiceState === 'transcribing' ||
    voiceState === 'thinking' ||
    voiceState === 'synthesizing';

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Recording Timer */}
      {voiceState === 'recording' && (
        <div
          data-testid="recording-timer"
          className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-4 py-1 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"
        >
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-600" />
          <span>
            เวลาบันทึก: {formatTimer(elapsedSeconds)} /{' '}
            {formatTimer(maxRecordingSeconds)}
          </span>
        </div>
      )}

      {/* Autoplay Blocked Manual Play Button */}
      {autoplayBlocked && (
        <button
          type="button"
          data-testid="play-blocked-audio-btn"
          onClick={onPlayBlockedAudio}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-teal-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-teal-700 focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:outline-none"
        >
          <span>🔊 เล่นเสียงตอบกลับ</span>
        </button>
      )}

      {/* Main Action Controls by State */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        {(voiceState === 'idle' || voiceState === 'error') && (
          <button
            type="button"
            data-testid="start-recording-btn"
            onClick={onStartRecording}
            className="inline-flex items-center justify-center gap-2.5 rounded-full bg-[#164775] px-7 py-3.5 text-base font-semibold text-white shadow-md transition hover:bg-[#11385d] active:scale-[0.99] focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:outline-none"
          >
            <svg
              aria-hidden="true"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
              />
            </svg>
            <span>กดเพื่อพูดคำถาม</span>
          </button>
        )}

        {voiceState === 'recording' && (
          <>
            <button
              type="button"
              data-testid="stop-and-submit-btn"
              onClick={onStopAndSubmit}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-rose-600 px-6 py-3.5 text-base font-semibold text-white shadow-md transition hover:bg-rose-700 focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 focus:outline-none"
            >
              <span className="h-3 w-3 rounded-xs bg-white" />
              <span>หยุดและส่ง</span>
            </button>

            <button
              type="button"
              data-testid="cancel-recording-btn"
              onClick={onCancelRecording}
              className="inline-flex items-center justify-center rounded-full border border-slate-300 bg-white px-5 py-3.5 text-sm font-medium text-slate-700 shadow-xs transition hover:bg-slate-50 focus:ring-2 focus:ring-slate-400 focus:outline-none"
            >
              ยกเลิก
            </button>
          </>
        )}

        {isProcessing && (
          <>
            <button
              type="button"
              disabled
              data-testid="processing-indicator-btn"
              className="inline-flex cursor-not-allowed items-center justify-center gap-2.5 rounded-full bg-slate-200 px-6 py-3.5 text-base font-medium text-slate-600"
            >
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-transparent" />
              <span>กำลังประมวลผล...</span>
            </button>

            <button
              type="button"
              data-testid="cancel-processing-btn"
              onClick={onCancelProcessing}
              className="inline-flex items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              ยกเลิกคำขอ
            </button>
          </>
        )}

        {voiceState === 'speaking' && (
          <button
            type="button"
            data-testid="stop-audio-btn"
            onClick={onStopAudio}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-amber-600 px-6 py-3.5 text-base font-semibold text-white shadow-md transition hover:bg-amber-700 focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:outline-none"
          >
            <span className="h-3 w-3 rounded-xs bg-white" />
            <span>หยุดเสียง</span>
          </button>
        )}
      </div>
    </div>
  );
}
