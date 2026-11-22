import type {
  AnswerResponse,
  ApiErrorResponse,
  ConversationTurn,
  SttResponse,
} from '@/types/api';

export const MAX_BROWSER_AUDIO_BYTES = 3 * 1024 * 1024; // 3 MB
export const MAX_RECORDING_SECONDS = 20;
export const MAX_CLIENT_CONVERSATION_HISTORY_TURNS = 4;

export interface StreamingAnswerCallbacks {
  onTier?: (data: {
    tier: 'TIER_1' | 'TIER_2' | 'TIER_3';
    matched: boolean;
    faqIds: number[];
    answer?: string;
    audioUrl?: string;
  }) => void | Promise<void>;
  onTextDelta?: (delta: string, accumulated: string) => void | Promise<void>;
  onAudioChunk?: (data: {
    chunkIndex: number;
    text: string;
    blob: Blob;
    cached: boolean;
    isLast: boolean;
  }) => void | Promise<void>;
  onDone?: (data: {
    tier: 'TIER_1' | 'TIER_2' | 'TIER_3';
    fullAnswer: string;
    totalChunks: number;
  }) => void | Promise<void>;
}

export function base64ToBlob(
  base64DataUri: string,
  mimeType = 'audio/mpeg',
): Blob {
  const base64 = base64DataUri.includes(',')
    ? base64DataUri.split(',')[1]
    : base64DataUri;
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Pure helper that appends a completed user + assistant exchange to the client session's
 * sliding conversation window (capped at `maxTurns`, default 4 turns).
 * Aborted or incomplete turns must never be passed to this helper.
 */
export function appendCompletedTurnToHistory(
  currentHistory: ReadonlyArray<ConversationTurn>,
  userTranscript: string,
  answerResult: AnswerResponse,
  maxTurns = MAX_CLIENT_CONVERSATION_HISTORY_TURNS,
): ConversationTurn[] {
  const cleanUser = userTranscript.trim().slice(0, 500);
  const cleanAssistant = answerResult.answer.trim().slice(0, 500);
  if (!cleanUser || !cleanAssistant) {
    return [...currentHistory].slice(-maxTurns);
  }

  const faqIds =
    answerResult.faqIds && answerResult.faqIds.length > 0
      ? answerResult.faqIds.slice(0, 5)
      : undefined;

  const nextTurns: ConversationTurn[] = [
    ...currentHistory,
    {
      role: 'user',
      text: cleanUser,
      ...(faqIds ? { faqIds } : {}),
    },
    {
      role: 'assistant',
      text: cleanAssistant,
      ...(faqIds ? { faqIds } : {}),
    },
  ];

  return nextTurns.slice(-maxTurns);
}

export class ClientVoiceError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ClientVoiceError';
    this.code = code;
    this.status = status;
  }
}

function getExtensionForMimeType(mimeType: string): string {
  const clean = mimeType.split(';')[0].trim().toLowerCase();
  switch (clean) {
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    default:
      return 'webm';
  }
}

async function parseErrorResponse(
  response: Response,
  fallbackMessage: string,
): Promise<ClientVoiceError> {
  try {
    const data = (await response.json()) as Partial<ApiErrorResponse>;
    if (data?.error?.message) {
      return new ClientVoiceError(
        data.error.code ?? `HTTP_${response.status}`,
        response.status,
        data.error.message,
      );
    }
  } catch {
    // Ignore JSON parse failure on non-JSON error responses
  }

  if (response.status === 413) {
    return new ClientVoiceError(
      'AUDIO_TOO_LARGE',
      413,
      'ไฟล์เสียงมีขนาดเกิน 3 MB กรุณาพูดให้สั้นลงแล้วลองใหม่อีกครั้ง',
    );
  }
  if (response.status === 415) {
    return new ClientVoiceError(
      'INVALID_AUDIO',
      415,
      'รูปแบบไฟล์เสียงไม่รองรับ กรุณาใช้เบราว์เซอร์ Chrome เวอร์ชันล่าสุด',
    );
  }
  if (response.status === 429) {
    return new ClientVoiceError(
      'RATE_LIMITED',
      429,
      'ขณะนี้มีคำขอจำนวนมากเกินขีดจำกัด (HTTP 429) กรุณารอสักครู่แล้วลองใหม่',
    );
  }
  if (response.status === 503) {
    return new ClientVoiceError(
      'SERVICE_UNAVAILABLE',
      503,
      'ระบบบริการฐานข้อมูลหรือ AI ไม่พร้อมใช้งานชั่วคราว (HTTP 503)',
    );
  }
  if (response.status === 504) {
    return new ClientVoiceError(
      'UPSTREAM_TIMEOUT',
      504,
      'การประมวลผลใช้เวลานานเกินกำหนด (HTTP 504) กรุณาลองใหม่อีกครั้ง',
    );
  }

  return new ClientVoiceError(
    `HTTP_${response.status}`,
    response.status,
    fallbackMessage,
  );
}

