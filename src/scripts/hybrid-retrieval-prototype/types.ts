import type { FaqRecord } from '@/types/faq';

export interface SemanticVector {
  faqId: number;
  embedding: number[];
  contentHash: string;
}

export interface LexicalSearchResult {
  faq: FaqRecord;
  score: number;
  matchedTerms: string[];
  rank: number;
}

export interface SemanticSearchResult {
  faq: FaqRecord;
  similarity: number;
  rank: number;
}

export interface HybridSearchResult {
  faq: FaqRecord;
  lexicalScore: number;
  semanticSimilarity: number;
  rrfScore: number;
  combinedScore: number;
  rank: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  evidenceSufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT';
  suggestedTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
}

export type QueryCategory =
  | 'EXACT_QUESTION'
  | 'NATURAL_PARAPHRASE'
  | 'CONVERSATIONAL_FOLLOW_UP'
  | 'YES_NO_QUESTION'
  | 'AMBIGUOUS'
  | 'OUT_OF_SCOPE'
  | 'SIMILAR_KEYWORDS_DIFFERENT_INTENT'
  | 'MULTI_FAQ_EVIDENCE'
  | 'ADVERSARIAL_TRAP';

export interface EvalQueryItem {
  id: string;
  query: string;
  category: QueryCategory;
  expectedFaqId: number | null; // null if out-of-scope or unanswerable
  expectedSufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT';
  expectedTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
  contextHistory?: Array<{
    role: 'user' | 'assistant';
    text: string;
    faqIds?: number[];
  }>;
  notes: string;
}

export interface MethodBenchmarkResult {
  methodName: string;
  faqCount: number;
  totalQueries: number;
  recallAt1: number;
  recallAt3: number;
  precisionAt1: number;
  falsePositiveRate: number;
  incorrectRoutingRate: number;
  fallbackAccuracy: number;
  coldLatencyMs: number;
  warmAvgLatencyMs: number;
  retrievalLatencyMs: number;
  embeddingLatencyMs?: number;
  costPer1kQueriesUsd: number;
}
