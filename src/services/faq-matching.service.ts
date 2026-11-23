import 'server-only';
import { getFaqMatcherMode } from '@/lib/validations/env';
import {
  getActiveFaqs,
  searchActiveFaqsLexically,
} from '@/repositories/faq.repository';
import { executeHybridFaqRetrieval } from '@/services/hybrid-faq-retrieval.service';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';
import type {
  AnswerSuitability,
  IntentCoverage,
} from '@/services/answer-suitability.service';

export const MAX_MATCHED_FAQS = 3;
const MIN_MATCH_SCORE = 35;

/**
 * Generic standalone words that must never trigger a strong FAQ match on their own.
 */
const GENERIC_STANDALONE_WORDS = new Set([
  'อะไร',
  'ข้อมูล',
  'บริการ',
  'ทดลอง',
  'สาธิต',
  'ระบบ',
  'ต้อง',
  'ไหม',
  'หรือเปล่า',
  'ที่ไหน',
  'อย่างไร',
  'ยังไง',
  'เท่าไร',
  'ได้ไหม',
  'ไป',
  'ใช้',
  'ขอ',
  'ถาม',
  'สอบถาม',
  'บ้าง',
]);

const thaiWordSegmenter = new Intl.Segmenter('th', { granularity: 'word' });

/**
 * Safe trailing Thai polite particles that can be stripped without altering question meaning.
 */
const TRAILING_POLITE_PARTICLES = [
  'หน่อยนะครับ',
  'หน่อยนะคะ',
  'ด้วยนะครับ',
  'ด้วยนะคะ',
  'หน่อยครับ',
  'หน่อยค่ะ',
  'หน่อยคะ',
  'ด้วยครับ',
  'ด้วยค่ะ',
  'ด้วยคะ',
  'นะครับ',
  'นะคะ',
  'ครับผม',
  'ครับ',
  'ค่ะ',
  'คะ',
  'จ้ะ',
  'จ๊ะ',
  'จ๋า',
  'ฮะ',
  'บ้างล่ะครับ',
  'บ้างล่ะค่ะ',
  'บ้างล่ะคะ',
  'บ้างล่ะ',
  'บ้างครับ',
  'บ้างค่ะ',
  'บ้างคะ',
  'ล่ะครับ',
  'ล่ะค่ะ',
  'ล่ะคะ',
  'ล่ะ',
  'ละครับ',
  'ละค่ะ',
  'ละ',
  'นะ',
  'น่ะ',
];

/**
 * Trailing question markers stripped only for core question equivalence comparisons.
 */
const TRAILING_QUESTION_MARKERS = [
  'หรือเปล่า',
  'รึเปล่า',
  'หรือไม่',
  'ใช่ไหม',
  'ใช่มั้ย',
  'ได้ไหม',
  'ได้มั้ย',
  'ไหม',
  'มั้ย',
  'หรือยัง',
  'รึยัง',
  'บ้าง',
  'คืออะไร',
  'อะไรบ้าง',
  'มีอะไรบ้าง',
];

/**
 * Common spoken Thai conversational discourse prefixes stripped before semantic comparison.
 */
export const LEADING_CONVERSATIONAL_PREFIXES = [
  'รบกวนสอบถามหน่อยว่า',
  'รบกวนสอบถามว่า',
  'รบกวนถามหน่อยว่า',
  'รบกวนถามว่า',
  'อยากสอบถามว่า',
  'อยากทราบว่า',
  'อยากรู้ว่า',
  'ไม่ทราบว่า',
  'สอบถามว่า',
  'ถามหน่อยว่า',
  'ถามว่า',
  'แล้วมัน',
  'แล้วถ้า',
  'แล้วก็',
  'แล้ว',
  'งั้นก็',
  'งั้น',
  'เอ่อ',
  'อ้าว',
] as const;

/**
 * Locative and demonstrative discourse fillers indicating "at this venue/service point/branch".
 * Stripped during semantic normalization so queries like "วันเสาร์ที่นี่เปิดหรือเปล่า"
 * or "ที่นี่เปิดกี่โมง" resolve to "วันเสาร์เปิดหรือเปล่า" and "เปิดกี่โมง" without altering intent.
 */
