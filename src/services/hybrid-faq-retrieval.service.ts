import 'server-only';
import { performance } from 'node:perf_hooks';
import { getOpenAIClient } from '@/lib/openai/client';
import { getSupabaseServerClient } from '@/lib/supabase/client';
import { getActiveFaqs } from '@/repositories/faq.repository';
import {
  extractQuestionCore,
  hasContextualFollowUpSignal,
  normalizeThaiText,
  scoreFaqRecord,
  stripLeadingConversationalPrefixes,
  stripLocativeDemonstratives,
  stripTrailingPoliteParticles,
  type FaqRetrievalResult,
  type ScoredFaqMatch,
} from '@/services/faq-matching.service';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

// -----------------------------------------------------------------------------
// In-Memory Query Embedding Cache (LRU/TTL pattern)
// -----------------------------------------------------------------------------
interface CachedEmbedding {
  embedding: number[];
  timestamp: number;
}

const MAX_CACHED_EMBEDDINGS = 500;
const EMBEDDING_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
const queryEmbeddingCache = new Map<string, CachedEmbedding>();

export function clearQueryEmbeddingCacheForTesting(): void {
  queryEmbeddingCache.clear();
}

export function getQueryEmbeddingCacheStats(): {
  size: number;
  max: number;
} {
  return {
    size: queryEmbeddingCache.size,
    max: MAX_CACHED_EMBEDDINGS,
  };
}

function getCachedEmbedding(normQuery: string): number[] | null {
  const cached = queryEmbeddingCache.get(normQuery);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > EMBEDDING_CACHE_TTL_MS) {
    queryEmbeddingCache.delete(normQuery);
    return null;
  }
  return cached.embedding;
}

function setCachedEmbedding(normQuery: string, embedding: number[]): void {
  if (queryEmbeddingCache.size >= MAX_CACHED_EMBEDDINGS) {
    // Evict oldest entry
    const oldestKey = queryEmbeddingCache.keys().next().value;
    if (oldestKey) queryEmbeddingCache.delete(oldestKey);
  }
  queryEmbeddingCache.set(normQuery, {
    embedding,
    timestamp: Date.now(),
  });
}

// -----------------------------------------------------------------------------
// Supabase RPC Result Interface
// -----------------------------------------------------------------------------
interface HybridRpcRow {
  id: number;
  question: string;
  answer: string;
  keywords: string[];
  audio_url: string | null;
  audio_status: string | null;
  lexical_score: number;
  semantic_similarity: number;
  rrf_score: number;
  lexical_rank: number | null;
  semantic_rank: number | null;
}

