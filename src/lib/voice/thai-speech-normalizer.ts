const THAI_DIGITS_TO_TEN: readonly string[] = [
  'ศูนย์',
  'หนึ่ง',
  'สอง',
  'สาม',
  'สี่',
  'ห้า',
  'หก',
  'เจ็ด',
  'แปด',
  'เก้า',
  'สิบ',
];

/**
 * Converts an integer from 0 to 59 into standard spoken Thai words.
 */
function numberToThaiWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 59) {
    return String(value);
  }

  if (value <= 10) {
    return THAI_DIGITS_TO_TEN[value];
  }

  if (value === 11) {
    return 'สิบเอ็ด';
  }

  if (value < 20) {
    return `สิบ${THAI_DIGITS_TO_TEN[value % 10]}`;
  }

  const tens = Math.floor(value / 10);
  const unit = value % 10;
  const tensPrefix = tens === 2 ? 'ยี่สิบ' : `${THAI_DIGITS_TO_TEN[tens]}สิบ`;

  if (unit === 0) {
    return tensPrefix;
  }
  if (unit === 1) {
    return `${tensPrefix}เอ็ด`;
  }
  return `${tensPrefix}${THAI_DIGITS_TO_TEN[unit]}`;
}

/**
 * Validates whether hour and minute strings represent a real 24-hour clock time.
 * Rejects numbers with > 2 hour digits or out-of-range values (e.g. 25:00, 16:75).
 */
export function isValidClockTime(
  hourStr: string,
  minuteStr: string,
): { hour: number; minute: number } | null {
  if (!/^\d{1,2}$/.test(hourStr) || !/^\d{2}$/.test(minuteStr)) {
    return null;
  }

  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { hour, minute };
}

/**
 * Converts a validated 24-hour clock time (00:00 - 23:59) into natural spoken Thai.
 */
export function formatClockTimeToThaiSpeech(
  hour: number,
  minute: number,
): string {
  const minuteSuffix =
    minute === 0
      ? ''
      : minute === 30
        ? 'ครึ่ง'
        : `${numberToThaiWords(minute)}นาที`;

  // 00:00 - 00:59 (Midnight)
  if (hour === 0) {
    return `เที่ยงคืน${minuteSuffix}`;
  }

  // 01:00 - 05:59 (Early morning: ตีหนึ่ง - ตีห้า)
  if (hour >= 1 && hour <= 5) {
    return `ตี${numberToThaiWords(hour)}${minuteSuffix}`;
  }

  // 06:00 - 11:59 (Morning: หกโมงเช้า - สิบเอ็ดโมงเช้า)
  if (hour >= 6 && hour <= 11) {
    const base = `${numberToThaiWords(hour)}โมง`;
    if (minute === 0) {
      return `${base}เช้า`;
    }
    return `${base}${minuteSuffix}`;
  }

  // 12:00 - 12:59 (Noon: เที่ยงวัน / เที่ยงครึ่ง / เที่ยง...นาที)
  if (hour === 12) {
    if (minute === 0) {
      return 'เที่ยงวัน';
    }
    return `เที่ยง${minuteSuffix}`;
  }

  // 13:00 - 13:59 (1 PM: บ่ายโมง)
  if (hour === 13) {
    return `บ่ายโมง${minuteSuffix}`;
  }

  // 14:00 - 15:59 (2 PM - 3 PM: บ่ายสองโมง - บ่ายสามโมง)
  if (hour >= 14 && hour <= 15) {
    return `บ่าย${numberToThaiWords(hour - 12)}โมง${minuteSuffix}`;
  }

  // 16:00 - 18:59 (4 PM - 6 PM: สี่โมงเย็น - หกโมงเย็น)
  if (hour >= 16 && hour <= 18) {
    const base = `${numberToThaiWords(hour - 12)}โมง`;
    if (minute === 0) {
      return `${base}เย็น`;
    }
    return `${base}${minuteSuffix}`;
  }

  // 19:00 - 23:59 (7 PM - 11 PM: หนึ่งทุ่ม - ห้าทุ่ม)
  return `${numberToThaiWords(hour - 18)}ทุ่ม${minuteSuffix}`;
}

/**
 * Matches a day-of-week range with standard dash or range separators (`-`, `–`, `—`, or `ถึง`),
 * with or without leading `วัน` and optional whitespace.
 * Examples:
 * - "จันทร์–ศุกร์" -> "วันจันทร์ถึงวันศุกร์"
 * - "วันจันทร์-วันศุกร์" -> "วันจันทร์ถึงวันศุกร์"
 * - "จันทร์ — ศุกร์" -> "วันจันทร์ถึงวันศุกร์"
 * - "เสาร์–อาทิตย์" -> "วันเสาร์ถึงวันอาทิตย์"
 */
const THAI_DAY_NAME_GROUP = '(?:วัน)?(จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์)';

