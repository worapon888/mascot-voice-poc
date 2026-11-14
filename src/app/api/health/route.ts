import { NextResponse } from 'next/server';
import type { HealthCheckResponse } from '@/types/api';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse<HealthCheckResponse>> {
  return NextResponse.json({
    status: 'ok',
    service: 'mascot-voice-poc',
  });
}
