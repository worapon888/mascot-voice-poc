import 'server-only';
import { z } from 'zod';

const DEFAULT_OPENAI_TIMEOUT_MS = 30_000;
export const DEFAULT_FAQ_AUDIO_BUCKET = 'mascot-faq-audio';

const openAIEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
});

const supabaseEnvSchema = z.object({
  SUPABASE_URL: z.url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SECRET_KEY: z.string().min(1, 'SUPABASE_SECRET_KEY is required'),
});

export type OpenAIEnv = z.infer<typeof openAIEnvSchema>;
export type SupabaseEnv = z.infer<typeof supabaseEnvSchema>;

export function getOpenAIEnv(): OpenAIEnv {
  return openAIEnvSchema.parse({
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  });
}

export function getSupabaseEnv(): SupabaseEnv {
  return supabaseEnvSchema.parse({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  });
}

/**
 * Feature flag for FAQ Matching Engine:
 * - 'legacy': uses existing heuristic matching engine (default, safe for regression prevention)
 * - 'hybrid': uses Supabase pgvector + lexical BM25 + RRF hybrid retrieval
 * - 'shadow': runs legacy as primary responder, runs hybrid asynchronously to log comparison telemetry
 */
export type FaqMatcherMode = 'legacy' | 'hybrid' | 'shadow';

export function getFaqMatcherMode(): FaqMatcherMode {
  const raw = process.env.FAQ_MATCHER?.trim().toLowerCase();
  if (raw === 'hybrid') {
    return 'hybrid';
  }
  if (raw === 'shadow') {
    return 'shadow';
  }
  return 'legacy';
}

/**
 * Feature flag for Tier 2 Realtime Voice Streaming:
 * - false (default): Uses existing sequential pipeline (Answer JSON -> TTS MP3 -> Playback)
 * - true: Uses progressive streaming pipeline (LLM Token Stream -> Validated Sentence -> TTS Chunk -> Audio Queue)
 */
export function isTier2StreamingEnabled(): boolean {
  const raw = process.env.TIER2_STREAMING_ENABLED?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/**
 * Checks whether paid demo API endpoints are enabled.
 * - In development/test: enabled by default unless DEMO_ENABLED is explicitly 'false' or '0'.
 * - In production: disabled by default unless DEMO_ENABLED is explicitly 'true' or '1'.
 */
export function isDemoEnabled(): boolean {
  const raw = process.env.DEMO_ENABLED?.trim().toLowerCase();
  if (raw === 'false' || raw === '0') {
    return false;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  return process.env.NODE_ENV !== 'production';
}

/**
 * Returns the configured upstream timeout for OpenAI calls in milliseconds (default: 30000ms).
 */
export function getOpenAITimeoutMs(): number {
  const raw = process.env.OPENAI_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_OPENAI_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1_000 || parsed > 120_000) {
    return DEFAULT_OPENAI_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * Returns the configured Supabase Storage bucket name for persistent FAQ audio (default: 'mascot-faq-audio').
 */
export function getFaqAudioBucketName(): string {
  const raw = process.env.SUPABASE_FAQ_AUDIO_BUCKET?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_FAQ_AUDIO_BUCKET;
}

/**
 * Returns the configured webhook secret used to authenticate Supabase Database Webhook / Edge Function requests.
 */
export function getFaqWebhookSecret(): string | null {
  const raw = process.env.FAQ_AUDIO_WEBHOOK_SECRET?.trim();
  return raw && raw.length >= 16 ? raw : null;
}
