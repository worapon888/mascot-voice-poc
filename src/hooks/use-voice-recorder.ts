'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClientVoiceError,
  MAX_BROWSER_AUDIO_BYTES,
  MAX_RECORDING_SECONDS,
} from '@/lib/voice/api-client';

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

export interface RecordedAudioPayload {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

export function detectSupportedRecordingMimeType(): string | null {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return null;
  }

  for (const candidate of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return '';
}

interface UseVoiceRecorderOptions {
  onAutoStopComplete?: (payload: RecordedAudioPayload) => void;
  onRecorderError?: (error: ClientVoiceError) => void;
}

export function useVoiceRecorder(options: UseVoiceRecorderOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeMsRef = useRef<number>(0);
  const isCancelledRef = useRef<boolean>(false);
  const stopResolverRef = useRef<
    ((payload: RecordedAudioPayload | null) => void) | null
  >(null);

  const onAutoStopRef = useRef(options.onAutoStopComplete);
  const onErrorRef = useRef(options.onRecorderError);

  useEffect(() => {
    onAutoStopRef.current = options.onAutoStopComplete;
    onErrorRef.current = options.onRecorderError;
  }, [options.onAutoStopComplete, options.onRecorderError]);

  const clearTimers = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (autoStopTimeoutRef.current) {
      clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }
  }, []);

  const stopMediaTracks = useCallback(() => {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
  }, []);

  const cleanupRecorder = useCallback(() => {
    clearTimers();
    stopMediaTracks();
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
    setElapsedSeconds(0);
  }, [clearTimers, stopMediaTracks]);

  useEffect(() => {
    return () => {
      isCancelledRef.current = true;
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore stop errors during unmount
        }
      }
      clearTimers();
      stopMediaTracks();
    };
  }, [clearTimers, stopMediaTracks]);

  const startRecording = useCallback(async (): Promise<void> => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      return;
    }

    if (
      typeof window === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      throw new ClientVoiceError(
        'MIC_UNSUPPORTED',
        400,
        'เบราว์เซอร์นี้ไม่รองรับการบันทึกเสียงผ่านไมโครโฟน กรุณาใช้งานผ่าน Google Chrome',
      );
    }

    const supportedMime = detectSupportedRecordingMimeType();
    if (supportedMime === null) {
      throw new ClientVoiceError(
        'MIME_UNSUPPORTED',
        415,
        'เบราว์เซอร์ไม่รองรับรูปแบบการบันทึกเสียงที่ระบบต้องการ',
      );
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      const domErrorName = err instanceof Error ? err.name : '';
      if (
        domErrorName === 'NotAllowedError' ||
        domErrorName === 'PermissionDeniedError'
      ) {
        throw new ClientVoiceError(
          'MIC_PERMISSION_DENIED',
          403,
          'ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน กรุณากดอนุญาตการใช้ไมโครโฟนบนแถบที่อยู่ของเบราว์เซอร์แล้วลองใหม่',
        );
      }
      if (
        domErrorName === 'NotFoundError' ||
        domErrorName === 'DevicesNotFoundError'
      ) {
        throw new ClientVoiceError(
          'MIC_NOT_FOUND',
          404,
          'ไม่พบอุปกรณ์ไมโครโฟนในเครื่องของคุณ กรุณาเชื่อมต่อไมโครโฟนแล้วลองใหม่',
        );
      }
      throw new ClientVoiceError(
        'MIC_ERROR',
        500,
        'ไม่สามารถเปิดใช้งานไมโครโฟนได้ กรุณาตรวจสอบอุปกรณ์แล้วลองใหม่',
      );
    }

    mediaStreamRef.current = stream;
    chunksRef.current = [];
    isCancelledRef.current = false;
    stopResolverRef.current = null;

    let recorder: MediaRecorder;
    try {
      recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);
    } catch {
      stopMediaTracks();
      throw new ClientVoiceError(
        'RECORDER_INIT_FAILED',
        415,
        'ไม่สามารถเริ่มต้นตัวบันทึกเสียงในรูปแบบที่รองรับได้',
      );
    }

    mediaRecorderRef.current = recorder;
    startTimeMsRef.current = Date.now();
    setElapsedSeconds(0);
    setIsRecording(true);

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onerror = () => {
      cleanupRecorder();
      onErrorRef.current?.(
        new ClientVoiceError(
          'RECORDER_RUNTIME_ERROR',
          500,
          'เกิดข้อผิดพลาดระหว่างการบันทึกเสียง กรุณาลองใหม่อีกครั้ง',
        ),
      );
    };

    recorder.onstop = () => {
      clearTimers();
      stopMediaTracks();
      setIsRecording(false);

      const wasCancelled = isCancelledRef.current;
      const recordedChunks = [...chunksRef.current];
      const actualMimeType = recorder.mimeType || supportedMime || 'audio/webm';
      const durationSeconds = Math.max(
        1,
        Math.round((Date.now() - startTimeMsRef.current) / 1000),
      );

      chunksRef.current = [];
      mediaRecorderRef.current = null;
      setElapsedSeconds(0);

      if (wasCancelled) {
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        resolver?.(null);
        return;
      }

      const blob = new Blob(recordedChunks, { type: actualMimeType });
      if (blob.size === 0) {
        const emptyError = new ClientVoiceError(
          'EMPTY_RECORDING',
          400,
          'ไม่พบสัญญาณเสียงที่บันทึก กรุณาพูดหลังกดปุ่มไมโครโฟน',
        );
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        if (resolver) {
          resolver(null);
        }
        onErrorRef.current?.(emptyError);
        return;
      }

      if (blob.size > MAX_BROWSER_AUDIO_BYTES) {
        const sizeError = new ClientVoiceError(
          'AUDIO_TOO_LARGE',
          413,
          'ไฟล์เสียงที่บันทึกมีขนาดเกิน 3 MB กรุณาบันทึกเสียงให้สั้นลง',
        );
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        if (resolver) {
          resolver(null);
        }
        onErrorRef.current?.(sizeError);
        return;
      }

      const payload: RecordedAudioPayload = {
        blob,
        mimeType: actualMimeType,
        durationSeconds,
      };

      const resolver = stopResolverRef.current;
      stopResolverRef.current = null;
      if (resolver) {
        resolver(payload);
      } else {
        // Triggered by automatic 20-second cap
        onAutoStopRef.current?.(payload);
      }
    };

    recorder.start(200);

    timerIntervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeMsRef.current) / 1000);
      setElapsedSeconds(Math.min(elapsed, MAX_RECORDING_SECONDS));
    }, 250);

    autoStopTimeoutRef.current = setTimeout(() => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === 'recording'
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          cleanupRecorder();
        }
      }
    }, MAX_RECORDING_SECONDS * 1000);
  }, [cleanupRecorder, clearTimers, stopMediaTracks]);

  const stopAndSubmitRecording =
    useCallback((): Promise<RecordedAudioPayload | null> => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        cleanupRecorder();
        return Promise.resolve(null);
      }

      isCancelledRef.current = false;
      return new Promise<RecordedAudioPayload | null>((resolve) => {
        stopResolverRef.current = resolve;
        try {
          recorder.stop();
        } catch {
          cleanupRecorder();
          resolve(null);
        }
      });
    }, [cleanupRecorder]);

  const cancelRecording = useCallback(() => {
    isCancelledRef.current = true;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Ignore stop errors on cancel
      }
    }
    cleanupRecorder();
  }, [cleanupRecorder]);

  return {
    isRecording,
    elapsedSeconds,
    maxRecordingSeconds: MAX_RECORDING_SECONDS,
    startRecording,
    stopAndSubmitRecording,
    cancelRecording,
  };
}
