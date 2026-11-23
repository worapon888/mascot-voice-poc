import 'server-only';
import { performance } from 'node:perf_hooks';

export type AnswerSuitability = 'DIRECT' | 'REQUIRES_SYNTHESIS' | 'UNSUITABLE';

export type IntentCoverageStatus = 'COMPLETE' | 'PARTIAL' | 'NONE';

export interface IntentCoverage {
  status: IntentCoverageStatus;
  requiredIntents: string[];
  supportingFaqIds: number[];
  uncoveredIntents: string[];
}

export interface AnswerSuitabilityEvaluation {
  suitability: AnswerSuitability;
  intentCoverage: IntentCoverage;
  reasons: string[];
  durationMs: number;
}

export interface AnswerSuitabilityInput {
  normalizedQuery: string;
  evidenceSufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT';
  exactQuestionMatch: boolean;
  contextualFollowUp: boolean;
  intentCoverage: IntentCoverage;
}

const BOOLEAN_QUESTION_PATTERN =
  /(?:ไหม|มั้ย|หรือไม่|รึไม่|หรือเปล่า|รึเปล่า|ใช่ไหม|ใช่มั้ย|ได้ไหม|ได้มั้ย|หรือยัง|รึยัง)\s*$/u;

const CONDITIONAL_PATTERN =
  /(?:^|\s)(?:ถ้า|หาก|กรณีที่|สมมติว่า)|^(?:ถ้า|หาก|กรณี|สมมติ)/u;

/**
 * Generic temporal entities that make an utterance more specific than a broad
 * schedule question. This is language-level parsing only; it is not tied to a
 * FAQ ID, answer, organization, or demo fixture.
 */
const SPECIFIC_TEMPORAL_CONSTRAINT_PATTERN =
  /(?:วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์|หยุด|นักขัตฤกษ์)|ช่วง(?:เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ)|ตอน(?:เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ)|(?:เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ)(?:นี้|วัน)?|\d{1,2}(?::|\.)\d{2}|\d{1,2}\s*โมง)/u;

const MULTI_INTENT_CONNECTOR_PATTERN =
  /\s*(?:และ|แล้วก็|รวมทั้ง|พร้อมกับ|นอกจากนี้|อีกเรื่อง|อีกคำถาม)\s*/u;

function normalizeForIntentAnalysis(query: string): string {
  return query
    .normalize('NFC')
    .toLowerCase()
    .replace(/[?!.,;:"'“”‘’()[\]{}/\\|~`@#$%^&*+=<>—–-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits explicit multi-part utterances into independently answerable intents.
 * It intentionally recognizes only language-level conjunctions and does not
 * infer semantic entailment from regexes.
 */
export function extractRequiredIntentSegments(query: string): string[] {
  const normalized = normalizeForIntentAnalysis(query);
  if (!normalized) return [];

  const segments = normalized
    .split(MULTI_INTENT_CONNECTOR_PATTERN)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 3);

  return segments.length > 1 ? segments : [normalized];
}

/**
 * Conservative deterministic suitability gate. It answers whether replaying a
 * canonical approved answer is appropriate, not whether the retrieved FAQ is
 * relevant. Uncertain or compositional cases are routed to grounded Tier 2.
 */
export function evaluateAnswerSuitability(
  input: AnswerSuitabilityInput,
): AnswerSuitabilityEvaluation {
  const startedAt = performance.now();
  const query = normalizeForIntentAnalysis(input.normalizedQuery);
  const reasons: string[] = [];

  let suitability: AnswerSuitability = 'DIRECT';

  if (input.evidenceSufficiency === 'INSUFFICIENT') {
    suitability = 'UNSUITABLE';
    reasons.push('INSUFFICIENT_EVIDENCE');
  } else if (input.exactQuestionMatch) {
    // The approved answer was authored for this exact approved question.
    suitability = 'DIRECT';
    reasons.push('EXACT_APPROVED_QUESTION');
  } else {
    if (input.intentCoverage.requiredIntents.length > 1) {
      suitability = 'REQUIRES_SYNTHESIS';
      reasons.push('MULTI_INTENT');
    }
    if (input.intentCoverage.status !== 'COMPLETE') {
      suitability = 'REQUIRES_SYNTHESIS';
      reasons.push('INCOMPLETE_INTENT_COVERAGE');
    }
    if (input.contextualFollowUp) {
      suitability = 'REQUIRES_SYNTHESIS';
      reasons.push('CONTEXTUAL_FOLLOW_UP');
    }
    if (BOOLEAN_QUESTION_PATTERN.test(query)) {
      suitability = 'REQUIRES_SYNTHESIS';
      reasons.push('BOOLEAN_ANSWER_REQUIRED');
    }
    if (CONDITIONAL_PATTERN.test(query)) {
      suitability = 'REQUIRES_SYNTHESIS';
      reasons.push('CONDITIONAL_REASONING_REQUIRED');
    }
    if (SPECIFIC_TEMPORAL_CONSTRAINT_PATTERN.test(query)) {
      suitability = 'REQUIRES_SYNTHESIS';
      reasons.push('SPECIFIC_TEMPORAL_REASONING_REQUIRED');
    }

    if (input.evidenceSufficiency === 'PARTIAL') {
      suitability = 'REQUIRES_SYNTHESIS';
      reasons.push('PARTIAL_EVIDENCE');
    }

    if (reasons.length === 0) {
      reasons.push('DIRECT_SINGLE_INTENT_PARAPHRASE');
    }
  }

  return {
    suitability,
    intentCoverage: input.intentCoverage,
    reasons: Array.from(new Set(reasons)),
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
  };
}
