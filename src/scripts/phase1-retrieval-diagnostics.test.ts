import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  getActiveFaqs,
  getFaqDbQueryCount,
  MAX_POC_FAQ_LIMIT,
  resetActiveFaqsCacheForTesting,
  resetFaqDbQueryCountForTesting,
} from '@/repositories/faq.repository';
import { streamGroundedAnswerEvents } from '@/services/answer-stream.service';
import {
  getPersistentAudioTelemetry,
  resetPersistentAudioTelemetry,
  resetPersistentFaqAudioCacheForTesting,
  resolvePersistentFaqAudioRef,
} from '@/services/faq-audio.service';
import { retrieveMatchingFaqs } from '@/services/faq-matching.service';
import {
  clearQueryEmbeddingCacheForTesting,
  executeHybridFaqRetrieval,
} from '@/services/hybrid-faq-retrieval.service';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

function createSyntheticMp3Buffer(text: string): Buffer {
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
  ]);
  return Buffer.concat([
    header,
    Buffer.from(`SYNTHETIC_MP3_${text}_PADDING_BYTES`, 'utf8'),
  ]);
}

async function runPhase1Tests() {
  process.env.FAQ_MATCHER = 'hybrid';
  console.log(
    '=== Phase 1: Retrieval & DB Optimization + Streaming Diagnostics ===',
  );

  const activeFaqs = await getActiveFaqs();
  assert.ok(activeFaqs.length > 0, 'Expected active FAQs in Supabase');
  assert.ok(
    activeFaqs.length < MAX_POC_FAQ_LIMIT,
    `Expected POC FAQ count (${activeFaqs.length}) < MAX_POC_FAQ_LIMIT (${MAX_POC_FAQ_LIMIT})`,
  );

  // 1. Cold Cache Paraphrase: DB queries = 2 (getActiveFaqs + match_faqs_hybrid RPC; skipped findActiveFaqByQuestion)
  //    AND Tier 1 persistent audio lookup = 0 storage reads (primed by RPC!)
  resetActiveFaqsCacheForTesting();
  resetPersistentFaqAudioCacheForTesting();
  resetPersistentAudioTelemetry();
  clearQueryEmbeddingCacheForTesting();
  resetFaqDbQueryCountForTesting();

  const coldPara = await executeHybridFaqRetrieval('จุดบริการเปิดตอนไหน', []);
  assert.equal(coldPara.matched, true);
  assert.equal(coldPara.highConfidenceFastPath, true);
  assert.equal(coldPara.faqs[0]?.id, 1);
  assert.equal(coldPara.answerSuitability, 'DIRECT');
  assert.equal(coldPara.retrievalMetrics?.dbQueries, 2);

  const audioLookupAfterRpc = await resolvePersistentFaqAudioRef(
    coldPara.faqs[0],
  );
  assert.equal(audioLookupAfterRpc.hit, true);
  assert.equal(audioLookupAfterRpc.lookupLatencyMs, 0);
  assert.equal(getPersistentAudioTelemetry().storageReadRequests, 0);
  console.log(
    `[PASS] Cold Paraphrase: dbQueries=${coldPara.retrievalMetrics?.dbQueries} (expected 2), persistentAudioStorageReads=0, retrievalMs=${coldPara.retrievalLatencyMs}`,
  );

  // 2. Warm Cache New Paraphrase: DB queries = 1 (match_faqs_hybrid RPC only)
  resetFaqDbQueryCountForTesting();
  const warmNewPara = await executeHybridFaqRetrieval(
    'วันอังคารบ่ายสามยังเปิดอยู่ไหม',
    [],
  );
  assert.equal(warmNewPara.matched, true);
  assert.equal(warmNewPara.highConfidenceFastPath, false);
  assert.equal(warmNewPara.answerSuitability, 'REQUIRES_SYNTHESIS');
  assert.equal(warmNewPara.faqs[0]?.id, 1);
  assert.equal(warmNewPara.retrievalMetrics?.dbQueries, 1);
  assert.equal(warmNewPara.retrievalMetrics?.faqCacheHit, true);
  console.log(
    `[PASS] Warm Cache New Paraphrase: dbQueries=${warmNewPara.retrievalMetrics?.dbQueries} (expected 1), suitability=${warmNewPara.answerSuitability}`,
  );

  // 3. Follow-up with History (Warm FAQ Cache): DB queries = 1 (skipped getActiveFaqsByIds & findActiveFaqByQuestion)
  const history: ConversationTurn[] = [
    { role: 'user', text: 'เปิดบริการกี่โมง', faqIds: [1] },
    { role: 'assistant', text: activeFaqs[0].answer, faqIds: [1] },
  ];
  resetFaqDbQueryCountForTesting();
  const followUpRes = await executeHybridFaqRetrieval('แล้ววันเสาร์ล่ะ', history);
  assert.equal(followUpRes.matched, true);
  assert.equal(followUpRes.highConfidenceFastPath, false);
  assert.equal(followUpRes.faqs[0]?.id, 1);
  assert.equal(followUpRes.answerSuitability, 'REQUIRES_SYNTHESIS');
  assert.equal(followUpRes.retrievalMetrics?.dbQueries, 1);
  console.log(
    `[PASS] Follow-up with History: dbQueries=${followUpRes.retrievalMetrics?.dbQueries} (expected 1), retrievalMs=${followUpRes.retrievalLatencyMs}`,
  );

  // 4. Exact Question Fast Path (Warm): DB queries = 0
  resetFaqDbQueryCountForTesting();
  const exactRes = await executeHybridFaqRetrieval('เปิดบริการกี่โมง', []);
  assert.equal(exactRes.highConfidenceFastPath, true);
  assert.equal(exactRes.fastPathMatchReason, 'EXACT_QUESTION');
  assert.equal(exactRes.retrievalMetrics?.dbQueries, 0);
  assert.equal(getFaqDbQueryCount(), 0);
  console.log(
    `[PASS] Exact Match (Warm): dbQueries=0, retrievalMs=${exactRes.retrievalLatencyMs}`,
  );

  // 5. Beyond-10-FAQ Exact Fast Path safety (synthetic 12-item corpus)
  const syntheticFaqs: FaqRecord[] = Array.from({ length: 12 }, (_, idx) => ({
    id: idx + 1,
    question: `คำถามทดสอบลำดับที่ ${idx + 1}`,
    answer: `คำตอบทดสอบลำดับที่ ${idx + 1}`,
    keywords: [`ทดสอบ ${idx + 1}`],
    is_active: true,
    created_at: new Date().toISOString(),
  }));
  const beyondTenRes = await executeHybridFaqRetrieval(
    syntheticFaqs[11].question,
    [],
    Promise.resolve(syntheticFaqs),
  );
  assert.equal(beyondTenRes.highConfidenceFastPath, true);
  assert.equal(beyondTenRes.faqs[0]?.id, 12);
  console.log('[PASS] Beyond-10-FAQ Exact Match safety preserved');

  // 6. Streaming Diagnostics Events (Tier 1 & Tier 2)
  const tier1Events: Array<{ event: string; data: Record<string, unknown> }> =
    [];
  for await (const ev of streamGroundedAnswerEvents({
    rawTranscript: 'จุดบริการเปิดตอนไหน',
  })) {
    tier1Events.push(ev);
  }
  const t1RetrievalEv = tier1Events.find(
    (e) => e.event === 'retrieval_complete',
  );
  const t1DoneEv = tier1Events.find((e) => e.event === 'done');
  assert.ok(t1RetrievalEv?.data.retrievalMetrics);
  assert.equal(t1DoneEv?.data.tier, 'TIER_1');
  const t1Timings = t1DoneEv?.data.timings as Record<string, unknown>;
  assert.equal(typeof t1Timings.retrievalMs, 'number');
  assert.equal(typeof t1Timings.persistentAudioLookupMs, 'number');
  assert.equal(t1Timings.persistentAudioCacheHit, true);
  console.log(
    '[PASS] Tier 1 Streaming Diagnostics:',
    JSON.stringify(t1Timings),
  );

  const tier2Events: Array<{ event: string; data: Record<string, unknown> }> =
    [];
  for await (const ev of streamGroundedAnswerEvents({
    rawTranscript: 'วันเสาร์เปิดไหม',
    customRetriever: async () => ({
      normalizedTranscript: 'วันเสาร์เปิดไหม',
      coreQuery: 'วันเสาร์เปิด',
      matched: true,
      ambiguous: false,
      faqs: [activeFaqs[0]],
      scoredMatches: [],
      highConfidenceFastPath: false,
      fastPathMatchReason: 'NONE',
      retrievalLatencyMs: 5,
      retrievalMetrics: {
        dbQueries: 1,
        faqCacheHit: true,
        embeddingCalled: false,
        embeddingCacheHit: true,
        embeddingMs: 0,
        rpcMs: 4,
      },
    }),
    customLlmStreamer: async function* () {
      yield 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ';
    },
    customTtsGenerator: async (text) => createSyntheticMp3Buffer(text),
  })) {
    tier2Events.push(ev);
  }
  const t2DoneEv = tier2Events.find((e) => e.event === 'done');
  const t2Timings = t2DoneEv?.data.timings as Record<string, unknown>;
  assert.equal(typeof t2Timings.llmTtftMs, 'number');
  assert.equal(typeof t2Timings.firstSentenceMs, 'number');
  assert.equal(typeof t2Timings.firstAudioReadyMs, 'number');
  assert.equal(typeof t2Timings.ttsMs, 'number');
  assert.ok(t2Timings.retrievalMetrics);
  console.log(
    '[PASS] Tier 2 Streaming Diagnostics:',
    JSON.stringify(t2Timings),
  );

  // 7. Measure 10-round Warm Retrieval & Tier 1 First Audio Latency after Phase 1
  const followUpLatencies: number[] = [];
  const tier1StreamLatencies: number[] = [];
  for (let i = 0; i < 10; i++) {
    const tf0 = performance.now();
    await retrieveMatchingFaqs('แล้ววันเสาร์ล่ะ', history);
    followUpLatencies.push(performance.now() - tf0);

    const ts0 = performance.now();
    for await (const ev of streamGroundedAnswerEvents({
      rawTranscript: 'จุดบริการเปิดตอนไหน',
    })) {
      if (ev.event === 'tier') {
        tier1StreamLatencies.push(performance.now() - ts0);
      }
    }
  }
  followUpLatencies.sort((a, b) => a - b);
  tier1StreamLatencies.sort((a, b) => a - b);
  console.log(
    `[METRICS] Follow-up Retrieval Warm Median=${followUpLatencies[4].toFixed(1)}ms (before Phase 1: 437.9ms) | Tier 1 Stream-to-Tier Median=${tier1StreamLatencies[4].toFixed(1)}ms`,
  );
}

runPhase1Tests().catch((err) => {
  console.error(err);
  process.exit(1);
});
