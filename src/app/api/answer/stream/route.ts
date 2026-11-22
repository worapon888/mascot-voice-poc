import { type NextRequest, NextResponse } from 'next/server';
import {
  ApiError,
  assertDemoEnabled,
  handleApiRouteError,
  methodNotAllowedResponse,
} from '@/lib/api/errors';
import { validateAnswerRequest } from '@/lib/validations/voice';
import { streamGroundedAnswerEvents } from '@/services/answer-stream.service';
import type { ApiErrorResponse } from '@/types/api';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
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

    const { transcript, conversationHistory } = validateAnswerRequest(rawBody);

    const encoder = new TextEncoder();
    const abortSignal = request.signal;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const sseEvent of streamGroundedAnswerEvents({
            rawTranscript: transcript,
            conversationHistory,
            signal: abortSignal,
          })) {
            if (abortSignal.aborted) {
              break;
            }

            const payload = `event: ${sseEvent.event}\ndata: ${JSON.stringify(sseEvent.data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          }
          controller.close();
        } catch (err) {
          if (!abortSignal.aborted) {
            const errorPayload = `event: error\ndata: ${JSON.stringify({
              code: 'STREAM_FAILED',
              message:
                err instanceof Error ? err.message : 'Unknown stream error',
            })}\n\n`;
            controller.enqueue(encoder.encode(errorPayload));
            controller.close();
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
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
