import 'server-only';
import OpenAI from 'openai';
import { getOpenAIEnv } from '@/lib/validations/env';

export const OPENAI_MODELS = {
  STT: 'gpt-transcribe',
  LLM: 'gpt-4.1-mini',
  TTS: 'gpt-4o-mini-tts',
} as const;

let openAIClientInstance: OpenAI | null = null;

/**
 * Lazily initializes and returns the server-only OpenAI client.
 * Throws a validation error only when called without OPENAI_API_KEY configured.
 */
export function getOpenAIClient(): OpenAI {
  if (!openAIClientInstance) {
    const { OPENAI_API_KEY } = getOpenAIEnv();
    openAIClientInstance = new OpenAI({
      apiKey: OPENAI_API_KEY,
    });
  }

  return openAIClientInstance;
}
