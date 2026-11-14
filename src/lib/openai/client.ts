import 'server-only';
import OpenAI from 'openai';
import { getOpenAIEnv, getOpenAITimeoutMs } from '@/lib/validations/env';

export const OPENAI_MODELS = {
  STT: 'gpt-transcribe',
  LLM: 'gpt-4.1-mini',
  TTS: 'gpt-4o-mini-tts',
  TTS_VOICE: 'coral',
} as const;

let openAIClientInstance: OpenAI | null = null;

/**
 * Lazily initializes and returns the server-only OpenAI client.
 * Configured with maxRetries: 0 to prevent automatic repeated paid API charges
 * and an upstream timeout (default 30s).
 */
export function getOpenAIClient(): OpenAI {
  if (!openAIClientInstance) {
    const { OPENAI_API_KEY } = getOpenAIEnv();
    openAIClientInstance = new OpenAI({
      apiKey: OPENAI_API_KEY,
      timeout: getOpenAITimeoutMs(),
      maxRetries: 0,
    });
  }

  return openAIClientInstance;
}