const LOCATIVE_DEMONSTRATIVE_PATTERNS: readonly RegExp[] = [
  /ที่จุดบริการนี้/gu,
  /จุดบริการนี้/gu,
  /ที่เคาน์เตอร์นี้/gu,
  /เคาน์เตอร์นี้/gu,
  /ที่สาขานี้/gu,
  /สาขานี้/gu,
  /ที่แห่งนี้/gu,
  /แห่งนี้/gu,
  /ที่นี่/gu,
  /ตรงนี้/gu,
  /จุดนี้/gu,
];

/**
 * Removes locative demonstrative fillers (e.g. "ที่นี่", "สาขานี้", "จุดบริการนี้").
 */
export function stripLocativeDemonstratives(text: string): string {
  let result = text;
  for (const pattern of LOCATIVE_DEMONSTRATIVE_PATTERNS) {
    result = result.replace(pattern, ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Removes safe spoken discourse prefixes (conversational starters) while keeping the question intact.
 */
export function stripLeadingConversationalPrefixes(text: string): string {
  let result = text.trim();
  let changed = true;

  while (changed && result.length > 0) {
    changed = false;
    for (const prefix of LEADING_CONVERSATIONAL_PREFIXES) {
      if (result.startsWith(prefix) && result.length > prefix.length) {
        result = result.slice(prefix.length).trim();
        changed = true;
        break;
      }
    }
  }

  return result;
}

export interface ScoredFaqMatch {
  faq: FaqRecord;
  score: number;
  matchedTerms: string[];
}

export type FastPathMatchReason =
  'EXACT_QUESTION' | 'SUITABLE_PARAPHRASE' | 'NONE';

export type FastPathDisqualifier =
  | 'NO_MATCH'
  | 'MULTIPLE_MATCHED_FAQS'
  | 'AMBIGUOUS_SCORE'
  | 'OUT_OF_SCOPE_SIGNAL'
  | 'NEGATION_OR_CONDITION_SIGNAL'
  | 'MULTI_INTENT_SIGNAL'
  | 'REVERSE_OR_SPECIFIC_TIME_ANGLE'
  | 'CONTEXTUAL_FOLLOW_UP'
  | 'WEAK_KEYWORD_ONLY';

export interface FaqRetrievalMetrics {
  dbQueries: number;
  faqCacheHit: boolean;
  embeddingCalled: boolean;
  embeddingCacheHit: boolean;
  embeddingMs: number;
  rpcMs: number;
}

export interface FaqRetrievalResult {
  normalizedTranscript: string;
  coreQuery: string;
  matched: boolean;
  ambiguous: boolean;
  faqs: FaqRecord[];
  scoredMatches: ScoredFaqMatch[];
  highConfidenceFastPath: boolean;
  fastPathMatchReason: FastPathMatchReason;
  fastPathDisqualifier?: FastPathDisqualifier;
  retrievalLatencyMs: number;
  answerSuitability?: AnswerSuitability;
  intentCoverage?: IntentCoverage;
  suitabilityReasons?: string[];
  suitabilityCheckDurationMs?: number;
  retrievalMetrics?: FaqRetrievalMetrics;
}

/**
 * Negation, conditional problem statements, or troubleshooting cues that require LLM reasoning
 * rather than returning a static canonical FAQ answer.
 */
const NEGATION_OR_COMPLEX_CONDITION_PATTERNS: readonly RegExp[] = [
  /ไม่ได้/u,
  /ไม่ติด/u,
  /ไม่สำเร็จ/u,
  /ไม่ผ่าน/u,
  /ไม่มีเอกสาร/u,
  /ไม่มีบัตร/u,
  /ไม่ได้จอง/u,
  /ไม่ได้นัด/u,
  /ไม่ว่าง/u,
  /เสีย/u,
  /พัง/u,
  /ล่ม/u,
  /ขัดข้อง/u,
  /มีปัญหา/u,
  /ทำไม/u,
  /ยกเว้น/u,
];

/**
 * Conjunctions or multi-part question connectors that signal multiple intents in a single utterance.
 */
const MULTI_INTENT_CONNECTOR_PATTERNS: readonly RegExp[] = [
  /แล้วก็/u,
  /และต้อง/u,
  /กับต้อง/u,
  /พร้อมกับ/u,
  /นอกจากนี้/u,
  /อีกเรื่อง/u,
  /อีกคำถาม/u,
];

/**
 * Applies Unicode NFC normalization, Thai SARA AM normalization, punctuation removal,
 * and whitespace normalization while preserving Thai tone marks and negation.
 */
export function normalizeThaiText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\u0E4D\u0E32/g, '\u0E33') // Normalize decomposed SARA AM
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove zero-width characters
    .toLowerCase()
    .replace(/[?!.,;:"'“”‘’()[\]{}/\\|~`@#$%^&*+=<>—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Removes safe trailing Thai polite particles while keeping internal words intact.
 */
export function stripTrailingPoliteParticles(normalizedText: string): string {
  let result = normalizedText.trim();
  let changed = true;

  while (changed && result.length > 0) {
    changed = false;
    for (const particle of TRAILING_POLITE_PARTICLES) {
      if (result.endsWith(particle) && result.length > particle.length) {
        result = result.slice(0, -particle.length).trim();
        changed = true;
        break;
      }
    }
  }

  return result;
}

/**
 * Strips trailing question markers to compare the core semantic stem of a question.
 */
export function extractQuestionCore(politeStrippedText: string): string {
  let result = politeStrippedText.trim();
  for (const marker of TRAILING_QUESTION_MARKERS) {
    if (result.endsWith(marker) && result.length > marker.length) {
      result = result.slice(0, -marker.length).trim();
      break;
    }
  }
  return result;
}

/**
 * Deterministically scores a single FAQ record against the normalized user query.
 * Prefers exact matches and longer, specific phrases over shorter keywords.
 */
export function scoreFaqRecord(
  politeStrippedQuery: string,
  queryCore: string,
  faq: FaqRecord,
): ScoredFaqMatch {
  const faqQuestionNorm = stripTrailingPoliteParticles(
    normalizeThaiText(faq.question),
  );
  const faqQuestionCore = extractQuestionCore(faqQuestionNorm);
  let score = 0;
  const matchedTerms: string[] = [];

  if (
    !politeStrippedQuery ||
    GENERIC_STANDALONE_WORDS.has(politeStrippedQuery)
  ) {
    return { faq, score: 0, matchedTerms };
  }

  // Explicitly unsupported sub-intents (e.g. overtime work, special privileges)
  // must never falsely match regular FAQ schedules or contact points.
  if (/ล่วงเวลา|ทำงานล่วงเวลา|โอที|นอกเวลาทำการ/u.test(politeStrippedQuery)) {
    return { faq, score: 0, matchedTerms };
  }
  if (/บริการพิเศษ|สิทธิพิเศษ/u.test(politeStrippedQuery)) {
    return { faq, score: 0, matchedTerms };
  }

  const conversationalStripped =
    stripLeadingConversationalPrefixes(politeStrippedQuery);
  const locativeStripped = stripLocativeDemonstratives(conversationalStripped);
  const conversationalClean = locativeStripped
    .replace(/\s*(?:ล่ะ|ละ)\s*/g, ' ')
    .trim();
  const conversationalCore = extractQuestionCore(conversationalClean);

  const locativeStrippedQuery =
    stripLocativeDemonstratives(politeStrippedQuery);
  const locativeStrippedCore = extractQuestionCore(locativeStrippedQuery);

  const spacelessPolite = politeStrippedQuery.replace(/\s+/g, '');
  const spacelessQueryCore = queryCore.replace(/\s+/g, '');
  const spacelessLocativeQuery = locativeStrippedQuery.replace(/\s+/g, '');
  const spacelessLocativeCore = locativeStrippedCore.replace(/\s+/g, '');
  const spacelessConversational = conversationalClean.replace(/\s+/g, '');
  const spacelessConversationalCore = conversationalCore.replace(/\s+/g, '');

  const spacelessFaqNorm = faqQuestionNorm.replace(/\s+/g, '');
  const spacelessFaqCore = faqQuestionCore.replace(/\s+/g, '');

  // 1. Exact question match (full or core stem, with or without conversational prefix)
  if (
    politeStrippedQuery === faqQuestionNorm ||
    conversationalClean === faqQuestionNorm ||
    locativeStrippedQuery === faqQuestionNorm ||
    spacelessPolite === spacelessFaqNorm ||
    spacelessLocativeQuery === spacelessFaqNorm ||
    spacelessConversational === spacelessFaqNorm ||
    (faqQuestionCore.length >= 4 &&
      (queryCore === faqQuestionCore ||
        conversationalCore === faqQuestionCore ||
        locativeStrippedCore === faqQuestionCore ||
        spacelessQueryCore === spacelessFaqCore ||
        spacelessLocativeCore === spacelessFaqCore ||
        spacelessConversationalCore === spacelessFaqCore))
  ) {
    score += 120;
    matchedTerms.push(`exact:${faq.question}`);
  } else if (
    politeStrippedQuery.includes(faqQuestionNorm) ||
    conversationalClean.includes(faqQuestionNorm) ||
    locativeStrippedQuery.includes(faqQuestionNorm) ||
    spacelessPolite.includes(spacelessFaqNorm) ||
    spacelessLocativeQuery.includes(spacelessFaqNorm) ||
    spacelessConversational.includes(spacelessFaqNorm) ||
    (faqQuestionCore.length >= 6 &&
      (politeStrippedQuery.includes(faqQuestionCore) ||
        conversationalClean.includes(faqQuestionCore) ||
        locativeStrippedQuery.includes(faqQuestionCore) ||
        spacelessPolite.includes(spacelessFaqCore) ||
        spacelessLocativeQuery.includes(spacelessFaqCore) ||
        spacelessConversational.includes(spacelessFaqCore)))
  ) {
    // 2. Full FAQ question phrase contained inside user query
    score += 85 + faqQuestionCore.length * 2;
    matchedTerms.push(`question:${faqQuestionNorm}`);
  }

  // 3. Phrase matching against Supabase `keywords` array (longest first)
  const sortedKeywords = [...(faq.keywords ?? [])]
    .map((kw) => normalizeThaiText(kw))
    .filter((kw) => kw.length >= 2 && !GENERIC_STANDALONE_WORDS.has(kw))
    .sort((a, b) => b.length - a.length);

  let hasFullKeywordMatch = false;

  for (const kw of sortedKeywords) {
    const spacelessKw = kw.replace(/\s+/g, '');
    if (
      politeStrippedQuery.includes(kw) ||
      queryCore.includes(kw) ||
      conversationalClean.includes(kw) ||
      conversationalCore.includes(kw) ||
      locativeStrippedQuery.includes(kw) ||
      locativeStrippedCore.includes(kw) ||
      spacelessPolite.includes(spacelessKw) ||
      spacelessLocativeQuery.includes(spacelessKw) ||
      spacelessConversational.includes(spacelessKw)
    ) {
      // Longer, specific phrases receive significantly higher weight
      const kwScore = 30 + kw.length * 4;
      score += kwScore;
      matchedTerms.push(`kw:${kw}`);
      hasFullKeywordMatch = true;
    }
  }

  // De-duplicated token matching for compound keywords when no full keyword matched (e.g. "เวลาทำการ" -> "ทำการ")
  if (!hasFullKeywordMatch) {
    const matchedTokens = new Set<string>();
    for (const kw of sortedKeywords) {
      const kwTokens = Array.from(thaiWordSegmenter.segment(kw))
        .filter((s) => s.isWordLike)
        .map((s) => s.segment)
        .filter((w) => w.length >= 2 && !GENERIC_STANDALONE_WORDS.has(w));
      for (const kt of kwTokens) {
        if (
          !matchedTokens.has(kt) &&
          (queryCore.includes(kt) ||
            politeStrippedQuery.includes(kt) ||
            conversationalClean.includes(kt))
        ) {
          matchedTokens.add(kt);
          const ktScore = 20 + kt.length * 3;
          score += ktScore;
          matchedTerms.push(`kw_token:${kw}[${kt}]`);
          break;
        }
      }
    }
  }

  // 4. Lexical matching against Supabase `answer` text
  const normAnswer = normalizeThaiText(faq.answer);
  if (normAnswer && politeStrippedQuery.length >= 4) {
    if (
      normAnswer.includes(politeStrippedQuery) ||
      normAnswer.includes(queryCore)
    ) {
      score += 20;
      matchedTerms.push('answer_overlap');
    }
  }

  return { faq, score, matchedTerms };
}

/**
 * Evaluates whether a single matched FAQ qualifies for the Safe High-Confidence Fast Path
 * (returning the canonical FAQ answer directly without invoking the LLM).
 *
 * In generic lexical mode, Fast Path is strictly reserved for unambiguous exact question matches
 * to guarantee 100% precision without hardcoded alias dictionaries.
 */
export function evaluateSafeFastPath(
  normalizedTranscript: string,
  politeStripped: string,
  coreQuery: string,
  allScoredAboveThreshold: ScoredFaqMatch[],
  selected: ScoredFaqMatch[],
  ambiguous: boolean,
): {
  highConfidenceFastPath: boolean;
  fastPathMatchReason: FastPathMatchReason;
  fastPathDisqualifier?: FastPathDisqualifier;
} {
  if (selected.length === 0) {
    return {
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'NO_MATCH',
    };
  }

  if (ambiguous) {
    return {
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'AMBIGUOUS_SCORE',
    };
  }

  if (selected.length > 1 || allScoredAboveThreshold.length > 1) {
    return {
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'MULTIPLE_MATCHED_FAQS',
    };
  }

  if (
    NEGATION_OR_COMPLEX_CONDITION_PATTERNS.some((pattern) =>
      pattern.test(normalizedTranscript),
    )
  ) {
    return {
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'NEGATION_OR_CONDITION_SIGNAL',
    };
  }

  if (
    MULTI_INTENT_CONNECTOR_PATTERNS.some((pattern) =>
      pattern.test(normalizedTranscript),
    )
  ) {
    return {
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'MULTI_INTENT_SIGNAL',
    };
  }

  const primaryMatch = selected[0];

  // Exact question match is the only valid Fast Path in generic lexical mode
  const hasExactMatch = primaryMatch.matchedTerms.some((term) =>
    term.startsWith('exact:'),
  );
  if (hasExactMatch) {
    return {
      highConfidenceFastPath: true,
      fastPathMatchReason: 'EXACT_QUESTION',
    };
  }

  return {
    highConfidenceFastPath: false,
    fastPathMatchReason: 'NONE',
    fastPathDisqualifier: 'WEAK_KEYWORD_ONLY',
  };
}

/**
 * Pure deterministic matcher against a provided list of active FAQs.
 * Useful for both live DB retrieval and deterministic unit testing.
 */
export function matchFaqsAgainstRecords(
  rawTranscript: string,
  activeFaqs: FaqRecord[],
  retrievalLatencyMs = 0,
): FaqRetrievalResult {
  const normalizedTranscript = normalizeThaiText(rawTranscript);
  const politeStripped = stripTrailingPoliteParticles(normalizedTranscript);
  const coreQuery = extractQuestionCore(politeStripped);

  if (
    !politeStripped ||
    GENERIC_STANDALONE_WORDS.has(politeStripped) ||
    GENERIC_STANDALONE_WORDS.has(coreQuery)
  ) {
    return {
      normalizedTranscript,
      coreQuery,
      matched: false,
      ambiguous: false,
      faqs: [],
      scoredMatches: [],
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'NO_MATCH',
      retrievalLatencyMs,
    };
  }

  const scored = activeFaqs
    .map((faq) => scoreFaqRecord(politeStripped, coreQuery, faq))
    .filter((item) => item.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score || a.faq.id - b.faq.id);

  if (scored.length === 0) {
    return {
      normalizedTranscript,
      coreQuery,
      matched: false,
      ambiguous: false,
      faqs: [],
      scoredMatches: [],
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'NO_MATCH',
      retrievalLatencyMs,
    };
  }

  const topScore = scored[0].score;
  // Select up to MAX_MATCHED_FAQS (3) relevant records
  const selected = scored
    .filter((item) => item.score >= Math.max(MIN_MATCH_SCORE, topScore * 0.45))
    .slice(0, MAX_MATCHED_FAQS);

  const ambiguous =
    selected.length > 1 &&
    Math.abs(selected[0].score - selected[1].score) <= 15;

  const fastPathEval = evaluateSafeFastPath(
    normalizedTranscript,
    politeStripped,
    coreQuery,
    scored,
    selected,
    ambiguous,
  );

  return {
    normalizedTranscript,
    coreQuery,
    matched: true,
    ambiguous,
    faqs: selected.map((s) => s.faq),
    scoredMatches: selected,
    highConfidenceFastPath: fastPathEval.highConfidenceFastPath,
    fastPathMatchReason: fastPathEval.fastPathMatchReason,
    fastPathDisqualifier: fastPathEval.fastPathDisqualifier,
    retrievalLatencyMs,
  };
}

/**
 * Ellipsis, anaphora, or follow-up question patterns that depend on the preceding conversation turn
 * (e.g., "แล้ววันเสาร์ล่ะ", "ถ้าไม่มีล่ะ", "เรื่องนี้ติดต่อใคร", "ใช้อะไรแทนได้ไหม").
 */
const CONTEXTUAL_FOLLOW_UP_PATTERNS: readonly RegExp[] = [
  /^(แล้ว|งั้น|อ้าว|เอ่อ)\s*(ถ้า|วัน|ช่วง|ตอน|อัน|เรื่อง|กรณี|แบบ|เวลา)/u,
  /^(แล้ว|งั้น|อ้าว|เอ่อ)\s*(มัน|นี่|นั่น|นี้|นั้น)/u,
  /อันนั้น/u,
  /อันนี้/u,
  /เรื่องนี้/u,
  /เรื่องนั้น/u,
  /กรณีนี้/u,
  /แบบนี้/u,
  /แบบนั้น/u,
  /ถ้าไม่มี/u,
  /ถ้าไม่ครบ/u,
  /ถ้าไม่ได้/u,
  /ใช้อะไรแทน/u,
  /แทนได้ไหม/u,
  /ทำยังไงต่อ/u,
  /ขอรายละเอียดเพิ่ม/u,
  /ขยายความ/u,
  /ล่ะ$/u,
];

/**
 * Returns true when the normalized/polite-stripped transcript contains an ellipsis or
 * follow-up cue that refers back to the previous conversation turn.
 */
export function hasContextualFollowUpSignal(rawTranscript: string): boolean {
  const normalized = normalizeThaiText(rawTranscript);
  const politeStripped = stripTrailingPoliteParticles(normalized);
  if (!politeStripped) {
    return false;
  }
  return CONTEXTUAL_FOLLOW_UP_PATTERNS.some(
    (pattern) => pattern.test(normalized) || pattern.test(politeStripped),
  );
}

/**
 * Resolves FAQ matches with optional multi-turn conversation history (`conversationHistory`).
 *
 * Guarantees:
 * 1. Self-contained queries that match a FAQ with high confidence (`highConfidenceFastPath === true`)
 *    and have no ellipsis/anaphora dependency keep `highConfidenceFastPath: true` so the Safe FAQ Fast Path
 *    and Persistent FAQ Audio (`0 LLM call, 0 TTS call`) are 100% preserved.
 * 2. Contextual follow-up queries (e.g. "เปิดกี่โมง" -> "แล้ววันเสาร์ล่ะ" or "เตรียมเอกสารอะไร" -> "ถ้าไม่มีล่ะ")
 *    inherit the referenced FAQ(s) from recent conversation history as Grounded Candidate Evidence
 *    and route to the Grounded LLM (`highConfidenceFastPath: false`, `fastPathDisqualifier: 'CONTEXTUAL_FOLLOW_UP'`).
 * 3. Out-of-scope queries (e.g. "ห้องน้ำอยู่ชั้นไหน", "ที่จอดรถอยู่ตรงไหน") are never falsely forced onto prior FAQs.
 */
export function matchFaqsWithConversationContext(
  rawTranscript: string,
  activeFaqs: FaqRecord[],
  conversationHistory: ReadonlyArray<ConversationTurn> = [],
  retrievalLatencyMs = 0,
): FaqRetrievalResult {
  const primary = matchFaqsAgainstRecords(
    rawTranscript,
    activeFaqs,
    retrievalLatencyMs,
  );

  if (!conversationHistory || conversationHistory.length === 0) {
    if (
      hasContextualFollowUpSignal(rawTranscript) &&
      !primary.highConfidenceFastPath
    ) {
      return {
        ...primary,
        matched: false,
        ambiguous: false,
        faqs: [],
        scoredMatches: [],
        highConfidenceFastPath: false,
        fastPathMatchReason: 'NONE',
        fastPathDisqualifier: 'CONTEXTUAL_FOLLOW_UP',
      };
    }
    return primary;
  }

  // If the query has no match at all and no follow-up signal, return primary immediately
  if (!primary.matched && !hasContextualFollowUpSignal(rawTranscript)) {
    return primary;
  }

  const isFollowUp = hasContextualFollowUpSignal(rawTranscript);

  // Extract recent referenced FAQ IDs from conversationHistory (most recent turn first)
  const referencedFaqIds: number[] = [];
  const seenIds = new Set<number>();

  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const turn = conversationHistory[i];
    if (turn.faqIds && turn.faqIds.length > 0) {
      for (const id of turn.faqIds) {
        if (!seenIds.has(id)) {
          seenIds.add(id);
          referencedFaqIds.push(id);
        }
      }
    } else if (turn.text) {
      const turnMatch = matchFaqsAgainstRecords(turn.text, activeFaqs, 0);
      for (const faq of turnMatch.faqs) {
        if (!seenIds.has(faq.id)) {
          seenIds.add(faq.id);
          referencedFaqIds.push(faq.id);
        }
      }
    }
  }

  // Preserve Self-Contained High-Confidence Fast Path (0 LLM cost)
  // When the query unambiguously matches an approved phrase on a single FAQ:
  // - If it has no follow-up signal, return primary immediately.
  // - If it has a conversational follow-up signal, preserve Fast Path if the context agrees on the same FAQ
  //   or the query has an approved intent phrase for that specific FAQ.
  if (primary.highConfidenceFastPath && primary.faqs.length === 1) {
    if (!isFollowUp) {
      return primary;
    }

    const primaryId = primary.faqs[0].id;
    const recentFaqId =
      referencedFaqIds.length > 0 ? referencedFaqIds[0] : null;

    if (
      recentFaqId === null ||
      recentFaqId === primaryId ||
      primary.fastPathMatchReason === 'EXACT_QUESTION' ||
      primary.fastPathMatchReason === 'SUITABLE_PARAPHRASE'
    ) {
      return primary;
    }
  }

  if (!isFollowUp) {
    return primary;
  }

  if (referencedFaqIds.length === 0) {
    return primary;
  }

  const faqById = new Map<number, FaqRecord>(
    activeFaqs.map((faq) => [faq.id, faq]),
  );

  const combinedFaqs: FaqRecord[] = [];
  const combinedScores: ScoredFaqMatch[] = [];
  const includedIds = new Set<number>();

  // A true follow-up is anchored to the most recently referenced evidence.
  // Put context first, then add new lexical candidates for disambiguation.
  for (const refId of referencedFaqIds) {
    const faq = faqById.get(refId);
    if (
      faq &&
      !includedIds.has(faq.id) &&
      combinedFaqs.length < MAX_MATCHED_FAQS
    ) {
      includedIds.add(faq.id);
      combinedFaqs.push(faq);
      combinedScores.push({
        faq,
        score: MIN_MATCH_SCORE,
        matchedTerms: [`context:faq#${faq.id}`],
      });
    }
  }

  for (const scoredItem of primary.scoredMatches) {
    const isReferenced = referencedFaqIds.includes(scoredItem.faq.id);
    const isExplicitNewIntent =
      scoredItem.score >= 100 ||
      scoredItem.matchedTerms.some(
        (term) => term.startsWith('exact:') || term.startsWith('question:'),
      );
    if (!isReferenced && !isExplicitNewIntent) {
      continue;
    }
    if (
      !includedIds.has(scoredItem.faq.id) &&
      combinedFaqs.length < MAX_MATCHED_FAQS
    ) {
      includedIds.add(scoredItem.faq.id);
      combinedFaqs.push(scoredItem.faq);
      combinedScores.push(scoredItem);
    }
  }

  if (combinedFaqs.length === 0) {
    return primary;
  }

  return {
    normalizedTranscript: primary.normalizedTranscript,
    coreQuery: primary.coreQuery,
    matched: true,
    ambiguous: primary.ambiguous || combinedFaqs.length > 1,
    faqs: combinedFaqs,
    scoredMatches: combinedScores,
    highConfidenceFastPath: false,
    fastPathMatchReason: 'NONE',
    fastPathDisqualifier: 'CONTEXTUAL_FOLLOW_UP',
    retrievalLatencyMs,
  };
}

/**
 * Retrieves active FAQs live from Supabase and selects up to 3 relevant FAQ records
 * using deterministic Thai normalization, exact matching, keyword/alias scoring,
 * and optional multi-turn conversation context.
 */
export async function retrieveMatchingFaqs(
  rawTranscript: string,
  conversationHistory: ReadonlyArray<ConversationTurn> = [],
): Promise<FaqRetrievalResult> {
  const matcherMode = getFaqMatcherMode();

  // Primary execution for Hybrid Matcher mode
  if (matcherMode === 'hybrid') {
    try {
      return await executeHybridFaqRetrieval(
        rawTranscript,
        conversationHistory,
      );
    } catch (err) {
      console.warn(
        '[FaqMatching] Hybrid retrieval failed, evaluating generic DB lexical search fallback:',
        err instanceof Error ? err.message : err,
      );
      // Fallback policy (Step 3):
      // 1. If DB is accessible, retrieve active FAQs and run generic lexical search
      // 2. If DB is inaccessible (getActiveFaqs throws FaqRepositoryError), let it throw
      //    so the API controller returns 503 instead of treating failure as "no FAQ".
      const t0 = performance.now();
      let activeFaqs: FaqRecord[];
      try {
        const databaseCandidates =
          await searchActiveFaqsLexically(rawTranscript);
        const previewFaqs = await getActiveFaqs();
        const candidatesById = new Map<number, FaqRecord>();
        for (const faq of [...databaseCandidates, ...previewFaqs]) {
          candidatesById.set(faq.id, faq);
        }
        activeFaqs = Array.from(candidatesById.values());
      } catch {
        // Older installations without search_tsv retain the bounded legacy
        // fallback. The primary hybrid RPC and direct exact lookup remain live.
        activeFaqs = await getActiveFaqs();
      }
      const retrievalLatencyMs = Math.round(performance.now() - t0);
      return matchFaqsWithConversationContext(
        rawTranscript,
        activeFaqs,
        conversationHistory,
        retrievalLatencyMs,
      );
    }
  }

  const t0 = performance.now();
  // Query live active FAQs from Supabase (throws FaqRepositoryError on DB failure)
  const activeFaqs = await getActiveFaqs();
  const retrievalLatencyMs = Math.round(performance.now() - t0);

  const legacyResult = matchFaqsWithConversationContext(
    rawTranscript,
    activeFaqs,
    conversationHistory,
    retrievalLatencyMs,
  );

  // Shadow comparison mode: execute hybrid asynchronously in background without blocking response
  if (matcherMode === 'shadow') {
    void executeHybridFaqRetrieval(
      rawTranscript,
      conversationHistory,
      Promise.resolve(activeFaqs),
    )
      .then((hybridResult) => {
        const legacyTop = legacyResult.faqs[0]?.id ?? null;
        const hybridTop = hybridResult.faqs[0]?.id ?? null;
        const agree = legacyTop === hybridTop;
        console.info(
          `[ShadowComparison] Query: "${rawTranscript.slice(0, 40)}" | Agree: ${agree} | Legacy: #${legacyTop} (FP:${legacyResult.highConfidenceFastPath}) | Hybrid: #${hybridTop} (FP:${hybridResult.highConfidenceFastPath}) | Latency: L=${legacyResult.retrievalLatencyMs}ms, H=${hybridResult.retrievalLatencyMs}ms`,
        );
      })
      .catch((shadowErr) => {
        console.warn(
          '[ShadowComparison] Shadow query failed:',
          shadowErr instanceof Error ? shadowErr.message : shadowErr,
        );
      });
  }

  return legacyResult;
}

/**
 * Determines whether a query can be safely and reliably classified as Tier 3
 * (Unknown / Out-of-Scope Fallback) without invoking the LLM:
 * 1. The query has no matched FAQs (`!retrieval.matched || retrieval.faqs.length === 0`).
 * 2. The query does not carry an ellipsis or contextual follow-up signal referencing previous conversation turns.
 */
export function isConfidentOutOfScopeOrUnknownQuery(
  retrieval: FaqRetrievalResult,
  rawTranscript: string,
  conversationHistory: ReadonlyArray<ConversationTurn> = [],
): boolean {
  if (retrieval.matched && retrieval.faqs.length > 0) {
    return false;
  }

  // If there's an ongoing conversation and the user asks a follow-up ("แล้ววันเสาร์ล่ะ", "ถ้าไม่มีล่ะ"),
  // do not cut off with fallback; let Tier 2 handle it with context.
  if (
    conversationHistory.length > 0 &&
    hasContextualFollowUpSignal(rawTranscript)
  ) {
    return false;
  }

  return true;
}
