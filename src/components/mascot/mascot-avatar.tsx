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
  idle: 'bg-[#d4f2e0] text-[#0f3123]',
  listening: 'bg-emerald-100 text-emerald-900',
  recording: 'bg-rose-100 text-rose-900',
  transcribing: 'bg-sky-100 text-sky-900',
  thinking: 'bg-indigo-100 text-indigo-900',
  synthesizing: 'bg-teal-100 text-teal-900',
  speaking: 'bg-[#cceef0] text-[#0f3842]',
  error: 'bg-amber-100 text-amber-950',
};

const STATE_DOT_STYLES: Record<VoiceState, string> = {
  idle: 'bg-[#17823c]',
  listening: 'bg-emerald-600 animate-ping',
  recording: 'bg-rose-600 animate-ping',
  transcribing: 'bg-sky-600 animate-pulse',
  thinking: 'bg-indigo-600 animate-pulse',
  synthesizing: 'bg-teal-600 animate-pulse',
  speaking: 'bg-[#15939e] animate-pulse',
  error: 'bg-amber-600',
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
    <div className="relative flex w-full flex-col items-center">
      {/* Full-Width Sky-Blue Mascot Stage (~70% of remaining viewport height on desktop) */}
      <div
        data-testid="mascot-stage"
        data-mouth-frame={effectiveMouth}
        data-blinking={isBlinking ? 'true' : 'false'}
        data-hand-gesturing={handGesture.isGesturing ? 'true' : 'false'}
        data-hand-angle={handGesture.rotationDeg}
        className="relative flex h-[46dvh] min-h-[260px] max-h-[440px] w-full items-end justify-center overflow-hidden bg-linear-to-b from-[#8cc6f2] via-[#bde2fb] to-[#def2fe] pt-4 lg:h-[calc((100dvh-60px)*0.68)] lg:min-h-[360px] lg:max-h-none lg:pt-6"
      >
        {/* Layer 2: Subtle Animated Sky Gradient */}
        <div
          aria-hidden="true"
          className="animate-mascot-sky-gradient pointer-events-none absolute inset-0 z-0"
          style={{
            background:
              'radial-gradient(circle at 30% 25%, rgba(255, 255, 255, 0.42) 0%, rgba(189, 226, 251, 0.18) 45%, rgba(116, 188, 240, 0.34) 100%)',
          }}
        />

        {/* Layer 3: Multi-Layer Parallax Animated Waves */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[62%] w-full overflow-hidden"
        >
          {/* Back Wave (Slowest) */}
          <svg
            viewBox="0 0 2400 220"
            preserveAspectRatio="none"
            className="animate-mascot-wave-back absolute bottom-0 left-0 h-full w-[200%]"
          >
            <path
              d="M0 78 Q300 26 600 78 T1200 78 Q1500 26 1800 78 T2400 78 L2400 220 L0 220 Z"
              fill="#9fd2f7"
              fillOpacity="0.42"
            />
          </svg>

          {/* Middle Wave (Medium Speed, Opposite Drift) */}
          <svg
            viewBox="0 0 2400 220"
            preserveAspectRatio="none"
            className="animate-mascot-wave-mid absolute bottom-0 left-0 h-[92%] w-[200%]"
          >
            <path
              d="M0 105 Q300 50 600 105 T1200 105 Q1500 50 1800 105 T2400 105 L2400 220 L0 220 Z"
              fill="#b0dcfb"
              fillOpacity="0.62"
            />
          </svg>

          {/* Front Wave (Closest) */}
          <svg
            viewBox="0 0 2400 220"
            preserveAspectRatio="none"
            className="animate-mascot-wave-front absolute bottom-0 left-0 h-[82%] w-[200%]"
          >
            <path
              d="M0 132 Q300 84 600 132 T1200 132 Q1500 84 1800 132 T2400 132 L2400 220 L0 220 Z"
              fill="#cdeafd"
              fillOpacity="0.82"
            />
          </svg>
        </div>

        {/* Pure 100% Vector SVG Mascot (scales proportionally with stage height) */}
        <div className="relative z-10 mb-[22px] aspect-[168/151] h-[82%] max-h-full w-auto max-w-[90vw] select-none sm:mb-[26px] lg:mb-[30px]">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="58 35 168 151"
            role="img"
            aria-label="มาสคอต 2D เจ้าหน้าที่ประชาสัมพันธ์"
            className="h-full w-full overflow-visible"
          >
            <defs>
              <linearGradient id="mascotHairFill" x1="0" x2="1" y1="0" y2="0.8">
                <stop stopColor="#37c1c8" />
                <stop offset="1" stopColor="#24abb6" />
              </linearGradient>
              <linearGradient
                id="mascotBodyFill"
                x1="0"
                x2="0.75"
                y1="0"
                y2="1"
              >
                <stop stopColor="#2f84af" />
                <stop offset="1" stopColor="#1f6795" />
              </linearGradient>
              <linearGradient
                id="mascotSkin"
                x1="0.2"
                y1="0"
                x2="0.85"
                y2="0.9"
              >
                <stop stopColor="#fff9ec" />
                <stop offset="1" stopColor="#fff6e7" />
              </linearGradient>
              <linearGradient id="mascotSleeve" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#bdf4ec" />
                <stop offset="1" stopColor="#91e1e0" />
              </linearGradient>
              <filter
                id="mascotCheekBlur"
                x="-40%"
                y="-40%"
                width="180%"
                height="180%"
              >
                <feGaussianBlur stdDeviation="0.65" />
              </filter>
            </defs>

            <g strokeLinecap="round" strokeLinejoin="round">
              {/* Back headphone band */}
              <g id="headset-band">
                <path
                  d="M80.1 101.9 C82.1 79.4 96.9 56.9 125.8 52.9 C147.5 48.9 175.6 64.5 189.9 97.4"
                  fill="none"
                  stroke="#144875"
                  strokeWidth="5.6"
                />
                <path
                  d="M92.9 102.5 C94.5 81.9 109.7 60.3 133.5 58.9 C161.3 57.2 182.6 75.4 187.6 102.1"
                  fill="none"
                  stroke="#a6edee"
                  strokeWidth="5"
                />
              </g>

              {/* Rear right headphone */}
              <g id="ear-right">
                <path
                  d="M184.1 96.5 C193.2 96.9 199.5 103.7 199 115.2 C198.5 128.3 193.3 132.3 184.7 130.6 Z"
                  fill="#144c74"
                />
                <path
                  d="M189.8 98.4 C194.5 103.2 195.7 124.8 190.1 129.7"
                  fill="none"
                  stroke="#0c3e68"
                  strokeWidth="3"
                />
              </g>

              {/* Hair and head silhouette at rear */}
              <g id="hair-back">
                <path
                  d="M97.8 97.1 C105.8 68.1 131.5 56.5 159.9 65.2 C178.9 71.2 192 92.1 186.5 119.1 C180 144.6 151 152.5 124.7 147.1 C99.1 143.8 89.2 124.2 97.8 97.1 Z"
                  fill="#0b8c95"
                  stroke="#125173"
                  strokeWidth="3"
                />
                <path
                  d="M166 65 C182 74 189 89 189 109 C189 118 186 126 181 131"
                  fill="none"
                  stroke="#37b6be"
                  strokeWidth="5.5"
                />
              </g>

              {/* Left stationary arm */}
              <g id="arm-left">
                <path
                  d="M124.2 149 C111.6 153.4 100.5 168 93.5 186.3 L131.9 186.3 L135.4 151.6 Z"
                  fill="url(#mascotSleeve)"
                  stroke="#0f527b"
                  strokeWidth="3.2"
                />
              </g>

              {/* Right animated forearm + raised hand */}
              <g
                data-testid="mascot-arm-layer"
                data-hand-gesturing={handGesture.isGesturing ? 'true' : 'false'}
                data-hand-angle={handGesture.rotationDeg}
                className="ease-in-out will-change-transform"
                style={{
                  transformOrigin: '179px 175px',
                  transform: `rotate(${handGesture.rotationDeg}deg)`,
                  transitionProperty: 'transform',
                  transitionDuration: `${handGesture.transitionDurationMs}ms`,
                }}
              >
                <path
                  d="M160.4 149.1 C169.6 152.1 177.4 158.8 180 169.5 C182.1 161.6 184.3 157.5 190.3 151.9 L199.3 159.1 C194.3 172.4 183.7 182.1 170.8 185.9 L163.1 185.9 Z"
                  fill="url(#mascotSleeve)"
                  stroke="#0e5078"
                  strokeWidth="3.1"
                />
                <path
                  d="M186.7 149.7 C185.9 146 188 141.6 194 139.6 C196.3 138.9 199.7 139 199.1 142.2 L197.6 144.8 C202.3 144.1 209.3 142.4 213.3 144.2 C216.3 145.7 215 149.4 211.6 152.1 C206.5 156.1 200.7 159.9 194.7 160.1 C191 160.2 188.2 155.2 186.7 149.7 Z"
                  fill="#fff9eb"
                  stroke="#12496e"
                  strokeWidth="2.8"
                />
                <path
                  d="M192 151.8 C194 155.5 196.4 156.1 200.3 156.1"
                  fill="none"
                  stroke="#dbeadd"
                  strokeWidth="0.8"
                />
              </g>

              {/* Torso / vest */}
              <g id="body">
                <path
                  d="M124.3 149.1 C137 147.3 150 147.2 161.3 149.1 C165.3 157 168.5 167.4 170 186.6 L127 186.6 C126 172 126.1 158.4 124.3 149.1 Z"
                  fill="url(#mascotBodyFill)"
                  stroke="#0c4871"
                  strokeWidth="3"
                />
                <path
                  d="M126 149.8 L139.3 150.8 L147 158.7 L140.3 168 C138.6 170.3 136.6 170.1 134.1 167.5 L124.9 153.9 Z"
                  fill="white"
                  stroke="#0e5279"
                  strokeWidth="1.35"
                />
                <path
                  d="M147 158.7 L154.6 150.8 L160.8 148.8 L161.2 160.7 L154.7 167.2 C152.4 169.6 149.3 169.3 147.4 166.9 L143 162.4 Z"
                  fill="white"
                  stroke="#0e5279"
                  strokeWidth="1.35"
                />
                {/* Brand badge */}
                <rect
                  x="149.8"
                  y="169.3"
                  width="16.1"
                  height="13.3"
                  rx="2.8"
                  fill="#fffdfa"
                  stroke="#7bbcd5"
                  strokeWidth="0.85"
                />
                <path
                  d="M152.6 176.9 L156.1 173.1 L159.1 176.2 L161 173.8 L163.7 176.5 L159 180.2 L155.9 177.8 L154.2 179.8 Z"
                  fill="#2c9faf"
                />
              </g>

              {/* Face oval */}
              <g id="face">
                <path
                  d="M104.9 109.7 C105 93.7 113.5 91 125.4 91.5 C145 94.2 155 89.3 166.5 78.8 C173.1 85.1 178.2 96.5 178.4 111.3 C179.1 128.5 168.5 143.9 147.7 147.2 C126.4 150.2 111.5 142.6 105.5 127.9 C102.2 119.9 103.6 115 104.9 109.7 Z"
                  fill="url(#mascotSkin)"
                  stroke="#104a73"
                  strokeWidth="2.7"
                />
                <ellipse
                  cx="115.6"
                  cy="127.8"
                  rx="5.8"
                  ry="5.5"
                  fill="#ffc6ad"
                  filter="url(#mascotCheekBlur)"
                  opacity="0.86"
                />
                <ellipse
                  cx="176.2"
                  cy="123.3"
                  rx="4.9"
                  ry="5"
                  fill="#ffc6ad"
                  filter="url(#mascotCheekBlur)"
                  opacity="0.85"
                />
              </g>

              {/* Hair over forehead */}
              <g id="hair-front">
                <path
                  d="M96 102.5 C102 76.6 111.5 67.6 135.2 57.8 C122.1 54.4 120.7 45.7 123.8 40.8 C135 43.7 140.8 39.4 152.8 44.3 C168.2 50.1 171.2 61 169 68.8 C166.2 80.9 155.6 88 140.9 90.1 C125.6 90.3 108 89.4 96 102.5 Z"
                  fill="url(#mascotHairFill)"
                />
                <path
                  d="M123.9 41.1 C123.5 48.7 133.7 57.5 149.8 59.2 C141.5 59.7 130.9 55.3 123.9 48.3"
                  fill="#0a8f94"
                />
                <path
                  d="M97.4 100.5 C110.9 88.7 123.4 89.9 139.7 87.8 C153.5 86 162.5 79.5 169.1 68.6 C168.4 83.8 159.8 91.8 146.4 93.2 C131.8 93.3 117.9 90.4 104.3 101.9 L99.2 111 Z"
                  fill="#0e8c95"
                />
              </g>

              {/* Eyebrows */}
              <g id="brows" fill="none" stroke="#144b73" strokeWidth="2.5">
                <path d="M120.8 100.9 C122.9 96.3 128.5 95.7 132.3 99.2" />
                <path d="M161.5 97.7 C164.5 93 169.2 93.7 171.7 97.7" />
              </g>

              {/* Eyes: Open vs Closed */}
              <g
                id="eyes-open"
                className={isBlinking ? 'opacity-0' : 'opacity-100'}
              >
                <ellipse
                  cx="126.7"
                  cy="113.2"
                  rx="4.1"
                  ry="7.9"
                  fill="#103b62"
                />
                <ellipse cx="129" cy="108.7" rx="1.35" ry="2.1" fill="white" />
                <ellipse
                  cx="168.1"
                  cy="110.4"
                  rx="3.4"
                  ry="6.9"
                  fill="#103b62"
                />
                <ellipse
                  cx="169.2"
                  cy="107.1"
                  rx="1.12"
                  ry="1.75"
                  fill="white"
                />
              </g>
              <g
                id="eyes-closed"
                data-testid="mascot-eye-blink-overlay"
                data-eye-state={isBlinking ? 'closed' : 'open'}
                fill="none"
                stroke="#144b73"
                strokeWidth="2.25"
                className={isBlinking ? 'opacity-100' : 'opacity-0'}
              >
                <path d="M122 113 Q126.5 118 131 112.8" />
                <path d="M164.3 110 Q167.5 114 171.3 109.9" />
              </g>

              {/* Mouth: Closed / Small / Open */}
              <g
                id="mouth-closed"
                data-testid="mascot-img-closed"
                className={
                  effectiveMouth === 'closed' ? 'opacity-100' : 'opacity-0'
                }
              >
                <path
                  d="M140.9 127.4 C145 130.1 150.5 130.1 154.1 126.7"
                  fill="none"
                  stroke="#9a4148"
                  strokeWidth="2.5"
                />
              </g>
              <g
                id="mouth-small"
                data-testid="mascot-img-small"
                className={
                  effectiveMouth === 'small' ? 'opacity-100' : 'opacity-0'
                }
              >
                <ellipse cx="147.4" cy="128" rx="4.1" ry="5.0" fill="#80333b" />
                <path d="M144.4 130.3 Q147 135 150.3 130.5" fill="#f2767e" />
              </g>
              <g
                id="mouth-open"
                data-testid="mascot-img-open"
                className={
                  effectiveMouth === 'open' ? 'opacity-100' : 'opacity-0'
                }
              >
                <path
                  d="M137.1 123 C143 124.3 151.2 124.8 156.1 121.9 C157.5 129.8 154.8 136.6 147.5 137.3 C141.6 137.4 137.3 131.7 137.1 123 Z"
                  fill="#782d31"
                />
                <path
                  d="M140.5 130 C144.5 129 149.8 129.6 152.8 131.8 C149.9 137.5 143.5 138 140.5 130"
                  fill="#f16f77"
                />
              </g>

              {/* Front headset on top of body */}
              <g id="headset-left">
                <path
                  d="M82.4 98.9 C91.1 98.9 95.1 106.7 94.5 117.4 C94.1 127.4 90.7 131.7 84.6 133.4"
                  fill="none"
                  stroke="#113f68"
                  strokeWidth="6.5"
                />
                <path
                  d="M78.2 96.7 C82.8 97.6 89 100.1 91 108.7 L91.2 121.9 C90.2 129.2 84.8 132.7 80.6 131.5"
                  fill="#bcf9f0"
                />
                <path
                  d="M75.4 99.1 C85.2 97.5 88.2 105.9 88.5 115.2 C88.9 126.8 83.2 131.7 76.6 131.4 C69.7 131 67.3 123.2 67.4 114.1 C67.5 105.6 70.4 100.6 75.4 99.1 Z"
                  fill="#27b8c1"
                  stroke="#1a8ca3"
                  strokeWidth="1"
                />
              </g>

              {/* Mic boom */}
              <g id="mic-boom">
                <path
                  d="M188.6 117.8 C188.9 130.1 183.1 136.5 174.1 138.8 L168.7 139.1"
                  fill="none"
                  stroke="#12486d"
                  strokeWidth="3.6"
                />
                <path
                  d="M166.8 133.3 C168.8 130.8 174.4 131.1 175.4 134 C177 137.4 173.7 141.1 169.8 140.6 L165.7 140.5 C162.4 140.3 161.5 135.9 164.4 134.1 Z"
                  fill="#114b73"
                />
              </g>

              {/* Excitement rays */}
              <g id="sparkles" fill="none" stroke="#26b9c1" strokeWidth="3.3">
                <path d="M191.8 68.7 L197.8 58.6" />
                <path d="M198.4 76.8 L209.8 67.9" />
                <path d="M204 82.6 L214 80.1" />
              </g>
            </g>
          </svg>
        </div>

        {/* Upward Cream Arch Overlap touching the bottom edge of the mascot */}
        <svg
          viewBox="0 0 1200 90"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -bottom-px z-20 h-[48px] w-full sm:h-[58px]"
        >
          <path d="M0 90 Q600 -45 1200 90 L1200 90 L0 90 Z" fill="#faf7f2" />
        </svg>
      </div>

      {/* Status Pill sitting right below the arch crest */}
      <div className="relative z-30 -mt-1.5 flex flex-col items-center">
        <div
          data-testid="voice-status-badge"
          data-voice-state={voiceState}
          className={`inline-flex items-center gap-2.5 rounded-full px-6 py-1.5 text-sm font-bold tracking-tight transition-colors sm:px-7 sm:text-base ${STATE_BADGE_STYLES[voiceState]}`}
        >
          <span className="relative flex h-3.5 w-3.5 shrink-0">
            <span
              className={`inline-flex h-full w-full rounded-full ${STATE_DOT_STYLES[voiceState]}`}
            />
          </span>
          <span>{VOICE_STATE_LABELS[voiceState]}</span>
        </div>

        {/* Hidden-when-idle amplitude bar test hook for speaking state */}
        {voiceState === 'speaking' && (
          <div className="sr-only" aria-hidden="true">
            <div
              data-testid="lipsync-amplitude-bar"
              style={{ width: `${levelPercent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
