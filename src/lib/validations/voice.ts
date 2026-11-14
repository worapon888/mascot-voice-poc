import 'server-only';
import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';

export const MAX_AUDIO_FILE_BYTES = 3 * 1024 * 1024; // 3 MB
export const MAX_MULTIPART_REQUEST_BYTES = MAX_AUDIO_FILE_BYTES + 64 * 1024; // 3 MB + 64 KB multipart overhead
export const MAX_TEXT_CHARS = 500;

const rawAnswerInputSchema = z.object({
  transcript: z.string(),
});

const rawTtsInputSchema = z.object({
  text: z.string(),
});

export function validateAnswerRequest(body: unknown): { transcript: string } {
  const parsed = rawAnswerInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'INVALID_REQUEST',
      400,
      'รูปแบบคำขอไม่ถูกต้อง กรุณาระบุฟิลด์ transcript เป็นข้อความ',
    );
  }

  const trimmed = parsed.data.transcript.trim();
  if (trimmed.length === 0) {
    throw new ApiError(
      'EMPTY_TRANSCRIPT',
      400,
      'ข้อความคำถาม (transcript) ต้องไม่ว่างเปล่า',
    );
  }

  if (trimmed.length > MAX_TEXT_CHARS) {
    throw new ApiError(
      'TEXT_TOO_LONG',
      400,
      `ข้อความคำถามต้องมีความยาวไม่เกิน ${MAX_TEXT_CHARS} ตัวอักษร`,
    );
  }

  return { transcript: trimmed };
}

export function validateTtsRequest(body: unknown): { text: string } {
  const parsed = rawTtsInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'INVALID_REQUEST',
      400,
      'รูปแบบคำขอไม่ถูกต้อง กรุณาระบุฟิลด์ text เป็นข้อความ',
    );
  }

  const trimmed = parsed.data.text.trim();
  if (trimmed.length === 0) {
    throw new ApiError(
      'INVALID_REQUEST',
      400,
      'ข้อความสำหรับแปลงเป็นเสียง (text) ต้องไม่ว่างเปล่า',
    );
  }

  if (trimmed.length > MAX_TEXT_CHARS) {
    throw new ApiError(
      'TEXT_TOO_LONG',
      400,
      `ข้อความสำหรับแปลงเป็นเสียงต้องมีความยาวไม่เกิน ${MAX_TEXT_CHARS} ตัวอักษร`,
    );
  }

  return { text: trimmed };
}