/**
 * Step A: Sends recorded audio Blob to POST /api/stt preserving its real MIME type and container extension.
 */
export async function requestSpeechToText(
  audioBlob: Blob,
  mimeType: string,
  signal?: AbortSignal,
): Promise<SttResponse> {
  if (!audioBlob || audioBlob.size === 0) {
    throw new ClientVoiceError(
      'EMPTY_RECORDING',
      400,
      'ไม่พบข้อมูลเสียงที่บันทึก กรุณากดไมโครโฟนแล้วพูดใหม่อีกครั้ง',
    );
  }

  if (audioBlob.size > MAX_BROWSER_AUDIO_BYTES) {
    throw new ClientVoiceError(
      'AUDIO_TOO_LARGE',
      413,
      'ไฟล์เสียงที่บันทึกมีขนาดเกิน 3 MB กรุณาบันทึกเสียงไม่เกิน 20 วินาที',
    );
  }

  const effectiveMime = mimeType || audioBlob.type || 'audio/webm';
  const ext = getExtensionForMimeType(effectiveMime);
  const fileName = `recording.${ext}`;

  const formData = new FormData();
  const normalizedBlob =
    audioBlob.type === effectiveMime
      ? audioBlob
      : new Blob([audioBlob], { type: effectiveMime });
  formData.append('audio', normalizedBlob, fileName);

  let response: Response;
  try {
    response = await fetch('/api/stt', {
      method: 'POST',
      body: formData,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    throw new ClientVoiceError(
      'NETWORK_ERROR',
      0,
      'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อแปลงเสียงได้ กรุณาตรวจสอบการเชื่อมต่อเครือข่าย',
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      'ไม่สามารถแปลงเสียงเป็นข้อความได้ กรุณาลองพูดใหม่อีกครั้ง',
    );
  }

  const data = (await response.json()) as SttResponse;
  if (!data?.transcript || data.transcript.trim().length === 0) {
    throw new ClientVoiceError(
      'EMPTY_TRANSCRIPT',
      422,
      'ระบบไม่ได้ยินข้อความที่ชัดเจน กรุณาพูดใกล้ไมโครโฟนแล้วลองใหม่',
    );
  }

  return { transcript: data.transcript.trim() };
}

/**
 * Step B: Sends Thai transcript (and optional recent conversation history) to POST /api/answer
 * to retrieve a Supabase FAQ-grounded answer.
 */
export async function requestGroundedAnswer(
  transcript: string,
  signal?: AbortSignal,
  conversationHistory?: ReadonlyArray<ConversationTurn>,
): Promise<AnswerResponse> {
  const payload =
    conversationHistory && conversationHistory.length > 0
      ? {
          transcript,
          conversationHistory: conversationHistory.slice(
            -MAX_CLIENT_CONVERSATION_HISTORY_TURNS,
          ),
        }
      : { transcript };

  let response: Response;
  try {
    response = await fetch('/api/answer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    throw new ClientVoiceError(
      'NETWORK_ERROR',
      0,
      'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อค้นหาคำตอบได้ กรุณาตรวจสอบเครือข่าย',
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      'ไม่สามารถค้นหาข้อมูลและสร้างคำตอบได้ในขณะนี้',
    );
  }

  return (await response.json()) as AnswerResponse;
}

/**
 * Sends transcript to POST /api/answer/stream and processes Server-Sent Events (SSE)
 * progressively yielding text deltas, tier identification, and ready-to-play audio chunks.
 */
export async function requestStreamingGroundedAnswer(
  transcript: string,
  callbacks: StreamingAnswerCallbacks,
  signal?: AbortSignal,
  conversationHistory?: ReadonlyArray<ConversationTurn>,
): Promise<void> {
  const payload =
    conversationHistory && conversationHistory.length > 0
      ? {
          transcript,
          conversationHistory: conversationHistory.slice(
            -MAX_CLIENT_CONVERSATION_HISTORY_TURNS,
          ),
        }
      : { transcript };

  let response: Response;
  try {
    response = await fetch('/api/answer/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    throw new ClientVoiceError(
      'NETWORK_ERROR',
      0,
      'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์สตรีมคำตอบได้',
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(response, 'เกิดข้อผิดพลาดในการรับสตรีมคำตอบ');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ClientVoiceError(
      'STREAM_UNAVAILABLE',
      500,
      'ตัวอ่านสตรีมไม่พร้อมใช้งาน',
    );
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        if (!block.trim()) continue;
        let eventType = 'message';
        let dataStr = '';

        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataStr = line.slice(5).trim();
          }
        }

        if (!dataStr) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (eventType === 'tier') {
          callbacks.onTier?.({
            tier: parsed.tier as 'TIER_1' | 'TIER_2' | 'TIER_3',
            matched: Boolean(parsed.matched),
            faqIds: (parsed.faqIds as number[]) ?? [],
            answer: parsed.answer as string | undefined,
            audioUrl: parsed.audioUrl as string | undefined,
          });
        } else if (eventType === 'text_chunk') {
          callbacks.onTextDelta?.(
            parsed.delta as string,
            parsed.accumulated as string,
          );
        } else if (eventType === 'audio_chunk_ready') {
          const audioDataUri = parsed.audioDataUri as string;
          if (audioDataUri) {
            const blob = base64ToBlob(audioDataUri);
            callbacks.onAudioChunk?.({
              chunkIndex: parsed.chunkIndex as number,
              text: parsed.text as string,
              blob,
              cached: Boolean(parsed.cached),
              isLast: Boolean(parsed.isLast),
            });
          }
        } else if (eventType === 'done') {
          callbacks.onDone?.({
            tier: parsed.tier as 'TIER_1' | 'TIER_2' | 'TIER_3',
            fullAnswer: parsed.fullAnswer as string,
            totalChunks: parsed.totalChunks as number,
          });
        } else if (eventType === 'error') {
          throw new ClientVoiceError(
            (parsed.code as string) ?? 'UPSTREAM_ERROR',
            500,
            (parsed.message as string) ?? 'ข้อผิดพลาดในการสตรีม',
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Step C: Sends Thai answer text to POST /api/tts and returns the binary MP3 Blob.
 */
export async function requestTextToSpeechBlob(
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    throw new ClientVoiceError(
      'NETWORK_ERROR',
      0,
      'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อสร้างเสียงตอบกลับได้',
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(response, 'ไม่สามารถสร้างเสียงตอบกลับได้ในขณะนี้');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength === 0 || !contentType.includes('audio/mpeg')) {
    throw new ClientVoiceError(
      'INVALID_TTS_AUDIO',
      502,
      'ข้อมูลเสียงตอบกลับที่ได้รับไม่ถูกต้อง',
    );
  }

  return new Blob([arrayBuffer], { type: 'audio/mpeg' });
}

const persistentAudioBlobClientCache = new Map<string, Blob>();

export function clearPersistentAudioClientCache(): void {
  persistentAudioBlobClientCache.clear();
}

export function getPersistentAudioClientCacheStats(): {
  size: number;
  urls: string[];
} {
  return {
    size: persistentAudioBlobClientCache.size,
    urls: Array.from(persistentAudioBlobClientCache.keys()),
  };
}

/**
 * Preloads all currently active FAQ persistent audios + fallback audio into client memory.
 * Runs in background without blocking audio/mic or autoplay policies.
 */
export async function preloadPersistentFaqAudios(
  signal?: AbortSignal,
): Promise<{ preloadedCount: number; errors: number }> {
  try {
    const res = await fetch('/api/faq-audio/manifest', {
      method: 'GET',
      signal,
    });
    if (!res.ok) {
      return { preloadedCount: 0, errors: 1 };
    }
    const data = (await res.json()) as {
      audios?: Array<{ audioUrl: string; faqId: number }>;
    };
    if (!Array.isArray(data.audios)) {
      return { preloadedCount: 0, errors: 0 };
    }

    let preloadedCount = 0;
    let errors = 0;

    await Promise.allSettled(
      data.audios.map(async (item) => {
        if (!item.audioUrl) return;
        if (persistentAudioBlobClientCache.has(item.audioUrl)) {
          preloadedCount += 1;
          return;
        }
        try {
          await requestPersistentAudioBlob(item.audioUrl, signal);
          preloadedCount += 1;
        } catch {
          errors += 1;
        }
      }),
    );

    return { preloadedCount, errors };
  } catch {
    return { preloadedCount: 0, errors: 1 };
  }
}

/**
 * Fetches a pre-generated persistent FAQ MP3 Blob directly from Supabase Storage by URL (with in-memory client caching).
 * Validates binary size and MPEG/ID3 header so corrupted or missing files safely trigger
 * the dynamic `/api/tts` fallback without breaking Web Audio API lip-sync.
 */
export async function requestPersistentAudioBlob(
  audioUrl: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const cached = persistentAudioBlobClientCache.get(audioUrl);
  if (cached) {
    return cached;
  }

  const response = await fetch(audioUrl, {
    method: 'GET',
    mode: 'cors',
    signal,
  });

  if (!response.ok) {
    throw new ClientVoiceError(
      'PERSISTENT_AUDIO_FETCH_FAILED',
      response.status,
      `ไม่สามารถดาวน์โหลดไฟล์เสียง FAQ ที่เตรียมไว้ได้ (HTTP ${response.status})`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const hasMp3Signature =
    bytes.byteLength > 12 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));

  if (!hasMp3Signature) {
    throw new ClientVoiceError(
      'INVALID_PERSISTENT_AUDIO',
      502,
      'ไฟล์เสียง FAQ ที่เตรียมไว้ไม่ใช่รูปแบบ MP3 ที่ถูกต้อง',
    );
  }

  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  persistentAudioBlobClientCache.set(audioUrl, blob);
  return blob;
}

export interface RetrySessionSnapshot {
  recording: {
    blob: Blob;
    mimeType: string;
    durationSeconds: number;
    vadTimings?: {
      speechEndMs: number;
      vadCommitMs: number;
      silenceWaitMs: number;
      wavEncodeMs: number;
    };
  };
  transcript: string | null;
  answerResult: AnswerResponse | null;
  ttsBlob: Blob | null;
}

export interface SmartPipelineExecutionOptions {
  recordingPayload: RetrySessionSnapshot['recording'];
  existingSession?: RetrySessionSnapshot | null;
  isRetry?: boolean;
  conversationHistory?: ReadonlyArray<ConversationTurn>;
  isStaleTurn: () => boolean;
  signal: AbortSignal;
  onStateChange: (state: 'transcribing' | 'thinking' | 'synthesizing') => void;
  onTranscriptReady: (transcript: string) => void;
  onAnswerReady: (answerResult: AnswerResponse) => void;
  sttFn?: typeof requestSpeechToText;
  answerFn?: typeof requestGroundedAnswer;
  ttsFn?: typeof requestTextToSpeechBlob;
  persistentAudioFn?: typeof requestPersistentAudioBlob;
}

export interface SmartPipelineStageResult {
  session: RetrySessionSnapshot;
  ttsBlob: Blob;
  audioSource: 'PERSISTENT_STORAGE' | 'DYNAMIC_TTS';
  stageLatenciesMs: {
    sttMs: number;
    answerMs: number;
    ttsMs: number;
  };
  timingBreakdown: {
    speechEndToVadCommitMs?: number;
    vadCommitToSttMs: number;
    sttToAnswerMs: number;
    answerToAudioReadyMs: number;
    totalProcessingMs: number;
  };
  apiCallsMade: {
    stt: number;
    answer: number;
    tts: number;
    persistentAudioFetch: number;
  };
}

/**
 * Executes the 3-stage voice pipeline (STT -> Answer -> TTS) with Smart Retry checkpointing:
 * - On fresh recordings (`isRetry = false`), resets checkpoints and runs from STT.
 * - On retry (`isRetry = true`), reuses an already-succeeded `transcript` (skipping `/api/stt`),
 *   an already-succeeded `answerResult` (skipping `/api/answer`), or `ttsBlob` (skipping `/api/tts`).
 */
export async function executeSmartPipelineStages(
  options: SmartPipelineExecutionOptions,
): Promise<SmartPipelineStageResult | null> {
  const {
    recordingPayload,
    existingSession,
    isRetry = false,
    conversationHistory,
    isStaleTurn,
    signal,
    onStateChange,
    onTranscriptReady,
    onAnswerReady,
    sttFn = requestSpeechToText,
    answerFn = requestGroundedAnswer,
    ttsFn = requestTextToSpeechBlob,
    persistentAudioFn = requestPersistentAudioBlob,
  } = options;

  const tPipelineStart = performance.now();
  const hasMatchingSession =
    existingSession !== null &&
    existingSession !== undefined &&
    existingSession.recording === recordingPayload;

  let session: RetrySessionSnapshot;
  if (hasMatchingSession) {
    session = existingSession;
    if (!isRetry) {
      session.transcript = null;
      session.answerResult = null;
      session.ttsBlob = null;
    }
  } else {
    session = {
      recording: recordingPayload,
      transcript: null,
      answerResult: null,
      ttsBlob: null,
    };
  }

  const stageLatenciesMs = { sttMs: 0, answerMs: 0, ttsMs: 0 };
  const apiCallsMade = {
    stt: 0,
    answer: 0,
    tts: 0,
    persistentAudioFetch: 0,
  };
  let audioSource: 'PERSISTENT_STORAGE' | 'DYNAMIC_TTS' = 'DYNAMIC_TTS';

  // Step A: Speech-to-Text (/api/stt) — skip on retry if transcript already succeeded
  let activeTranscript = session.transcript;
  if (!activeTranscript) {
    onStateChange('transcribing');
    const tStt0 = performance.now();
    const sttResult = await sttFn(
      recordingPayload.blob,
      recordingPayload.mimeType,
      signal,
    );
    stageLatenciesMs.sttMs = Math.round(performance.now() - tStt0);
    apiCallsMade.stt += 1;

    if (isStaleTurn()) {
      return null;
    }

    activeTranscript = sttResult.transcript;
    session.transcript = activeTranscript;
    onTranscriptReady(activeTranscript);
  } else {
    onTranscriptReady(activeTranscript);
  }

  // Step B: Grounded FAQ Answer (/api/answer) — skip on retry if answerResult already succeeded
  let activeAnswerResult = session.answerResult;
  if (!activeAnswerResult) {
    onStateChange('thinking');
    const tAns0 = performance.now();
    const fetchedAnswer = await answerFn(
      activeTranscript,
      signal,
      conversationHistory,
    );
    stageLatenciesMs.answerMs = Math.round(performance.now() - tAns0);
    apiCallsMade.answer += 1;

    if (isStaleTurn()) {
      return null;
    }

    activeAnswerResult = fetchedAnswer;
    session.answerResult = activeAnswerResult;
    onAnswerReady(activeAnswerResult);
  } else {
    onAnswerReady(activeAnswerResult);
  }

  // Step C: Audio Resolution — Prefer verified Persistent Pre-generated FAQ Audio if available,
  // falling back seamlessly to POST /api/tts if missing or unreachable.
  let activeTtsBlob = session.ttsBlob;
  if (!activeTtsBlob) {
    onStateChange('synthesizing');
    const tTts0 = performance.now();

    if (activeAnswerResult.audioRef?.audioUrl) {
      try {
        apiCallsMade.persistentAudioFetch += 1;
        const persistentBlob = await persistentAudioFn(
          activeAnswerResult.audioRef.audioUrl,
          signal,
        );
        if (isStaleTurn()) {
          return null;
        }
        activeTtsBlob = persistentBlob;
        audioSource = 'PERSISTENT_STORAGE';
        stageLatenciesMs.ttsMs = Math.round(performance.now() - tTts0);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        // Seamless fallback to dynamic POST /api/tts when storage read fails
      }
    }

    if (!activeTtsBlob) {
      const fetchedBlob = await ttsFn(activeAnswerResult.answer, signal);
      stageLatenciesMs.ttsMs = Math.round(performance.now() - tTts0);
      apiCallsMade.tts += 1;
      audioSource = 'DYNAMIC_TTS';

      if (isStaleTurn()) {
        return null;
      }

      activeTtsBlob = fetchedBlob;
    }

    session.ttsBlob = activeTtsBlob;
  }

  const tPipelineEnd = performance.now();
  const timingBreakdown = {
    speechEndToVadCommitMs: recordingPayload.vadTimings
      ? Math.round(
          recordingPayload.vadTimings.vadCommitMs -
            recordingPayload.vadTimings.speechEndMs,
        )
      : undefined,
    vadCommitToSttMs: stageLatenciesMs.sttMs,
    sttToAnswerMs: stageLatenciesMs.answerMs,
    answerToAudioReadyMs: stageLatenciesMs.ttsMs,
    totalProcessingMs: Math.round(tPipelineEnd - tPipelineStart),
  };

  return {
    session,
    ttsBlob: activeTtsBlob,
    audioSource,
    stageLatenciesMs,
    timingBreakdown,
    apiCallsMade,
  };
}