// -----------------------------------------------------------------------------
// Generic Evidence Sufficiency Evaluator
// -----------------------------------------------------------------------------
export function evaluateGenericEvidenceSufficiency(
  query: string,
  topFaq: FaqRecord,
  topSimilarity: number,
  margin = 0,
  lexicalRank: number | null = null,
): {
  sufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT';
  suggestedTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
} {
  // A. Generic Statistical Out-of-Scope Detection
  // If vector similarity is very low (< 0.16) and no lexical tsvector match exists,
  // the query is statistically unrelated to any FAQ (Tier 3 Fallback).
  if (topSimilarity < 0.16 && lexicalRank === null) {
    return { sufficiency: 'INSUFFICIENT', suggestedTier: 'TIER_3' };
  }

  // B. Ambiguity / Flat Distribution Noise Check
  // If no lexical rank, similarity is marginal (< 0.28) and margin to top 2 is near zero (< 0.02),
  // it indicates a flat noise distribution across irrelevant FAQs.
  if (lexicalRank === null && topSimilarity < 0.28 && margin < 0.02) {
    return { sufficiency: 'INSUFFICIENT', suggestedTier: 'TIER_3' };
  }

  // C. Generic Interrogative Target vs Evidence Grounding Check
  const faqCorpusText =
    `${topFaq.question} ${(topFaq.keywords ?? []).join(' ')} ${topFaq.answer}`.toLowerCase();

  // If user asks about price/cost/fee (e.g. "ค่า...", "ราคา", "เท่าไหร่", "กี่บาท", "เสียเงิน")
  // but the FAQ contains no pricing or financial terms:
  const isAskingPriceOrFee =
    /(?:ราคา|ค่าบริการ|ค่าธรรมเนียม|ค่าใช้จ่าย|เท่าไหร่|กี่บาท|เสียเงิน)/u.test(query);
  if (
    isAskingPriceOrFee &&
    !/(?:บาท|ฟรี|ค่า|ราคา|เสียเงิน|จ่าย)/u.test(faqCorpusText)
  ) {
    return { sufficiency: 'INSUFFICIENT', suggestedTier: 'TIER_3' };
  }

  // If user asks about location / directions ("ห้องน้ำ", "จอดรถ", "ชั้นไหน", "อยู่ตรงไหน", "อยู่ที่ไหน", "เดินทาง")
  // but the FAQ contains no location info:
  const isAskingLocation =
    /(?:ห้องน้ำ|จอดรถ|ที่จอดรถ|ชั้นไหน|อยู่ตรงไหน|อยู่ที่ไหน|เดินทาง)/u.test(query);
  if (
    isAskingLocation &&
    !/(?:ชั้น|อาคาร|ห้อง|จอดรถ|เดินทาง|แผนที่|สถานที่)/u.test(faqCorpusText)
  ) {
    return { sufficiency: 'INSUFFICIENT', suggestedTier: 'TIER_3' };
  }

  // If user asks about external weather:
  if (
    /(?:ฝนตก|อากาศ|พยากรณ์)/u.test(query) &&
    !/(?:ฝน|อากาศ)/u.test(faqCorpusText)
  ) {
    return { sufficiency: 'INSUFFICIENT', suggestedTier: 'TIER_3' };
  }

  // D. Generic Problem / Troubleshooting / Incident statements ("เปิดไม่ได้", "ลืมของ", "ระบบล่ม", "พัง")
  if (/(ไม่ได้|ไม่ผ่าน|ล่ม|พัง|เสีย|ทำไม|ลืม|ทำตก|หาย)/u.test(query)) {
    return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
  }

  // E. Generic Counterfactual or hypothetical conditions ("ถ้าไม่มี...", "ถ้าเกิด...")
  if (/(ถ้าไม่มี|หากไม่มี|ถ้าเกิด|สมมติว่า)/u.test(query)) {
    return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
  }

  // F. Generic Multi-intent conjunctions ("และ...อะไรบ้าง", "รวมทั้ง")
  if (/(และ.*อะไรบ้าง|และ.*ด้วยไหม|รวมทั้ง)/u.test(query)) {
    return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
  }

  // G. Check for specific constraint modifiers not in FAQ corpus (e.g. asking about specific time/break/holiday policies)
  const subAngleModifiers = [
    'พักเที่ยง',
    'พักกลางวัน',
    'หยุดชดเชย',
    'ล่วงเวลา',
    'โอที',
  ];
  for (const angle of subAngleModifiers) {
    if (query.includes(angle) && !faqCorpusText.includes(angle)) {
      return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
    }
  }

  // H. High-Confidence Evidence Match:
  // Either very high similarity (>= 0.70) or solid similarity (>= 0.17) with a distinctive margin (>= 0.03) or lexical hit (>= 0.20)
  if (
    topSimilarity >= 0.7 ||
    (topSimilarity >= 0.17 && margin >= 0.03) ||
    (lexicalRank !== null && topSimilarity >= 0.2)
  ) {
    return { sufficiency: 'SUFFICIENT', suggestedTier: 'TIER_1' };
  }

  // I. Partial Match:
  if (topSimilarity >= 0.15 || lexicalRank !== null) {
    return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
  }

  return { sufficiency: 'INSUFFICIENT', suggestedTier: 'TIER_3' };
}

