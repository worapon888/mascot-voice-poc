import 'server-only';
import { getSupabaseServerClient } from '@/lib/supabase/client';
import type { FaqRecord } from '@/types/faq';

const FAQ_TABLE = 'faqs';
const FAQ_SELECT_COLUMNS =
  'id, question, answer, keywords, is_active, created_at';
const MAX_POC_FAQ_LIMIT = 10;
const MAX_DATABASE_CANDIDATE_LIMIT = 50;
const MAX_EXACT_LOOKUP_CACHE_ENTRIES = 1_000;

interface CachedActiveFaqs {
  records: FaqRecord[];
  cachedAt: number;
}

interface CachedExactFaqLookup {
  record: FaqRecord | null;
  cachedAt: number;
}

let activeFaqsCache: CachedActiveFaqs | null = null;
const exactFaqLookupCache = new Map<string, CachedExactFaqLookup>();
export const ACTIVE_FAQS_CACHE_TTL_MS = 60_000; // 60s TTL

export function resetActiveFaqsCacheForTesting(): void {
  activeFaqsCache = null;
  exactFaqLookupCache.clear();
}

export function getActiveFaqsCacheStats(): {
  cached: boolean;
  ageMs?: number;
  count?: number;
} {
  if (
    activeFaqsCache &&
    Date.now() - activeFaqsCache.cachedAt < ACTIVE_FAQS_CACHE_TTL_MS
  ) {
    return {
      cached: true,
      ageMs: Date.now() - activeFaqsCache.cachedAt,
      count: activeFaqsCache.records.length,
    };
  }
  return { cached: false };
}

export class FaqRepositoryError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'FAQ_REPOSITORY_ERROR') {
    super(message);
    this.name = 'FaqRepositoryError';
    this.code = code;
  }
}

/**
 * Retrieves active FAQs from Supabase PostgreSQL with in-memory caching (60s TTL).
 * Enforces a maximum limit of 10 records for the POC.
 */
export async function getActiveFaqs(
  limit: number = MAX_POC_FAQ_LIMIT,
  options: { bypassCache?: boolean } = {},
): Promise<FaqRecord[]> {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_POC_FAQ_LIMIT);
  const now = Date.now();

  if (
    !options.bypassCache &&
    activeFaqsCache &&
    now - activeFaqsCache.cachedAt < ACTIVE_FAQS_CACHE_TTL_MS &&
    activeFaqsCache.records.length <= safeLimit
  ) {
    return activeFaqsCache.records.slice(0, safeLimit);
  }

  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select(FAQ_SELECT_COLUMNS)
    .eq('is_active', true)
    .order('id', { ascending: true })
    .limit(safeLimit);

  if (error) {
    throw new FaqRepositoryError(
      'Failed to retrieve active FAQs from database.',
      error.code || 'SUPABASE_QUERY_ERROR',
    );
  }

  const records = (data ?? []) as FaqRecord[];
  activeFaqsCache = {
    records,
    cachedAt: now,
  };

  return records;
}

/**
 * Looks up a canonical active FAQ question directly in PostgreSQL. This keeps
 * exact matching available beyond the small in-memory POC window without
 * loading an entire 500–600 row corpus on every request.
 */
