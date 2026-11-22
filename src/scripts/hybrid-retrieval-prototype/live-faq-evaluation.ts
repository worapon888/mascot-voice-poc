import { performance } from 'node:perf_hooks';
import { getOpenAIClient } from '@/lib/openai/client';
import { matchFaqsWithConversationContext } from '@/services/faq-matching.service';
import type { FaqRecord } from '@/types/faq';
import { EVALUATION_DATASET } from './evaluation-dataset';
import { HybridRanker } from './hybrid-ranker';
import { LexicalSearchEngine } from './lexical-engine';
import { cosineSimilarity } from './semantic-engine';
import { REAL_SEEDED_FAQS } from './synthetic-faq-generator';
import type { SemanticSearchResult } from './types';

interface EvaluationRunResult {
  methodName: string;
  totalQueries: number;
  expectedMatchCount: number;
  outOfScopeCount: number;
  correctTop1: number;
  correctTop3: number;
  recallAt1: number;
  recallAt3: number;
  precisionAt1: number;
  falsePositives: number;
  falsePositiveRate: number;
  correctFallbacks: number;
  fallbackAccuracy: number;
  correctTierRoutings: number;
  tierRoutingAccuracy: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
  breakdownByCategory: Record<
    string,
    { total: number; correctFaq: number; correctTier: number }
  >;
}

