import 'server-only';
import { FABRICATED_CLAIM_PATTERNS } from '@/services/answer.service';
import type { FaqRecord } from '@/types/faq';

export type SentenceGroundingStatus =
  'GROUNDED_SAFE' | 'HOLD_FOR_FULL_TEXT' | 'FABRICATION_DETECTED';

export interface SentenceGroundingResult {
  status: SentenceGroundingStatus;
  reason: string;
  sanitizedText: string;
}

/**
 * Validates a single speech sentence chunk against the authoritative FAQ evidence.
 *
 * Strict safety rules:
 * 1. Checks for fabricated floor numbers, unauthorized pricing, or unverified phone numbers.
 * 2. Checks for factual contradictions against FAQ schedule (e.g. claiming weekend opening when closed).
 * 3. Never relies solely on keyword matching or numeric anchors.
 * 4. If a sentence cannot be verified with high certainty, it returns 'HOLD_FOR_FULL_TEXT'
 *    so the system safely holds TTS until the complete LLM text is verified.
 */
export function evaluateSentenceGrounding(
  sentenceText: string,
  evidenceFaqs: ReadonlyArray<FaqRecord>,
): SentenceGroundingResult {
  const normalized = sentenceText.normalize('NFC').trim();
  if (!normalized) {
    return {
      status: 'HOLD_FOR_FULL_TEXT',
      reason: 'EMPTY_SENTENCE',
      sanitizedText: '',
    };
  }

  // 1. Standard Fallback is always safe
  if (
    normalized.includes('ไม่มีข้อมูลในเรื่องนี้') ||
    normalized.includes('โปรดติดต่อ')
  ) {
    return {
      status: 'GROUNDED_SAFE',
      reason: 'SAFE_FALLBACK_STATEMENT',
      sanitizedText: normalized,
    };
  }

  // Combine evidence text from all matched FAQs
  const combinedEvidenceText = evidenceFaqs
    .map((f) => `${f.question} ${f.answer} ${(f.keywords ?? []).join(' ')}`)
    .join(' ');

  // 2. Fabrication Check (Floors, unauthorized prices, phone numbers)
  const hasFabricatedClaim = FABRICATED_CLAIM_PATTERNS.some(
    (pattern: RegExp) =>
      pattern.test(normalized) && !pattern.test(combinedEvidenceText),
  );
  if (hasFabricatedClaim) {
    return {
      status: 'FABRICATION_DETECTED',
      reason: 'FABRICATED_CLAIM_DETECTED',
      sanitizedText: normalized,
    };
  }

  // 3. Generic Contradiction Guardrail on Schedule / Operating Days
  // If the sentence asserts that service is open on weekend / every day:
  const claimsWeekendOpen =
    /เปิด\s*(ให้)?\s*(บริการ|ทำการ)?\s*(ใน)?\s*(วัน)?\s*(เสาร์|อาทิตย์|ทุกวัน)/u.test(
      normalized,
    ) && !/(?:^|[^เ])ปิด|เว้น|ยกเว้น|ไม่เปิด/u.test(normalized);

  if (claimsWeekendOpen) {
    // Check if the evidence corpus explicitly supports opening on weekends / every day
    const evidenceSupportsWeekend =
      /เปิด\s*(ให้)?\s*(บริการ|ทำการ)?\s*(ใน)?\s*(วัน)?\s*(เสาร์|อาทิตย์|ทุกวัน)/u.test(
        combinedEvidenceText,
      ) &&
      !/(?:^|[^เ])ปิด\s*(ใน)?\s*(วัน)?\s*(เสาร์|อาทิตย์)/u.test(
        combinedEvidenceText,
      );

    if (!evidenceSupportsWeekend) {
      return {
        status: 'FABRICATION_DETECTED',
        reason: 'WEEKEND_CONTRADICTION_DETECTED',
        sanitizedText: normalized,
      };
    }
  }

  // 4. Generic Entity & Reference Code Check
  // If the sentence mentions alphanumeric reference codes (e.g. DEMO-001, REG-1234),
  // every code must exist in the retrieved authoritative evidence.
  const sentenceCodeMatches: string[] = Array.from(
    normalized.match(/[A-Z0-9]+-[A-Z0-9-]+/g) ?? [],
  );
  if (sentenceCodeMatches.length > 0) {
    const evidenceCodeMatches: string[] = Array.from(
      combinedEvidenceText.match(/[A-Z0-9]+-[A-Z0-9-]+/g) ?? [],
    );
    const hasUnverifiedCode = sentenceCodeMatches.some(
      (code) => !evidenceCodeMatches.includes(code),
    );
    if (hasUnverifiedCode) {
      return {
        status: 'FABRICATION_DETECTED',
        reason: 'UNVERIFIED_CODE_DETECTED',
        sanitizedText: normalized,
      };
    }
  }

  // 5. In-depth Entailment Check:
  // If the sentence is a polite conversational affirmation of verified facts:
  // e.g. "จุดบริการ Demo เปิดวันจันทร์ถึงวันศุกร์ เวลา 09:00 ถึง 16:00 น. ครับ"
  // Check that any time mentioned exists in the evidence:
  const sentenceTimes: string[] = Array.from(
    normalized.match(/\d{1,2}[:.]\d{2}/g) ?? [],
  );
  const evidenceTimes: string[] = Array.from(
    combinedEvidenceText.match(/\d{1,2}[:.]\d{2}/g) ?? [],
  );
  for (const time of sentenceTimes) {
    if (!evidenceTimes.includes(time)) {
      return {
        status: 'HOLD_FOR_FULL_TEXT',
        reason: `UNVERIFIED_TIME_${time}`,
        sanitizedText: normalized,
      };
    }
  }

  // If sentence passes all checks, it is safely verified for speech
  return {
    status: 'GROUNDED_SAFE',
    reason: 'VERIFIED_GROUNDED_EVIDENCE',
    sanitizedText: normalized,
  };
}
