import 'server-only';
import { z } from 'zod';

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
