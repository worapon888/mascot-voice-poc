import 'server-only';
import { getActiveFaqs } from '@/repositories/faq.repository';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

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
]);

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
];

/**
 * Supplemental domain phrase aliases mapped to canonical FAQ questions.
 * Complements the primary `keywords` array stored in Supabase `public.faqs`.
 */
const SUPPLEMENTAL_ALIASES_BY_QUESTION: Record<string, string[]> = {
  เปิดบริการกี่โมง: [
    'เปิดวันไหน',
    'เปิดวันอะไร',
    'ปิดกี่โมง',
    'ปิดบริการ',
    'ปิดบริการกี่โมง',
    'ปิดทำการ',
    'ปิดทำการกี่โมง',
    'สำนักงานปิดกี่โมง',
    'เวลาเปิด',
    'เวลาปิด',
    'เปิดทำการ',
    'เปิดทำการกี่โมง',
    'เปิดถึงกี่โมง',
    'กี่โมงถึงกี่โมง',
    'วันเวลาทำการ',
    'เสาร์อาทิตย์เปิดไหม',
    'วันเสาร์เปิดไหม',
    'วันอาทิตย์เปิดไหม',
    'เปิดวันเสาร์ไหม',
    'เปิดวันอาทิตย์ไหม',
  ],
  ต้องจองคิวไหม: [
    'จองล่วงหน้า',
    'คิวนัด',
    'รับคิว',
    'ต้องจองไหม',
    'นัดคิว',
    'ต้องนัดไหม',
    'วอล์คอิน',
    'walk in',
    'เข้าไปได้เลยไหม',
    'มาได้เลยไหม',
  ],
  เตรียมเอกสารอะไร: [
    'ใช้เอกสารอะไร',
    'ต้องเตรียมอะไร',
    'หลักฐานอะไร',
    'พกอะไรไปบ้าง',
    'นำอะไรไปบ้าง',
    'เอกสารอะไรบ้าง',
    'ต้องใช้บัตรประชาชนไหม',
  ],
  ทดลองผ่านมือถือได้ไหม: [
    'สมาร์ทโฟน',
    'โทรศัพท์มือถือ',
    'ใช้ในมือถือ',
    'เปิดในมือถือ',
    'รองรับมือถือ',
    'ใช้มือถือได้ไหม',
    'เข้าผ่านมือถือ',
    'เบราว์เซอร์อะไร',
  ],
  ติดต่อใครเมื่อไม่มีคำตอบ: [
    'ติดต่อใคร',
    'ติดต่อเจ้าหน้าที่',
    'ผู้ดูแล',
    'สอบถามเพิ่มเติม',
    'ถามใครได้',
    'ติดต่อได้ที่ไหน',
  ],
};

export interface ScoredFaqMatch {
  faq: FaqRecord;
  score: number;
  matchedTerms: string[];
}

export type FastPathMatchReason =
  'EXACT_QUESTION' | 'APPROVED_INTENT_ALIAS' | 'NONE';

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
}

/**
 * Out-of-scope or organization-specific topics that do not exist in the demo FAQ table.
 * Any query containing these terms must NEVER bypass the LLM via Fast Path.
 */
const OUT_OF_SCOPE_FAST_PATH_PATTERNS: readonly RegExp[] = [
  /ห้องน้ำ/u,
  /ส้วม/u,
  /สุขา/u,
  /ที่จอดรถ/u,
  /จอดรถ/u,
  /สูบบุหรี่/u,
  /บุหรี่/u,
  /ชั้น\s*[0-9๑-๙]+/u,
  /ชั้นไหน/u,
  /ชั้นอะไร/u,
  /อยู่ชั้น/u,
  /ราคา/u,
  /ค่าเช่า/u,
  /ค่าธรรมเนียม/u,
  /ค่าบริการ/u,
  /ค่าใช้จ่าย/u,
  /กี่บาท/u,
  /เสียเงิน/u,
  /ฟรีไหม/u,
  /ฟรีหรือเปล่า/u,
  /อากาศ/u,
  /พยากรณ์/u,
  /ฝนตก/u,
  /เพิกเฉย/u,
  /คำสั่งเดิม/u,
  /ลืม/u,
  /ทำหาย/u,
  /ชาร์จ/u,
  /แบต/u,
  /ไวไฟ/u,
  /wifi/iu,
  /รหัสผ่าน/u,
  /ไปรษณีย์/u,
  /คนไหน/u,
  /ชื่ออะไร/u,
  /เบอร์โทร/u,
  /เบอร์ติดต่อ/u,
  /แผนที่/u,
  /เดินทางยังไง/u,
];

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
 * Angles on opening hours (e.g. closing time or weekend availability) where LLM phrasing
 * directly answers the specific sub-question better than the raw canonical string.
 */
