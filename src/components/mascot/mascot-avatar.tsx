'use client';

import type { MouthFrame, VoiceState } from '@/types/voice';
import { VOICE_STATE_LABELS } from '@/types/voice';

interface MascotAvatarProps {
  voiceState: VoiceState;
  mouthFrame: MouthFrame;
  amplitude: number;
}

const STATE_BADGE_STYLES: Record<VoiceState, string> = {
  idle: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  recording: 'bg-rose-100 text-rose-800 border-rose-200',
  transcribing: 'bg-sky-100 text-sky-800 border-sky-200',
  thinking: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  synthesizing: 'bg-violet-100 text-violet-800 border-violet-200',
  speaking: 'bg-teal-100 text-teal-800 border-teal-200',
  error: 'bg-amber-100 text-amber-900 border-amber-300',
};

const STATE_DOT_STYLES: Record<VoiceState, string> = {
  idle: 'bg-emerald-500',
  recording: 'bg-rose-500 animate-ping',
  transcribing: 'bg-sky-500 animate-pulse',
  thinking: 'bg-indigo-500 animate-pulse',
  synthesizing: 'bg-violet-500 animate-pulse',
  speaking: 'bg-teal-500 animate-pulse',
  error: 'bg-amber-500',
};

export function MascotAvatar({
  voiceState,
  mouthFrame,
  amplitude,
}: MascotAvatarProps) {
  // Strictly keep mouth closed whenever not actively in 'speaking' state
  const effectiveMouth: MouthFrame =
    voiceState === 'speaking' ? mouthFrame : 'closed';

  const levelPercent =
    voiceState === 'speaking' ? Math.min(100, Math.round(amplitude * 100)) : 0;

  return (
    <div className="flex flex-col items-center">
      {/* Status Pill */}
      <div
        data-testid="voice-status-badge"
        data-voice-state={voiceState}
        className={`mb-4 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium shadow-xs transition-colors ${STATE_BADGE_STYLES[voiceState]}`}
      >
        <span className="relative flex h-2.5 w-2.5">
          <span
            className={`inline-flex h-full w-full rounded-full ${STATE_DOT_STYLES[voiceState]}`}
          />
        </span>
        <span>{VOICE_STATE_LABELS[voiceState]}</span>
      </div>

      {/* Original 2D Mascot Stage */}
      <div
        data-testid="mascot-stage"
        data-mouth-frame={effectiveMouth}
        className="relative flex h-64 w-72 items-end justify-center overflow-hidden rounded-3xl border border-sky-200/80 bg-linear-to-b from-[#b5ddfb] to-[#dbf3ff] shadow-md sm:h-72 sm:w-80"
      >
        {/* Subtle speaking aura ring */}
        {voiceState === 'speaking' && effectiveMouth !== 'closed' && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-3xl ring-4 ring-teal-400/50 transition-opacity duration-75"
          />
        )}

        {/* Fixed aspect-ratio sprite stack (168x151 original cutout dimensions) */}
        <div className="relative aspect-[168/151] w-[88%] select-none">
          {/* Frame 1: Closed Mouth (Idle / Silent) */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/mascot/mascot-original-idle.png"
            alt="มาสคอต 2D ต้นฉบับ (สถานะปิดปาก)"
            width={168}
            height={151}
            draggable={false}
            data-testid="mascot-img-closed"
            className={`absolute inset-0 h-full w-full object-contain ${
              effectiveMouth === 'closed'
                ? 'opacity-100'
                : 'pointer-events-none opacity-0'
            }`}
          />

          {/* Frame 2: Small Open Mouth (Low/Mid Speech Amplitude) */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/mascot/mascot-original-small.png"
            alt="มาสคอต 2D ต้นฉบับ (สถานะขยับปากเล็กน้อย)"
            width={168}
            height={151}
            draggable={false}
            data-testid="mascot-img-small"
            className={`absolute inset-0 h-full w-full object-contain ${
              effectiveMouth === 'small'
                ? 'opacity-100'
                : 'pointer-events-none opacity-0'
            }`}
          />

          {/* Frame 3: Full Open Mouth (High Speech Amplitude) */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/mascot/mascot-original-talking.png"
            alt="มาสคอต 2D ต้นฉบับ (สถานะอ้าปากพูด)"
            width={168}
            height={151}
            draggable={false}
            data-testid="mascot-img-open"
            className={`absolute inset-0 h-full w-full object-contain ${
              effectiveMouth === 'open'
                ? 'opacity-100'
                : 'pointer-events-none opacity-0'
            }`}
          />
        </div>
      </div>

      {/* Live Speech Amplitude Meter (visible during speaking) */}
      <div className="mt-3 flex h-5 w-64 items-center justify-center gap-2 text-xs text-slate-600">
        {voiceState === 'speaking' ? (
          <>
            <span className="shrink-0 font-medium text-teal-700">
              ระดับเสียงพูด:
            </span>
            <div className="h-2 w-32 overflow-hidden rounded-full bg-slate-200">
              <div
                data-testid="lipsync-amplitude-bar"
                className="h-full rounded-full bg-teal-500 transition-all duration-75"
                style={{ width: `${levelPercent}%` }}
              />
            </div>
          </>
        ) : (
          <span className="text-slate-500">
            เสียงตอบกลับสร้างโดย AI (OpenAI TTS)
          </span>
        )}
      </div>
    </div>
  );
}
