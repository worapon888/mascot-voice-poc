import 'server-only';
import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import type { ConversationTurn } from '@/types/api';

export const MAX_AUDIO_FILE_BYTES = 3 * 1024 * 1024; // 3 MB
export const MAX_MULTIPART_REQUEST_BYTES = MAX_AUDIO_FILE_BYTES + 64 * 1024; // 3 MB + 64 KB multipart overhead
export const MAX_TEXT_CHARS = 500;
export const MAX_CONVERSATION_HISTORY_TURNS = 4;
export const MAX_CONVERSATION_TURN_CHARS = 500;
export const MAX_CONVERSATION_FAQ_IDS_PER_TURN = 5;

const rawConversationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  faqIds: z.array(z.number().int().positive()).optional(),
});

const rawAnswerInputSchema = z.object({
  transcript: z.string(),
  conversationHistory: z.array(rawConversationTurnSchema).optional(),
});

const rawTtsInputSchema = z.object({
  text: z.string(),
});

export function validateAnswerRequest(body: unknown): {
  transcript: string;
  conversationHistory: ConversationTurn[];
} {
  const parsed = rawAnswerInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'INVALID_REQUEST',
      400,
      'รูปแบบคำขอไม่ถูกต้อง กรุณาระบุฟิลด์ transcript เป็นข้อความ และ conversationHistory ให้ถูกรูปแบบ',
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

  const rawHistory = parsed.data.conversationHistory ?? [];
  if (rawHistory.length > MAX_CONVERSATION_HISTORY_TURNS) {
    throw new ApiError(
      'INVALID_REQUEST',
      400,
      `ประวัติการสนทนา (conversationHistory) ต้องไม่เกิน ${MAX_CONVERSATION_HISTORY_TURNS} รายการล่าสุด`,
    );
  }

  const validatedHistory: ConversationTurn[] = [];
  for (const item of rawHistory) {
    const turnText = item.text.trim();
    if (turnText.length === 0) {
      throw new ApiError(
        'INVALID_REQUEST',
        400,
        'ข้อความในประวัติการสนทนา (conversationHistory) ต้องไม่ว่างเปล่า',
      );
    }
    if (turnText.length > MAX_CONVERSATION_TURN_CHARS) {
      throw new ApiError(
        'TEXT_TOO_LONG',
        400,
        `ข้อความในประวัติการสนทนาแต่ละรายการต้องไม่เกิน ${MAX_CONVERSATION_TURN_CHARS} ตัวอักษร`,
      );
    }
    if (item.faqIds && item.faqIds.length > MAX_CONVERSATION_FAQ_IDS_PER_TURN) {
      throw new ApiError(
        'INVALID_REQUEST',
        400,
        `รายการ faqIds ในแต่ละรอบสนทนาต้องไม่เกิน ${MAX_CONVERSATION_FAQ_IDS_PER_TURN} รายการ`,
      );
    }
    validatedHistory.push({
      role: item.role,
      text: turnText,
      ...(item.faqIds && item.faqIds.length > 0 ? { faqIds: item.faqIds } : {}),
    });
  }

  return {
    transcript: trimmed,
    conversationHistory: validatedHistory,
  };
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
