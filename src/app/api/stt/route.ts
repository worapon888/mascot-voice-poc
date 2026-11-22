import { type NextRequest, NextResponse } from 'next/server';
import {
  ApiError,
  assertDemoEnabled,
  handleApiRouteError,
  methodNotAllowedResponse,
  NO_STORE_HEADERS,
} from '@/lib/api/errors';
import {
  MAX_AUDIO_FILE_BYTES,
  MAX_MULTIPART_REQUEST_BYTES,
} from '@/lib/validations/voice';
import { transcribeAudioBuffer } from '@/services/transcription.service';
import type { ApiErrorResponse, SttResponse } from '@/types/api';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
): Promise<NextResponse<SttResponse | ApiErrorResponse>> {
  try {
    assertDemoEnabled();

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw new ApiError(
        'INVALID_CONTENT_TYPE',
        415,
        'ต้องส่งข้อมูลในรูปแบบ multipart/form-data เท่านั้น',
      );
    }

    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (
        !Number.isNaN(contentLength) &&
        contentLength > MAX_MULTIPART_REQUEST_BYTES
      ) {
        throw new ApiError(
          'AUDIO_TOO_LARGE',
          413,
          'ไฟล์เสียงมีขนาดเกิน 3 MB กรุณาใช้ไฟล์เสียงขนาดไม่เกิน 3 MB',
        );
      }
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new ApiError(
        'INVALID_REQUEST',
        400,
        'ไม่สามารถอ่านข้อมูล multipart/form-data ได้',
      );
    }

    const audioEntry = formData.get('audio');
    if (!audioEntry || typeof audioEntry === 'string') {
      throw new ApiError(
        'MISSING_AUDIO',
        400,
        'ไม่พบไฟล์เสียงในฟิลด์ audio กรุณาอัปโหลดไฟล์เสียง',
      );
    }

    if (audioEntry.size === 0) {
      throw new ApiError('MISSING_AUDIO', 400, 'ไฟล์เสียงที่อัปโหลดว่างเปล่า');
    }

    if (audioEntry.size > MAX_AUDIO_FILE_BYTES) {
      throw new ApiError(
        'AUDIO_TOO_LARGE',
        413,
        'ไฟล์เสียงมีขนาดเกิน 3 MB กรุณาใช้ไฟล์เสียงขนาดไม่เกิน 3 MB',
      );
    }

    const arrayBuffer = await audioEntry.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    const t0 = performance.now();
    const transcript = await transcribeAudioBuffer(
      audioBuffer,
      audioEntry.type,
    );
    const sttLatencyMs = Math.round(performance.now() - t0);

    return NextResponse.json(
      { transcript },
      {
        status: 200,
        headers: {
          ...NO_STORE_HEADERS,
          'X-STT-Latency-Ms': String(sttLatencyMs),
          'X-OpenAI-STT-Called': '1',
        },
      },
    );
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
