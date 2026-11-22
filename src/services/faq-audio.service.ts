import 'server-only';
import { getOpenAIClient, OPENAI_MODELS } from '@/lib/openai/client';
import { getFaqAudioBucketName } from '@/lib/validations/env';
import { normalizeThaiSpeech } from '@/lib/voice/thai-speech-normalizer';
import { getFaqById } from '@/repositories/faq.repository';
import {
  buildFaqAudioObjectPath,
  createSupabaseFaqAudioStorageAdapter,
  type FaqAudioStorageAdapter,
} from '@/repositories/faq-audio.repository';
import {
  buildTtsCacheKey,
  synthesizeSpeechMp3WithMetrics,
  THAI_TTS_INSTRUCTIONS,
  TTS_CACHE_VERSION,
} from '@/services/speech.service';
import { detectAudioFormatFromSignature } from '@/services/transcription.service';
import type { SupabaseFaqWebhookPayload } from '@/types/api';
import type {
  FaqAudioAssetRecord,
  FaqRecord,
  PersistentFaqAudioReference,
} from '@/types/faq';

const TRAILING_POLITE_PARTICLE_REGEX = /(ครับผม|นะครับ|นะคะ|ครับ|ค่ะ|คะ)$/u;
const MAX_CANONICAL_CHARS = 500;
const MAX_GENERATION_ATTEMPTS = 2;

export interface PersistentAudioTelemetry {
  persistentAudioHits: number;
  persistentAudioMisses: number;
  storageReadRequests: number;
  audioGenerationsSucceeded: number;
  audioGenerationsFailed: number;
  duplicateEventsSkipped: number;
  supersededVersionsSkipped: number;
}

const telemetry: PersistentAudioTelemetry = {
  persistentAudioHits: 0,
  persistentAudioMisses: 0,
  storageReadRequests: 0,
  audioGenerationsSucceeded: 0,
  audioGenerationsFailed: 0,
  duplicateEventsSkipped: 0,
  supersededVersionsSkipped: 0,
};

const inFlightFaqAudioJobs = new Map<
  string,
  Promise<FaqAudioGenerationOutcome>
>();

interface CachedPersistentFaqAudioEntry {
  audioRef: PersistentFaqAudioReference;
  cachedAt: number;
}

const persistentFaqAudioCache = new Map<
  string,
  CachedPersistentFaqAudioEntry
>();
export const PERSISTENT_FAQ_AUDIO_CACHE_TTL_MS = 60_000; // 60s TTL

export function resetPersistentFaqAudioCacheForTesting(): void {
  persistentFaqAudioCache.clear();
  cachedFallbackAudioRef = null;
}

export function getPersistentAudioCacheStats(): {
  entryCount: number;
  keys: string[];
} {
  return {
    entryCount: persistentFaqAudioCache.size,
    keys: Array.from(persistentFaqAudioCache.keys()),
  };
}

export function getPersistentAudioTelemetry(): PersistentAudioTelemetry {
  return { ...telemetry };
}

export function resetPersistentAudioTelemetry(): void {
  telemetry.persistentAudioHits = 0;
  telemetry.persistentAudioMisses = 0;
  telemetry.storageReadRequests = 0;
  telemetry.audioGenerationsSucceeded = 0;
  telemetry.audioGenerationsFailed = 0;
  telemetry.duplicateEventsSkipped = 0;
  telemetry.supersededVersionsSkipped = 0;
  inFlightFaqAudioJobs.clear();
  persistentFaqAudioCache.clear();
}

/**
 * Formats a raw database FAQ answer into the exact canonical answer string returned by Fast Path.
 */
export function buildCanonicalFaqAnswerText(rawFaqAnswer: string): string {
  const trimmed = rawFaqAnswer.normalize('NFC').trim();
  if (!trimmed) {
    return '';
  }
  if (TRAILING_POLITE_PARTICLE_REGEX.test(trimmed)) {
    return trimmed.slice(0, MAX_CANONICAL_CHARS).trim();
  }
  return `${trimmed} ครับ`.slice(0, MAX_CANONICAL_CHARS).trim();
}

export interface ComputedFaqAudioIdentity {
  faqId: number;
  canonicalAnswer: string;
  normalizedSpeechText: string;
  contentHash: string;
  bucketName: string;
  objectPath: string;
  idempotencyKey: string;
}