export async function findActiveFaqByQuestion(
  question: string,
): Promise<FaqRecord | null> {
  const normalizedQuestion = question.normalize('NFC').trim();
  if (!normalizedQuestion) return null;

  const cached = exactFaqLookupCache.get(normalizedQuestion);
  if (cached && Date.now() - cached.cachedAt < ACTIVE_FAQS_CACHE_TTL_MS) {
    return cached.record;
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select(FAQ_SELECT_COLUMNS)
    .eq('is_active', true)
    .eq('question', normalizedQuestion)
    .maybeSingle();

  if (error) {
    throw new FaqRepositoryError(
      'Failed to look up an active FAQ by canonical question.',
      error.code || 'SUPABASE_QUERY_ERROR',
    );
  }

  const record = (data as FaqRecord | null) ?? null;
  if (exactFaqLookupCache.size >= MAX_EXACT_LOOKUP_CACHE_ENTRIES) {
    const oldestKey = exactFaqLookupCache.keys().next().value;
    if (oldestKey !== undefined) exactFaqLookupCache.delete(oldestKey);
  }
  exactFaqLookupCache.set(normalizedQuestion, {
    record,
    cachedAt: Date.now(),
  });
  return record;
}

/** Retrieves referenced active FAQs by ID for conversation context. */
export async function getActiveFaqsByIds(
  ids: ReadonlyArray<number>,
): Promise<FaqRecord[]> {
  const safeIds = Array.from(
    new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
  ).slice(0, MAX_DATABASE_CANDIDATE_LIMIT);
  if (safeIds.length === 0) return [];

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select(FAQ_SELECT_COLUMNS)
    .eq('is_active', true)
    .in('id', safeIds);

  if (error) {
    throw new FaqRepositoryError(
      'Failed to retrieve active FAQs by context IDs.',
      error.code || 'SUPABASE_QUERY_ERROR',
    );
  }

  const byId = new Map(
    ((data ?? []) as FaqRecord[]).map((faq) => [faq.id, faq]),
  );
  return safeIds.flatMap((id) => {
    const faq = byId.get(id);
    return faq ? [faq] : [];
  });
}

/**
 * Database-side lexical fallback for hybrid RPC outages. PostgreSQL limits the
 * candidate set before records reach the application process.
 */
export async function searchActiveFaqsLexically(
  query: string,
  limit = 20,
): Promise<FaqRecord[]> {
  const normalizedQuery = query.normalize('NFC').trim();
  if (!normalizedQuery) return [];

  // A fallback query must retain candidates for every stated intent. Joining
  // terms with AND can discard two individually relevant FAQs in a multi-intent
  // question. A database-side OR keeps the candidate set broad; the existing
  // application scorer still decides relevance and coverage afterward.
  const searchTerms = Array.from(
    new Set(
      normalizedQuery
        .split(/\s+/u)
        .map((term) => term.replace(/[^\p{L}\p{M}\p{N}]/gu, ''))
        .filter(Boolean),
    ),
  ).slice(0, 12);
  const lexicalOrFilter = searchTerms
    .flatMap((term) => [`question.ilike.*${term}*`, `answer.ilike.*${term}*`])
    .join(',');
  if (!lexicalOrFilter) return [];

  const safeLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    MAX_DATABASE_CANDIDATE_LIMIT,
  );
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select(FAQ_SELECT_COLUMNS)
    .eq('is_active', true)
    .or(lexicalOrFilter)
    .limit(safeLimit);

  if (error) {
    throw new FaqRepositoryError(
      'Failed to retrieve database-side lexical FAQ candidates.',
      error.code || 'SUPABASE_QUERY_ERROR',
    );
  }

  return (data ?? []) as FaqRecord[];
}

/**
 * Retrieves a single FAQ record by ID regardless of active status.
 * Used by persistent audio verification to check current version freshness.
 */
export async function getFaqById(id: number): Promise<FaqRecord | null> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select(FAQ_SELECT_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new FaqRepositoryError(
      `Failed to retrieve FAQ id=${id} from database.`,
      error.code || 'SUPABASE_QUERY_ERROR',
    );
  }

  return (data as FaqRecord | null) ?? null;
}

/**
 * Retrieves all FAQ records (both active and inactive) up to the POC limit.
 * Used by admin initial audio setup / reconciliation tools.
 */
export async function getAllFaqs(
  limit: number = MAX_POC_FAQ_LIMIT,
): Promise<FaqRecord[]> {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_POC_FAQ_LIMIT);
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select(FAQ_SELECT_COLUMNS)
    .order('id', { ascending: true })
    .limit(safeLimit);

  if (error) {
    throw new FaqRepositoryError(
      'Failed to retrieve FAQs from database.',
      error.code || 'SUPABASE_QUERY_ERROR',
    );
  }

  return (data ?? []) as FaqRecord[];
}

/**
 * Updates the active status of a specific FAQ record by ID.
 * Used for server-side verification and smoke testing.
 */
export async function setFaqActiveStatus(
  id: number,
  isActive: boolean,
): Promise<FaqRecord> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .update({ is_active: isActive })
    .eq('id', id)
    .select(FAQ_SELECT_COLUMNS)
    .single();

  if (error || !data) {
    throw new FaqRepositoryError(
      `Failed to update active status for FAQ id=${id}.`,
      error?.code || 'SUPABASE_UPDATE_ERROR',
    );
  }

  activeFaqsCache = null;
  exactFaqLookupCache.clear();
  return data as FaqRecord;
}

/**
 * Updates the answer text of a specific FAQ record by ID.
 * Used for server-side verification and smoke testing.
 */
export async function updateFaqAnswer(
  id: number,
  answer: string,
): Promise<FaqRecord> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .update({ answer })
    .eq('id', id)
    .select(FAQ_SELECT_COLUMNS)
    .single();

  if (error || !data) {
    throw new FaqRepositoryError(
      `Failed to update answer for FAQ id=${id}.`,
      error?.code || 'SUPABASE_UPDATE_ERROR',
    );
  }

  activeFaqsCache = null;
  exactFaqLookupCache.clear();
  return data as FaqRecord;
}
