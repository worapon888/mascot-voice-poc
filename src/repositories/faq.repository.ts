import 'server-only';
import { getSupabaseServerClient } from '@/lib/supabase/client';
import type { FaqRecord } from '@/types/faq';

const FAQ_TABLE = 'faqs';
const FAQ_SELECT_COLUMNS =
  'id, question, answer, keywords, is_active, created_at';
const MAX_POC_FAQ_LIMIT = 10;

interface CachedActiveFaqs {
  records: FaqRecord[];
  cachedAt: number;
}

let activeFaqsCache: CachedActiveFaqs | null = null;
export const ACTIVE_FAQS_CACHE_TTL_MS = 60_000; // 60s TTL

export function resetActiveFaqsCacheForTesting(): void {
  activeFaqsCache = null;
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
  return data as FaqRecord;
}