/**
 * Computes the deterministic content-addressed identity for a FAQ record's audio.
 * Bound to:
 * - Normalized Thai speech text (after `buildCanonicalFaqAnswerText` + `normalizeThaiSpeech`)
 * - OpenAI TTS Model (`gpt-4o-mini-tts`) & Voice (`coral`)
 * - `THAI_TTS_INSTRUCTIONS` & `TTS_CACHE_VERSION` ('v1')
 */
export function computeFaqAudioIdentity(
  faqId: number,
  rawFaqAnswer: string,
  bucketName: string = getFaqAudioBucketName(),
): ComputedFaqAudioIdentity {
  const canonicalAnswer = buildCanonicalFaqAnswerText(rawFaqAnswer);
  const normalizedSpeechText = normalizeThaiSpeech(canonicalAnswer);
  const contentHash = buildTtsCacheKey(
    normalizedSpeechText,
    OPENAI_MODELS.TTS,
    OPENAI_MODELS.TTS_VOICE,
    THAI_TTS_INSTRUCTIONS,
  );
  const objectPath = buildFaqAudioObjectPath(
    faqId,
    contentHash,
    TTS_CACHE_VERSION,
  );

  return {
    faqId,
    canonicalAnswer,
    normalizedSpeechText,
    contentHash,
    bucketName,
    objectPath,
    idempotencyKey: `faq:${faqId}:hash:${contentHash}`,
  };
}

export const STANDARD_FALLBACK_ANSWER =
  'ขออภัยครับ ตอนนี้ผมยังไม่มีข้อมูลในเรื่องนี้ กรุณาติดต่อเจ้าหน้าที่เพื่อสอบถามเพิ่มเติมนะครับ';

export interface ComputedFallbackAudioIdentity {
  canonicalAnswer: string;
  normalizedSpeechText: string;
  contentHash: string;
  bucketName: string;
  objectPath: string;
  audioUrl: string;
}

export function computeFallbackAudioIdentity(
  bucketName: string = getFaqAudioBucketName(),
  storageAdapter?: FaqAudioStorageAdapter,
): ComputedFallbackAudioIdentity {
  const canonicalAnswer = STANDARD_FALLBACK_ANSWER;
  const normalizedSpeechText = normalizeThaiSpeech(canonicalAnswer);
  const contentHash = buildTtsCacheKey(
    normalizedSpeechText,
    OPENAI_MODELS.TTS,
    OPENAI_MODELS.TTS_VOICE,
    THAI_TTS_INSTRUCTIONS,
  );
  const objectPath = `fallback/${TTS_CACHE_VERSION}/fallback-${contentHash}.mp3`;
  const adapter = storageAdapter ?? createSupabaseFaqAudioStorageAdapter();
  const audioUrl = adapter.getPublicAudioUrl(bucketName, objectPath);

  return {
    canonicalAnswer,
    normalizedSpeechText,
    contentHash,
    bucketName,
    objectPath,
    audioUrl,
  };
}

let cachedFallbackAudioRef: PersistentFaqAudioReference | null = null;

export function resetFallbackAudioCacheForTesting(): void {
  cachedFallbackAudioRef = null;
}

export async function resolvePersistentFallbackAudioRef(
  deps: FaqAudioLookupDependencies = {},
): Promise<PersistentFaqAudioLookupResult> {
  const t0 = performance.now();
  const bucketName = getFaqAudioBucketName();
  const adapter = deps.storageAdapter ?? createSupabaseFaqAudioStorageAdapter();
  const identity = computeFallbackAudioIdentity(bucketName, adapter);

  if (
    cachedFallbackAudioRef &&
    cachedFallbackAudioRef.contentHash === identity.contentHash
  ) {
    telemetry.persistentAudioHits += 1;
    return {
      hit: true,
      reason: 'READY_VERIFIED',
      contentHash: identity.contentHash,
      lookupLatencyMs: 0,
      audioRef: cachedFallbackAudioRef,
    };
  }

  try {
    telemetry.storageReadRequests += 1;
    const exists = await adapter.objectExistsInStorage(
      bucketName,
      identity.objectPath,
    );
    const lookupLatencyMs = Math.round(performance.now() - t0);

    if (exists) {
      telemetry.persistentAudioHits += 1;
      const ref: PersistentFaqAudioReference = {
        faqId: 0,
        contentHash: identity.contentHash,
        audioUrl: identity.audioUrl,
        objectPath: identity.objectPath,
        mimeType: 'audio/mpeg',
        byteLength: 0,
      };
      cachedFallbackAudioRef = ref;
      return {
        hit: true,
        reason: 'READY_VERIFIED',
        contentHash: identity.contentHash,
        lookupLatencyMs,
        audioRef: ref,
      };
    }

    telemetry.persistentAudioMisses += 1;
    return {
      hit: false,
      reason: 'STORAGE_OBJECT_MISSING',
      contentHash: identity.contentHash,
      lookupLatencyMs,
    };
  } catch {
    telemetry.persistentAudioMisses += 1;
    return {
      hit: false,
      reason: 'STORAGE_READ_ERROR',
      contentHash: identity.contentHash,
      lookupLatencyMs: Math.round(performance.now() - t0),
    };
  }
}

