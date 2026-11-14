import 'server-only';
import { getActiveFaqs } from '@/repositories/faq.repository';
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

export interface FaqRetrievalResult {
  normalizedTranscript: string;
  coreQuery: string;
  matched: boolean;
  ambiguous: boolean;
  faqs: FaqRecord[];
  scoredMatches: ScoredFaqMatch[];
}

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
 * Retrieves active FAQs from Supabase and selects up to 3 relevant FAQ records
 * using deterministic Thai normalization, exact matching, and keyword/alias scoring.
 */
export async function retrieveMatchingFaqs(
  rawTranscript: string,
): Promise<FaqRetrievalResult> {
  const normalizedTranscript = normalizeThaiText(rawTranscript);
  const politeStripped = stripTrailingPoliteParticles(normalizedTranscript);
  const coreQuery = extractQuestionCore(politeStripped);

  // Query live active FAQs from Supabase (throws FaqRepositoryError on DB failure)
  const activeFaqs = await getActiveFaqs();

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

  return {
    normalizedTranscript,
    coreQuery,
    matched: true,
    ambiguous,
    faqs: selected.map((s) => s.faq),
    scoredMatches: selected,
  };
}
