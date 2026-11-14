'use client';

import { useEyeBlink } from '@/hooks/use-eye-blink';
import { useHandGesture } from '@/hooks/use-hand-gesture';
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
  const isBlinking = useEyeBlink();
  const handGesture = useHandGesture(voiceState);

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
        data-blinking={isBlinking ? 'true' : 'false'}
        data-hand-gesturing={handGesture.isGesturing ? 'true' : 'false'}
        data-hand-angle={handGesture.rotationDeg}
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
          {/* Base Mascot Body & Mouth Frames (with static forearm masked out to prevent duplicate arm) */}
          <div
            data-testid="mascot-body-mask-layer"
            className="absolute inset-0 h-full w-full"
            style={{
              WebkitMaskImage:
                "url('/assets/mascot/mascot-original-body-mask.png')",
              maskImage: "url('/assets/mascot/mascot-original-body-mask.png')",
              WebkitMaskSize: '100% 100%',
              maskSize: '100% 100%',
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
            }}
          >
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

          {/* Separate Original Forearm/Hand Layer with Elbow Pivot (121.5, 139.0 in 168x151 space) */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/mascot/mascot-original-arm.png"
            alt=""
            aria-hidden="true"
            width={168}
            height={151}
            draggable={false}
            data-testid="mascot-arm-layer"
            data-hand-gesturing={handGesture.isGesturing ? 'true' : 'false'}
            data-hand-angle={handGesture.rotationDeg}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain ease-in-out will-change-transform"
            style={{
              transformOrigin: '72.32% 92.05%',
              transform: `rotate(${handGesture.rotationDeg}deg)`,
              transitionProperty: 'transform',
              transitionDuration: `${handGesture.transitionDurationMs}ms`,
            }}
          />

          {/* Eye-Only Blink Overlay aligned to original 168x151 pixel coordinates */}
          <svg
            viewBox="0 0 168 151"
            aria-hidden="true"
            data-testid="mascot-eye-blink-overlay"
            data-eye-state={isBlinking ? 'closed' : 'open'}
            className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-75 ${
              isBlinking ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {/* Skin-tone patches covering only the left (x:63..75, y:70..89) and right (x:104..115, y:68..86) open eyes */}
            <ellipse cx="69.2" cy="79.8" rx="6.8" ry="10.1" fill="#fff7ec" />
            <ellipse cx="109.5" cy="77.2" rx="6.4" ry="9.7" fill="#fff7ec" />

            {/* Closed eyelid curves matching original outline color (#10314d) and slight head tilt */}
            <path
              d="M 63.8 80.6 Q 69.2 84.2 74.6 80.2"
              fill="none"
              stroke="#10314d"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
            <path
              d="M 104.3 78.0 Q 109.5 81.6 114.6 77.6"
              fill="none"
              stroke="#10314d"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
          </svg>
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
