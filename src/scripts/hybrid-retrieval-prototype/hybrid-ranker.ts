import { hasContextualFollowUpSignal } from '@/services/faq-matching.service';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';
import type {
  LexicalSearchResult,
  SemanticSearchResult,
  HybridSearchResult,
} from './types';

/**
 * Reciprocal Rank Fusion (RRF) parameters.
 * k=60 is standard in information retrieval (Cormack et al., SIGIR 2009).
 */
const RRF_K = 60;
const WEIGHT_LEXICAL = 0.55;
const WEIGHT_SEMANTIC = 0.45;

/**
 * Generic Evidence Sufficiency Evaluator for any FAQ in a 500-600 item corpus.
 * Decouples Topic Relevance from Factual Evidence Sufficiency:
 * - Relevance: Does the query match this FAQ candidate?
 * - Sufficiency: Does the FAQ question/answer/keywords contain the direct factual proof
 *   needed to satisfy the user's specific angle without hallucination?
 * ZERO hardcoded FAQ IDs or answer text.
 */
export function evaluateEvidenceSufficiency(
  query: string,
  topFaq: FaqRecord,
  topSimilarity: number,
  margin = 0,
): {
  sufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT';
  suggestedTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
} {
  // 1. Problem / Troubleshooting / Incident statements ("เปิดไม่ได้", "ลืมของ", "ระบบล่ม", "พัง")
  if (/(ไม่ได้|ไม่ผ่าน|ล่ม|พัง|เสีย|ทำไม|ลืม|ทำตก|หาย)/u.test(query)) {
    return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
  }

  // 2. Counterfactual or hypothetical conditions ("ถ้าไม่มี...", "ถ้าเกิด...")
  if (/(ถ้าไม่มี|หากไม่มี|ถ้าเกิด|สมมติว่า)/u.test(query)) {
    return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
  }

  // 3. Multi-intent conjunctions ("และ...อะไรบ้าง", "รวมทั้ง")
  if (/(และ.*อะไรบ้าง|และ.*ด้วยไหม|รวมทั้ง)/u.test(query)) {
    return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
  }

  // 4. Check whether specific constraints in query are covered in FAQ content
  // If query asks about a specific modifier that is absent from faq question, keywords, and answer
  const faqCorpusText =
    `${topFaq.question} ${(topFaq.keywords ?? []).join(' ')} ${topFaq.answer}`.toLowerCase();
  const specificSubAngles = [
    'พักเที่ยง',
    'พักกลางวัน',
    'หยุดชดเชย',
    'ล่วงเวลา',
    'โอที',
    'พิเศษ',
  ];
  for (const angle of specificSubAngles) {
    if (query.includes(angle) && !faqCorpusText.includes(angle)) {
      return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
    }
  }

  // 5. Sufficient Match:
  // If high similarity OR strong margin with sufficient similarity
  // Note: RRF margins are typically ~0.002 to 0.008, while raw cosine margins are ~0.04 to 0.15
  if (topSimilarity >= 0.7 || (topSimilarity >= 0.35 && margin >= 0.002)) {
    return { sufficiency: 'SUFFICIENT', suggestedTier: 'TIER_1' };
  }

  // 6. Partial Match:
  if (topSimilarity >= 0.28) {
    return { sufficiency: 'PARTIAL', suggestedTier: 'TIER_2' };
  }

  return { sufficiency: 'INSUFFICIENT', suggestedTier: 'TIER_3' };
}

/**
 * Hybrid Ranker using Reciprocal Rank Fusion (RRF) and Margin Calibration.
 */
export class HybridRanker {
  public rank(
    query: string,
    lexicalResults: LexicalSearchResult[],
    semanticResults: SemanticSearchResult[],
    conversationHistory: ReadonlyArray<ConversationTurn> = [],
    topK = 5,
  ): HybridSearchResult[] {
    const combined = new Map<
      number,
      {
        faq: FaqRecord;
        lexicalScore: number;
        semanticSimilarity: number;
        rrfScore: number;
      }
    >();

    // 1. Stage A: Exact / Fast Path Check (0ms bypass)
    // If the top lexical match is an exact question match with overwhelming score, return immediately
    const topLex = lexicalResults[0];

    if (
      topLex &&
      topLex.matchedTerms.includes('exact_question') &&
      topLex.score >= 100
    ) {
      const { sufficiency, suggestedTier } = evaluateEvidenceSufficiency(
        query,
        topLex.faq,
        0.95,
        1.0,
      );
      return [
        {
          faq: topLex.faq,
          lexicalScore: topLex.score,
          semanticSimilarity: 0.99,
          rrfScore: 1.0,
          combinedScore: 1.0,
          rank: 1,
          confidence: 'HIGH',
          evidenceSufficiency: sufficiency,
          suggestedTier,
        },
      ];
    }

    // 2. Stage B: Reciprocal Rank Fusion (RRF)
    for (const item of lexicalResults) {
      const rrf = WEIGHT_LEXICAL / (RRF_K + item.rank);
      combined.set(item.faq.id, {
        faq: item.faq,
        lexicalScore: item.score,
        semanticSimilarity: 0,
        rrfScore: rrf,
      });
    }

    for (const item of semanticResults) {
      const rrf = WEIGHT_SEMANTIC / (RRF_K + item.rank);
      if (combined.has(item.faq.id)) {
        const existing = combined.get(item.faq.id)!;
        existing.semanticSimilarity = item.similarity;
        existing.rrfScore += rrf;
      } else {
        combined.set(item.faq.id, {
          faq: item.faq,
          lexicalScore: 0,
          semanticSimilarity: item.similarity,
          rrfScore: rrf,
        });
      }
    }

    // 3. Stage C: Conversation Context Bias
    // If recent turn referenced a FAQ and user asks a follow-up, apply rank fusion boost
    if (conversationHistory.length > 0 && hasContextualFollowUpSignal(query)) {
      const recentTurn = conversationHistory[conversationHistory.length - 1];
      if (recentTurn.faqIds && recentTurn.faqIds.length > 0) {
        for (const recentId of recentTurn.faqIds) {
          if (combined.has(recentId)) {
            combined.get(recentId)!.rrfScore += 0.015; // Context boost
          }
        }
      }
    }

    // Sort by final fused RRF score
    const sorted = Array.from(combined.values())
      .sort((a, b) => b.rrfScore - a.rrfScore || a.faq.id - b.faq.id)
      .slice(0, topK);

    if (sorted.length === 0) {
      return [];
    }

    const top1 = sorted[0];
    const top2 = sorted[1];
    const margin = top2 ? top1.rrfScore - top2.rrfScore : top1.rrfScore;

    return sorted.map((item, idx) => {
      let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
      if (idx === 0) {
        if (margin >= 0.003 && item.rrfScore >= 0.008) {
          confidence = 'HIGH';
        } else if (item.rrfScore < 0.006) {
          confidence = 'LOW';
        }
      }

      const { sufficiency, suggestedTier } = evaluateEvidenceSufficiency(
        query,
        item.faq,
        item.semanticSimilarity,
        margin,
      );

      return {
        faq: item.faq,
        lexicalScore: item.lexicalScore,
        semanticSimilarity: item.semanticSimilarity,
        rrfScore: Math.round(item.rrfScore * 10000) / 10000,
        combinedScore: Math.round(item.rrfScore * 10000) / 10000,
        rank: idx + 1,
        confidence,
        evidenceSufficiency: sufficiency,
        suggestedTier: confidence === 'LOW' ? 'TIER_3' : suggestedTier,
      };
    });
  }
}
