-- =============================================================================
-- Migration: 202611220001_faq_persistent_audio.sql
-- Purpose:
--   1. Create `public.faq_audio_assets` metadata table to track versioned,
--      content-addressed persistent MP3 audio per FAQ answer version without
--      mutating `public.faqs` (preventing infinite webhook trigger loops).
--   2. Create `mascot-faq-audio` Supabase Storage bucket with public read access
--      for immutable content-addressed MP3 files while prohibiting public
--      upload, update, or delete.
-- =============================================================================

-- 1. Metadata table for content-addressed FAQ audio versions
CREATE TABLE IF NOT EXISTS public.faq_audio_assets (
  faq_id BIGINT NOT NULL REFERENCES public.faqs(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  canonical_answer TEXT NOT NULL,
  normalized_speech_text TEXT NOT NULL,
  bucket_name TEXT NOT NULL DEFAULT 'mascot-faq-audio',
  object_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
  byte_length INTEGER NOT NULL DEFAULT 0,
  tts_model TEXT NOT NULL DEFAULT 'gpt-4o-mini-tts',
  tts_voice TEXT NOT NULL DEFAULT 'coral',
  normalizer_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'GENERATING', 'READY', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  generated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (faq_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_faq_audio_assets_lookup
  ON public.faq_audio_assets (faq_id, content_hash, status);

-- Enable Row Level Security (only server-side service_role / secret key can read or write)
ALTER TABLE public.faq_audio_assets ENABLE ROW LEVEL SECURITY;

-- 2. Supabase Storage Bucket (`mascot-faq-audio`)
-- Public read is enabled ONLY for reading pre-generated public FAQ MP3 files by content-addressed path.
-- Public insert/update/delete policies are intentionally NOT created (only server-side secret key can write).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mascot-faq-audio',
  'mascot-faq-audio',
  TRUE,
  3145728,
  ARRAY['audio/mpeg', 'audio/mp3']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Allow public read of objects inside `mascot-faq-audio` (no public upload/update/delete)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Public read access for mascot-faq-audio'
  ) THEN
    CREATE POLICY "Public read access for mascot-faq-audio"
      ON storage.objects
      FOR SELECT
      USING (bucket_id = 'mascot-faq-audio');
  END IF;
END
$$;
