import 'server-only';
import { getSupabaseServerClient } from '@/lib/supabase/client';
import type { FaqRecord } from '@/types/faq';

const FAQ_TABLE = 'faqs';
const FAQ_SELECT_COLUMNS =
  'id, question, answer, keywords, is_active, created_at';
const MAX_POC_FAQ_LIMIT = 10;

export class FaqRepositoryError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'FAQ_REPOSITORY_ERROR') {
    super(message);
    this.name = 'FaqRepositoryError';
    this.code = code;
  }
}

/**
 * Retrieves active FAQs from Supabase PostgreSQL.
 * Enforces a maximum limit of 10 records for the POC.
 */
export async function getActiveFaqs(
  limit: number = MAX_POC_FAQ_LIMIT,
): Promise<FaqRecord[]> {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_POC_FAQ_LIMIT);
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

  return data as FaqRecord;
}