export async function ensurePersistentFallbackAudio(
  deps: {
    storageAdapter?: FaqAudioStorageAdapter;
    synthesizeMp3Fn?: (normalizedText: string) => Promise<Buffer>;
  } = {},
): Promise<{
  identity: ComputedFallbackAudioIdentity;
  alreadyReady: boolean;
  uploaded: boolean;
  byteLength: number;
}> {
  const bucketName = getFaqAudioBucketName();
  const adapter = deps.storageAdapter ?? createSupabaseFaqAudioStorageAdapter();
  const identity = computeFallbackAudioIdentity(bucketName, adapter);

  const exists = await adapter.objectExistsInStorage(
    bucketName,
    identity.objectPath,
  );
  if (exists) {
    cachedFallbackAudioRef = {
      faqId: 0,
      contentHash: identity.contentHash,
      audioUrl: identity.audioUrl,
      objectPath: identity.objectPath,
      mimeType: 'audio/mpeg',
      byteLength: 0,
    };
    return {
      identity,
      alreadyReady: true,
      uploaded: false,
      byteLength: 0,
    };
  }

  const synthesize =
    deps.synthesizeMp3Fn ??
    (async (text: string) => {
      const client = getOpenAIClient();
      const response = await client.audio.speech.create({
        model: OPENAI_MODELS.TTS,
        voice: OPENAI_MODELS.TTS_VOICE,
        input: text,
        instructions: THAI_TTS_INSTRUCTIONS,
        response_format: 'mp3',
      });
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    });

  const mp3Buffer = await synthesize(identity.normalizedSpeechText);
  await adapter.uploadAudioObject(bucketName, identity.objectPath, mp3Buffer);

  cachedFallbackAudioRef = {
    faqId: 0,
    contentHash: identity.contentHash,
    audioUrl: identity.audioUrl,
    objectPath: identity.objectPath,
    mimeType: 'audio/mpeg',
    byteLength: mp3Buffer.length,
  };

  return {
    identity,
    alreadyReady: false,
    uploaded: true,
    byteLength: mp3Buffer.length,
  };
}

/**
 * Determines whether a Supabase Database Webhook event (INSERT / UPDATE)
 * actually requires persistent audio generation.
 *
 * Rules:
 * - Disabled FAQs (`is_active === false`) NEVER trigger TTS generation.
 * - UPDATE events that only modify non-audio columns (`question`, `keywords`) and leave
 *   the normalized speech hash unchanged NEVER trigger TTS regeneration.
 * - Re-enabling an inactive FAQ (`old.is_active === false && new.is_active === true`)
 *   triggers a check/generation to ensure its current answer version is READY.
 */
