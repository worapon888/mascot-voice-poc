import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getOpenAIClient } from '@/lib/openai/client';
import { getSupabaseServerClient } from '@/lib/supabase/client';
import type { FaqRecord } from '@/types/faq';

export function computeFaqContentHash(faq: FaqRecord): string {
  const payload = `${faq.id}|${faq.question}|${faq.answer}|${(faq.keywords ?? []).sort().join(',')}`;
  return createHash('sha256').update(payload).digest('hex');
}

async function backfillFaqEmbeddings() {
  console.log(
    '======================================================================',
  );
  console.log(' Supabase Embeddings Backfill (OpenAI text-embedding-3-small)');
  console.log(
    '======================================================================\n',
  );

  const supabase = getSupabaseServerClient();
  const openai = getOpenAIClient();

  // 1. Fetch all active FAQs
  console.log('1. Fetching active FAQs from Supabase...');
  const { data: faqs, error: faqsErr } = await supabase
    .from('faqs')
    .select('*')
    .eq('is_active', true)
    .order('id', { ascending: true });

  if (faqsErr || !faqs) {
    console.error('Error fetching faqs:', faqsErr);
    process.exit(1);
  }

  console.log(`   Found ${faqs.length} active FAQs.\n`);

  // 2. Fetch existing embeddings
  const { data: existingEmbeddings } = await supabase
    .from('faq_embeddings')
    .select('faq_id, model_name, content_hash');

  const existingMap = new Set(
    (existingEmbeddings || []).map(
      (e) => `${e.faq_id}:${e.model_name}:${e.content_hash}`,
    ),
  );

  // 3. Identify FAQs needing embedding
  const toEmbed: FaqRecord[] = [];
  for (const faq of faqs) {
    const hash = computeFaqContentHash(faq);
    const key = `${faq.id}:text-embedding-3-small:${hash}`;
    if (!existingMap.has(key)) {
      toEmbed.push(faq);
    }
  }

  console.log(`2. FAQs requiring new embeddings: ${toEmbed.length}`);

  if (toEmbed.length > 0) {
    console.log('3. Generating embeddings with text-embedding-3-small...');
    const t0 = performance.now();
    const inputs = toEmbed.map(
      (f) =>
        `คำถาม: ${f.question} คำสำคัญ: ${(f.keywords ?? []).join(' ')} คำตอบ: ${f.answer}`,
    );

    const embedResp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: inputs,
    });
    const embedLatency = Math.round(performance.now() - t0);
    console.log(
      `   OpenAI response received in ${embedLatency} ms (${embedResp.usage.prompt_tokens} tokens)`,
    );

    const insertPayload = toEmbed.map((f, idx) => ({
      faq_id: f.id,
      model_name: 'text-embedding-3-small',
      model_version: 'v1',
      dimensions: 1536,
      content_hash: computeFaqContentHash(f),
      embedding: embedResp.data[idx].embedding,
    }));

    const { error: insertErr } = await supabase
      .from('faq_embeddings')
      .upsert(insertPayload, {
        onConflict: 'faq_id,model_name,content_hash',
      });

    if (insertErr) {
      console.error('Error upserting faq_embeddings:', insertErr);
      process.exit(1);
    }

    console.log(
      `   Successfully inserted ${insertPayload.length} embeddings.\n`,
    );
  } else {
    console.log('   All active FAQs are already up-to-date with embeddings.\n');
  }

  // 4. Test live match_faqs_hybrid RPC
  console.log('4. Testing live match_faqs_hybrid RPC call on Supabase...');
  const testQuery = 'วันเสาร์ที่นี่เปิดหรือเปล่า';
  console.log(`   Query: "${testQuery}"`);

  const tRpcStart = performance.now();
  const qEmbed = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: testQuery,
  });
  const qVector = qEmbed.data[0].embedding;

  const { data: rpcMatches, error: rpcErr } = await supabase.rpc(
    'match_faqs_hybrid',
    {
      query_text: testQuery,
      query_embedding: qVector,
      match_count: 3,
      rrf_k: 60,
    },
  );
  const totalRpcLatency = Math.round(performance.now() - tRpcStart);

  if (rpcErr) {
    console.error('RPC match_faqs_hybrid execution error:', rpcErr);
    process.exit(1);
  }

  console.log(
    `   RPC executed in ${totalRpcLatency} ms (including query embedding)`,
  );
  console.log('   Top Matches returned from Supabase:\n');
  console.log(JSON.stringify(rpcMatches, null, 2));

  console.log(
    '\n======================================================================',
  );
  console.log(' Backfill & Live RPC Verification COMPLETE!');
  console.log(
    '======================================================================\n',
  );
}

backfillFaqEmbeddings().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
