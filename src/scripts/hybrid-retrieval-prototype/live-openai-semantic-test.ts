import { performance } from 'node:perf_hooks';
import { getOpenAIClient } from '@/lib/openai/client';
import { cosineSimilarity } from './semantic-engine';
import { REAL_SEEDED_FAQS } from './synthetic-faq-generator';

async function runLiveOpenAiSemanticTest() {
  console.log(
    '======================================================================',
  );
  console.log(' Live OpenAI Semantic Embedding Test (text-embedding-3-small)');
  console.log(
    '======================================================================\n',
  );

  const openai = getOpenAIClient();

  // 1. Embed the 5 Real FAQs
  console.log('1. Embedding 5 Base FAQs into Vector Memory...');
  const t0 = performance.now();
  const faqInputs = REAL_SEEDED_FAQS.map(
    (f) =>
      `คำถาม: ${f.question} คำสำคัญ: ${(f.keywords ?? []).join(' ')} คำตอบ: ${f.answer}`,
  );

  const faqEmbeddingResp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: faqInputs,
  });
  const faqEmbedTime = Math.round(performance.now() - t0);
  const faqTokens = faqEmbeddingResp.usage.prompt_tokens;
  const faqCostUsd = (faqTokens / 1_000) * 0.00002;

  console.log(`   Indexed 5 FAQs in ${faqEmbedTime} ms`);
  console.log(
    `   Tokens: ${faqTokens} tokens | Estimated Cost: $${faqCostUsd.toFixed(6)} USD\n`,
  );

  const faqVectors = faqEmbeddingResp.data.map((d, i) => ({
    faq: REAL_SEEDED_FAQS[i],
    embedding: d.embedding,
  }));

  // 2. Test Key User Queries
  const testQueries = [
    { q: 'วันเสาร์ที่นี่เปิดหรือเปล่า', expectedFaqId: 1 },
    { q: 'เปิดวันไหนบ้าง', expectedFaqId: 1 },
    { q: 'เปิดในเบราว์เซอร์ไหนบ้าง', expectedFaqId: 4 },
    { q: 'เปิดผ่านมือถือได้หรือเปล่า', expectedFaqId: 4 },
    { q: 'วอล์คอินเข้าไปได้เลยไหม', expectedFaqId: 2 },
    { q: 'จะไปใช้บริการต้องเอาอะไรไปบ้าง', expectedFaqId: 3 },
    { q: 'ค่าบริการเท่าไหร่', expectedFaqId: null },
    { q: 'ห้องน้ำอยู่ตรงไหน', expectedFaqId: null },
  ];

  console.log('2. Querying Live Embeddings & Measuring Cosine Similarity:');
  console.log(
    '----------------------------------------------------------------------',
  );

  let totalQueryTokens = 0;
  const queryLatencies: number[] = [];

  for (const tq of testQueries) {
    const tqStart = performance.now();
    const qResp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: tq.q,
    });
    const qLatency = Math.round(performance.now() - tqStart);
    queryLatencies.push(qLatency);
    totalQueryTokens += qResp.usage.prompt_tokens;

    const qVec = qResp.data[0].embedding;

    // Rank against 5 FAQs
    const ranked = faqVectors
      .map((fv) => ({
        faq: fv.faq,
        sim: cosineSimilarity(qVec, fv.embedding),
      }))
      .sort((a, b) => b.sim - a.sim);

    const top = ranked[0];
    const top2 = ranked[1];
    const margin = top.sim - top2.sim;

    const matchedId = top.sim >= 0.5 ? top.faq.id : null;
    const matchStatus =
      matchedId === tq.expectedFaqId
        ? 'MATCH'
        : tq.expectedFaqId === null
          ? 'OUT_OF_SCOPE'
          : 'MISMATCH';

    console.log(`Query: "${tq.q}"`);
    console.log(
      `  Top 1: FAQ #${top.faq.id} (${top.faq.question}) | Similarity: ${(top.sim * 100).toFixed(1)}%`,
    );
    console.log(
      `  Top 2: FAQ #${top2.faq.id} (${top2.faq.question}) | Similarity: ${(top2.sim * 100).toFixed(1)}% | Margin: ${(margin * 100).toFixed(1)}%`,
    );
    console.log(
      `  Expected: ${tq.expectedFaqId ? `FAQ #${tq.expectedFaqId}` : 'None'} | Outcome: ${matchStatus} | Latency: ${qLatency} ms\n`,
    );
  }

  const avgLatency = Math.round(
    queryLatencies.reduce((a, b) => a + b, 0) / queryLatencies.length,
  );
  const totalCostUsd = ((faqTokens + totalQueryTokens) / 1_000) * 0.00002;

  console.log(
    '----------------------------------------------------------------------',
  );
  console.log(`Live Test Summary:`);
  console.log(
    `  Total OpenAI Embedding API Calls: ${1 + testQueries.length} (1 batch index + ${testQueries.length} queries)`,
  );
  console.log(
    `  Total Tokens Consumed: ${faqTokens + totalQueryTokens} tokens`,
  );
  console.log(`  Total Incurred Cost: $${totalCostUsd.toFixed(6)} USD`);
  console.log(`  Average Query Embedding Latency: ${avgLatency} ms`);
  console.log(
    '======================================================================\n',
  );
}

runLiveOpenAiSemanticTest().catch(console.error);