export function shouldTriggerFaqAudioGeneration(
  payload: SupabaseFaqWebhookPayload,
): {
  shouldProcess: boolean;
  reason:
    | 'NEW_ACTIVE_FAQ'
    | 'REACTIVATED_FAQ'
    | 'ANSWER_SPEECH_HASH_CHANGED'
    | 'FAQ_INACTIVE'
    | 'NO_RECORD'
    | 'NON_AUDIO_FIELD_UPDATE';
  identity?: ComputedFaqAudioIdentity;
} {
  const record = payload.record;
  if (!record || typeof record.id !== 'number' || !record.answer) {
    return { shouldProcess: false, reason: 'NO_RECORD' };
  }

  if (!record.is_active) {
    return { shouldProcess: false, reason: 'FAQ_INACTIVE' };
  }

  const newIdentity = computeFaqAudioIdentity(record.id, record.answer);

  if (payload.type === 'INSERT') {
    return {
      shouldProcess: true,
      reason: 'NEW_ACTIVE_FAQ',
      identity: newIdentity,
    };
  }

  if (payload.type === 'UPDATE') {
    const oldRecord = payload.old_record;
    if (!oldRecord) {
      return {
        shouldProcess: true,
        reason: 'ANSWER_SPEECH_HASH_CHANGED',
        identity: newIdentity,
      };
    }

    if (!oldRecord.is_active && record.is_active) {
      return {
        shouldProcess: true,
        reason: 'REACTIVATED_FAQ',
        identity: newIdentity,
      };
    }

    const oldIdentity = computeFaqAudioIdentity(
      oldRecord.id,
      oldRecord.answer ?? '',
    );
    if (oldIdentity.contentHash !== newIdentity.contentHash) {
      return {
        shouldProcess: true,
        reason: 'ANSWER_SPEECH_HASH_CHANGED',
        identity: newIdentity,
      };
    }

    return {
      shouldProcess: false,
      reason: 'NON_AUDIO_FIELD_UPDATE',
      identity: newIdentity,
    };
  }

  return { shouldProcess: false, reason: 'NO_RECORD' };
}

export interface FaqAudioLookupDependencies {
  storageAdapter?: FaqAudioStorageAdapter;
}

export interface PersistentFaqAudioLookupResult {
  hit: boolean;
  reason:
    | 'READY_VERIFIED'
    | 'FAQ_INACTIVE'
    | 'METADATA_NOT_FOUND'
    | 'STATUS_NOT_READY'
    | 'HASH_MISMATCH'
    | 'STORAGE_OBJECT_MISSING'
    | 'STORAGE_READ_ERROR';
  audioRef?: PersistentFaqAudioReference;
  contentHash: string;
  lookupLatencyMs: number;
}

/**
 * Resolves a READY persistent audio reference for an active FAQ record.
 * Strictly verifies that:
 * 1. The FAQ record is currently active (`faq.is_active === true`).
 * 2. The metadata record exists for `(faq.id, currentContentHash)` and has `status === 'READY'`.
 * 3. The metadata's `content_hash` matches the live FAQ answer's `contentHash` (never serves old versions).
 * 4. If storage read fails or audio is not yet ready, safely returns `hit: false` so the caller
 *    falls back to dynamic TTS without failing the user request.
 */
export async function resolvePersistentFaqAudioRef(
  faq: FaqRecord,
  deps: FaqAudioLookupDependencies = {},
): Promise<PersistentFaqAudioLookupResult> {
  const t0 = performance.now();
  const identity = computeFaqAudioIdentity(faq.id, faq.answer);

  if (!faq.is_active) {
    telemetry.persistentAudioMisses += 1;
    return {
      hit: false,
      reason: 'FAQ_INACTIVE',
      contentHash: identity.contentHash,
      lookupLatencyMs: Math.round(performance.now() - t0),
    };
  }

  const cacheKey = `${faq.id}:${identity.contentHash}`;
  if (!deps.storageAdapter) {
    const cached = persistentFaqAudioCache.get(cacheKey);
    if (
      cached &&
      Date.now() - cached.cachedAt < PERSISTENT_FAQ_AUDIO_CACHE_TTL_MS
    ) {
      telemetry.persistentAudioHits += 1;
      return {
        hit: true,
        reason: 'READY_VERIFIED',
        contentHash: identity.contentHash,
        lookupLatencyMs: 0,
        audioRef: cached.audioRef,
      };
    }
  }

  const adapter = deps.storageAdapter ?? createSupabaseFaqAudioStorageAdapter();

  try {
    telemetry.storageReadRequests += 1;
    const metadata = await adapter.getMetadata(faq.id, identity.contentHash);

    if (!metadata) {
      telemetry.persistentAudioMisses += 1;
      return {
        hit: false,
        reason: 'METADATA_NOT_FOUND',
        contentHash: identity.contentHash,
        lookupLatencyMs: Math.round(performance.now() - t0),
      };
    }

    if (metadata.content_hash !== identity.contentHash) {
      telemetry.persistentAudioMisses += 1;
      return {
        hit: false,
        reason: 'HASH_MISMATCH',
        contentHash: identity.contentHash,
        lookupLatencyMs: Math.round(performance.now() - t0),
      };
    }

    if (metadata.status !== 'READY' || metadata.byte_length <= 0) {
      telemetry.persistentAudioMisses += 1;
      return {
        hit: false,
        reason: 'STATUS_NOT_READY',
        contentHash: identity.contentHash,
        lookupLatencyMs: Math.round(performance.now() - t0),
      };
    }

    const audioUrl = adapter.getPublicAudioUrl(
      metadata.bucket_name,
      metadata.object_path,
    );

    const audioRef: PersistentFaqAudioReference = {
      faqId: faq.id,
      contentHash: metadata.content_hash,
      audioUrl,
      objectPath: metadata.object_path,
      mimeType: 'audio/mpeg',
      byteLength: metadata.byte_length,
    };

    if (!deps.storageAdapter) {
      persistentFaqAudioCache.set(cacheKey, {
        audioRef,
        cachedAt: Date.now(),
      });
    }

    telemetry.persistentAudioHits += 1;
    return {
      hit: true,
      reason: 'READY_VERIFIED',
      contentHash: identity.contentHash,
      lookupLatencyMs: Math.round(performance.now() - t0),
      audioRef,
    };
  } catch (err) {
    telemetry.persistentAudioMisses += 1;
    const errMsg =
      err instanceof Error
        ? err.message
        : 'Unknown persistent audio lookup error';
    console.warn(
      `[faq-audio.service] Persistent audio lookup failed for faq_id=${faq.id} (${errMsg}). Falling back to dynamic TTS pipeline.`,
    );
    return {
      hit: false,
      reason: 'STORAGE_READ_ERROR',
      contentHash: identity.contentHash,
      lookupLatencyMs: Math.round(performance.now() - t0),
    };
  }
}

