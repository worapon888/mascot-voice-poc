import 'server-only';
import { getSupabaseServerClient } from '@/lib/supabase/client';
import { getFaqAudioBucketName, getSupabaseEnv } from '@/lib/validations/env';
import type { FaqAudioAssetRecord } from '@/types/faq';

const FAQ_AUDIO_METADATA_TABLE = 'faq_audio_assets';

export interface FaqAudioStorageAdapter {
  getMetadata(
    faqId: number,
    contentHash: string,
  ): Promise<FaqAudioAssetRecord | null>;
  upsertMetadata(record: FaqAudioAssetRecord): Promise<FaqAudioAssetRecord>;
  objectExistsInStorage(
    bucketName: string,
    objectPath: string,
  ): Promise<boolean>;
  uploadAudioObject(
    bucketName: string,
    objectPath: string,
    mp3Buffer: Buffer,
  ): Promise<void>;
  getPublicAudioUrl(bucketName: string, objectPath: string): string;
}

/**
 * Builds the immutable, content-addressed object path inside the Supabase Storage bucket.
 * Never uses `faqId` alone so old versions are never overwritten in place and CDN/browser caches
 * never serve stale audio when a FAQ answer changes.
 */
export function buildFaqAudioObjectPath(
  faqId: number,
  contentHash: string,
  normalizerVersion = 'v1',
): string {
  return `faqs/${normalizerVersion}/faq-${faqId}-${contentHash}.mp3`;
}

/**
 * Builds the immutable metadata JSON sidecar object path in Supabase Storage.
 * Used as a fallback metadata store when `public.faq_audio_assets` migration has not yet been applied.
 */
export function buildFaqAudioMetadataObjectPath(
  faqId: number,
  contentHash: string,
  normalizerVersion = 'v1',
): string {
  return `faqs/${normalizerVersion}/faq-${faqId}-${contentHash}.meta.json`;
}

function isMissingTableError(error: {
  code?: string;
  message?: string;
}): boolean {
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    msg.includes('faq_audio_assets') ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  );
}

/**
 * Ensures the persistent FAQ audio bucket (`mascot-faq-audio`) exists in Supabase Storage.
 * Safe and idempotent to call from admin setup/reconciliation scripts.
 */
export async function ensureFaqAudioBucketExists(
  bucketName: string = getFaqAudioBucketName(),
): Promise<{ created: boolean; bucketName: string }> {
  const supabase = getSupabaseServerClient();
  const { data: existing, error: getErr } =
    await supabase.storage.getBucket(bucketName);

  if (!getErr && existing) {
    return { created: false, bucketName };
  }

  const { error: createErr } = await supabase.storage.createBucket(bucketName, {
    public: true,
    fileSizeLimit: 3 * 1024 * 1024,
    allowedMimeTypes: ['audio/mpeg', 'audio/mp3'],
  });

  if (
    createErr &&
    !createErr.message.toLowerCase().includes('already exists')
  ) {
    throw new Error(
      `Failed to ensure Supabase Storage bucket "${bucketName}": ${createErr.message}`,
    );
  }

  return { created: true, bucketName };
}

/**
 * Default live Supabase adapter for persistent FAQ audio metadata and Storage objects.
 * Supports `public.faq_audio_assets` table with automatic fallback to a content-addressed
 * `.meta.json` sidecar in Supabase Storage if the SQL migration table is not yet created.
 */
export function createSupabaseFaqAudioStorageAdapter(): FaqAudioStorageAdapter {
  return {
    async getMetadata(
      faqId: number,
      contentHash: string,
    ): Promise<FaqAudioAssetRecord | null> {
      const supabase = getSupabaseServerClient();
      const { data, error } = await supabase
        .from(FAQ_AUDIO_METADATA_TABLE)
        .select('*')
        .eq('faq_id', faqId)
        .eq('content_hash', contentHash)
        .maybeSingle();

      if (!error && data) {
        return data as FaqAudioAssetRecord;
      }

      if (error && !isMissingTableError(error)) {
        throw new Error(
          `Failed to query faq_audio_assets for faq_id=${faqId}: ${error.message}`,
        );
      }

      // Fallback: check content-addressed sidecar JSON in Storage bucket
      const bucketName = getFaqAudioBucketName();
      const metaPath = buildFaqAudioMetadataObjectPath(faqId, contentHash);
      const { data: blobData, error: downloadErr } = await supabase.storage
        .from(bucketName)
        .download(metaPath);

      if (downloadErr || !blobData) {
        return null;
      }

      try {
        const text = await blobData.text();
        return JSON.parse(text) as FaqAudioAssetRecord;
      } catch {
        return null;
      }
    },

    async upsertMetadata(
      record: FaqAudioAssetRecord,
    ): Promise<FaqAudioAssetRecord> {
      const supabase = getSupabaseServerClient();
      const { data, error } = await supabase
        .from(FAQ_AUDIO_METADATA_TABLE)
        .upsert(record, { onConflict: 'faq_id,content_hash' })
        .select('*')
        .single();

      if (!error && data) {
        return data as FaqAudioAssetRecord;
      }

      if (error && !isMissingTableError(error)) {
        throw new Error(
          `Failed to upsert faq_audio_assets for faq_id=${record.faq_id}: ${error.message}`,
        );
      }

      // Fallback: write content-addressed sidecar JSON to Storage bucket
      const metaPath = buildFaqAudioMetadataObjectPath(
        record.faq_id,
        record.content_hash,
        record.normalizer_version,
      );
      const jsonBytes = Buffer.from(JSON.stringify(record), 'utf8');
      const { error: uploadErr } = await supabase.storage
        .from(record.bucket_name)
        .upload(metaPath, jsonBytes, {
          contentType: 'application/json',
          upsert: true,
        });

      if (uploadErr) {
        throw new Error(
          `Failed to persist FAQ audio metadata sidecar (${metaPath}): ${uploadErr.message}`,
        );
      }

      return record;
    },

    async objectExistsInStorage(
      bucketName: string,
      objectPath: string,
    ): Promise<boolean> {
      const supabase = getSupabaseServerClient();
      const lastSlash = objectPath.lastIndexOf('/');
      const folder = lastSlash >= 0 ? objectPath.slice(0, lastSlash) : '';
      const fileName =
        lastSlash >= 0 ? objectPath.slice(lastSlash + 1) : objectPath;

      const { data, error } = await supabase.storage
        .from(bucketName)
        .list(folder, {
          limit: 10,
          search: fileName,
        });

      if (error || !data) {
        return false;
      }

      return data.some((item) => item.name === fileName);
    },

    async uploadAudioObject(
      bucketName: string,
      objectPath: string,
      mp3Buffer: Buffer,
    ): Promise<void> {
      const supabase = getSupabaseServerClient();
      const { error } = await supabase.storage
        .from(bucketName)
        .upload(objectPath, mp3Buffer, {
          contentType: 'audio/mpeg',
          cacheControl: '31536000',
          upsert: true,
        });

      if (error) {
        throw new Error(
          `Failed to upload MP3 to Supabase Storage (${bucketName}/${objectPath}): ${error.message}`,
        );
      }
    },

    getPublicAudioUrl(bucketName: string, objectPath: string): string {
      const { SUPABASE_URL } = getSupabaseEnv();
      const baseUrl = SUPABASE_URL.replace(/\/$/, '');
      const encodedPath = objectPath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      return `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucketName)}/${encodedPath}`;
    },
  };
}
