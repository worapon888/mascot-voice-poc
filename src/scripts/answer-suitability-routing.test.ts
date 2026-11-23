import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  evaluateAnswerSuitability,
  extractRequiredIntentSegments,
  type IntentCoverage,
} from '@/services/answer-suitability.service';
import { streamGroundedAnswerEvents } from '@/services/answer-stream.service';
import { retrieveMatchingFaqs } from '@/services/faq-matching.service';
import { executeHybridFaqRetrieval } from '@/services/hybrid-faq-retrieval.service';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

const OPENING_FAQ: FaqRecord = {
  id: 1,
  question: 'เปิดบริการกี่โมง',
  answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น.',
  keywords: ['เปิดบริการ', 'เวลาทำการ', 'เปิดกี่โมง'],
  is_active: true,
  created_at: new Date().toISOString(),
};

function coverage(
  requiredIntents: string[],
  supportingFaqIds: number[],
  uncoveredIntents: string[] = [],
): IntentCoverage {
  return {
    status:
      supportingFaqIds.length === 0
        ? 'NONE'
        : uncoveredIntents.length === 0
          ? 'COMPLETE'
          : 'PARTIAL',
    requiredIntents,
    supportingFaqIds,
    uncoveredIntents,
  };
}

function resolvedTier(
  result: Awaited<ReturnType<typeof retrieveMatchingFaqs>>,
) {
  return result.highConfidenceFastPath
    ? 'TIER_1'
    : result.matched
      ? 'TIER_2'
      : 'TIER_3';
}

function createSyntheticMp3Buffer(text: string): Buffer {
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
  ]);
  return Buffer.concat([
    header,
    Buffer.from(`SYNTHETIC_MP3_${text}_PADDING_BYTES`, 'utf8'),
  ]);
}

