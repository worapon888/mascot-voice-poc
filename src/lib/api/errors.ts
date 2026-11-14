import 'server-only';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { isDemoEnabled } from '@/lib/validations/env';
import { FaqRepositoryError } from '@/repositories/faq.repository';
import type { ApiErrorCode, ApiErrorResponse } from '@/types/api';

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const;

export function assertDemoEnabled(): void {
  if (!isDemoEnabled()) {
    throw new ApiError(
      'DEMO_DISABLED',
      503,
      'ระบบสาธิตถูกปิดใช้งานชั่วคราว (DEMO_ENABLED=false)',
    );
  }
}

export function createErrorResponse(
  code: ApiErrorCode,
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers: {
        ...NO_STORE_HEADERS,
        ...extraHeaders,
      },
    },
  );
}

export function methodNotAllowedResponse(
  allowed = 'POST',
): NextResponse<ApiErrorResponse> {
  return createErrorResponse(
    'METHOD_NOT_ALLOWED',
    405,
    `รองรับเฉพาะ HTTP ${allowed} เท่านั้น`,
    { Allow: allowed },
  );
}

export function handleApiRouteError(
  error: unknown,
): NextResponse<ApiErrorResponse> {
  if (error instanceof ApiError) {
    return createErrorResponse(error.code, error.status, error.message);
  }

  if (error instanceof FaqRepositoryError) {
    return createErrorResponse(
      'DATABASE_ERROR',
      503,
      'ไม่สามารถเชื่อมต่อฐานข้อมูลคำถามที่พบบ่อยได้ในขณะนี้',
    );
  }

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return createErrorResponse(
      'UPSTREAM_TIMEOUT',
      504,
      'การเชื่อมต่อระบบ AI ใช้เวลานานเกินกำหนด กรุณาลองใหม่อีกครั้ง',
    );
  }

  if (error instanceof OpenAI.RateLimitError) {
    return createErrorResponse(
      'RATE_LIMITED',
      429,
      'ระบบ AI มีผู้ใช้งานจำนวนมากเกินขีดจำกัด กรุณารอสักครู่แล้วลองใหม่',
    );
  }

  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) {
      return createErrorResponse(
        'RATE_LIMITED',
        429,
        'ระบบ AI มีผู้ใช้งานจำนวนมากเกินขีดจำกัด กรุณารอสักครู่แล้วลองใหม่',
      );
    }
    if (error.status === 408 || error.status === 504) {
      return createErrorResponse(
        'UPSTREAM_TIMEOUT',
        504,
        'การเชื่อมต่อระบบ AI ใช้เวลานานเกินกำหนด กรุณาลองใหม่อีกครั้ง',
      );
    }
    return createErrorResponse(
      'UPSTREAM_PROVIDER_ERROR',
      502,
      'เกิดข้อผิดพลาดจากผู้ให้บริการ AI ภายนอก กรุณาลองใหม่อีกครั้ง',
    );
  }

  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return createErrorResponse(
      'UPSTREAM_TIMEOUT',
      504,
      'การประมวลผลใช้เวลานานเกินกำหนด กรุณาลองใหม่อีกครั้ง',
    );
  }

  return createErrorResponse(
    'INTERNAL_ERROR',
    500,
    'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง',
  );
}
