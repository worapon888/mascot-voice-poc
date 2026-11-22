import 'server-only';
import { createHash } from 'node:crypto';
import { ApiError } from '@/lib/api/errors';
import { getOpenAIClient, OPENAI_MODELS } from '@/lib/openai/client';
import { normalizeThaiSpeech } from '@/lib/voice/thai-speech-normalizer';
import { detectAudioFormatFromSignature } from '@/services/transcription.service';

export const THAI_TTS_INSTRUCTIONS =
  'พูดภาษาไทยให้ชัดเจน เป็นธรรมชาติ ใช้น้ำเสียงสุภาพและเป็นมิตร อ่านเวลาตามการพูดภาษาไทยทั่วไป เว้นจังหวะอย่างเหมาะสม ไม่อ่านเครื่องหมายวรรคตอนหรือตัวย่อเป็นคำแปลก ๆ';

export const TTS_CACHE_VERSION = 'v1';
export const MAX_TTS_CACHE_ENTRIES = 32;
export const MAX_TTS_CACHE_TOTAL_BYTES = 4 * 1024 * 1024; // 4 MB cap per warm Node.js instance

export type TtsCacheStatus = 'HIT' | 'MISS' | 'COALESCED';

export interface TtsSynthesisResult {
  buffer: Buffer;
  cacheKey: string;
  cacheStatus: TtsCacheStatus;
  ttsLatencyMs: number;
  openAiTtsCalled: boolean;
}

export interface TtsCacheStats {
  entryCount: number;
  totalBytes: number;
  inFlightCount: number;
  hits: number;
  misses: number;
  coalescedHits: number;
  evictions: number;
}

interface TtsCacheEntry {
  buffer: Buffer;
  byteLength: number;
  createdAtMs: number;
}

const ttsAudioCache = new Map<string, TtsCacheEntry>();
const inFlightTtsRequests = new Map<string, Promise<Buffer>>();

let cacheHits = 0;
let cacheMisses = 0;
let coalescedHits = 0;
let cacheEvictions = 0;
let currentTotalBytes = 0;

/**
 * Builds a deterministic content-addressed SHA-256 cache key bound to:
 * - TTS_CACHE_VERSION
 * - OpenAI TTS Model & Voice
 * - THAI_TTS_INSTRUCTIONS
 * - Normalized Thai speech text
 *
 * When a FAQ answer is updated in Supabase, `normalizedInput` changes automatically,
 * producing a new cache key and guaranteeing stale audio is never served.
 */