const REVERSE_OR_SPECIFIC_TIME_ANGLE_PATTERNS: readonly RegExp[] = [
  /(?<!เ)ปิดกี่โมง/u,
  /(?<!เ)ปิดบริการ/u,
  /(?<!เ)ปิดทำการ/u,
  /เวลาปิด/u,
  /เปิดถึงกี่โมง/u,
  /เสาร์/u,
  /อาทิตย์/u,
  /วันหยุด/u,
  /พักเที่ยง/u,
];

/**
 * Approved high-confidence phrase aliases per canonical FAQ question that are safe
 * for direct canonical answer return when no disqualifier is present.
 * Generic single-word keywords (e.g. "มือถือ", "ติดต่อ", "เจ้าหน้าที่", "เอกสาร") are intentionally excluded.
 */
const APPROVED_FAST_PATH_PHRASES_BY_QUESTION: Record<
  string,
  readonly string[]
> = {
  เปิดบริการกี่โมง: [
    'เปิดบริการกี่โมง',
    'เปิดกี่โมง',
    'สำนักงานเปิดกี่โมง',
    'เปิดทำการกี่โมง',
    'เวลาทำการ',
    'วันเวลาทำการ',
    'เวลาเปิดบริการ',
    'เวลาเปิดทำการ',
    'เปิดให้บริการกี่โมง',
  ],
  ต้องจองคิวไหม: [
    'ต้องจองคิวไหม',
    'ต้องจองคิวล่วงหน้าไหม',
    'ต้องนัดล่วงหน้า',
    'ต้องนัดหมายล่วงหน้า',
    'ต้องจองล่วงหน้า',
    'ต้องจองไหม',
    'ต้องนัดไหม',
    'ต้องนัดคิวไหม',
    'จองคิวยังไง',
    'นัดหมายล่วงหน้า',
  ],
  เตรียมเอกสารอะไร: [
    'เตรียมเอกสารอะไร',
    'เตรียมเอกสารอะไรบ้าง',
    'ต้องเตรียมเอกสารอะไร',
    'ต้องเตรียมเอกสารอะไรบ้าง',
    'ใช้เอกสารอะไร',
    'ใช้เอกสารอะไรบ้าง',
    'ต้องใช้เอกสารอะไร',
    'ต้องเอาอะไรไปบ้าง',
    'เอาอะไรไปบ้าง',
    'พกอะไรไปบ้าง',
    'นำอะไรไปบ้าง',
  ],
  ทดลองผ่านมือถือได้ไหม: [
    'ทดลองผ่านมือถือได้ไหม',
    'ใช้มือถือได้ไหม',
    'ใช้ในมือถือได้ไหม',
    'เปิดในมือถือได้ไหม',
    'รองรับมือถือไหม',
    'เข้าผ่านมือถือได้ไหม',
    'ทดลองในมือถือ',
    'ใช้งานผ่านมือถือ',
    'ใช้เบราว์เซอร์อะไร',
  ],
  ติดต่อใครเมื่อไม่มีคำตอบ: [
    'ติดต่อใครเมื่อไม่มีคำตอบ',
    'ถ้าไม่มีคำตอบติดต่อใคร',
    'สอบถามเพิ่มเติมได้ที่ไหน',
    'สอบถามข้อมูลเพิ่มเติมได้ที่ใคร',
    'ติดต่อผู้ดูแลการสาธิต',
    'ติดต่อเจ้าหน้าที่ประชาสัมพันธ์',
  ],
};

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

  // 1. Exact question match (full or core stem)
  if (
    politeStrippedQuery === faqQuestionNorm ||
    (faqQuestionCore.length >= 4 && queryCore === faqQuestionCore)
  ) {
    score += 120;
    matchedTerms.push(`exact:${faq.question}`);
  } else if (
    politeStrippedQuery.includes(faqQuestionNorm) ||
    (faqQuestionCore.length >= 6 &&
      politeStrippedQuery.includes(faqQuestionCore))
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

  for (const kw of sortedKeywords) {
    if (politeStrippedQuery.includes(kw) || queryCore.includes(kw)) {
      // Longer, specific phrases receive significantly higher weight
      const kwScore = 30 + kw.length * 4;
      score += kwScore;
      matchedTerms.push(`kw:${kw}`);
    }
  }

  // 4. Supplemental alias/synonym phrase matching
  const supplementalAliases =
    SUPPLEMENTAL_ALIASES_BY_QUESTION[faq.question] ?? [];
  for (const rawAlias of supplementalAliases) {
    const alias = normalizeThaiText(rawAlias);
    if (
      alias.length >= 3 &&
      !GENERIC_STANDALONE_WORDS.has(alias) &&
      (politeStrippedQuery.includes(alias) || queryCore.includes(alias))
    ) {
      score += 25 + alias.length * 3;
      matchedTerms.push(`alias:${alias}`);
    }
  }

  return { faq, score, matchedTerms };
}

