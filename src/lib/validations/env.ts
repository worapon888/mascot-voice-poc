import 'server-only';
import { z } from 'zod';

const DEFAULT_OPENAI_TIMEOUT_MS = 30_000;

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
