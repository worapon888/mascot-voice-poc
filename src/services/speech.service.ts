import 'server-only';
import { ApiError } from '@/lib/api/errors';
import { getOpenAIClient, OPENAI_MODELS } from '@/lib/openai/client';
import { normalizeThaiSpeech } from '@/lib/voice/thai-speech-normalizer';
import { detectAudioFormatFromSignature } from '@/services/transcription.service';

export const THAI_TTS_INSTRUCTIONS =
  'พูดภาษาไทยให้ชัดเจน เป็นธรรมชาติ ใช้น้ำเสียงสุภาพและเป็นมิตร อ่านเวลาตามการพูดภาษาไทยทั่วไป เว้นจังหวะอย่างเหมาะสม ไม่อ่านเครื่องหมายวรรคตอนหรือตัวย่อเป็นคำแปลก ๆ';

/**
 * Normalizes Thai clock time expressions for speech and synthesizes MP3 audio bytes in memory
 * using OpenAI gpt-4o-mini-tts (voice: coral).
 * Does not modify the original displayed answer text or write user audio to persistent disk.
 */
export async function synthesizeSpeechMp3(text: string): Promise<Buffer> {
  const client = getOpenAIClient();
  const normalizedInput = normalizeThaiSpeech(text);

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
