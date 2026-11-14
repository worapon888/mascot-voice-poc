'use client';

import type { VoiceState } from '@/types/voice';

interface MicrophoneButtonProps {
  voiceState: VoiceState;
  amplitude?: number;
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

const LEFT_WAVE_BARS = [4, 4, 14, 9, 26, 16, 36, 22, 14, 9, 5] as const;
const RIGHT_WAVE_BARS = [5, 9, 14, 22, 36, 16, 26, 9, 14, 4, 4] as const;

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

export function MicrophoneButton({
  voiceState,
  amplitude = 0,
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

  const isWaveActive = voiceState === 'recording' || voiceState === 'speaking';
  const dynamicScale =
    voiceState === 'speaking'
      ? 1 + Math.min(0.85, amplitude * 1.4)
      : voiceState === 'recording'
        ? 1.2
        : 1;

  const handlePrimaryClick = () => {
    if (voiceState === 'idle' || voiceState === 'error') {
      onStartRecording();
    } else if (voiceState === 'recording') {
      onStopAndSubmit();
    } else if (voiceState === 'speaking') {
      onStopAudio();
    }
  };

  const primaryTestId =
    voiceState === 'recording'
      ? 'stop-and-submit-btn'
      : voiceState === 'speaking'
        ? 'stop-audio-btn'
        : isProcessing
          ? 'processing-indicator-btn'
          : 'start-recording-btn';

  const primaryLabel =
    voiceState === 'recording'
      ? 'กดเพื่อส่งคำถาม'
      : isProcessing
        ? 'กำลังประมวลผล...'
        : voiceState === 'speaking'
          ? 'กดเพื่อหยุดเสียง'
          : 'กดเพื่อพูด';

  const outerRingClass =
    voiceState === 'recording'
      ? 'bg-rose-400 shadow-[0_0_24px_rgba(244,63,94,0.45)]'
      : voiceState === 'speaking'
        ? 'bg-[#5ce1d2] shadow-[0_0_22px_rgba(45,212,191,0.45)]'
        : 'bg-[#7ce2d4] shadow-[0_6px_18px_rgba(15,43,72,0.14)]';

  const waveBarColor =
    voiceState === 'recording'
      ? 'bg-rose-400'
      : voiceState === 'speaking'
        ? 'bg-[#3bc4bd]'
        : 'bg-[#9ab3c9]';

  return (
    <div className="flex w-full flex-col items-center">
      {/* Soundwave Bars + Central Circular Microphone Button */}
      <div className="flex items-center justify-center gap-5 sm:gap-7">
        {/* Left Equalizer Bars */}
        <div
          aria-hidden="true"
          className="flex h-12 items-center gap-[5px] sm:gap-[6px]"
        >
          {LEFT_WAVE_BARS.map((baseHeight, idx) => {
            const height = isWaveActive
              ? Math.max(
                  4,
                  Math.round(
                    baseHeight *
                      (idx % 2 === 0
                        ? dynamicScale
                        : 0.85 + dynamicScale * 0.2),
                  ),
                )
              : baseHeight;
            return (
              <span
                key={`left-bar-${idx}`}
                className={`w-[4px] rounded-full transition-all duration-100 ${waveBarColor} ${
                  voiceState === 'recording' ? 'animate-pulse' : ''
                }`}
                style={{ height: `${height}px` }}
              />
            );
          })}
        </div>

        {/* Center Circular Microphone Button */}
        <button
          type="button"
          data-testid={primaryTestId}
          disabled={isProcessing}
          onClick={handlePrimaryClick}
          aria-label={primaryLabel}
          className={`group relative flex h-[104px] w-[104px] shrink-0 items-center justify-center rounded-full p-[6px] transition-transform duration-150 focus:ring-4 focus:ring-[#7ce2d4]/60 focus:outline-none sm:h-[112px] sm:w-[112px] lg:h-[clamp(90px,12.5dvh,124px)] lg:w-[clamp(90px,12.5dvh,124px)] ${outerRingClass} ${
            isProcessing
              ? 'cursor-not-allowed opacity-85'
              : 'cursor-pointer hover:scale-[1.03] active:scale-[0.98]'
          }`}
        >
          <span className="flex h-full w-full items-center justify-center rounded-full bg-linear-to-b from-[#1b406c] via-[#122f54] to-[#0a1f3a] text-white shadow-inner">
            {isProcessing ? (
              <span className="h-9 w-9 animate-spin rounded-full border-4 border-white/85 border-t-transparent" />
            ) : (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-11 w-11 text-white transition-transform group-hover:scale-105 sm:h-12 sm:w-12 lg:h-[46%] lg:w-[46%]"
              >
                {/* Solid White Capsule Mic Head */}
                <rect
                  x="8.5"
                  y="3"
                  width="7"
                  height="11.5"
                  rx="3.5"
                  fill="currentColor"
                />
                {/* U-Shaped Cradle & Base */}
                <path
                  d="M6 10.75a6 6 0 0 0 12 0M12 16.75v3.75M8.75 20.5h6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
        </button>

        {/* Right Equalizer Bars */}
        <div
          aria-hidden="true"
          className="flex h-12 items-center gap-[5px] sm:gap-[6px]"
        >
          {RIGHT_WAVE_BARS.map((baseHeight, idx) => {
            const height = isWaveActive
              ? Math.max(
                  4,
                  Math.round(
                    baseHeight *
                      (idx % 2 === 1
                        ? dynamicScale
                        : 0.85 + dynamicScale * 0.2),
                  ),
                )
              : baseHeight;
            return (
              <span
                key={`right-bar-${idx}`}
                className={`w-[4px] rounded-full transition-all duration-100 ${waveBarColor} ${
                  voiceState === 'recording' ? 'animate-pulse' : ''
                }`}
                style={{ height: `${height}px` }}
              />
            );
          })}
        </div>
      </div>

      {/* Main Call-to-Action Text ("กดเพื่อพูด") */}
      <p className="mt-2.5 text-[24px] leading-tight font-bold tracking-tight text-[#0f2942] sm:text-[26px] lg:mt-2 lg:text-[clamp(22px,2.8dvh,28px)]">
        {primaryLabel}
      </p>

      {/* Secondary Contextual Controls (Recording Timer / Cancel / Blocked Audio) */}
      {voiceState === 'recording' && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2.5">
          <div
            data-testid="recording-timer"
            className="inline-flex items-center gap-1.5 rounded-full bg-rose-100/90 px-3.5 py-1 text-xs font-semibold text-rose-800"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-rose-600" />
            <span>
              {formatTimer(elapsedSeconds)} / {formatTimer(maxRecordingSeconds)}
            </span>
          </div>
          <button
            type="button"
            data-testid="cancel-recording-btn"
            onClick={onCancelRecording}
            className="rounded-full border border-slate-300 bg-white px-3.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            ยกเลิก
          </button>
        </div>
      )}

      {isProcessing && (
        <div className="mt-2">
          <button
            type="button"
            data-testid="cancel-processing-btn"
            onClick={onCancelProcessing}
            className="rounded-full border border-slate-300 bg-white px-3.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            ยกเลิกคำขอ
          </button>
        </div>
      )}

      {autoplayBlocked && (
        <div className="mt-2.5">
          <button
            type="button"
            data-testid="play-blocked-audio-btn"
            onClick={onPlayBlockedAudio}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#133256] px-5 py-2 text-sm font-semibold text-white shadow-xs transition hover:bg-[#1b4370]"
          >
            <span>🔊 เล่นเสียงตอบกลับ</span>
          </button>
        </div>
      )}
    </div>
  );
}
