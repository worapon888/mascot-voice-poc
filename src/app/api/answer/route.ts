import { type NextRequest, NextResponse } from 'next/server';
import {
  ApiError,
  assertDemoEnabled,
  handleApiRouteError,
  methodNotAllowedResponse,
  NO_STORE_HEADERS,
} from '@/lib/api/errors';
import { validateAnswerRequest } from '@/lib/validations/voice';
import { generateGroundedAnswer } from '@/services/answer.service';
import type { AnswerResponse, ApiErrorResponse } from '@/types/api';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
): Promise<NextResponse<AnswerResponse | ApiErrorResponse>> {
  try {
    assertDemoEnabled();

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new ApiError(
        'INVALID_CONTENT_TYPE',
        415,
        'ต้องส่งข้อมูลในรูปแบบ application/json เท่านั้น',
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new ApiError('INVALID_REQUEST', 400, 'รูปแบบ JSON ไม่ถูกต้อง');
    }

    const { transcript } = validateAnswerRequest(rawBody);
    const result = await generateGroundedAnswer(transcript);

    return NextResponse.json(result, {
      status: 200,
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