const DAY_RANGE_PATTERN = new RegExp(
  `(?<!พระ|ดาว|ดวง)(?<![0-9A-Za-z.-])${THAI_DAY_NAME_GROUP}\\s*(?:[-–—]|ถึง)\\s*${THAI_DAY_NAME_GROUP}(?![0-9A-Za-z.-])`,
  'gu',
);

/**
 * Matches a clock time range with an explicit trailing Thai time unit (`น.`, `นาฬิกา`, or malformed `นา` before polite particle).
 * Examples:
 * - "09:00–16:00 น."
 * - "09.00 - 16.00 น."
 * - "09:00 น. ถึง 16:00 น."
 */
const TIME_RANGE_PATTERN =
  /(?<![0-9A-Za-z.-])(\d{1,2})([:.])(\d{2})(?:\s*(?:น\.|นาฬิกา))?\s*(?:[-–—]|ถึง)\s*(\d{1,2})([:.])(\d{2})\s*(?:(น\.|นาฬิกา)(?:\s*(ครับผม|ครับ|ค่ะ|คะ|นะครับ|นะคะ))?|(นา)\s*(ครับผม|ครับ|ค่ะ|คะ|นะครับ|นะคะ))(?![0-9.])/gu;

/**
 * Matches a single clock time with an explicit trailing Thai time unit (`น.`, `นาฬิกา`, or malformed `นา` before polite particle).
 * Examples:
 * - "09:00 น."
 * - "9.00 น."
 * - "16:30 น."
 * - "16.00 นาครับ"
 */
const SINGLE_TIME_WITH_UNIT_PATTERN =
  /(?<![0-9A-Za-z.-])(\d{1,2})([:.])(\d{2})\s*(?:(น\.|นาฬิกา)(?:\s*(ครับผม|ครับ|ค่ะ|คะ|นะครับ|นะคะ))?|(นา)\s*(ครับผม|ครับ|ค่ะ|คะ|นะครับ|นะคะ))(?![0-9.])/gu;

/**
 * Collapses accidental duplicate polite particles that may appear around normalized speech.
 */
const DUPLICATE_POLITE_PARTICLE_PATTERN = /(ครับผม|นะครับ|นะคะ|ครับ|ค่ะ|คะ)\s+\1/gu;

/**
 * Deterministic, pure normalizer that converts Thai day-of-week ranges and clock time expressions
 * into natural spoken Thai for Text-to-Speech (TTS) synthesis while leaving non-time numbers, prices,
 * IDs, and ambiguous decimals untouched.
 */
export function normalizeThaiSpeech(text: string): string {
  if (!text) {
    return '';
  }

  let result = text.normalize('NFC');

  // 1. Convert explicit day-of-week ranges first (e.g., "จันทร์–ศุกร์", "วันจันทร์-วันศุกร์", "จันทร์ — ศุกร์", "เสาร์–อาทิตย์")
  result = result.replace(
    DAY_RANGE_PATTERN,
    (_match, d1: string, d2: string) => {
      return `วัน${d1}ถึงวัน${d2}`;
    },
  );

  // 2. Convert explicit clock time ranges (e.g., "09:00–16:00 น.", "09.00 - 16.00 น.", "09:00 น. ถึง 16:00 น.")
  result = result.replace(
    TIME_RANGE_PATTERN,
    (
      fullMatch,
      h1Str: string,
      _sep1: string,
      m1Str: string,
      h2Str: string,
      _sep2: string,
      m2Str: string,
      _unit: string | undefined,
      politeAfterUnit: string | undefined,
      _malformedNa: string | undefined,
      politeAfterNa: string | undefined,
    ) => {
      const t1 = isValidClockTime(h1Str, m1Str);
      const t2 = isValidClockTime(h2Str, m2Str);
      if (!t1 || !t2) {
        return fullMatch;
      }

      const spokenRange = `${formatClockTimeToThaiSpeech(t1.hour, t1.minute)}ถึง${formatClockTimeToThaiSpeech(t2.hour, t2.minute)}`;
      const politeParticle = politeAfterUnit ?? politeAfterNa ?? '';
      return `${spokenRange}${politeParticle}`;
    },
  );

  // 3. Convert single clock times that carry an explicit Thai time unit ("น.", "นาฬิกา", or unambiguous "นาครับ")
  result = result.replace(
    SINGLE_TIME_WITH_UNIT_PATTERN,
    (
      fullMatch,
      hStr: string,
      _sep: string,
      mStr: string,
      _unit: string | undefined,
      politeAfterUnit: string | undefined,
      _malformedNa: string | undefined,
      politeAfterNa: string | undefined,
    ) => {
      const parsed = isValidClockTime(hStr, mStr);
      if (!parsed) {
        return fullMatch;
      }

      const spokenTime = formatClockTimeToThaiSpeech(
        parsed.hour,
        parsed.minute,
      );
      const politeParticle = politeAfterUnit ?? politeAfterNa ?? '';
      return `${spokenTime}${politeParticle}`;
    },
  );

  // 4. Deduplicate adjacent polite particles if any existed in source text
  result = result.replace(DUPLICATE_POLITE_PARTICLE_PATTERN, '$1');

  return result;
}
