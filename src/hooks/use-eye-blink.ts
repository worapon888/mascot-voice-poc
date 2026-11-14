'use client';

import { useEffect, useState } from 'react';

const MIN_BLINK_INTERVAL_MS = 3000;
const MAX_BLINK_INTERVAL_MS = 7000;
const MIN_BLINK_DURATION_MS = 100;
const MAX_BLINK_DURATION_MS = 180;
const DOUBLE_BLINK_PROBABILITY = 0.18;
const DOUBLE_BLINK_PAUSE_MS = 110;

function randomBetween(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

/**
 * Lightweight client-side hook for natural mascot eye blinking.
 * - Schedules blinks at random 3–7 second intervals
 * - Closes eyes for 100–180ms and reopens automatically
 * - Occasionally performs a natural double blink
 * - Runs completely independently of voiceState and Web Audio lip-sync
 * - Respects `prefers-reduced-motion: reduce` and cleans up all timers on unmount
 */
export function useEyeBlink(): boolean {
  const [isBlinking, setIsBlinking] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const activeTimers = new Set<ReturnType<typeof setTimeout>>();
    let isUnmounted = false;

    const clearAllTimers = () => {
      for (const timerId of activeTimers) {
        clearTimeout(timerId);
      }
      activeTimers.clear();
    };

    const scheduleTimeout = (callback: () => void, delayMs: number) => {
      const timerId = setTimeout(() => {
        activeTimers.delete(timerId);
        if (!isUnmounted) {
          callback();
        }
      }, delayMs);
      activeTimers.add(timerId);
    };

    const mediaQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    const scheduleNextBlinkCycle = () => {
      if (isUnmounted || mediaQuery?.matches) {
        return;
      }

      const nextIntervalMs = randomBetween(
        MIN_BLINK_INTERVAL_MS,
        MAX_BLINK_INTERVAL_MS,
      );

      scheduleTimeout(() => {
        if (mediaQuery?.matches) {
          setIsBlinking(false);
          return;
        }

        const firstCloseDurationMs = randomBetween(
          MIN_BLINK_DURATION_MS,
          MAX_BLINK_DURATION_MS,
        );
        const shouldDoubleBlink = Math.random() < DOUBLE_BLINK_PROBABILITY;

        setIsBlinking(true);

        scheduleTimeout(() => {
          setIsBlinking(false);

          if (!shouldDoubleBlink || mediaQuery?.matches) {
            scheduleNextBlinkCycle();
            return;
          }

          // Optional natural double-blink after a brief reopen pause
          scheduleTimeout(() => {
            if (mediaQuery?.matches) {
              setIsBlinking(false);
              return;
            }

            const secondCloseDurationMs = randomBetween(
              MIN_BLINK_DURATION_MS,
              MAX_BLINK_DURATION_MS,
            );
            setIsBlinking(true);

            scheduleTimeout(() => {
              setIsBlinking(false);
              scheduleNextBlinkCycle();
            }, secondCloseDurationMs);
          }, DOUBLE_BLINK_PAUSE_MS);
        }, firstCloseDurationMs);
      }, nextIntervalMs);
    };

    if (!mediaQuery?.matches) {
      scheduleNextBlinkCycle();
    }

    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      clearAllTimers();
      if (event.matches) {
        setIsBlinking(false);
      } else {
        scheduleNextBlinkCycle();
      }
    };

    mediaQuery?.addEventListener('change', handleMotionPreferenceChange);

    return () => {
      isUnmounted = true;
      clearAllTimers();
      mediaQuery?.removeEventListener('change', handleMotionPreferenceChange);
    };
  }, []);

  return isBlinking;
}
