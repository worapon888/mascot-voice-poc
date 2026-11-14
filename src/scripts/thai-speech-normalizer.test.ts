import assert from 'node:assert/strict';
import { normalizeThaiSpeech } from '@/lib/voice/thai-speech-normalizer';

interface NormalizationTestCase {
  id: string;
  category: string;
  input: string;
  expected: string;
}

const TEST_CASES: readonly NormalizationTestCase[] = [
  // 1. Prompt Table Exact Cases
  {
    id: 'U01',
    category: 'Single clock time (leading zero + colon)',
    input: '09:00 น.',
    expected: 'เก้าโมงเช้า',
  },
  {
    id: 'U02',
    category: 'Single clock time (non-leading zero + dot)',
    input: '9.00 น.',
    expected: 'เก้าโมงเช้า',
  },
  {
    id: 'U03',
    category: 'Single clock time (16:00 colon)',
    input: '16:00 น.',
    expected: 'สี่โมงเย็น',
  },
  {
    id: 'U04',
    category: 'Single clock time (16.00 dot)',
    input: '16.00 น.',
    expected: 'สี่โมงเย็น',
  },
  {
    id: 'U05',
    category: 'Opening-hours range (en-dash)',
    input: '09:00–16:00 น.',
    expected: 'เก้าโมงเช้าถึงสี่โมงเย็น',
  },
  {
    id: 'U06',
    category: 'Opening-hours range (dot + spaced hyphen)',
    input: '09.00 - 16.00 น.',
    expected: 'เก้าโมงเช้าถึงสี่โมงเย็น',
  },
  {
    id: 'U07',
    category: 'Half-hour minute value (16:30)',
    input: '16:30 น.',
    expected: 'สี่โมงครึ่ง',
  },
  {
    id: 'U08',
    category: 'Noon (12:00)',
    input: '12:00 น.',
    expected: 'เที่ยงวัน',
  },
  {
    id: 'U09',
    category: 'Afternoon (13:00)',
    input: '13:00 น.',
    expected: 'บ่ายโมง',
  },
  {
    id: 'U10',
    category: 'Evening (18:00)',
    input: '18:00 น.',
    expected: 'หกโมงเย็น',
  },

  // 2. Full Sentences, Ranges, Afternoon, Minutes & Polite Particles
  {
    id: 'U11',
    category: 'Display vs Speech POC sentence (en-dash)',
    input: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ',
    expected: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ เก้าโมงเช้าถึงสี่โมงเย็นครับ',
  },
  {
    id: 'U12',
    category: 'Range with repeated unit and ถึง',
    input: 'เปิดให้บริการตั้งแต่เวลา 09:00 น. ถึง 16:00 น. ครับผม',
    expected: 'เปิดให้บริการตั้งแต่เวลา เก้าโมงเช้าถึงสี่โมงเย็นครับผม',
  },
  {
    id: 'U13',
    category: 'Afternoon 2 PM - 3 PM and non-30 minutes',
    input: 'พักเบรกเวลา 12:30 น. และเริ่มรอบบ่ายเวลา 14:15 น. ถึง 15:45 น.',
    expected:
      'พักเบรกเวลา เที่ยงครึ่ง และเริ่มรอบบ่ายเวลา บ่ายสองโมงสิบห้านาทีถึงบ่ายสามโมงสี่สิบห้านาที',
  },
  {
    id: 'U14',
    category: 'Malformed LLM abbreviation (16.00 นาครับ)',
    input: 'จุดบริการ Demo ปิดเวลา 16.00 นาครับ',
    expected: 'จุดบริการ Demo ปิดเวลา สี่โมงเย็นครับ',
  },
  {
    id: 'U15',
    category: 'Duplicate polite particle prevention',
    input: 'เปิดเวลา 09:00 น. ครับ ครับ',
    expected: 'เปิดเวลา เก้าโมงเช้าครับ',
  },

  // 3. Safety & Non-Time Preservation Cases
  {
    id: 'U16',
    category: 'Price values must remain unchanged',
    input: 'ค่าธรรมเนียม 500.00 บาท และค่าจอดรถ 16.50 บาท',
    expected: 'ค่าธรรมเนียม 500.00 บาท และค่าจอดรถ 16.50 บาท',
  },
  {
    id: 'U17',
    category: 'Document identifiers must remain unchanged',
    input: 'การทดลอง Demo ใช้เลขอ้างอิง DEMO-001 ไม่ต้องใช้เอกสาร DOC-09-16',
    expected: 'การทดลอง Demo ใช้เลขอ้างอิง DEMO-001 ไม่ต้องใช้เอกสาร DOC-09-16',
  },
  {
    id: 'U18',
    category: 'Invalid clock values must remain unchanged',
    input: 'ข้อมูลผิดพลาด 25:00 น. หรือ 16:75 น. หรือ 99.99 น.',
    expected: 'ข้อมูลผิดพลาด 25:00 น. หรือ 16:75 น. หรือ 99.99 น.',
  },
  {
    id: 'U19',
    category:
      'Ambiguous decimal numbers without time unit must remain unchanged',
    input: 'ค่าเฉลี่ยอยู่ที่ 9.00 ถึง 16.00 ในระบบเวอร์ชัน 2.00 (ค่าพาย 3.14)',
    expected: 'ค่าเฉลี่ยอยู่ที่ 9.00 ถึง 16.00 ในระบบเวอร์ชัน 2.00 (ค่าพาย 3.14)',
  },
  {
    id: 'U20',
    category: 'Already-normalized Thai speech must remain unchanged',
    input: 'จุดบริการ Demo เปิดจันทร์ถึงศุกร์ เวลา เก้าโมงเช้าถึงสี่โมงเย็นครับ',
    expected: 'จุดบริการ Demo เปิดจันทร์ถึงศุกร์ เวลา เก้าโมงเช้าถึงสี่โมงเย็นครับ',
  },
  {
    id: 'U21',
    category: 'Empty input',
    input: '',
    expected: '',
  },
];

function runTests(): void {
  console.log('==============================================================');
  console.log(' Thai Speech Normalizer Unit Tests (U01 - U21 + Idempotency)  ');
  console.log(
    '==============================================================\n',
  );

  let passedCount = 0;

  for (const tc of TEST_CASES) {
    const actual = normalizeThaiSpeech(tc.input);
    assert.equal(
      actual,
      tc.expected,
      `[${tc.id}] Failed (${tc.category}):\n  Input:    "${tc.input}"\n  Expected: "${tc.expected}"\n  Actual:   "${actual}"`,
    );

    const twice = normalizeThaiSpeech(actual);
    assert.equal(
      twice,
      actual,
      `[${tc.id}] Idempotency check failed:\n  Once:  "${actual}"\n  Twice: "${twice}"`,
    );

    passedCount += 1;
    console.log(`[PASS] ${tc.id} — ${tc.category}`);
    console.log(`       Input:      "${tc.input}"`);
    console.log(`       Normalized: "${actual}"`);
  }

  console.log(
    '\n--------------------------------------------------------------',
  );
  console.log(
    `Summary: ${passedCount}/${TEST_CASES.length} Unit & Idempotency Tests PASSED`,
  );
  console.log('--------------------------------------------------------------');
}

runTests();