async function runLiveFaqEvaluation() {
  console.log(
    '================================================================================',
  );
  console.log(
    ' LIVE EVALUATION: REAL 5 FAQS & OPENAI EMBEDDINGS (text-embedding-3-small)',
  );
  console.log(
    '================================================================================\n',
  );

  const openai = getOpenAIClient();
  const faqs: FaqRecord[] = REAL_SEEDED_FAQS;

  console.log('1. Real FAQ Corpus (from Supabase Source of Truth):');
  faqs.forEach((f) => {
    console.log(`   [ID ${f.id}] Q: "${f.question}"`);
    console.log(`            A: "${f.answer}"`);
    console.log(`            Keywords: [${(f.keywords ?? []).join(', ')}]`);
  });
  console.log('');

  // 1. Compute Live Embeddings for the 5 Real FAQs
  console.log('2. Computing Live OpenAI Embeddings for the 5 Real FAQs...');
  const tFaq0 = performance.now();
  const faqCorpusTexts = faqs.map(
    (f) =>
      `คำถาม: ${f.question} คำสำคัญ: ${(f.keywords ?? []).join(' ')} คำตอบ: ${f.answer}`,
  );

  const faqEmbeddingResp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: faqCorpusTexts,
  });
  const faqEmbedTimeMs = Math.round(performance.now() - tFaq0);
  const faqTokens = faqEmbeddingResp.usage.prompt_tokens;
  const faqCostUsd = (faqTokens / 1_000_000) * 0.02;

  console.log(`   Indexed 5 FAQs in ${faqEmbedTimeMs} ms`);
  console.log(
    `   Tokens: ${faqTokens} | Cost: $${faqCostUsd.toFixed(8)} USD\n`,
  );

  const faqVectors = faqEmbeddingResp.data.map((d, i) => ({
    faq: faqs[i],
    embedding: d.embedding,
  }));

  // Build Lexical Engine
  const lexicalEngine = new LexicalSearchEngine(faqs);
  const hybridRanker = new HybridRanker();

  // 2. Query Live Embeddings for all 27 Evaluation Dataset queries
  console.log(
    `3. Querying Live Embeddings for ${EVALUATION_DATASET.length} Evaluation Queries...`,
  );
  let totalQueryTokens = faqTokens;
  const queryLatencies: number[] = [];
  const queryVectors: number[][] = [];

  for (let i = 0; i < EVALUATION_DATASET.length; i++) {
    const item = EVALUATION_DATASET[i];
    const tStart = performance.now();
    const qResp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: item.query,
    });
    const lat = Math.round((performance.now() - tStart) * 100) / 100;
    queryLatencies.push(lat);
    totalQueryTokens += qResp.usage.prompt_tokens;
    queryVectors.push(qResp.data[0].embedding);
  }

  const queryEmbedTotalCostUsd = (totalQueryTokens / 1_000_000) * 0.02;
  console.log(
    `   Completed 27 live embedding calls. Total tokens: ${totalQueryTokens} | Total cost: $${queryEmbedTotalCostUsd.toFixed(8)} USD\n`,
  );

  // ---------------------------------------------------------------------------
  // Evaluate Method 1: Current Hardcoded Matcher
  // ---------------------------------------------------------------------------
  function runMethod1(): EvaluationRunResult {
    const latencies: number[] = [];
    let correctTop1 = 0;
    let correctTop3 = 0;
    let falsePositives = 0;
    let correctFallbacks = 0;
    let correctTierRoutings = 0;
    const catMap: Record<
      string,
      { total: number; correctFaq: number; correctTier: number }
    > = {};

    for (let i = 0; i < EVALUATION_DATASET.length; i++) {
      const item = EVALUATION_DATASET[i];
      if (!catMap[item.category]) {
        catMap[item.category] = { total: 0, correctFaq: 0, correctTier: 0 };
      }
      catMap[item.category].total++;

      const t0 = performance.now();
      const match = matchFaqsWithConversationContext(
        item.query,
        faqs,
        item.contextHistory || [],
      );
      latencies.push(performance.now() - t0);

      const topFaq = match.faqs && match.faqs.length > 0 ? match.faqs[0] : null;
      const topFaqId = match.matched && topFaq ? topFaq.id : null;
      const suggestedTier = match.highConfidenceFastPath
        ? 'TIER_1'
        : match.matched
          ? 'TIER_2'
          : 'TIER_3';

      if (item.expectedFaqId !== null) {
        if (topFaqId === item.expectedFaqId) {
          correctTop1++;
          correctTop3++;
          catMap[item.category].correctFaq++;
        }
      } else {
        if (topFaqId === null || suggestedTier !== 'TIER_1') {
          correctFallbacks++;
          catMap[item.category].correctFaq++;
        } else {
          falsePositives++;
        }
      }

      if (suggestedTier === item.expectedTier) {
        correctTierRoutings++;
        catMap[item.category].correctTier++;
      }
    }

    return computeStats(
      'Current Hardcoded Matcher',
      latencies,
      correctTop1,
      correctTop3,
      falsePositives,
      correctFallbacks,
      correctTierRoutings,
      catMap,
      0,
      0,
    );
  }

  // ---------------------------------------------------------------------------
  // Evaluate Method 2: Pure Dense Semantic Search (Live text-embedding-3-small)
  // ---------------------------------------------------------------------------
  function runMethod2(): EvaluationRunResult {
    const latencies: number[] = [];
    let correctTop1 = 0;
    let correctTop3 = 0;
    let falsePositives = 0;
    let correctFallbacks = 0;
    let correctTierRoutings = 0;
    const catMap: Record<
      string,
      { total: number; correctFaq: number; correctTier: number }
    > = {};

    for (let i = 0; i < EVALUATION_DATASET.length; i++) {
      const item = EVALUATION_DATASET[i];
      const qVec = queryVectors[i];
      if (!catMap[item.category]) {
        catMap[item.category] = { total: 0, correctFaq: 0, correctTier: 0 };
      }
      catMap[item.category].total++;

      const t0 = performance.now();
      const ranked = faqVectors
        .map((fv) => ({
          faq: fv.faq,
          similarity: cosineSimilarity(qVec, fv.embedding),
        }))
        .sort((a, b) => b.similarity - a.similarity);

      const top1 = ranked[0];
      const top2 = ranked[1];
      const margin = top2 ? top1.similarity - top2.similarity : top1.similarity;
      const searchLatency = performance.now() - t0 + (queryLatencies[i] || 400);
      latencies.push(searchLatency);

      // Raw semantic decision:
      // In Thai text-embedding-3-small, true matches have sim 0.28-0.45 with margin > 0.04
      const isConfident = top1.similarity >= 0.28 && margin >= 0.04;
      const topFaqId = isConfident ? top1.faq.id : null;
      const suggestedTier = isConfident
        ? top1.similarity >= 0.35
          ? 'TIER_1'
          : 'TIER_2'
        : 'TIER_3';

      if (item.expectedFaqId !== null) {
        if (topFaqId === item.expectedFaqId) {
          correctTop1++;
          catMap[item.category].correctFaq++;
        }
        if (ranked.slice(0, 3).some((r) => r.faq.id === item.expectedFaqId)) {
          correctTop3++;
        }
      } else {
        if (topFaqId === null || suggestedTier !== 'TIER_1') {
          correctFallbacks++;
          catMap[item.category].correctFaq++;
        } else {
          falsePositives++;
        }
      }

      if (suggestedTier === item.expectedTier) {
        correctTierRoutings++;
        catMap[item.category].correctTier++;
      }
    }

    return computeStats(
      'Pure Dense Semantic (Live Embeddings)',
      latencies,
      correctTop1,
      correctTop3,
      falsePositives,
      correctFallbacks,
      correctTierRoutings,
      catMap,
      totalQueryTokens,
      queryEmbedTotalCostUsd,
    );
  }

  // ---------------------------------------------------------------------------
  // Evaluate Method 3: Proposed Hybrid Retrieval (Live Embeddings + BM25 + RRF + Sufficiency)
  // ---------------------------------------------------------------------------
  function runMethod3(): EvaluationRunResult {
    const latencies: number[] = [];
    let correctTop1 = 0;
    let correctTop3 = 0;
    let falsePositives = 0;
    let correctFallbacks = 0;
    let correctTierRoutings = 0;
    const catMap: Record<
      string,
      { total: number; correctFaq: number; correctTier: number }
    > = {};

    for (let i = 0; i < EVALUATION_DATASET.length; i++) {
      const item = EVALUATION_DATASET[i];
      const qVec = queryVectors[i];
      if (!catMap[item.category]) {
        catMap[item.category] = { total: 0, correctFaq: 0, correctTier: 0 };
      }
      catMap[item.category].total++;

      const t0 = performance.now();

      // Stage A: Lexical Search
      const lexResults = lexicalEngine.search(item.query, 5);

      // Fast Path check: if exact question match, embedding latency = 0 ms
      const isExactMatch =
        lexResults[0] &&
        lexResults[0].matchedTerms.includes('exact_question') &&
        lexResults[0].score >= 100;
      const embeddingTime = isExactMatch ? 0 : queryLatencies[i] || 400;

      // Stage B: Semantic Search
      const semResults: SemanticSearchResult[] = faqVectors
        .map((fv) => ({
          faq: fv.faq,
          similarity: cosineSimilarity(qVec, fv.embedding),
          rank: 0,
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 5)
        .map((item, idx) => ({ ...item, rank: idx + 1 }));

      // Stage C & D: RRF Ranker & Evidence Sufficiency Check
      const hybridResults = hybridRanker.rank(
        item.query,
        lexResults,
        semResults,
        item.contextHistory || [],
      );
      const totalElapsed = performance.now() - t0 + embeddingTime;
      latencies.push(totalElapsed);

      const topResult = hybridResults[0];
      const topFaqId =
        topResult && topResult.confidence !== 'LOW' ? topResult.faq.id : null;
      const suggestedTier = topResult ? topResult.suggestedTier : 'TIER_3';

      if (item.expectedFaqId !== null) {
        if (topFaqId === item.expectedFaqId) {
          correctTop1++;
          catMap[item.category].correctFaq++;
        }
        if (
          hybridResults.slice(0, 3).some((r) => r.faq.id === item.expectedFaqId)
        ) {
          correctTop3++;
        }
      } else {
        if (topFaqId === null || suggestedTier !== 'TIER_1') {
          correctFallbacks++;
          catMap[item.category].correctFaq++;
        } else {
          falsePositives++;
        }
      }

      if (suggestedTier === item.expectedTier) {
        correctTierRoutings++;
        catMap[item.category].correctTier++;
      }
    }

    return computeStats(
      'Proposed Hybrid Retrieval (BM25 + Live Embeddings)',
      latencies,
      correctTop1,
      correctTop3,
      falsePositives,
      correctFallbacks,
      correctTierRoutings,
      catMap,
      totalQueryTokens,
      queryEmbedTotalCostUsd,
    );
  }

  function computeStats(
    name: string,
    latencies: number[],
    c1: number,
    c3: number,
    fp: number,
    fb: number,
    ctr: number,
    catMap: Record<
      string,
      { total: number; correctFaq: number; correctTier: number }
    >,
    tokens: number,
    cost: number,
  ): EvaluationRunResult {
    const total = EVALUATION_DATASET.length;
    const matchExpected = EVALUATION_DATASET.filter(
      (i) => i.expectedFaqId !== null,
    ).length;
    const oosExpected = EVALUATION_DATASET.filter(
      (i) => i.expectedFaqId === null,
    ).length;

    const sortedLats = [...latencies].sort((a, b) => a - b);
    const p95Idx = Math.floor(sortedLats.length * 0.95);

    return {
      methodName: name,
      totalQueries: total,
      expectedMatchCount: matchExpected,
      outOfScopeCount: oosExpected,
      correctTop1: c1,
      correctTop3: c3,
      recallAt1: Math.round((c1 / matchExpected) * 1000) / 10,
      recallAt3: Math.round((c3 / matchExpected) * 1000) / 10,
      precisionAt1: Math.round((c1 / (c1 + fp || 1)) * 1000) / 10,
      falsePositives: fp,
      falsePositiveRate: Math.round((fp / oosExpected) * 1000) / 10,
      correctFallbacks: fb,
      fallbackAccuracy: Math.round((fb / oosExpected) * 1000) / 10,
      correctTierRoutings: ctr,
      tierRoutingAccuracy: Math.round((ctr / total) * 1000) / 10,
      minLatencyMs: Math.round(sortedLats[0] * 100) / 100,
      maxLatencyMs: Math.round(sortedLats[sortedLats.length - 1] * 100) / 100,
      avgLatencyMs:
        Math.round((latencies.reduce((a, b) => a + b, 0) / total) * 100) / 100,
      p95LatencyMs: Math.round(sortedLats[p95Idx] * 100) / 100,
      totalTokens: tokens,
      totalCostUsd: cost,
      breakdownByCategory: catMap,
    };
  }

  const res1 = runMethod1();
  const res2 = runMethod2();
  const res3 = runMethod3();

  console.log(
    '========================================================================================================================',
  );
  console.log(
    ' COMPARATIVE EVALUATION RESULTS (REAL FAQS & LIVE OPENAI EMBEDDINGS)',
  );
  console.log(
    '========================================================================================================================\n',
  );

  const printTable = [res1, res2, res3].map((r) => ({
    Method: r.methodName,
    'Recall@1': `${r.recallAt1}% (${r.correctTop1}/${r.expectedMatchCount})`,
    'Recall@3': `${r.recallAt3}% (${r.correctTop3}/${r.expectedMatchCount})`,
    'Precision@1': `${r.precisionAt1}%`,
    'False Pos Rate': `${r.falsePositiveRate}% (${r.falsePositives}/${r.outOfScopeCount})`,
    'Fallback Acc': `${r.fallbackAccuracy}% (${r.correctFallbacks}/${r.outOfScopeCount})`,
    'Tier Routing Acc': `${r.tierRoutingAccuracy}% (${r.correctTierRoutings}/${r.totalQueries})`,
    'Avg Latency': `${r.avgLatencyMs} ms`,
    'P95 Latency': `${r.p95LatencyMs} ms`,
  }));

  console.table(printTable);

  console.log(
    '\n--- DETAILED CATEGORY ACCURACY BREAKDOWN (Correct FAQ / Correct Tier) ---',
  );
  for (const cat of Object.keys(res3.breakdownByCategory)) {
    const b1 = res1.breakdownByCategory[cat];
    const b2 = res2.breakdownByCategory[cat];
    const b3 = res3.breakdownByCategory[cat];
    console.log(
      `${cat.padEnd(35)} | Total: ${b3.total} | Matcher: ${b1.correctFaq}/${b1.correctTier} | Semantic: ${b2.correctFaq}/${b2.correctTier} | Hybrid: ${b3.correctFaq}/${b3.correctTier}`,
    );
  }

  console.log('\n--- TOKEN AND COST METRICS (MEASURED LIVE) ---');
  console.log(`OpenAI Model: text-embedding-3-small (1536 dim)`);
  console.log(`Total Tokens Used: ${totalQueryTokens} tokens`);
  console.log(
    `Total Actual Cost: $${queryEmbedTotalCostUsd.toFixed(8)} USD (~${(queryEmbedTotalCostUsd * 35).toFixed(4)} THB)`,
  );
  console.log(
    `Cost per 1,000 queries: $${((queryEmbedTotalCostUsd / 27) * 1000).toFixed(6)} USD (~${((queryEmbedTotalCostUsd / 27) * 1000 * 35).toFixed(4)} THB)`,
  );
  console.log(
    '========================================================================================================================\n',
  );
}

runLiveFaqEvaluation().catch((err) => {
  console.error('Live evaluation failed:', err);
  process.exit(1);
});
