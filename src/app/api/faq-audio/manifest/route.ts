import { NextResponse } from 'next/server';
import { assertDemoEnabled, handleApiRouteError } from '@/lib/api/errors';
import { getActiveFaqs } from '@/repositories/faq.repository';
import {
  resolvePersistentFaqAudioRef,
  resolvePersistentFallbackAudioRef,
} from '@/services/faq-audio.service';
import type { ApiErrorResponse } from '@/types/api';

export const runtime = 'nodejs';

export interface FaqAudioManifestItem {
  faqId: number;
  audioUrl: string;
  contentHash: string;
  isFallback?: boolean;
}

export interface FaqAudioManifestResponse {
  audios: FaqAudioManifestItem[];
}

export async function GET(): Promise<
  NextResponse<FaqAudioManifestResponse | ApiErrorResponse>
> {
  try {
    assertDemoEnabled();

    const activeFaqs = await getActiveFaqs();
    const manifestItems: FaqAudioManifestItem[] = [];

    // 1. Collect ready active FAQ audio references
    for (const faq of activeFaqs) {
      const audioResult = await resolvePersistentFaqAudioRef(faq);
      if (audioResult.hit && audioResult.audioRef?.audioUrl) {
        manifestItems.push({
          faqId: faq.id,
          audioUrl: audioResult.audioRef.audioUrl,
          contentHash: audioResult.contentHash,
          isFallback: false,
        });
      }
    }

    // 2. Collect fallback audio reference
    const fallbackResult = await resolvePersistentFallbackAudioRef();
    if (fallbackResult.hit && fallbackResult.audioRef?.audioUrl) {
      manifestItems.push({
        faqId: 0,
        audioUrl: fallbackResult.audioRef.audioUrl,
        contentHash: fallbackResult.contentHash,
        isFallback: true,
      });
    }

    return NextResponse.json(
      { audios: manifestItems },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=60, s-maxage=60',
          'X-Manifest-Items': String(manifestItems.length),
        },
      },
    );
  } catch (error) {
    return handleApiRouteError(error);
  }
}
