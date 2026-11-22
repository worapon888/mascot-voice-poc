import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import {
  ApiError,
  assertDemoEnabled,
  handleApiRouteError,
  methodNotAllowedResponse,
  NO_STORE_HEADERS,
} from '@/lib/api/errors';
import { getFaqWebhookSecret } from '@/lib/validations/env';
import {
  ensurePersistentFaqAudioForRecord,
  type EnsureFaqAudioOptions,
  type FaqAudioGenerationOutcome,
  shouldTriggerFaqAudioGeneration,
} from '@/services/faq-audio.service';
import type { ApiErrorResponse, SupabaseFaqWebhookPayload } from '@/types/api';

export const runtime = 'nodejs';

export interface FaqAudioWebhookResponse {
  processed: boolean;
  reason: string;
  faqId?: number;
  contentHash?: string;
  idempotencyKey?: string;
  outcome?: FaqAudioGenerationOutcome['outcome'];
  audioUrl?: string;
  objectPath?: string;
  openAiTtsCalled?: boolean;
  storageUploaded?: boolean;
  error?: string;
}

/**
 * Constant-time webhook secret verification against `x-webhook-secret` or `Authorization: Bearer <secret>`.
 */
export function verifyWebhookAuthorization(
  headers: Headers,
  configuredSecret: string | null = getFaqWebhookSecret(),
): boolean {
  if (!configuredSecret || configuredSecret.length < 16) {
    return false;
  }

  const headerSecret = headers.get('x-webhook-secret')?.trim();
  const authHeader = headers.get('authorization')?.trim();
  const bearerSecret =
    authHeader && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : null;

  const candidate = headerSecret || bearerSecret;
  if (!candidate) {
    return false;
  }

  const expectedBuf = Buffer.from(configuredSecret, 'utf8');
  const candidateBuf = Buffer.from(candidate, 'utf8');
  if (expectedBuf.length !== candidateBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, candidateBuf);
}

/**
 * Core webhook handler logic (injectable for deterministic automated unit testing).
 */
export async function handleFaqAudioWebhookEvent(
  headers: Headers,
  rawPayload: unknown,
  options: EnsureFaqAudioOptions & { configuredSecret?: string | null } = {},
): Promise<FaqAudioWebhookResponse> {
  const isAuthorized = verifyWebhookAuthorization(
    headers,
    options.configuredSecret !== undefined
      ? options.configuredSecret
      : getFaqWebhookSecret(),
  );

  if (!isAuthorized) {
    throw new ApiError(
      'UNAUTHORIZED',
      401,
      'ไม่ได้รับอนุญาตให้เรียกใช้งาน Webhook สร้างเสียง FAQ (Invalid or missing webhook secret)',
    );
  }

  if (!rawPayload || typeof rawPayload !== 'object') {
    throw new ApiError('INVALID_REQUEST', 400, 'รูปแบบ Webhook Payload ไม่ถูกต้อง');
  }

  const payload = rawPayload as SupabaseFaqWebhookPayload;
  if (
    payload.type !== 'INSERT' &&
    payload.type !== 'UPDATE' &&
    payload.type !== 'DELETE'
  ) {
    throw new ApiError(
      'INVALID_REQUEST',
      400,
      'รองรับเฉพาะเหตุการณ์ INSERT, UPDATE หรือ DELETE จากตาราง public.faqs',
    );
  }

  const evaluation = shouldTriggerFaqAudioGeneration(payload);
  if (!evaluation.shouldProcess || !payload.record) {
    return {
      processed: false,
      reason: evaluation.reason,
      faqId: payload.record?.id,
      contentHash: evaluation.identity?.contentHash,
      idempotencyKey: evaluation.identity?.idempotencyKey,
    };
  }

  const generationOutcome = await ensurePersistentFaqAudioForRecord(
    {
      id: payload.record.id,
      answer: payload.record.answer,
      is_active: payload.record.is_active,
    },
    options,
  );

  return {
    processed: true,
    reason: evaluation.reason,
    faqId: generationOutcome.faqId,
    contentHash: generationOutcome.contentHash,
    idempotencyKey: generationOutcome.idempotencyKey,
    outcome: generationOutcome.outcome,
    audioUrl: generationOutcome.audioUrl,
    objectPath: generationOutcome.objectPath,
    openAiTtsCalled: generationOutcome.openAiTtsCalled,
    storageUploaded: generationOutcome.storageUploaded,
    error: generationOutcome.error,
  };
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<FaqAudioWebhookResponse | ApiErrorResponse>> {
  try {
    assertDemoEnabled();

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new ApiError('INVALID_REQUEST', 400, 'รูปแบบ JSON ไม่ถูกต้อง');
    }

    const result = await handleFaqAudioWebhookEvent(request.headers, rawBody);
    const httpStatus = result.outcome === 'FAILED' ? 502 : 200;

    return NextResponse.json(result, {
      status: httpStatus,
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    return handleApiRouteError(error);
  }
}

export async function GET(): Promise<NextResponse<ApiErrorResponse>> {
  return methodNotAllowedResponse('POST');
}

export async function PUT(): Promise<NextResponse<ApiErrorResponse>> {
  return methodNotAllowedResponse('POST');
}

export async function DELETE(): Promise<NextResponse<ApiErrorResponse>> {
  return methodNotAllowedResponse('POST');
}

export async function PATCH(): Promise<NextResponse<ApiErrorResponse>> {
  return methodNotAllowedResponse('POST');
}