export function buildTtsCacheKey(
  normalizedInput: string,
  model: string = OPENAI_MODELS.TTS,
  voice: string = OPENAI_MODELS.TTS_VOICE,
  instructions: string = THAI_TTS_INSTRUCTIONS,
): string {
  const payload = JSON.stringify({
    v: TTS_CACHE_VERSION,
    model,
    voice,
    instructions,
    normalizedInput,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function evictLeastRecentlyUsedIfNeeded(incomingBytes: number): void {
  if (incomingBytes > MAX_TTS_CACHE_TOTAL_BYTES) {
    return;
  }

  while (
    ttsAudioCache.size > 0 &&
    (ttsAudioCache.size >= MAX_TTS_CACHE_ENTRIES ||
      currentTotalBytes + incomingBytes > MAX_TTS_CACHE_TOTAL_BYTES)
  ) {
    const oldestKey = ttsAudioCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    const oldestEntry = ttsAudioCache.get(oldestKey);
    ttsAudioCache.delete(oldestKey);
    if (oldestEntry) {
      currentTotalBytes = Math.max(
        0,
        currentTotalBytes - oldestEntry.byteLength,
      );
    }
    cacheEvictions += 1;
  }
}

function storeInTtsCache(cacheKey: string, buffer: Buffer): void {
  if (
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_TTS_CACHE_TOTAL_BYTES
  ) {
    return;
  }

  const existing = ttsAudioCache.get(cacheKey);
  if (existing) {
    currentTotalBytes = Math.max(0, currentTotalBytes - existing.byteLength);
    ttsAudioCache.delete(cacheKey);
  }

  evictLeastRecentlyUsedIfNeeded(buffer.byteLength);

  ttsAudioCache.set(cacheKey, {
    buffer,
    byteLength: buffer.byteLength,
    createdAtMs: Date.now(),
  });
  currentTotalBytes += buffer.byteLength;
}

export function getTtsCacheStats(): TtsCacheStats {
  return {
    entryCount: ttsAudioCache.size,
    totalBytes: currentTotalBytes,
    inFlightCount: inFlightTtsRequests.size,
    hits: cacheHits,
    misses: cacheMisses,
    coalescedHits,
    evictions: cacheEvictions,
  };
}

export function clearTtsAudioCache(): void {
  ttsAudioCache.clear();
  inFlightTtsRequests.clear();
  currentTotalBytes = 0;
  cacheHits = 0;
  cacheMisses = 0;
  coalescedHits = 0;
  cacheEvictions = 0;
}

async function generateMp3FromOpenAI(normalizedInput: string): Promise<Buffer> {
  const client = getOpenAIClient();
  const response = await client.audio.speech.create({
    model: OPENAI_MODELS.TTS,
    voice: OPENAI_MODELS.TTS_VOICE,
    input: normalizedInput,
    instructions: THAI_TTS_INSTRUCTIONS,
    response_format: 'mp3',
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const detected = detectAudioFormatFromSignature(buffer);
  if (buffer.length === 0 || detected?.ext !== 'mp3') {
    throw new ApiError(
      'UPSTREAM_PROVIDER_ERROR',
      502,
      'ระบบสังเคราะห์เสียงไม่สามารถสร้างไฟล์ MP3 ที่ถูกต้องได้',
    );
  }

  return buffer;
}

/**
 * Synthesizes MP3 audio bytes with content-addressed in-memory caching and
 * concurrent request deduplication (single-flight).
 * Note: On Vercel serverless, this cache is process-local to warm instances only.
 */
export async function synthesizeSpeechMp3WithMetrics(
  text: string,
  customGenerator?: (normalizedInput: string) => Promise<Buffer>,
): Promise<TtsSynthesisResult> {
  const t0 = performance.now();
  const normalizedInput = normalizeThaiSpeech(text);
  const cacheKey = buildTtsCacheKey(normalizedInput);

  // 1. Check LRU In-Memory Cache
  const cached = ttsAudioCache.get(cacheKey);
  if (cached) {
    // Refresh LRU order
    ttsAudioCache.delete(cacheKey);
    ttsAudioCache.set(cacheKey, cached);
    cacheHits += 1;
    return {
      buffer: cached.buffer,
      cacheKey,
      cacheStatus: 'HIT',
      ttsLatencyMs: Math.round(performance.now() - t0),
      openAiTtsCalled: false,
    };
  }

  // 2. Check Single-Flight In-Flight Requests (Concurrent Cache Miss Deduplication)
  const existingInFlight = inFlightTtsRequests.get(cacheKey);
  if (existingInFlight) {
    coalescedHits += 1;
    const buffer = await existingInFlight;
    return {
      buffer,
      cacheKey,
      cacheStatus: 'COALESCED',
      ttsLatencyMs: Math.round(performance.now() - t0),
      openAiTtsCalled: false,
    };
  }

  // 3. Cache Miss -> Invoke OpenAI TTS once and share the promise
  cacheMisses += 1;
  const generatorFn = customGenerator ?? generateMp3FromOpenAI;
  const generationPromise = (async () => {
    const generatedBuffer = await generatorFn(normalizedInput);
    const detected = detectAudioFormatFromSignature(generatedBuffer);
    if (generatedBuffer.length === 0 || detected?.ext !== 'mp3') {
      throw new ApiError(
        'UPSTREAM_PROVIDER_ERROR',
        502,
        'ระบบสังเคราะห์เสียงไม่สามารถสร้างไฟล์ MP3 ที่ถูกต้องได้',
      );
    }
    storeInTtsCache(cacheKey, generatedBuffer);
    return generatedBuffer;
  })();

  inFlightTtsRequests.set(cacheKey, generationPromise);

  try {
    const buffer = await generationPromise;
    return {
      buffer,
      cacheKey,
      cacheStatus: 'MISS',
      ttsLatencyMs: Math.round(performance.now() - t0),
      openAiTtsCalled: true,
    };
  } finally {
    inFlightTtsRequests.delete(cacheKey);
  }
}

/**
 * Normalizes Thai clock time expressions for speech and synthesizes MP3 audio bytes in memory
 * using OpenAI gpt-4o-mini-tts (voice: coral), backed by content-addressed LRU cache.
 */
export async function synthesizeSpeechMp3(text: string): Promise<Buffer> {
  const { buffer } = await synthesizeSpeechMp3WithMetrics(text);
  return buffer;
}
