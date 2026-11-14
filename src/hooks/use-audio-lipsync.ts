'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientVoiceError } from '@/lib/voice/api-client';
import type { MouthFrame } from '@/types/voice';

const SILENCE_RMS_THRESHOLD = 0.016;
const WIDE_OPEN_RMS_THRESHOLD = 0.055;
const SMOOTHING_ALPHA = 0.45;

export type PlayAudioOutcome = 'completed' | 'stopped' | 'autoplay-blocked';

export function useAudioLipsync() {
  const [mouthFrame, setMouthFrame] = useState<MouthFrame>('closed');
  const [amplitude, setAmplitude] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const currentObjectUrlRef = useRef<string | null>(null);
  const smoothedRmsRef = useRef<number>(0);
  const playbackResolverRef = useRef<
    ((outcome: PlayAudioOutcome) => void) | null
  >(null);

  const cancelAnimationLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    smoothedRmsRef.current = 0;
    setMouthFrame('closed');
    setAmplitude(0);
  }, []);

  const revokeCurrentObjectUrl = useCallback(() => {
    if (currentObjectUrlRef.current) {
      URL.revokeObjectURL(currentObjectUrlRef.current);
      currentObjectUrlRef.current = null;
    }
  }, []);

  /**
   * Initializes the persistent HTMLAudioElement and single Web Audio API graph.
   * Ensures createMediaElementSource() is called at most once on the stable audio element.
   */
  const ensureAudioGraph = useCallback((): {
    audio: HTMLAudioElement;
    context: AudioContext;
    analyser: AnalyserNode;
  } => {
    if (!audioElementRef.current) {
      const audioEl = new Audio();
      audioEl.preload = 'auto';
      audioEl.crossOrigin = 'anonymous';
      audioElementRef.current = audioEl;
    }

    if (!audioContextRef.current) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioContextRef.current = new AudioCtx();
    }

    const context = audioContextRef.current;
    const audio = audioElementRef.current;

    if (!analyserNodeRef.current) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      analyserNodeRef.current = analyser;
    }

    if (!sourceNodeRef.current) {
      const source = context.createMediaElementSource(audio);
      source.connect(analyserNodeRef.current);
      analyserNodeRef.current.connect(context.destination);
      sourceNodeRef.current = source;
    }

    return {
      audio,
      context,
      analyser: analyserNodeRef.current,
    };
  }, []);

  /**
   * Call inside a direct user click gesture (e.g., microphone button press)
   * to unlock/resume the Web Audio API context for subsequent TTS playback.
   */
  const unlockAudioContext = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const { context } = ensureAudioGraph();
      if (context.state === 'suspended') {
        await context.resume();
      }
    } catch {
      // Ignore if browser prevents early AudioContext initialization
    }
  }, [ensureAudioGraph]);

  const startAmplitudeSampling = useCallback(
    (audio: HTMLAudioElement, analyser: AnalyserNode) => {
      cancelAnimationLoop();
      const bufferLength = analyser.fftSize;
      const timeDomainData = new Uint8Array(bufferLength);

      const sampleFrame = () => {
        if (audio.paused || audio.ended) {
          setMouthFrame('closed');
          setAmplitude(0);
          return;
        }

        analyser.getByteTimeDomainData(timeDomainData);

        let sumSquares = 0;
        for (let i = 0; i < bufferLength; i++) {
          const normalized = (timeDomainData[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rawRms = Math.sqrt(sumSquares / bufferLength);
        const smoothed =
          smoothedRmsRef.current * (1 - SMOOTHING_ALPHA) +
          rawRms * SMOOTHING_ALPHA;
        smoothedRmsRef.current = smoothed;

        const normalizedLevel = Math.min(1, smoothed * 10);
        setAmplitude(normalizedLevel);

        if (smoothed < SILENCE_RMS_THRESHOLD) {
          setMouthFrame('closed');
        } else if (smoothed < WIDE_OPEN_RMS_THRESHOLD) {
          setMouthFrame('small');
        } else {
          setMouthFrame('open');
        }

        rafIdRef.current = requestAnimationFrame(sampleFrame);
      };

      rafIdRef.current = requestAnimationFrame(sampleFrame);
    },
    [cancelAnimationLoop],
  );

  const stopAudio = useCallback(
    (revokeUrl = true) => {
      cancelAnimationLoop();
      setIsPlaying(false);

      const audio = audioElementRef.current;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        try {
          audio.pause();
          audio.currentTime = 0;
          if (revokeUrl) {
            audio.removeAttribute('src');
            audio.load();
          }
        } catch {
          // Ignore pause reset errors
        }
      }

      if (revokeUrl) {
        revokeCurrentObjectUrl();
      }

      const resolver = playbackResolverRef.current;
      playbackResolverRef.current = null;
      resolver?.('stopped');
    },
    [cancelAnimationLoop, revokeCurrentObjectUrl],
  );

  const playAudioBlob = useCallback(
    async (mp3Blob: Blob): Promise<PlayAudioOutcome> => {
      stopAudio(true);

      const { audio, context, analyser } = ensureAudioGraph();
      if (context.state === 'suspended') {
        try {
          await context.resume();
        } catch {
          // Will handle blocked state below if play() rejects
        }
      }

      const objectUrl = URL.createObjectURL(mp3Blob);
      currentObjectUrlRef.current = objectUrl;
      audio.src = objectUrl;
      audio.currentTime = 0;

      return new Promise<PlayAudioOutcome>((resolve, reject) => {
        playbackResolverRef.current = resolve;

        audio.onended = () => {
          cancelAnimationLoop();
          setIsPlaying(false);
          revokeCurrentObjectUrl();
          playbackResolverRef.current = null;
          resolve('completed');
        };

        audio.onerror = () => {
          cancelAnimationLoop();
          setIsPlaying(false);
          revokeCurrentObjectUrl();
          playbackResolverRef.current = null;
          reject(
            new ClientVoiceError(
              'AUDIO_PLAYBACK_FAILED',
              500,
              'ไม่สามารถเล่นไฟล์เสียงตอบกลับได้ กรุณาลองใหม่อีกครั้ง',
            ),
          );
        };

        audio
          .play()
          .then(() => {
            setIsPlaying(true);
            startAmplitudeSampling(audio, analyser);
          })
          .catch((err: unknown) => {
            cancelAnimationLoop();
            setIsPlaying(false);
            const errName = err instanceof Error ? err.name : '';
            if (errName === 'NotAllowedError') {
              // Keep objectUrl intact so user can click "เล่นเสียงตอบกลับ" manually
              playbackResolverRef.current = null;
              resolve('autoplay-blocked');
              return;
            }
            revokeCurrentObjectUrl();
            playbackResolverRef.current = null;
            reject(
              new ClientVoiceError(
                'AUDIO_PLAYBACK_FAILED',
                500,
                'ไม่สามารถเริ่มต้นเล่นเสียงตอบกลับได้ กรุณาลองใหม่อีกครั้ง',
              ),
            );
          });
      });
    },
    [
      cancelAnimationLoop,
      ensureAudioGraph,
      revokeCurrentObjectUrl,
      startAmplitudeSampling,
      stopAudio,
    ],
  );

  useEffect(() => {
    return () => {
      cancelAnimationLoop();
      if (audioElementRef.current) {
        try {
          audioElementRef.current.pause();
          audioElementRef.current.removeAttribute('src');
        } catch {
          // Ignore unmount pause errors
        }
      }
      revokeCurrentObjectUrl();
      if (
        audioContextRef.current &&
        audioContextRef.current.state !== 'closed'
      ) {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, [cancelAnimationLoop, revokeCurrentObjectUrl]);

  return {
    mouthFrame,
    amplitude,
    isPlaying,
    unlockAudioContext,
    playAudioBlob,
    stopAudio,
  };
}