// -----------------------------------------------------------------------------
// Hybrid Retrieval Execution Function
// -----------------------------------------------------------------------------
export async function executeHybridFaqRetrieval(
  rawTranscript: string,
  conversationHistory: ReadonlyArray<ConversationTurn> = [],
  activeFaqsPromise?: Promise<FaqRecord[]>,
): Promise<FaqRetrievalResult> {
  const t0 = performance.now();

  const norm = normalizeThaiText(rawTranscript);
  const politeStripped = stripTrailingPoliteParticles(norm);
  const convStripped = stripLeadingConversationalPrefixes(politeStripped);
  const locStripped = stripLocativeDemonstratives(convStripped);
  const coreQuery = extractQuestionCore(locStripped);
  const spacelessCore = coreQuery.replace(/\s+/g, '');

  // 1. Fetch active FAQs (from cache or passed promise)
  const activeFaqs = activeFaqsPromise
    ? await activeFaqsPromise
    : await getActiveFaqs();

  // ---------------------------------------------------------------------------
  // Stage A: Exact / High-Confidence Lexical Fast Path (0ms embedding bypass)
  // ---------------------------------------------------------------------------
  const exactFaq = activeFaqs.find((f) => {
    const normQ = normalizeThaiText(f.question);
    const coreQ = extractQuestionCore(normQ);
    const spacelessQ = coreQ.replace(/\s+/g, '');
    return (
      spacelessCore === spacelessQ ||
      spacelessCore === normQ.replace(/\s+/g, '')
    );
  });

  if (exactFaq) {
    const retrievalLatencyMs = Math.round(performance.now() - t0);
    const scoredMatch: ScoredFaqMatch = {
      faq: exactFaq,
      score: 100,
      matchedTerms: ['exact_question'],
    };

    return {
      normalizedTranscript: norm,
      coreQuery,
      matched: true,
      ambiguous: false,
      faqs: [exactFaq],
      scoredMatches: [scoredMatch],
      highConfidenceFastPath: true,
      fastPathMatchReason: 'EXACT_QUESTION',
      retrievalLatencyMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Stage B: Compute / Retrieve Query Embedding
  // ---------------------------------------------------------------------------
  const embedInput = politeStripped || rawTranscript;
  const cacheKey = embedInput.replace(/\s+/g, '') || spacelessCore || norm;
  let queryVector = getCachedEmbedding(cacheKey);

  if (!queryVector) {
    const openai = getOpenAIClient();
    const embedResp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: embedInput,
    });
    queryVector = embedResp.data[0].embedding;
    setCachedEmbedding(cacheKey, queryVector);
  }

  // ---------------------------------------------------------------------------
  // Stage C: Application-Level Thai Lexical Ranking & Supabase Hybrid RPC
  // ---------------------------------------------------------------------------
  const appLexicalScored = activeFaqs
    .map((faq) => ({
      faq,
      match: scoreFaqRecord(politeStripped, coreQuery, faq),
    }))
    .filter((item) => item.match.score >= 35)
    .sort((a, b) => b.match.score - a.match.score);

  const appLexicalRankMap = new Map<number, number>();
  appLexicalScored.forEach((item, idx) => {
    appLexicalRankMap.set(item.faq.id, idx + 1);
  });

  const supabase = getSupabaseServerClient();
  const { data: rpcRows, error: rpcErr } = await supabase.rpc(
    'match_faqs_hybrid',
    {
      query_text: coreQuery || rawTranscript,
      query_embedding: queryVector,
      match_count: 5,
      rrf_k: 60,
    },
  );

  if (rpcErr || !rpcRows) {
    throw new Error(
      `Hybrid search RPC failed: ${rpcErr?.message || 'Empty response'}`,
    );
  }

  const rows = rpcRows as HybridRpcRow[];
  const retrievalLatencyMs = Math.round(performance.now() - t0);

  if (rows.length === 0) {
    return {
      normalizedTranscript: norm,
      coreQuery,
      matched: false,
      ambiguous: false,
      faqs: [],
      scoredMatches: [],
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      retrievalLatencyMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Stage D: Reciprocal Rank Fusion & Context Bias Boost
  // ---------------------------------------------------------------------------
  const isFollowUp = hasContextualFollowUpSignal(rawTranscript);
  let contextReferencedFaqId: number | null = null;

  if (conversationHistory.length > 0 && isFollowUp) {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const turn = conversationHistory[i];
      if (turn.faqIds && turn.faqIds.length > 0) {
        contextReferencedFaqId = turn.faqIds[0];
        break;
      }
    }
  }

  const RRF_K = 60;
  const adjustedRows = rows.map((row) => {
    const lexRank = appLexicalRankMap.get(row.id) ?? row.lexical_rank ?? null;
    const semRank = row.semantic_rank;
    let rrf =
      (lexRank !== null ? 1 / (RRF_K + lexRank) : 0) +
      (semRank !== null ? 1 / (RRF_K + semRank) : 0);

    if (contextReferencedFaqId !== null && row.id === contextReferencedFaqId) {
      rrf += 0.003; // Contextual follow-up boost
    }
    return {
      ...row,
      lexical_rank: lexRank,
      adjusted_rrf: rrf,
    };
  });

  adjustedRows.sort((a, b) => b.adjusted_rrf - a.adjusted_rrf);

  const top1 = adjustedRows[0];
  const top2 = adjustedRows[1];

  const simMargin = top2
    ? top1.semantic_similarity - top2.semantic_similarity
    : top1.semantic_similarity;

  // Ambiguity detection: when top 2 candidates have very close semantic similarities (< 3% gap) and neither dominates
  const isAmbiguous =
    top2 &&
    simMargin < 0.03 &&
    top1.semantic_similarity > 0.35 &&
    top2.semantic_similarity > 0.35;

  // Convert top row to FaqRecord
  const matchedFaqRecord: FaqRecord = {
    id: top1.id,
    question: top1.question,
    answer: top1.answer,
    keywords: top1.keywords || [],
    is_active: true,
    created_at: new Date().toISOString(),
  };

  // Evaluate Evidence Sufficiency
  const { sufficiency, suggestedTier } = evaluateGenericEvidenceSufficiency(
    rawTranscript,
    matchedFaqRecord,
    top1.semantic_similarity,
    simMargin,
    top1.lexical_rank,
  );

  // Confidence assessment
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
  if (sufficiency === 'INSUFFICIENT') {
    confidence = 'LOW';
  } else if (
    sufficiency === 'SUFFICIENT' &&
    (simMargin >= 0.03 || top1.lexical_rank !== null) &&
    top1.semantic_similarity >= 0.17
  ) {
    confidence = 'HIGH';
  } else if (top1.semantic_similarity < 0.15 && top1.lexical_rank === null) {
    confidence = 'LOW';
  }

  const isMatched = confidence !== 'LOW' && sufficiency !== 'INSUFFICIENT';
  const isHighConfidenceFastPath =
    isMatched &&
    confidence === 'HIGH' &&
    sufficiency === 'SUFFICIENT' &&
    suggestedTier === 'TIER_1' &&
    !isAmbiguous;

  const scoredMatches: ScoredFaqMatch[] = adjustedRows.map((r) => ({
    faq: {
      id: r.id,
      question: r.question,
      answer: r.answer,
      keywords: r.keywords || [],
      is_active: true,
      created_at: new Date().toISOString(),
    },
    score: Math.round(r.adjusted_rrf * 10000),
    matchedTerms: [
      `sim:${(r.semantic_similarity * 100).toFixed(1)}%`,
      `rrf:${r.adjusted_rrf.toFixed(4)}`,
    ],
  }));

  const matchedFaqs = isMatched ? [matchedFaqRecord] : [];
  if (isAmbiguous && top2) {
    matchedFaqs.push({
      id: top2.id,
      question: top2.question,
      answer: top2.answer,
      keywords: top2.keywords || [],
      is_active: true,
      created_at: new Date().toISOString(),
    });
  }

  return {
    normalizedTranscript: norm,
    coreQuery,
    matched: isMatched,
    ambiguous: isAmbiguous,
    faqs: matchedFaqs,
    scoredMatches,
    highConfidenceFastPath: isHighConfidenceFastPath,
    fastPathMatchReason: isHighConfidenceFastPath
      ? 'APPROVED_INTENT_ALIAS'
      : 'NONE',
    retrievalLatencyMs,
  };
}