/**
 * Evaluates whether a single matched FAQ qualifies for the Safe High-Confidence Fast Path
 * (returning the canonical FAQ answer directly without invoking the LLM).
 *
 * Rules:
 * 1. Never decides by numeric score threshold alone.
 * 2. Requires a single unambiguous matched FAQ (`selected.length === 1 && !ambiguous`).
 * 3. Rejects queries containing out-of-scope signals, negation/troubleshooting conditions,
 *    multi-intent connectors, or reverse/weekend time angles.
 * 4. Requires either an exact canonical question match OR an approved intent phrase alias.
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
    OUT_OF_SCOPE_FAST_PATH_PATTERNS.some((pattern) =>
      pattern.test(normalizedTranscript),
    )
  ) {
    return {
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'OUT_OF_SCOPE_SIGNAL',
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
  const primaryFaq = primaryMatch.faq;

  if (
    primaryFaq.question === 'เปิดบริการกี่โมง' &&
    REVERSE_OR_SPECIFIC_TIME_ANGLE_PATTERNS.some((pattern) =>
      pattern.test(normalizedTranscript),
    )
  ) {
    return {
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'REVERSE_OR_SPECIFIC_TIME_ANGLE',
    };
  }

  // Check 1: Exact question match
  const hasExactMatch = primaryMatch.matchedTerms.some((term) =>
    term.startsWith('exact:'),
  );
  if (hasExactMatch) {
    return {
      highConfidenceFastPath: true,
      fastPathMatchReason: 'EXACT_QUESTION',
    };
  }

  // Check 2: Approved intent phrase alias match
  const approvedPhrases =
    APPROVED_FAST_PATH_PHRASES_BY_QUESTION[primaryFaq.question] ?? [];
  const matchesApprovedPhrase = approvedPhrases.some((rawPhrase) => {
    const normPhrase = stripTrailingPoliteParticles(
      normalizeThaiText(rawPhrase),
    );
    const corePhrase = extractQuestionCore(normPhrase);
    return (
      (normPhrase.length >= 4 && politeStripped.includes(normPhrase)) ||
      (corePhrase.length >= 4 &&
        (politeStripped.includes(corePhrase) || coreQuery.includes(corePhrase)))
    );
  });

  if (matchesApprovedPhrase) {
    return {
      highConfidenceFastPath: true,
      fastPathMatchReason: 'APPROVED_INTENT_ALIAS',
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
    return primary;
  }

  const normalized = primary.normalizedTranscript;
  const isOutOfScope = OUT_OF_SCOPE_FAST_PATH_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  if (isOutOfScope) {
    return primary;
  }

  const isFollowUp = hasContextualFollowUpSignal(rawTranscript);

  // Preserve Self-Contained High-Confidence Fast Path (0 LLM cost)
  if (primary.highConfidenceFastPath && !isFollowUp) {
    return primary;
  }

  if (!isFollowUp) {
    return primary;
  }

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

  if (referencedFaqIds.length === 0) {
    return primary;
  }

  const faqById = new Map<number, FaqRecord>(
    activeFaqs.map((faq) => [faq.id, faq]),
  );

  const combinedFaqs: FaqRecord[] = [];
  const combinedScores: ScoredFaqMatch[] = [];
  const includedIds = new Set<number>();

  for (const scoredItem of primary.scoredMatches) {
    if (
      !includedIds.has(scoredItem.faq.id) &&
      combinedFaqs.length < MAX_MATCHED_FAQS
    ) {
      includedIds.add(scoredItem.faq.id);
      combinedFaqs.push(scoredItem.faq);
      combinedScores.push(scoredItem);
    }
  }

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
  const t0 = performance.now();
  // Query live active FAQs from Supabase (throws FaqRepositoryError on DB failure)
  const activeFaqs = await getActiveFaqs();
  const retrievalLatencyMs = Math.round(performance.now() - t0);

  return matchFaqsWithConversationContext(
    rawTranscript,
    activeFaqs,
    conversationHistory,
    retrievalLatencyMs,
  );
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