export type FaqAudioGenerationStatusOutcome =
  | 'ALREADY_READY'
  | 'GENERATED_AND_READY'
  | 'COALESCED_IN_FLIGHT'
  | 'SKIPPED_INACTIVE'
  | 'SUPERSEDED_BY_NEWER_VERSION'
  | 'FAILED';

export interface FaqAudioGenerationOutcome {
  faqId: number;
  contentHash: string;
  idempotencyKey: string;
  outcome: FaqAudioGenerationStatusOutcome;
  openAiTtsCalled: boolean;
  storageUploaded: boolean;
  audioUrl?: string;
  objectPath: string;
  byteLength: number;
  error?: string;
}

export interface EnsureFaqAudioOptions {
  storageAdapter?: FaqAudioStorageAdapter;
  fetchCurrentFaqById?: (id: number) => Promise<FaqRecord | null>;
  synthesizeMp3Fn?: (normalizedSpeechText: string) => Promise<Buffer>;
  maxAttempts?: number;
}

/**
 * Ensures persistent MP3 audio exists in Supabase Storage for a specific FAQ version.
 *
 * Guarantees:
 * 1. Idempotency & Duplicate Prevention: Uses `idempotencyKey = faq:<id>:hash:<sha256>`
 *    to coalesce concurrent webhook events and skip already-READY versions without calling OpenAI TTS.
 * 2. Rapid Consecutive Update Safety (Optimistic Version Verification):
 *    Before marking status = 'READY', re-reads the current FAQ record from the database
 *    and verifies that its live `contentHash` still matches the version being generated.
 *    If a newer edit occurred while TTS was generating, the older job aborts setting READY
 *    and returns `SUPERSEDED_BY_NEWER_VERSION`.
 * 3. Controlled Retry & Failure Recording: Retries transient TTS/Upload failures up to
 *    `maxAttempts` (default 2) and records `status = 'FAILED'` with `last_error` on failure.
 */
