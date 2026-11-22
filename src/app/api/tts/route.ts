import { type NextRequest, NextResponse } from 'next/server';
import {
  ApiError,
  assertDemoEnabled,
  handleApiRouteError,
  methodNotAllowedResponse,
} from '@/lib/api/errors';
import { validateTtsRequest } from '@/lib/validations/voice';
import { synthesizeSpeechMp3WithMetrics } from '@/services/speech.service';
import type { ApiErrorResponse } from '@/types/api';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
): Promise<NextResponse | NextResponse<ApiErrorResponse>> {
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

    const { text } = validateTtsRequest(rawBody);
    const {
      buffer: mp3Buffer,
      cacheStatus,
      ttsLatencyMs,
      openAiTtsCalled,
    } = await synthesizeSpeechMp3WithMetrics(text);

    return new NextResponse(new Uint8Array(mp3Buffer), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(mp3Buffer.length),
        'Cache-Control': 'no-store',
        'X-TTS-Cache': cacheStatus,
        'X-TTS-Latency-Ms': String(ttsLatencyMs),
        'X-OpenAI-TTS-Called': openAiTtsCalled ? '1' : '0',
      },
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
