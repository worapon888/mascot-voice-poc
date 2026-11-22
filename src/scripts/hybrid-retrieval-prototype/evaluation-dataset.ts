import type { EvalQueryItem } from './types';

export const EVALUATION_DATASET: EvalQueryItem[] = [
  // ---------------------------------------------------------------------------
  // 1. Exact FAQ Questions
  // ---------------------------------------------------------------------------
  {
    id: 'EQ-01',
    query: 'เปิดบริการกี่โมง',
    category: 'EXACT_QUESTION',
    expectedFaqId: 1,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Exact question string from database for FAQ #1',
  },
  {
    id: 'EQ-02',
    query: 'ต้องจองคิวไหม',
    category: 'EXACT_QUESTION',
    expectedFaqId: 2,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Exact question string from database for FAQ #2',
  },
  {
    id: 'EQ-03',
    query: 'เตรียมเอกสารอะไร',
    category: 'EXACT_QUESTION',
    expectedFaqId: 3,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Exact question string from database for FAQ #3',
  },
  {
    id: 'EQ-04',
    query: 'ทดลองผ่านมือถือได้ไหม',
    category: 'EXACT_QUESTION',
    expectedFaqId: 4,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Exact question string from database for FAQ #4',
  },
  {
    id: 'EQ-05',
    query: 'ติดต่อใครเมื่อไม่มีคำตอบ',
    category: 'EXACT_QUESTION',
    expectedFaqId: 5,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Exact question string from database for FAQ #5',
  },

  // ---------------------------------------------------------------------------
  // 2. Natural Thai Paraphrases
  // ---------------------------------------------------------------------------
  {
    id: 'NP-01',
    query: 'วันเสาร์ที่นี่เปิดหรือเปล่า',
    category: 'NATURAL_PARAPHRASE',
    expectedFaqId: 1,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Spoken Thai with locative "ที่นี่" and question marker "หรือเปล่า"',
  },
  {
    id: 'NP-02',
    query: 'เปิดวันไหนบ้าง',
    category: 'NATURAL_PARAPHRASE',
    expectedFaqId: 1,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Inquiring operating days covered by FAQ #1 (จันทร์–ศุกร์)',
  },
  {
    id: 'NP-03',
    query: 'เปิดในเบราว์เซอร์ไหนบ้าง',
    category: 'NATURAL_PARAPHRASE',
    expectedFaqId: 4,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Inquiring browser compatibility covered by FAQ #4 (Chrome Desktop)',
  },
  {
    id: 'NP-04',
    query: 'ขอทราบเวลาเปิดปิดทำการหน่อยครับ',
    category: 'NATURAL_PARAPHRASE',
    expectedFaqId: 1,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Polite spoken request for operating hours',
  },
  {
    id: 'NP-05',
    query: 'จะไปใช้บริการต้องเอาอะไรไปบ้าง',
    category: 'NATURAL_PARAPHRASE',
    expectedFaqId: 3,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Colloquial Thai phrasing for document preparation',
  },

  // ---------------------------------------------------------------------------
  // 3. Conversational Follow-ups
  // ---------------------------------------------------------------------------
  {
    id: 'CF-01',
    query: 'แล้ววันเสาร์ล่ะ เปิดไหม?',
    category: 'CONVERSATIONAL_FOLLOW_UP',
    expectedFaqId: 1,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    contextHistory: [
      { role: 'user', text: 'เปิดกี่โมง', faqIds: [1] },
      {
        role: 'assistant',
        text: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น.',
        faqIds: [1],
      },
    ],
    notes: 'Follow-up continuing schedule topic from Turn 1',
  },
  {
    id: 'CF-02',
    query: 'แล้วมันเปิดได้ในเบราว์เซอร์ไหนบ้างล่ะครับ',
    category: 'CONVERSATIONAL_FOLLOW_UP',
    expectedFaqId: 4,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    contextHistory: [
      { role: 'user', text: 'ทดลองผ่านมือถือได้ไหม', faqIds: [4] },
      {
        role: 'assistant',
        text: 'Demo นี้แนะนำ Chrome Desktop; Mobile ยังไม่รับรองจนกว่าจะทดสอบ',
        faqIds: [4],
      },
    ],
    notes: 'Follow-up continuing browser compatibility topic from Turn 1',
  },
  {
    id: 'CF-03',
    query: 'แล้วถ้าไม่มีล่ะครับ',
    category: 'CONVERSATIONAL_FOLLOW_UP',
    expectedFaqId: 3,
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    contextHistory: [
      { role: 'user', text: 'เตรียมเอกสารอะไร', faqIds: [3] },
      {
        role: 'assistant',
        text: 'การทดลอง Demo ใช้เลขอ้างอิง DEMO-001 ไม่ต้องส่งเอกสารส่วนบุคคล',
        faqIds: [3],
      },
    ],
    notes: 'Conditional follow-up needing grounded LLM contextual reasoning',
  },

  // ---------------------------------------------------------------------------
  // 4. Yes/No Questions
  // ---------------------------------------------------------------------------
  {
    id: 'YN-01',
    query: 'วันอาทิตย์เปิดหรือไม่',
    category: 'YES_NO_QUESTION',
    expectedFaqId: 1,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Schedule inquiry with "หรือไม่"',
  },
  {
    id: 'YN-02',
    query: 'ต้องนัดล่วงหน้าไหม',
    category: 'YES_NO_QUESTION',
    expectedFaqId: 2,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Queue question with appointment synonym ("รับนัดหมายล่วงหน้า")',
  },
  {
    id: 'YN-03',
    query: 'ใช้ Chrome ได้ไหม',
    category: 'YES_NO_QUESTION',
    expectedFaqId: 4,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Specific browser named entity in FAQ #4',
  },
  {
    id: 'YN-04',
    query: 'เปิดผ่านมือถือได้หรือเปล่า',
    category: 'YES_NO_QUESTION',
    expectedFaqId: 4,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Device inquiry with "หรือเปล่า"',
  },
  {
    id: 'YN-05',
    query: 'ต้องใช้บัตรประชาชนไหม',
    category: 'YES_NO_QUESTION',
    expectedFaqId: 3,
    expectedSufficiency: 'SUFFICIENT',
    expectedTier: 'TIER_1',
    notes: 'Personal ID confirmation answered by "ไม่ต้องส่งเอกสารส่วนบุคคล"',
  },

  // ---------------------------------------------------------------------------
  // 5. Ambiguous Questions (Cross-FAQ / Multi-Topic)
  // ---------------------------------------------------------------------------
  {
    id: 'AM-01',
    query: 'จองคิวผ่านมือถือได้ไหม',
    category: 'AMBIGUOUS',
    expectedFaqId: null, // Multiple candidates (FAQ 2 & 4)
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    notes: 'Combines queue (FAQ #2) and mobile (FAQ #4)',
  },
  {
    id: 'AM-02',
    query: 'เปิดบริการกี่โมงและต้องเตรียมเอกสารอะไรบ้างครับ',
    category: 'AMBIGUOUS',
    expectedFaqId: null, // Multiple candidates (FAQ 1 & 3)
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    notes: 'Multi-intent connector combining schedule and documents',
  },

  // ---------------------------------------------------------------------------
  // 6. Out-of-Scope Questions
  // ---------------------------------------------------------------------------
  {
    id: 'OS-01',
    query: 'ค่าบริการเท่าไหร่',
    category: 'OUT_OF_SCOPE',
    expectedFaqId: null,
    expectedSufficiency: 'INSUFFICIENT',
    expectedTier: 'TIER_3',
    notes: 'Pricing/fees not covered by demo FAQs',
  },
  {
    id: 'OS-02',
    query: 'ห้องน้ำอยู่ตรงไหน',
    category: 'OUT_OF_SCOPE',
    expectedFaqId: null,
    expectedSufficiency: 'INSUFFICIENT',
    expectedTier: 'TIER_3',
    notes: 'Facility location not covered by demo FAQs',
  },
  {
    id: 'OS-03',
    query: 'วันนี้ฝนตกไหม',
    category: 'OUT_OF_SCOPE',
    expectedFaqId: null,
    expectedSufficiency: 'INSUFFICIENT',
    expectedTier: 'TIER_3',
    notes: 'Weather query completely out of scope',
  },
  {
    id: 'OS-04',
    query: 'ขอรหัส wifi หน่อยครับ',
    category: 'OUT_OF_SCOPE',
    expectedFaqId: null,
    expectedSufficiency: 'INSUFFICIENT',
    expectedTier: 'TIER_3',
    notes: 'Network credentials out of scope',
  },

  // ---------------------------------------------------------------------------
  // 7. Questions With Similar Keywords But Different Intent
  // ---------------------------------------------------------------------------
  {
    id: 'SK-01',
    query: 'วันเสาร์มีบริการพิเศษอะไรบ้าง',
    category: 'SIMILAR_KEYWORDS_DIFFERENT_INTENT',
    expectedFaqId: null,
    expectedSufficiency: 'INSUFFICIENT',
    expectedTier: 'TIER_3',
    notes: 'Has "วันเสาร์" but asks for special services not covered by FAQ #1',
  },
  {
    id: 'SK-02',
    query: 'มีเจ้าหน้าที่ทำงานล่วงเวลาไหม',
    category: 'SIMILAR_KEYWORDS_DIFFERENT_INTENT',
    expectedFaqId: null,
    expectedSufficiency: 'INSUFFICIENT',
    expectedTier: 'TIER_3',
    notes: 'Has "เจ้าหน้าที่" but asks for overtime policy not in FAQ #5',
  },
  {
    id: 'SK-03',
    query: 'ติดต่อเจ้าหน้าที่เรื่องที่จอดรถได้ที่ไหนครับ',
    category: 'SIMILAR_KEYWORDS_DIFFERENT_INTENT',
    expectedFaqId: null,
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    notes: 'Has "ติดต่อเจ้าหน้าที่" but about parking topic',
  },
  {
    id: 'SK-04',
    query: 'เปิดบริการช่วงพักเที่ยงไหมครับ',
    category: 'SIMILAR_KEYWORDS_DIFFERENT_INTENT',
    expectedFaqId: 1,
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    notes: 'Specific sub-angle not answered by FAQ #1 canonical answer',
  },

  // ---------------------------------------------------------------------------
  // 8. Questions Requiring Multiple FAQ Evidence
  // ---------------------------------------------------------------------------
  {
    id: 'ME-01',
    query: 'ถ้าจะไปติดต่อต้องจองคิวก่อนหรือไปเตรียมเอกสารที่จุดบริการได้เลย',
    category: 'MULTI_FAQ_EVIDENCE',
    expectedFaqId: null,
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    notes: 'Complex multi-turn question requiring synthesis of FAQ #2 and #3',
  },

  // ---------------------------------------------------------------------------
  // 9. Adversarial / False Positive Cases
  // ---------------------------------------------------------------------------
  {
    id: 'AD-01',
    query: 'เปิดในมือถือไม่ได้ ระบบล่มหรือเปล่าครับ',
    category: 'ADVERSARIAL_TRAP',
    expectedFaqId: 4,
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    notes: 'Has device keyword but is a problem report requiring LLM handling',
  },
  {
    id: 'AD-02',
    query: 'ลืมมือถือไว้ที่เคาน์เตอร์ทำยังไงครับ',
    category: 'ADVERSARIAL_TRAP',
    expectedFaqId: null,
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    notes: 'Lost item trap query with "มือถือ"',
  },
  {
    id: 'AD-03',
    query: 'ส่งเอกสารทางไปรษณีย์ได้ไหมครับ',
    category: 'ADVERSARIAL_TRAP',
    expectedFaqId: null,
    expectedSufficiency: 'PARTIAL',
    expectedTier: 'TIER_2',
    notes: 'Mail delivery trap query with "เอกสาร"',
  },
];