export async function ensurePersistentFaqAudioForRecord(
  targetFaq: Pick<FaqRecord, 'id' | 'answer' | 'is_active'>,
  options: EnsureFaqAudioOptions = {},
): Promise<FaqAudioGenerationOutcome> {
  const identity = computeFaqAudioIdentity(targetFaq.id, targetFaq.answer);

  if (!targetFaq.is_active) {
    return {
      faqId: targetFaq.id,
      contentHash: identity.contentHash,
      idempotencyKey: identity.idempotencyKey,
      outcome: 'SKIPPED_INACTIVE',
      openAiTtsCalled: false,
      storageUploaded: false,
      objectPath: identity.objectPath,
      byteLength: 0,
    };
  }

  // 1. Concurrent Webhook / Single-Flight Coalescing by Idempotency Key
  const existingJob = inFlightFaqAudioJobs.get(identity.idempotencyKey);
  if (existingJob) {
    telemetry.duplicateEventsSkipped += 1;
    const settled = await existingJob;
    return {
      ...settled,
      outcome: settled.outcome === 'FAILED' ? 'FAILED' : 'COALESCED_IN_FLIGHT',
      openAiTtsCalled: false,
      storageUploaded: false,
    };
  }

  const adapter =
    options.storageAdapter ?? createSupabaseFaqAudioStorageAdapter();
  const fetchCurrentFaq = options.fetchCurrentFaqById ?? getFaqById;
  const maxAttempts = Math.min(
    Math.max(1, options.maxAttempts ?? MAX_GENERATION_ATTEMPTS),
    3,
  );

  const jobPromise = (async (): Promise<FaqAudioGenerationOutcome> => {
    // 2. Check if this exact contentHash is already READY in metadata & Storage
    telemetry.storageReadRequests += 1;
    const existingMeta = await adapter.getMetadata(
      identity.faqId,
      identity.contentHash,
    );

    if (
      existingMeta &&
      existingMeta.status === 'READY' &&
      existingMeta.content_hash === identity.contentHash &&
      existingMeta.byte_length > 0
    ) {
      const existsInBucket = await adapter.objectExistsInStorage(
        existingMeta.bucket_name,
        existingMeta.object_path,
      );
      if (existsInBucket) {
        telemetry.duplicateEventsSkipped += 1;
        return {
          faqId: identity.faqId,
          contentHash: identity.contentHash,
          idempotencyKey: identity.idempotencyKey,
          outcome: 'ALREADY_READY',
          openAiTtsCalled: false,
          storageUploaded: false,
          audioUrl: adapter.getPublicAudioUrl(
            existingMeta.bucket_name,
            existingMeta.object_path,
          ),
          objectPath: existingMeta.object_path,
          byteLength: existingMeta.byte_length,
        };
      }
    }

    const previousAttempts = existingMeta?.attempt_count ?? 0;
    let lastErrorMessage = 'Unknown FAQ audio generation error';
    let openAiCalledCount = 0;
    let uploadedToStorage = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const currentAttemptNumber = previousAttempts + attempt;
      const nowIso = new Date().toISOString();

      try {
        // Mark as GENERATING
        await adapter.upsertMetadata({
          faq_id: identity.faqId,
          content_hash: identity.contentHash,
          canonical_answer: identity.canonicalAnswer,
          normalized_speech_text: identity.normalizedSpeechText,
          bucket_name: identity.bucketName,
          object_path: identity.objectPath,
          mime_type: 'audio/mpeg',
          byte_length: 0,
          tts_model: OPENAI_MODELS.TTS,
          tts_voice: OPENAI_MODELS.TTS_VOICE,
          normalizer_version: TTS_CACHE_VERSION,
          status: 'GENERATING',
          attempt_count: currentAttemptNumber,
          last_error: null,
          generated_at: null,
          updated_at: nowIso,
        });

        // Synthesize MP3 via OpenAI TTS (or injected test synthesizer)
        let mp3Buffer: Buffer;
        if (options.synthesizeMp3Fn) {
          openAiCalledCount += 1;
          mp3Buffer = await options.synthesizeMp3Fn(
            identity.normalizedSpeechText,
          );
        } else {
          const ttsRes = await synthesizeSpeechMp3WithMetrics(
            identity.canonicalAnswer,
          );
          if (ttsRes.openAiTtsCalled) {
            openAiCalledCount += 1;
          }
          mp3Buffer = ttsRes.buffer;
        }

        const detected = detectAudioFormatFromSignature(mp3Buffer);
        if (
          !mp3Buffer ||
          mp3Buffer.byteLength === 0 ||
          detected?.ext !== 'mp3'
        ) {
          throw new Error(
            'Synthesized audio buffer is empty or not a valid MP3 binary.',
          );
        }

        // Upload MP3 to content-addressed immutable object path in Supabase Storage
        await adapter.uploadAudioObject(
          identity.bucketName,
          identity.objectPath,
          mp3Buffer,
        );
        uploadedToStorage = true;

        // 3. Optimistic Concurrency Check: Verify current FAQ in DB still matches this version!
        const latestFaq = await fetchCurrentFaq(identity.faqId);
        if (!latestFaq || !latestFaq.is_active) {
          telemetry.supersededVersionsSkipped += 1;
          return {
            faqId: identity.faqId,
            contentHash: identity.contentHash,
            idempotencyKey: identity.idempotencyKey,
            outcome: 'SKIPPED_INACTIVE',
            openAiTtsCalled: openAiCalledCount > 0,
            storageUploaded: uploadedToStorage,
            objectPath: identity.objectPath,
            byteLength: mp3Buffer.byteLength,
          };
        }

        const latestIdentity = computeFaqAudioIdentity(
          latestFaq.id,
          latestFaq.answer,
          identity.bucketName,
        );
        if (latestIdentity.contentHash !== identity.contentHash) {
          telemetry.supersededVersionsSkipped += 1;
          return {
            faqId: identity.faqId,
            contentHash: identity.contentHash,
            idempotencyKey: identity.idempotencyKey,
            outcome: 'SUPERSEDED_BY_NEWER_VERSION',
            openAiTtsCalled: openAiCalledCount > 0,
            storageUploaded: uploadedToStorage,
            objectPath: identity.objectPath,
            byteLength: mp3Buffer.byteLength,
          };
        }

        // 4. Commit READY metadata record only after confirming version freshness
        const readyTimestamp = new Date().toISOString();
        const readyRecord: FaqAudioAssetRecord = {
          faq_id: identity.faqId,
          content_hash: identity.contentHash,
          canonical_answer: identity.canonicalAnswer,
          normalized_speech_text: identity.normalizedSpeechText,
          bucket_name: identity.bucketName,
          object_path: identity.objectPath,
          mime_type: 'audio/mpeg',
          byte_length: mp3Buffer.byteLength,
          tts_model: OPENAI_MODELS.TTS,
          tts_voice: OPENAI_MODELS.TTS_VOICE,
          normalizer_version: TTS_CACHE_VERSION,
          status: 'READY',
          attempt_count: currentAttemptNumber,
          last_error: null,
          generated_at: readyTimestamp,
          updated_at: readyTimestamp,
        };

        await adapter.upsertMetadata(readyRecord);
        telemetry.audioGenerationsSucceeded += 1;

        return {
          faqId: identity.faqId,
          contentHash: identity.contentHash,
          idempotencyKey: identity.idempotencyKey,
          outcome: 'GENERATED_AND_READY',
          openAiTtsCalled: openAiCalledCount > 0,
          storageUploaded: uploadedToStorage,
          audioUrl: adapter.getPublicAudioUrl(
            identity.bucketName,
            identity.objectPath,
          ),
          objectPath: identity.objectPath,
          byteLength: mp3Buffer.byteLength,
        };
      } catch (err) {
        lastErrorMessage =
          err instanceof Error ? err.message : 'Unknown generation error';

        try {
          await adapter.upsertMetadata({
            faq_id: identity.faqId,
            content_hash: identity.contentHash,
            canonical_answer: identity.canonicalAnswer,
            normalized_speech_text: identity.normalizedSpeechText,
            bucket_name: identity.bucketName,
            object_path: identity.objectPath,
            mime_type: 'audio/mpeg',
            byte_length: 0,
            tts_model: OPENAI_MODELS.TTS,
            tts_voice: OPENAI_MODELS.TTS_VOICE,
            normalizer_version: TTS_CACHE_VERSION,
            status: 'FAILED',
            attempt_count: currentAttemptNumber,
            last_error: lastErrorMessage,
            generated_at: null,
            updated_at: new Date().toISOString(),
          });
        } catch {
          // Ignore secondary metadata error so primary failure is reported cleanly
        }
      }
    }

    telemetry.audioGenerationsFailed += 1;
    return {
      faqId: identity.faqId,
      contentHash: identity.contentHash,
      idempotencyKey: identity.idempotencyKey,
      outcome: 'FAILED',
      openAiTtsCalled: openAiCalledCount > 0,
      storageUploaded: uploadedToStorage,
      objectPath: identity.objectPath,
      byteLength: 0,
      error: lastErrorMessage,
    };
  })();

  inFlightFaqAudioJobs.set(identity.idempotencyKey, jobPromise);

  try {
    return await jobPromise;
  } finally {
    inFlightFaqAudioJobs.delete(identity.idempotencyKey);
  }
}
