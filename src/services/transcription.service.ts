import 'server-only';
import { toFile } from 'openai/uploads';
import { ApiError } from '@/lib/api/errors';
import { getOpenAIClient, OPENAI_MODELS } from '@/lib/openai/client';
import { MAX_AUDIO_FILE_BYTES } from '@/lib/validations/voice';

export interface DetectedAudioFormat {
  ext: 'mp3' | 'wav' | 'webm' | 'ogg' | 'm4a';
  mime: 'audio/mpeg' | 'audio/wav' | 'audio/webm' | 'audio/ogg' | 'audio/mp4';
}

const ALLOWED_DECLARED_MIMES = new Set([
  '',
  'application/octet-stream',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
]);

/**
 * Inspects binary magic bytes to determine the real audio container format.
 * Does not trust filename extensions or browser-supplied MIME types alone.
 */
export function detectAudioFormatFromSignature(
  buffer: Buffer,
): DetectedAudioFormat | null {
  if (buffer.length < 12) {
    return null;
  }

  // 1. WAV: "RIFF" at 0..3 and "WAVE" at 8..11
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  ) {
    return { ext: 'wav', mime: 'audio/wav' };
  }

  // 2. WebM / Matroska EBML header: 1A 45 DF A3
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { ext: 'webm', mime: 'audio/webm' };
  }

  // 3. OGG container: "OggS" (4F 67 67 53)
  if (
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return { ext: 'ogg', mime: 'audio/ogg' };
  }

  // 4. MP4 / M4A ISO Base Media container: "ftyp" at offset 4..7
  if (
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return { ext: 'm4a', mime: 'audio/mp4' };
  }

  // 5. MP3: "ID3" tag at 0..2 OR valid MPEG audio frame sync word
  const isId3 = buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33;
  const isMpegFrameSync =
    buffer[0] === 0xff &&
    (buffer[1] & 0xe0) === 0xe0 &&
    (buffer[1] & 0x18) !== 0x08 &&
    (buffer[1] & 0x06) !== 0x00;

  if (isId3 || isMpegFrameSync) {
    return { ext: 'mp3', mime: 'audio/mpeg' };
  }

  return null;
}

/**
 * Validates and transcribes a Thai audio buffer using OpenAI gpt-transcribe.
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  declaredMimeType?: string,
): Promise<string> {
  if (!buffer || buffer.length === 0) {
    throw new ApiError(
      'MISSING_AUDIO',
      400,
      'ไม่พบข้อมูลไฟล์เสียง กรุณาแนบไฟล์เสียงในฟิลด์ audio',
    );
  }

  if (buffer.length > MAX_AUDIO_FILE_BYTES) {
    throw new ApiError(
      'AUDIO_TOO_LARGE',
      413,
      'ไฟล์เสียงมีขนาดเกิน 3 MB กรุณาใช้ไฟล์เสียงขนาดไม่เกิน 3 MB',
    );
  }

  const normalizedMime = (declaredMimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!ALLOWED_DECLARED_MIMES.has(normalizedMime)) {
    throw new ApiError(
      'INVALID_AUDIO',
      415,
      'ชนิดไฟล์เสียงไม่รองรับ รองรับเฉพาะ MP3, WAV, WebM, OGG และ M4A',
    );
  }

  const detectedFormat = detectAudioFormatFromSignature(buffer);
  if (!detectedFormat) {
    throw new ApiError(
      'INVALID_AUDIO',
      415,
      'ไฟล์เสียงไม่ถูกต้องหรือไม่รองรับ กรุณาอัปโหลดไฟล์เสียงจริง (MP3, WAV, WebM, OGG, M4A)',
    );
  }

  const client = getOpenAIClient();
  // Preserve the true detected container format (never rename WebM to MP3/WAV)
  const uploadableFile = await toFile(buffer, `speech.${detectedFormat.ext}`, {
    type: detectedFormat.mime,
  });

  const response = await client.audio.transcriptions.create({
    file: uploadableFile,
    model: OPENAI_MODELS.STT,
    language: 'th',
  });

  const transcript = (response.text ?? '').normalize('NFC').trim();
  if (transcript.length === 0) {
    throw new ApiError(
      'EMPTY_TRANSCRIPT',
      422,
      'ไม่สามารถถอดข้อความจากไฟล์เสียงได้ กรุณาพูดใหม่อีกครั้ง',
    );
  }

  return transcript;
}