async function runAnswerSuitabilityRoutingTests() {
  process.env.FAQ_MATCHER = 'hybrid';

  // Generic language behavior on topics that are not part of the demo corpus.
  const novelDirect = evaluateAnswerSuitability({
    normalizedQuery: 'ศูนย์รับพัสดุเปิดตอนไหน',
    evidenceSufficiency: 'SUFFICIENT',
    exactQuestionMatch: false,
    contextualFollowUp: false,
    intentCoverage: coverage(['ศูนย์รับพัสดุเปิดตอนไหน'], [81]),
  });
  assert.equal(novelDirect.suitability, 'DIRECT');

  const novelConditional = evaluateAnswerSuitability({
    normalizedQuery: 'ถ้าส่งเอกสารก่อนเที่ยงจะรับคืนวันนี้ไหม',
    evidenceSufficiency: 'SUFFICIENT',
    exactQuestionMatch: false,
    contextualFollowUp: false,
    intentCoverage: coverage(['ถ้าส่งเอกสารก่อนเที่ยงจะรับคืนวันนี้ไหม'], [91]),
  });
  assert.equal(novelConditional.suitability, 'REQUIRES_SYNTHESIS');

  assert.deepEqual(
    extractRequiredIntentSegments('ศูนย์อาหารเปิดกี่โมงและรับบัตรเครดิตไหม'),
    ['ศูนย์อาหารเปิดกี่โมง', 'รับบัตรเครดิตไหม'],
  );

  const benchmarkStart = performance.now();
  for (let i = 0; i < 10_000; i++) {
    evaluateAnswerSuitability({
      normalizedQuery: 'ถ้าไปวันพฤหัสตอนบ่ายยังเปิดไหม',
      evidenceSufficiency: 'SUFFICIENT',
      exactQuestionMatch: false,
      contextualFollowUp: false,
      intentCoverage: coverage(['ถ้าไปวันพฤหัสตอนบ่ายยังเปิดไหม'], [1]),
    });
  }
  const suitabilityAvgMs = (performance.now() - benchmarkStart) / 10_000;
  assert.equal(suitabilityAvgMs < 1, true);

  const history: ConversationTurn[] = [
    { role: 'user', text: 'เปิดบริการกี่โมง', faqIds: [1] },
    { role: 'assistant', text: OPENING_FAQ.answer, faqIds: [1] },
  ];
  const cases: Array<{
    query: string;
    expectedTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
    expectedFaqIds?: number[];
    history?: ConversationTurn[];
  }> = [
    { query: 'เปิดบริการกี่โมง', expectedTier: 'TIER_1', expectedFaqIds: [1] },
    {
      query: 'จุดบริการเปิดตอนไหน',
      expectedTier: 'TIER_1',
      expectedFaqIds: [1],
    },
    { query: 'วันอังคารเปิดไหม', expectedTier: 'TIER_2', expectedFaqIds: [1] },
    {
      query: 'วันอังคารบ่ายสามยังเปิดอยู่ไหม',
      expectedTier: 'TIER_2',
      expectedFaqIds: [1],
    },
    {
      query: 'ถ้าไปวันอังคารบ่ายสามยังเปิดไหม',
      expectedTier: 'TIER_2',
      expectedFaqIds: [1],
    },
    {
      query: 'เปิดกี่โมงและต้องจองคิวไหม',
      expectedTier: 'TIER_2',
      expectedFaqIds: [1, 2],
    },
    {
      query: 'แล้ววันเสาร์ล่ะ',
      expectedTier: 'TIER_2',
      expectedFaqIds: [1],
      history,
    },
    {
      query: 'วันหยุดนักขัตฤกษ์เปิดไหม',
      expectedTier: 'TIER_2',
      expectedFaqIds: [1],
    },
    { query: 'วันนี้ฝนตกไหม', expectedTier: 'TIER_3', expectedFaqIds: [] },
  ];

  for (const testCase of cases) {
    const result = await retrieveMatchingFaqs(
      testCase.query,
      testCase.history ?? [],
    );
    assert.equal(resolvedTier(result), testCase.expectedTier, testCase.query);
    assert.deepEqual(
      result.faqs.map((faq) => faq.id),
      testCase.expectedFaqIds,
      testCase.query,
    );
  }

  // An exact FAQ outside the first ten records still uses the embedding-free path.
  const syntheticFaqs: FaqRecord[] = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    question: `ขั้นตอนบริการหมายเลข ${index + 1}`,
    answer: `ปฏิบัติตามขั้นตอนที่ได้รับอนุมัติหมายเลข ${index + 1}`,
    keywords: [`บริการหมายเลข ${index + 1}`],
    is_active: true,
    created_at: new Date().toISOString(),
  }));
  const outsideWindow = await executeHybridFaqRetrieval(
    syntheticFaqs[11].question,
    [],
    Promise.resolve(syntheticFaqs),
  );
  assert.equal(outsideWindow.faqs[0]?.id, 12);
  assert.equal(outsideWindow.highConfidenceFastPath, true);

  // Fabricated and unresolved held sentences must never reach TTS.
  const spokenTexts: string[] = [];
  const streamEvents = [];
  for await (const event of streamGroundedAnswerEvents({
    rawTranscript: 'วันเสาร์เปิดไหม',
    customRetriever: async () => ({
      normalizedTranscript: 'วันเสาร์เปิดไหม',
      coreQuery: 'วันเสาร์เปิด',
      matched: true,
      ambiguous: false,
      faqs: [OPENING_FAQ],
      scoredMatches: [],
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      retrievalLatencyMs: 1,
    }),
    customLlmStreamer: async function* () {
      yield 'จุดบริการ Demo เปิดทำการวันเสาร์และวันอาทิตย์ครับ';
    },
    customTtsGenerator: async (text) => {
      spokenTexts.push(text);
      return createSyntheticMp3Buffer(text);
    },
  })) {
    streamEvents.push(event);
  }
  assert.equal(
    spokenTexts.some((text) => text.includes('เปิดทำการวันเสาร์')),
    false,
  );
  assert.equal(spokenTexts.length, 1);
  const done = streamEvents.find((event) => event.event === 'done');
  assert.equal(String(done?.data.fullAnswer).includes('เปิดทำการวันเสาร์'), false);

  console.log(
    JSON.stringify({
      passed: true,
      cases: cases.length,
      suitabilityAvgMs: Math.round(suitabilityAvgMs * 1000) / 1000,
      multiIntentFaqIds: [1, 2],
      unsafeTtsCalls: 0,
    }),
  );
}

runAnswerSuitabilityRoutingTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
