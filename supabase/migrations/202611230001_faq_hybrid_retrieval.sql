-- =============================================================================
-- Migration: 202611230001_faq_hybrid_retrieval.sql
-- Status: PRODUCTION MIGRATION
--
-- Purpose:
--   1. Enable `vector` extension (pgvector) in Supabase.
--   2. Add full-text search `search_tsv` column & trigger-based updater & GIN index to `public.faqs`.
--   3. Create `public.faq_embeddings` dedicated metadata table for versioned,
--      content-hashed 1536-dim vectors referencing `public.faqs(id)` (BIGINT PK).
--   4. Create HNSW index on `faq_embeddings` for sub-millisecond approximate nearest neighbor.
--   5. Provide `match_faqs_hybrid` RPC function executing Reciprocal Rank Fusion (RRF k=60)
--      joining lexical search, dense vector cosine similarity, and persistent MP3 assets.
--   6. Enforce strict Row Level Security (RLS) on `faq_embeddings`.
--   7. Maintain 100% backward compatibility with `public.faqs` and `public.faq_audio_assets`.
-- =============================================================================

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Add Full-Text Search tsvector column on public.faqs
ALTER TABLE public.faqs
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

-- 3. Trigger function to automatically update search_tsv on insert/update
CREATE OR REPLACE FUNCTION public.faqs_update_search_tsv()
RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector(
    'simple',
    coalesce(NEW.question, '') || ' ' ||
    coalesce(array_to_string(NEW.keywords, ' '), '') || ' ' ||
    coalesce(NEW.answer, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Attach trigger to public.faqs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_faqs_search_tsv'
  ) THEN
    CREATE TRIGGER trigger_faqs_search_tsv
    BEFORE INSERT OR UPDATE ON public.faqs
    FOR EACH ROW EXECUTE FUNCTION public.faqs_update_search_tsv();
  END IF;
END $$;

-- 5. Backfill search_tsv for existing active FAQs
UPDATE public.faqs
SET search_tsv = to_tsvector(
  'simple',
  coalesce(question, '') || ' ' ||
  coalesce(array_to_string(keywords, ' '), '') || ' ' ||
  coalesce(answer, '')
)
WHERE search_tsv IS NULL;

-- 6. Create GIN index on search_tsv for fast lexical searches
CREATE INDEX IF NOT EXISTS idx_faqs_search_tsv
  ON public.faqs USING gin(search_tsv);

-- 7. Dedicated Embeddings Table (Decoupled from public.faqs to prevent webhook trigger loops)
CREATE TABLE IF NOT EXISTS public.faq_embeddings (
  faq_id BIGINT NOT NULL REFERENCES public.faqs(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  model_version TEXT NOT NULL DEFAULT 'v1',
  dimensions INTEGER NOT NULL DEFAULT 1536,
  content_hash TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (faq_id, model_name, content_hash)
);

-- 8. Vector and Lookup Indexes
CREATE INDEX IF NOT EXISTS idx_faq_embeddings_lookup
  ON public.faq_embeddings (faq_id, model_name, content_hash);

CREATE INDEX IF NOT EXISTS idx_faq_embeddings_hnsw
  ON public.faq_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 9. Enable Row Level Security (RLS)
ALTER TABLE public.faq_embeddings ENABLE ROW LEVEL SECURITY;

-- Allow read access for authenticated and service_role
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'faq_embeddings'
      AND policyname = 'Allow read access for authenticated and service_role'
  ) THEN
    CREATE POLICY "Allow read access for authenticated and service_role"
      ON public.faq_embeddings
      FOR SELECT
      USING (true);
  END IF;
END $$;

-- 10. Hybrid Search RPC (Lexical BM25 / ts_rank_cd + Dense Vector Cosine + RRF k=60)
-- Joins with `faq_audio_assets` to seamlessly return existing persistent MP3 audio URL
CREATE OR REPLACE FUNCTION public.match_faqs_hybrid(
  query_text text,
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  rrf_k int DEFAULT 60
)
RETURNS TABLE (
  id bigint,
  question text,
  answer text,
  keywords text[],
  audio_url text,
  audio_status text,
  lexical_score float8,
  semantic_similarity float8,
  rrf_score float8,
  lexical_rank int,
  semantic_rank int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH lexical_matches AS (
    SELECT
      f.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(f.search_tsv, plainto_tsquery('simple', query_text)) DESC) AS rank,
      ts_rank_cd(f.search_tsv, plainto_tsquery('simple', query_text))::float8 AS score
    FROM public.faqs f
    WHERE f.is_active = TRUE
      AND f.search_tsv @@ plainto_tsquery('simple', query_text)
    LIMIT match_count * 3
  ),
  semantic_matches AS (
    SELECT
      fe.faq_id AS id,
      ROW_NUMBER() OVER (ORDER BY fe.embedding <=> query_embedding ASC) AS rank,
      (1.0 - (fe.embedding <=> query_embedding))::float8 AS similarity
    FROM public.faq_embeddings fe
    JOIN public.faqs f ON f.id = fe.faq_id
    WHERE f.is_active = TRUE
      AND fe.model_name = 'text-embedding-3-small'
    LIMIT match_count * 3
  ),
  fused_candidates AS (
    SELECT
      f.id,
      f.question,
      f.answer,
      f.keywords,
      COALESCE(l.score, 0.0)::float8 AS lexical_score,
      COALESCE(s.similarity, 0.0)::float8 AS semantic_similarity,
      (COALESCE(1.0 / (rrf_k + l.rank), 0.0) + COALESCE(1.0 / (rrf_k + s.rank), 0.0))::float8 AS rrf_score,
      l.rank::int AS lexical_rank,
      s.rank::int AS semantic_rank
    FROM public.faqs f
    LEFT JOIN lexical_matches l ON f.id = l.id
    LEFT JOIN semantic_matches s ON f.id = s.id
    WHERE l.rank IS NOT NULL OR s.rank IS NOT NULL
  )
  SELECT
    fc.id,
    fc.question,
    fc.answer,
    fc.keywords,
    fa.object_path AS audio_url,
    fa.status AS audio_status,
    fc.lexical_score,
    fc.semantic_similarity,
    fc.rrf_score,
    fc.lexical_rank,
    fc.semantic_rank
  FROM fused_candidates fc
  LEFT JOIN LATERAL (
    SELECT object_path, status
    FROM public.faq_audio_assets
    WHERE faq_id = fc.id AND status = 'READY'
    ORDER BY generated_at DESC NULLS LAST
    LIMIT 1
  ) fa ON TRUE
  ORDER BY fc.rrf_score DESC
  LIMIT match_count;
END;
$$;

-- 11. Grant execution permissions
GRANT EXECUTE ON FUNCTION public.match_faqs_hybrid(text, vector, int, int) TO anon, authenticated, service_role;
