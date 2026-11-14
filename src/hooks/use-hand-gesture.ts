'use client';

import { useEffect, useState } from 'react';
import type { VoiceState } from '@/types/voice';

const INITIAL_SPEECH_DELAY_MIN_MS = 220;
const INITIAL_SPEECH_DELAY_MAX_MS = 520;
const GESTURE_DURATION_MIN_MS = 820;
const GESTURE_DURATION_MAX_MS = 1480;
const PAUSE_BETWEEN_GESTURES_MIN_MS = 550;
const PAUSE_BETWEEN_GESTURES_MAX_MS = 1350;
const REST_RETURN_TRANSITION_MS = 300;

// Negative rotation raises the mascot's right hand slightly upward/inward from the elbow pivot
const GESTURE_PEAK_ANGLES_DEG = [-5.8, -6.6, -7.2, -5.4, -6.2] as const;

function randomBetween(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

export interface HandGestureState {
  isGesturing: boolean;
  rotationDeg: number;
  transitionDurationMs: number;
}

const RESTING_HAND_STATE: HandGestureState = {
  isGesturing: false,
  rotationDeg: 0,
  transitionDurationMs: REST_RETURN_TRANSITION_MS,
};

/**
 * Lightweight client-side hook for natural mascot hand gestures during active TTS playback.
 * - Triggers ONLY when `voiceState === 'speaking'`
 * - Raises and lowers the right forearm/hand from the elbow pivot over 0.8–1.5s cycles
 * - Adds varied pauses between gestures to avoid repetitive mechanical waving
 * - Immediately clears timers and smoothly returns to 0deg when speech stops, ends, or fails
 * - Respects `prefers-reduced-motion: reduce`
 */
export function useHandGesture(voiceState: VoiceState): HandGestureState {
  const [gestureState, setGestureState] =
    useState<HandGestureState>(RESTING_HAND_STATE);

  useEffect(() => {
    if (typeof window === 'undefined' || voiceState !== 'speaking') {
      return;
    }

    const mediaQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    if (mediaQuery?.matches) {
      return;
    }

    const activeTimers = new Set<ReturnType<typeof setTimeout>>();
    let isCancelled = false;
    let gestureIndex = 0;

    const clearAllTimers = () => {
      for (const timerId of activeTimers) {
        clearTimeout(timerId);
      }
      activeTimers.clear();
    };

    const scheduleTimeout = (callback: () => void, delayMs: number) => {
      const timerId = setTimeout(() => {
        activeTimers.delete(timerId);
        if (!isCancelled) {
          callback();
        }
      }, delayMs);
      activeTimers.add(timerId);
    };

    const runGestureCycle = () => {
      if (isCancelled || mediaQuery?.matches) {
        setGestureState(RESTING_HAND_STATE);
        return;
      }

      const totalGestureMs = randomBetween(
        GESTURE_DURATION_MIN_MS,
        GESTURE_DURATION_MAX_MS,
      );
      const raisePhaseMs = Math.round(totalGestureMs * 0.44);
      const holdPhaseMs = Math.round(totalGestureMs * 0.18);
      const lowerPhaseMs = Math.max(
        260,
        totalGestureMs - raisePhaseMs - holdPhaseMs,
      );

      const peakAngle =
        GESTURE_PEAK_ANGLES_DEG[gestureIndex % GESTURE_PEAK_ANGLES_DEG.length];
      gestureIndex += 1;

      // Phase 1: Smoothly raise hand as though explaining
      setGestureState({
        isGesturing: true,
        rotationDeg: peakAngle,
        transitionDurationMs: raisePhaseMs,
      });

      // Phase 2: Subtle mid-air emphasis settle before lowering
      scheduleTimeout(() => {
        if (mediaQuery?.matches) {
          setGestureState(RESTING_HAND_STATE);
          return;
        }

        setGestureState({
          isGesturing: true,
          rotationDeg: Number((peakAngle * 0.68).toFixed(2)),
          transitionDurationMs: holdPhaseMs,
        });

        // Phase 3: Smoothly lower hand back to resting position
        scheduleTimeout(() => {
          setGestureState({
            isGesturing: false,
            rotationDeg: 0,
            transitionDurationMs: lowerPhaseMs,
          });

          // Varied pause after returning to rest before next gesture
          const nextPauseMs = randomBetween(
            PAUSE_BETWEEN_GESTURES_MIN_MS,
            PAUSE_BETWEEN_GESTURES_MAX_MS,
          );
          scheduleTimeout(() => {
            runGestureCycle();
          }, lowerPhaseMs + nextPauseMs);
        }, holdPhaseMs);
      }, raisePhaseMs);
    };

    const initialDelayMs = randomBetween(
      INITIAL_SPEECH_DELAY_MIN_MS,
      INITIAL_SPEECH_DELAY_MAX_MS,
    );
    scheduleTimeout(() => {
      runGestureCycle();
    }, initialDelayMs);

    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        clearAllTimers();
        setGestureState(RESTING_HAND_STATE);
      }
    };

    mediaQuery?.addEventListener('change', handleMotionPreferenceChange);

    return () => {
      isCancelled = true;
      clearAllTimers();
      mediaQuery?.removeEventListener('change', handleMotionPreferenceChange);
      setGestureState(RESTING_HAND_STATE);
    };
  }, [voiceState]);

  if (voiceState !== 'speaking') {
    return RESTING_HAND_STATE;
  }

  return gestureState;
}
