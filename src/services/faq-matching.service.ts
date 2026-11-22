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

/**
 * Supplemental domain phrase aliases mapped to canonical FAQ questions.
 * Complements the primary `keywords` array stored in Supabase `public.faqs`.
 */
const SUPPLEMENTAL_ALIASES_BY_QUESTION: Record<string, string[]> = {
  เปิดบริการกี่โมง: [
    'เปิดวันไหน',
    'เปิดวันไหนบ้าง',
    'เปิดวันอะไร',
    'เปิดทำการวันไหน',
    'เปิดให้บริการวันไหน',
    'ปิดกี่โมง',
    'ปิดบริการ',
    'ปิดบริการกี่โมง',
    'ปิดทำการ',
    'ปิดทำการกี่โมง',
    'สำนักงานปิดกี่โมง',
    'เวลาเปิด',
    'เวลาปิด',
    'เวลาปิดบริการ',
    'เปิดทำการ',
    'เปิดทำการกี่โมง',
    'เปิดถึงกี่โมง',
    'กี่โมงถึงกี่โมง',
    'เวลาทำการ',
    'วันเวลาทำการ',
    'เวลาเปิดทำการ',
    'เวลาเปิดบริการ',
    'เสาร์อาทิตย์เปิดไหม',
    'วันเสาร์เปิดไหม',
    'วันอาทิตย์เปิดไหม',
    'เปิดวันเสาร์ไหม',
    'เปิดวันอาทิตย์ไหม',
    'วันเสาร์เปิดให้บริการไหม',
    'เสาร์อาทิตย์เปิดให้บริการไหม',
  ],
  ต้องจองคิวไหม: [
    'จองล่วงหน้า',
    'คิวนัด',
    'รับคิว',
    'ต้องจองไหม',
    'นัดคิว',
    'ต้องนัดไหม',
    'ต้องนัดคิวไหม',
    'ต้องนัดหมายไหม',
    'ต้องนัดหมายล่วงหน้า',
    'จองคิวยังไง',
    'นัดหมายล่วงหน้า',
    'วอล์คอิน',
    'วอล์คอินได้ไหม',
    'walk in',
    'walk in ได้ไหม',
    'เข้าไปได้เลยไหม',
    'มาได้เลยไหม',
  ],
  เตรียมเอกสารอะไร: [
    'ใช้เอกสารอะไร',
    'ใช้เอกสารอะไรบ้าง',
    'ต้องเตรียมอะไร',
    'ต้องเตรียมอะไรไปบ้าง',
    'ต้องเตรียมเอกสารอะไร',
    'ต้องเตรียมเอกสารอะไรบ้าง',
    'หลักฐานอะไร',
    'พกอะไรไปบ้าง',
    'นำอะไรไปบ้าง',
    'เอกสารอะไรบ้าง',
    'ต้องใช้เอกสารอะไร',
    'ต้องใช้บัตรประชาชนไหม',
    'ใช้บัตรประชาชนไหม',
    'พกบัตรประชาชนไหม',
  ],
  ทดลองผ่านมือถือได้ไหม: [
    'สมาร์ทโฟน',
    'สมาร์ทโฟนใช้ได้ไหม',
    'โทรศัพท์มือถือ',
    'โทรศัพท์ใช้ได้ไหม',
    'ใช้ในมือถือ',
    'ใช้ในมือถือได้ไหม',
    'ใช้บนมือถือได้ไหม',
    'ใช้ผ่านมือถือได้ไหม',
    'เปิดในมือถือ',
    'เปิดในมือถือได้ไหม',
    'เปิดผ่านมือถือ',
    'เปิดผ่านมือถือได้ไหม',
    'เปิดบนมือถือได้ไหม',
    'รองรับมือถือ',
    'รองรับมือถือไหม',
    'ใช้มือถือได้ไหม',
    'มือถือใช้ได้ไหม',
    'มือถือเปิดได้ไหม',
    'เข้าผ่านมือถือ',
    'เข้าผ่านมือถือได้ไหม',
    'เข้าในมือถือได้ไหม',
    'ทดลองในมือถือ',
    'ใช้งานผ่านมือถือ',
    'เบราว์เซอร์อะไร',
    'เบราว์เซอร์อะไรบ้าง',
    'เบราว์เซอร์ไหน',
    'เบราว์เซอร์ไหนบ้าง',
    'ใช้เบราว์เซอร์อะไร',
    'ใช้เบราว์เซอร์ไหน',
    'ใช้เบราว์เซอร์ไหนบ้าง',
    'เปิดในเบราว์เซอร์อะไร',
    'เปิดในเบราว์เซอร์ไหน',
    'เปิดในเบราว์เซอร์ไหนบ้าง',
    'เปิดได้ในเบราว์เซอร์ไหนบ้าง',
    'เปิดได้ในเบราว์เซอร์ไหน',
    'เปิดบนเบราว์เซอร์ไหน',
    'เปิดบนเบราว์เซอร์อะไร',
    'เปิดด้วยเบราว์เซอร์อะไร',
    'ใช้ chrome ได้ไหม',
    'ใช้โครมได้ไหม',
    'เปิดใน chrome ได้ไหม',
    'เปิดบน chrome ได้ไหม',
    'เปิดผ่าน chrome ได้ไหม',
    'รองรับ chrome ไหม',
    'รองรับโครมไหม',
  ],
  ติดต่อใครเมื่อไม่มีคำตอบ: [
    'ติดต่อใคร',
    'ติดต่อใครได้บ้าง',
    'ติดต่อเจ้าหน้าที่',
    'ติดต่อเจ้าหน้าที่ได้ที่ไหน',
    'ผู้ดูแล',
    'สอบถามเพิ่มเติม',
    'สอบถามเพิ่มเติมได้ที่ไหน',
    'ถามใครได้',
    'สอบถามใครได้บ้าง',
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
  /ล่วงเวลา/u,
  /ทำงานล่วงเวลา/u,
  /นอกเวลาทำการ/u,
  /โอที/u,
  /บริการพิเศษ/u,
  /สิทธิพิเศษ/u,
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
 * Unmentioned specific time or schedule sub-angles (such as lunch break or special holiday policies)
 * where the canonical FAQ answer does not contain facts, requiring LLM handling.
 */
const UNANSWERED_SPECIFIC_SCHEDULE_PATTERNS: readonly RegExp[] = [
  /พักเที่ยง/u,
  /พักกลางวัน/u,
  /หยุดชดเชย/u,
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
    'เปิดวันไหน',
    'เปิดวันไหนบ้าง',
    'เปิดวันอะไร',
    'เปิดทำการวันไหน',
    'เปิดให้บริการวันไหน',
    'กี่โมงถึงกี่โมง',
    'เปิดถึงกี่โมง',
    'ปิดกี่โมง',
    'ปิดบริการกี่โมง',
    'ปิดทำการกี่โมง',
    'เวลาปิด',
    'เวลาปิดบริการ',
    'วันเสาร์เปิดไหม',
    'เสาร์อาทิตย์เปิดไหม',
    'เปิดวันเสาร์ไหม',
    'เปิดวันอาทิตย์ไหม',
    'วันอาทิตย์เปิดไหม',
    'วันเสาร์เปิดให้บริการไหม',
    'เสาร์อาทิตย์เปิดให้บริการไหม',
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
    'ต้องนัดหมายไหม',
    'จองคิวยังไง',
    'นัดหมายล่วงหน้า',
    'วอล์คอิน',
    'วอล์คอินได้ไหม',
    'walk in',
    'walk in ได้ไหม',
    'เข้าไปได้เลยไหม',
    'มาได้เลยไหม',
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
    'ต้องใช้บัตรประชาชนไหม',
    'ใช้บัตรประชาชนไหม',
    'พกบัตรประชาชนไหม',
  ],
  ทดลองผ่านมือถือได้ไหม: [
    'ทดลองผ่านมือถือได้ไหม',
    'ใช้มือถือได้ไหม',
    'ใช้ในมือถือได้ไหม',
    'เปิดในมือถือได้ไหม',
    'รองรับมือถือไหม',
    'เข้าผ่านมือถือได้ไหม',
    'เข้าในมือถือได้ไหม',
    'ทดลองในมือถือ',
    'ใช้งานผ่านมือถือ',
    'เปิดผ่านมือถือได้ไหม',
    'เปิดผ่านมือถือ',
    'เปิดในมือถือ',
    'ใช้ผ่านมือถือได้ไหม',
    'ใช้บนมือถือได้ไหม',
    'เปิดบนมือถือได้ไหม',
    'มือถือใช้ได้ไหม',
    'มือถือเปิดได้ไหม',
    'โทรศัพท์ใช้ได้ไหม',
    'สมาร์ทโฟนใช้ได้ไหม',
    'ใช้เบราว์เซอร์อะไร',
    'ใช้เบราว์เซอร์ไหน',
    'ใช้เบราว์เซอร์ไหนบ้าง',
    'เปิดในเบราว์เซอร์อะไร',
    'เปิดในเบราว์เซอร์ไหน',
    'เปิดในเบราว์เซอร์ไหนบ้าง',
    'เปิดได้ในเบราว์เซอร์ไหนบ้าง',
    'เปิดได้ในเบราว์เซอร์ไหน',
    'เปิดบนเบราว์เซอร์ไหน',
    'เปิดบนเบราว์เซอร์อะไร',
    'เปิดด้วยเบราว์เซอร์อะไร',
    'เบราว์เซอร์ไหนบ้าง',
    'เบราว์เซอร์อะไรบ้าง',
    'เบราว์เซอร์อะไร',
    'ใช้ chrome ได้ไหม',
    'ใช้โครมได้ไหม',
    'เปิดใน chrome ได้ไหม',
    'เปิดบน chrome ได้ไหม',
    'เปิดผ่าน chrome ได้ไหม',
    'รองรับ chrome ไหม',
    'รองรับโครมไหม',
  ],
  ติดต่อใครเมื่อไม่มีคำตอบ: [
    'ติดต่อใครเมื่อไม่มีคำตอบ',
    'ถ้าไม่มีคำตอบติดต่อใคร',
    'สอบถามเพิ่มเติมได้ที่ไหน',
    'สอบถามข้อมูลเพิ่มเติมได้ที่ใคร',
    'ติดต่อใครได้บ้าง',
    'ติดต่อเจ้าหน้าที่ได้ที่ไหน',
    'สอบถามใครได้บ้าง',
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
    }
  }

  // 4. Supplemental alias/synonym phrase matching
  const supplementalAliases =
    SUPPLEMENTAL_ALIASES_BY_QUESTION[faq.question] ?? [];
  for (const rawAlias of supplementalAliases) {
    const alias = normalizeThaiText(rawAlias);
    const aliasCore = extractQuestionCore(alias);
    const spacelessAlias = alias.replace(/\s+/g, '');
    const spacelessAliasCore = aliasCore.replace(/\s+/g, '');
    if (
      alias.length >= 3 &&
      !GENERIC_STANDALONE_WORDS.has(alias) &&
      (politeStrippedQuery.includes(alias) ||
        queryCore.includes(alias) ||
        conversationalClean.includes(alias) ||
        conversationalCore.includes(alias) ||
        locativeStrippedQuery.includes(alias) ||
        locativeStrippedCore.includes(alias) ||
        spacelessPolite.includes(spacelessAlias) ||
        spacelessLocativeQuery.includes(spacelessAlias) ||
        spacelessConversational.includes(spacelessAlias) ||
        (spacelessConversationalCore.length >= 4 &&
          (spacelessAlias.includes(spacelessConversationalCore) ||
            spacelessAliasCore.includes(spacelessConversationalCore) ||
            spacelessConversationalCore.includes(spacelessAliasCore))) ||
        (spacelessLocativeCore.length >= 4 &&
          (spacelessAlias.includes(spacelessLocativeCore) ||
            spacelessAliasCore.includes(spacelessLocativeCore) ||
            spacelessLocativeCore.includes(spacelessAliasCore))) ||
        (conversationalCore.length >= 4 &&
          (alias.includes(conversationalCore) ||
            aliasCore.includes(conversationalCore) ||
            conversationalCore.includes(aliasCore))))
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
  const conversationalStripped =
    stripLeadingConversationalPrefixes(politeStripped);
  const locativeStripped = stripLocativeDemonstratives(conversationalStripped);
  const conversationalClean = locativeStripped
    .replace(/\s*(?:ล่ะ|ละ)\s*/g, ' ')
    .trim();
  const conversationalCore = extractQuestionCore(conversationalClean);

  const locativeStrippedQuery = stripLocativeDemonstratives(politeStripped);
  const locativeStrippedCore = extractQuestionCore(locativeStrippedQuery);

  const spacelessPolite = politeStripped.replace(/\s+/g, '');
  const spacelessLocativeQuery = locativeStrippedQuery.replace(/\s+/g, '');
  const spacelessLocativeCore = locativeStrippedCore.replace(/\s+/g, '');
  const spacelessConversational = conversationalClean.replace(/\s+/g, '');
  const spacelessConversationalCore = conversationalCore.replace(/\s+/g, '');

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
    const spacelessPhrase = normPhrase.replace(/\s+/g, '');
    const spacelessCorePhrase = corePhrase.replace(/\s+/g, '');
    return (
      (normPhrase.length >= 4 &&
        (politeStripped.includes(normPhrase) ||
          conversationalClean.includes(normPhrase) ||
          locativeStrippedQuery.includes(normPhrase) ||
          spacelessPolite.includes(spacelessPhrase) ||
          spacelessLocativeQuery.includes(spacelessPhrase) ||
          spacelessConversational.includes(spacelessPhrase))) ||
      (corePhrase.length >= 4 &&
        (politeStripped.includes(corePhrase) ||
          coreQuery.includes(corePhrase) ||
          conversationalClean.includes(corePhrase) ||
          conversationalCore.includes(corePhrase) ||
          locativeStrippedQuery.includes(corePhrase) ||
          locativeStrippedCore.includes(corePhrase) ||
          spacelessPolite.includes(spacelessCorePhrase) ||
          spacelessLocativeQuery.includes(spacelessCorePhrase) ||
          spacelessLocativeCore.includes(spacelessCorePhrase) ||
          spacelessConversational.includes(spacelessCorePhrase) ||
          spacelessConversationalCore.includes(spacelessCorePhrase))) ||
      (conversationalCore.length >= 4 &&
        (normPhrase.includes(conversationalCore) ||
          corePhrase.includes(conversationalCore) ||
          spacelessPhrase.includes(spacelessConversationalCore) ||
          spacelessCorePhrase.includes(spacelessConversationalCore) ||
          spacelessConversationalCore.includes(spacelessCorePhrase))) ||
      (spacelessLocativeCore.length >= 4 &&
        (spacelessPhrase.includes(spacelessLocativeCore) ||
          spacelessCorePhrase.includes(spacelessLocativeCore) ||
          spacelessLocativeCore.includes(spacelessCorePhrase)))
    );
  });

  if (matchesApprovedPhrase) {
    return {
      highConfidenceFastPath: true,
      fastPathMatchReason: 'APPROVED_INTENT_ALIAS',
    };
  }

  // Check 3: Unanswered specific schedule angles (e.g. lunch breaks)
  if (
    primaryFaq.question === 'เปิดบริการกี่โมง' &&
    UNANSWERED_SPECIFIC_SCHEDULE_PATTERNS.some((pattern) =>
      pattern.test(normalizedTranscript),
    )
  ) {
    return {
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      fastPathDisqualifier: 'REVERSE_OR_SPECIFIC_TIME_ANGLE',
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
      primary.fastPathMatchReason === 'APPROVED_INTENT_ALIAS'
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
