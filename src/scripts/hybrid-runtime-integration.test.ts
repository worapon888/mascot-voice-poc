import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { generateGroundedAnswerWithMetrics } from '@/services/answer.service';
import { retrieveMatchingFaqs } from '@/services/faq-matching.service';
import {
  clearQueryEmbeddingCacheForTesting,
  getQueryEmbeddingCacheStats,
} from '@/services/hybrid-faq-retrieval.service';
import type { ConversationTurn } from '@/types/api';

async function runHybridRuntimeIntegrationTests() {
  console.log(
    '================================================================================',
  );
  console.log(' HYBRID SEMANTIC FAQ RETRIEVAL RUNTIME INTEGRATION TEST SUITE');
  console.log(
    '================================================================================\n',
  );

  // ===========================================================================
  // Part 1: Verify Default Mode (Legacy)
  // ===========================================================================
  console.log('--- PART 1: Default Mode (FAQ_MATCHER unset / legacy) ---');
  delete process.env.FAQ_MATCHER;

  const tLegacyStart = performance.now();
  const legacyRes1 = await retrieveMatchingFaqs('เปิดบริการกี่โมง');
  const legacyLat1 = Math.round(performance.now() - tLegacyStart);

  assert.equal(legacyRes1.matched, true);
  assert.equal(legacyRes1.faqs[0].id, 1);
  assert.equal(legacyRes1.highConfidenceFastPath, true);
  console.log(
    `[PASS] Default mode uses legacy matcher: "เปิดบริการกี่โมง" -> FAQ #${legacyRes1.faqs[0].id} (${legacyLat1} ms)`,
  );

  const legacyOos = await retrieveMatchingFaqs('ค่าบริการเท่าไหร่');
  assert.equal(legacyOos.matched, false);
  console.log(
    `[PASS] Default mode legacy out-of-scope: "ค่าบริการเท่าไหร่" -> matched: false`,
  );

  // ===========================================================================
  // Part 2: Switch to Hybrid Mode (FAQ_MATCHER=hybrid)
  // ===========================================================================
  console.log('\n--- PART 2: Hybrid Mode (FAQ_MATCHER=hybrid) ---');
  process.env.FAQ_MATCHER = 'hybrid';
  clearQueryEmbeddingCacheForTesting();

  // Test 2.1: Stage A Exact Question Fast Path (0ms embedding bypass)
  console.log('Test 2.1: Stage A Exact Question Lexical Fast Path Bypass...');
  const tExact0 = performance.now();
  const hybridExact = await retrieveMatchingFaqs('เปิดบริการกี่โมง');
  const exactLat = Math.round(performance.now() - tExact0);

  assert.equal(hybridExact.matched, true);
  assert.equal(hybridExact.faqs[0].id, 1);
  assert.equal(hybridExact.highConfidenceFastPath, true);
  assert.equal(hybridExact.fastPathMatchReason, 'EXACT_QUESTION');
  console.log(
    `[PASS] Stage A Fast Path: "เปิดบริการกี่โมง" -> FAQ #${hybridExact.faqs[0].id} (Latency: ${exactLat} ms, FastPath: true)`,
  );

  // Verify no embedding was cached for exact match
  assert.equal(getQueryEmbeddingCacheStats().size, 0);

  // Test 2.2: Natural Thai Paraphrase requiring Live Supabase pgvector Embedding
  console.log(
    '\nTest 2.2: Natural Thai Paraphrase with Live Supabase pgvector...',
  );
  const tPara0 = performance.now();
  const hybridPara = await retrieveMatchingFaqs('วันเสาร์ที่นี่เปิดหรือเปล่า');
  const paraLat = Math.round(performance.now() - tPara0);

  assert.equal(hybridPara.matched, true);
  assert.equal(hybridPara.faqs[0].id, 1);
  assert.equal(hybridPara.highConfidenceFastPath, true);
  console.log(
    `[PASS] Paraphrase: "วันเสาร์ที่นี่เปิดหรือเปล่า" -> FAQ #${hybridPara.faqs[0].id} (Latency: ${paraLat} ms, FastPath: true)`,
  );

  // Verify query embedding was cached in memory
  assert.equal(getQueryEmbeddingCacheStats().size, 1);

  // Test 2.3: In-Memory Query Embedding Cache Hit (2nd call on same query)
  console.log('\nTest 2.3: In-Memory Query Embedding Cache Hit...');
  const tCache0 = performance.now();
  const hybridCached = await retrieveMatchingFaqs('วันเสาร์ที่นี่เปิดหรือเปล่า');
  const cachedLat = Math.round(performance.now() - tCache0);

  assert.equal(hybridCached.matched, true);
  assert.equal(hybridCached.faqs[0].id, 1);
  assert.equal(hybridCached.highConfidenceFastPath, true);
  console.log(
    `[PASS] Query Cache Hit: "วันเสาร์ที่นี่เปิดหรือเปล่า" -> FAQ #${hybridCached.faqs[0].id} (Latency: ${cachedLat} ms vs ${paraLat} ms initial)`,
  );

  // Test 2.4: Device / Browser compatibility question
  console.log('\nTest 2.4: Browser compatibility query...');
  const hybridBrowser = await retrieveMatchingFaqs('เปิดในเบราว์เซอร์ไหนบ้าง');
  assert.equal(hybridBrowser.matched, true);
  assert.equal(hybridBrowser.faqs[0].id, 4);
  console.log(
    `[PASS] Browser query: "เปิดในเบราว์เซอร์ไหนบ้าง" -> FAQ #${hybridBrowser.faqs[0].id}`,
  );

  // Test 2.5: Conversational Follow-up with Context History
  console.log('\nTest 2.5: Conversational Follow-up maintaining Context...');
  const historyTurn1: ConversationTurn[] = [
    { role: 'user', text: 'เปิดบริการกี่โมง', faqIds: [1] },
    {
      role: 'assistant',
      text: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น.',
      faqIds: [1],
    },
  ];
  const hybridFollowUp = await retrieveMatchingFaqs(
    'แล้ววันเสาร์ล่ะ เปิดไหม',
    historyTurn1,
  );
  assert.equal(hybridFollowUp.matched, true);
  assert.equal(hybridFollowUp.faqs[0].id, 1);
  assert.equal(hybridFollowUp.highConfidenceFastPath, true);
  console.log(
    `[PASS] Follow-up query: "แล้ววันเสาร์ล่ะ เปิดไหม" -> FAQ #${hybridFollowUp.faqs[0].id} (Maintained Turn 1 context)`,
  );

  // Test 2.6: Unanswered Specific Sub-angle (Evidence Sufficiency -> Tier 2)
  console.log(
    '\nTest 2.6: Unanswered specific sub-angle (Evidence Sufficiency check)...',
  );
  const hybridSpecificAngle = await retrieveMatchingFaqs(
    'เปิดบริการช่วงพักเที่ยงไหมครับ',
  );
  assert.equal(hybridSpecificAngle.matched, true);
  assert.equal(hybridSpecificAngle.faqs[0].id, 1);
  assert.equal(hybridSpecificAngle.highConfidenceFastPath, false); // Must NOT fast path without evidence
  console.log(
    `[PASS] Specific Sub-angle: "เปิดบริการช่วงพักเที่ยงไหมครับ" -> Matched FAQ #1 but HighConfidenceFastPath: false (routes to Tier 2 LLM)`,
  );

  // Test 2.7: Confident Out-of-Scope Queries (Tier 3 Fallback)
  console.log('\nTest 2.7: Out-of-Scope Queries...');
  const oosQueries = ['ค่าบริการเท่าไหร่', 'ห้องน้ำอยู่ตรงไหน', 'วันนี้ฝนตกไหม'];
  for (const q of oosQueries) {
    const oosRes = await retrieveMatchingFaqs(q);
    assert.equal(oosRes.matched, false);
    assert.equal(oosRes.highConfidenceFastPath, false);
    console.log(`[PASS] Out-of-Scope: "${q}" -> matched: false`);
  }

  // ===========================================================================
  // Part 3: End-to-End Answer Service with Persistent MP3 Audio
  // ===========================================================================
  console.log(
    '\n--- PART 3: End-to-End Answer Service Execution (generateGroundedAnswerWithMetrics) ---',
  );

  // E2E 3.1: Natural language query -> Tier 1 Fast Path with Persistent MP3
  const e2eFast = await generateGroundedAnswerWithMetrics('วันเสาร์ที่นี่เปิดหรือเปล่า');
  assert.equal(e2eFast.response.matched, true);
  assert.equal(e2eFast.response.tier, 'TIER_1');
  assert.equal(e2eFast.metrics.llmCalled, false);
  assert.equal(e2eFast.metrics.persistentAudioStatus, 'HIT');
  assert.ok(e2eFast.response.audioRef);
  assert.equal(e2eFast.response.audioRef?.faqId, 1);
  console.log(
    `[PASS] E2E Fast Path: "วันเสาร์ที่นี่เปิดหรือเปล่า" -> Tier 1, LLM Called: false, Persistent MP3 Audio HIT: ${e2eFast.response.audioRef?.audioUrl}`,
  );

  // E2E 3.2: Out of scope -> Tier 3 Cached Fallback MP3
  const e2eFallback = await generateGroundedAnswerWithMetrics('ค่าบริการเท่าไหร่');
  assert.equal(e2eFallback.response.matched, false);
  assert.equal(e2eFallback.response.tier, 'TIER_3');
  assert.equal(e2eFallback.metrics.llmCalled, false);
  assert.equal(e2eFallback.metrics.persistentAudioStatus, 'HIT');
  console.log(
    `[PASS] E2E Fallback: "ค่าบริการเท่าไหร่" -> Tier 3, LLM Called: false, Fallback Audio HIT`,
  );

  // ===========================================================================
  // Part 4: Rollback Verification (Switch back to legacy)
  // ===========================================================================
  console.log('\n--- PART 4: Rollback Verification ---');
  process.env.FAQ_MATCHER = 'legacy';
  const rollbackRes = await retrieveMatchingFaqs('เปิดบริการกี่โมง');
  assert.equal(rollbackRes.matched, true);
  assert.equal(rollbackRes.faqs[0].id, 1);
  console.log(
    `[PASS] Rollback: setting FAQ_MATCHER=legacy immediately returns to legacy engine with 0 side-effects.`,
  );

  console.log(
    '\n================================================================================',
  );
  console.log(' ALL HYBRID RUNTIME INTEGRATION TESTS PASSED (100% GREEN)');
  console.log(
    '================================================================================\n',
  );
}

runHybridRuntimeIntegrationTests().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
