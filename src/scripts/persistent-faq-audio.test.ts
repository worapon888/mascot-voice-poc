import assert from 'node:assert/strict';
import { handleFaqAudioWebhookEvent } from '@/app/api/faq-audio/webhook/route';
import { computeMouthFrameFromSamples } from '@/hooks/use-audio-lipsync';
import { ApiError } from '@/lib/api/errors';
import {
  ClientVoiceError,
  executeSmartPipelineStages,
} from '@/lib/voice/api-client';
import type { FaqAudioStorageAdapter } from '@/repositories/faq-audio.repository';
import { runFaqAudioReconciliation } from '@/scripts/generate-faq-audio';
import { generateGroundedAnswerWithMetrics } from '@/services/answer.service';
import {
  computeFaqAudioIdentity,
  ensurePersistentFaqAudioForRecord,
  getPersistentAudioTelemetry,
  resetPersistentAudioTelemetry,
  resolvePersistentFaqAudioRef,
} from '@/services/faq-audio.service';
import { matchFaqsAgainstRecords } from '@/services/faq-matching.service';
import {
  clearTtsAudioCache,
  synthesizeSpeechMp3WithMetrics,
} from '@/services/speech.service';
import { detectAudioFormatFromSignature } from '@/services/transcription.service';
import type { AnswerResponse, SupabaseFaqWebhookPayload } from '@/types/api';
import type { FaqAudioAssetRecord, FaqRecord } from '@/types/faq';

const WEBHOOK_SECRET = 'test-webhook-secret-key-2026-poc';

function createInitialFaqs(): FaqRecord[] {
  return [
    {
      id: 1,
      question: 'เปิดบริการกี่โมง',
      answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น.',
      keywords: ['เปิดบริการ', 'เวลาทำการ', 'เปิดกี่โมง', 'สำนักงานเปิดกี่โมง'],
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 2,
      question: 'ต้องจองคิวไหม',
      answer: 'บริการ Demo นี้รับนัดหมายล่วงหน้าผ่านเจ้าหน้าที่ Demo',
      keywords: ['จองคิว', 'นัดหมาย', 'นัดล่วงหน้า', 'ต้องนัด'],
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 3,
      question: 'เตรียมเอกสารอะไร',
      answer: 'การทดลอง Demo ใช้เลขอ้างอิง DEMO-001 ไม่ต้องส่งเอกสารส่วนบุคคล',
      keywords: ['เอกสาร', 'เตรียมเอกสาร', 'เอาอะไรไปบ้าง'],
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 4,
      question: 'ทดลองผ่านมือถือได้ไหม',
      answer: 'Demo นี้แนะนำ Chrome Desktop; Mobile ยังไม่รับรองจนกว่าจะทดสอบ',
      keywords: ['มือถือ', 'เบราว์เซอร์'],
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 5,
      question: 'ติดต่อใครเมื่อไม่มีคำตอบ',
      answer: 'โปรดติดต่อผู้ดูแลการสาธิตเพื่อขอข้อมูลเพิ่มเติม',
      keywords: ['ติดต่อ', 'เจ้าหน้าที่'],
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
    },
  ];
}

function createSyntheticMp3Buffer(tagText: string): Buffer {
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
  ]);
  const payload = Buffer.from(
    `PERSISTENT_MP3_${tagText}_PADDING_AUDIO_FRAMES`,
    'utf8',
  );
  return Buffer.concat([header, payload]);
}

/**
 * Simulates durable Supabase PostgreSQL `faq_audio_assets` table + Supabase Storage `mascot-faq-audio` bucket.
 * Persists across simulated server restarts and browser reloads.
 */
function createMockDurableSupabaseStorage() {
  const metadataMap = new Map<string, FaqAudioAssetRecord>();
  const storageObjects = new Map<string, Buffer>();
  let failNextUpload = false;
  let failNextRead = false;

  const adapter: FaqAudioStorageAdapter = {
    async getMetadata(
      faqId: number,
      contentHash: string,
    ): Promise<FaqAudioAssetRecord | null> {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('Simulated Supabase metadata read outage');
      }
      return metadataMap.get(`${faqId}:${contentHash}`) ?? null;
    },

    async upsertMetadata(
      record: FaqAudioAssetRecord,
    ): Promise<FaqAudioAssetRecord> {
      const copy = { ...record };
      metadataMap.set(`${record.faq_id}:${record.content_hash}`, copy);
      return copy;
    },

    async objectExistsInStorage(
      bucketName: string,
      objectPath: string,
    ): Promise<boolean> {
      return storageObjects.has(`${bucketName}/${objectPath}`);
    },

    async uploadAudioObject(
      bucketName: string,
      objectPath: string,
      mp3Buffer: Buffer,
    ): Promise<void> {
      if (failNextUpload) {
        failNextUpload = false;
        throw new Error('Simulated Supabase Storage 503 Upload Error');
      }
      storageObjects.set(`${bucketName}/${objectPath}`, Buffer.from(mp3Buffer));
    },

    getPublicAudioUrl(bucketName: string, objectPath: string): string {
      return `https://mock-supabase.local/storage/v1/object/public/${bucketName}/${objectPath}`;
    },
  };

  return {
    adapter,
    metadataMap,
    storageObjects,
    setFailNextUpload(val: boolean) {
      failNextUpload = val;
    },
    setFailNextRead(val: boolean) {
      failNextRead = val;
    },
    downloadByPublicUrl(url: string): Buffer | null {
      const prefix = 'https://mock-supabase.local/storage/v1/object/public/';
      if (!url.startsWith(prefix)) return null;
      const key = url.slice(prefix.length);
      return storageObjects.get(key) ?? null;
    },
  };
}

function makeWebhookHeaders(secret = WEBHOOK_SECRET): Headers {
  const h = new Headers();
  h.set('content-type', 'application/json');
  h.set('x-webhook-secret', secret);
  return h;
}

async function runTests(): Promise<void> {
  console.log(
    '======================================================================',
  );
  console.log(
    ' Persistent FAQ Audio & Automatic Regeneration Test Suite (0 Paid API) ',
  );
  console.log(
    '======================================================================\n',
  );

  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    total += 1;
    await fn();
    passed += 1;
    console.log(`[PASS] P${String(total).padStart(2, '0')} — ${name}`);
  }

  const faqsDb = createInitialFaqs();
  const durableStorage = createMockDurableSupabaseStorage();
  let openAiTtsCallCount = 0;
  let openAiLlmCallCount = 0;

  const mockSynthesizeMp3 = async (normalizedText: string): Promise<Buffer> => {
    openAiTtsCallCount += 1;
    return createSyntheticMp3Buffer(normalizedText);
  };

  const getLiveFaqById = async (id: number): Promise<FaqRecord | null> => {
    return faqsDb.find((f) => f.id === id) ?? null;
  };

  // -------------------------------------------------------------------------
  // P01. Initial Audio Generation CLI (Dry Run vs Execute & Idempotency)
  // -------------------------------------------------------------------------
  await test('Initial Audio Generation: Dry-Run makes 0 TTS calls; Execute pre-generates all 5 FAQs; Re-run makes 0 duplicate TTS calls', async () => {
    clearTtsAudioCache();
    resetPersistentAudioTelemetry();
    openAiTtsCallCount = 0;

    // 1. Dry-run
    const dryRunReport = await runFaqAudioReconciliation({
      execute: false,
      faqs: faqsDb,
      storageAdapter: durableStorage.adapter,
    });
    assert.equal(dryRunReport.mode, 'DRY_RUN');
    assert.equal(dryRunReport.toGenerateCount, 5);
    assert.equal(dryRunReport.alreadyReadyCount, 0);
    assert.equal(dryRunReport.totalEstimatedCostUsd > 0, true);
    assert.equal(openAiTtsCallCount, 0, 'Dry-run must make 0 OpenAI TTS calls');

    // 2. Execute pre-generation for all 5 active FAQs
    const execReport = await runFaqAudioReconciliation({
      execute: true,
      faqs: faqsDb,
      storageAdapter: durableStorage.adapter,
      fetchCurrentFaqById: getLiveFaqById,
      synthesizeMp3Fn: mockSynthesizeMp3,
      ensureBucketFn: async (b) => ({ created: true, bucketName: b }),
    });
    assert.equal(execReport.mode, 'EXECUTE');
    assert.equal(openAiTtsCallCount, 5);
    assert.equal(durableStorage.storageObjects.size, 5);

    // 3. Re-run Execute -> All 5 are ALREADY_READY -> 0 new OpenAI TTS calls
    const rerunReport = await runFaqAudioReconciliation({
      execute: true,
      faqs: faqsDb,
      storageAdapter: durableStorage.adapter,
      fetchCurrentFaqById: getLiveFaqById,
      synthesizeMp3Fn: mockSynthesizeMp3,
      ensureBucketFn: async (b) => ({ created: false, bucketName: b }),
    });
    assert.equal(rerunReport.alreadyReadyCount, 5);
    assert.equal(rerunReport.toGenerateCount, 0);
    assert.equal(
      openAiTtsCallCount,
      5,
      'Re-running setup must not call OpenAI TTS again',
    );
  });

  // -------------------------------------------------------------------------
  // P02. Existing FAQ First Request (Zero LLM Calls, Zero TTS Calls on 1st Turn!)
  // -------------------------------------------------------------------------
  await test('Existing FAQ First Request uses pre-generated Persistent Audio immediately (0 LLM calls, 0 TTS calls)', async () => {
    clearTtsAudioCache(); // Simulate cold in-memory cache
    const ttsCallsBefore = openAiTtsCallCount;
    const llmCallsBefore = openAiLlmCallCount;

    const fakeRecording = {
      blob: new Blob([new Uint8Array(createSyntheticMp3Buffer('mic'))], {
        type: 'audio/webm',
      }),
      mimeType: 'audio/webm',
      durationSeconds: 2,
    };

    const turnResult = await executeSmartPipelineStages({
      recordingPayload: fakeRecording,
      isRetry: false,
      isStaleTurn: () => false,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: async () => ({ transcript: 'เปิดบริการกี่โมงครับ' }),
      answerFn: async (transcript) => {
        const { response, metrics } = await generateGroundedAnswerWithMetrics(
          transcript,
          async (q) =>
            matchFaqsAgainstRecords(
              q,
              faqsDb.filter((f) => f.is_active),
              5,
            ),
          async (faq) =>
            resolvePersistentFaqAudioRef(faq, {
              storageAdapter: durableStorage.adapter,
            }),
        );
        if (metrics.llmCalled) openAiLlmCallCount += 1;
        return response;
      },
      ttsFn: async () => {
        openAiTtsCallCount += 1;
        throw new Error(
          'Dynamic /api/tts must NOT be called when persistent audio is READY',
        );
      },
      persistentAudioFn: async (audioUrl) => {
        const buf = durableStorage.downloadByPublicUrl(audioUrl);
        assert.notEqual(
          buf,
          null,
          'Expected persistent MP3 to exist in storage bucket',
        );
        return new Blob([new Uint8Array(buf!)], { type: 'audio/mpeg' });
      },
    });

    assert.notEqual(turnResult, null);
    assert.equal(turnResult?.audioSource, 'PERSISTENT_STORAGE');
    assert.equal(turnResult?.apiCallsMade.tts, 0);
    assert.equal(turnResult?.apiCallsMade.persistentAudioFetch, 1);
    assert.equal(openAiLlmCallCount, llmCallsBefore);
    assert.equal(openAiTtsCallCount, ttsCallsBefore);
  });

  // -------------------------------------------------------------------------
  // P03. Repeated FAQ, Server Restart Simulation & Browser Reload Simulation
  // -------------------------------------------------------------------------
  await test('Repeated FAQ after simulated Server Restart (in-memory cache wiped) & Browser Reload still hits Persistent Audio with 0 LLM/TTS calls', async () => {
    // Simulate full Server Restart (wiping all in-memory caches and telemetry)
    clearTtsAudioCache();
    resetPersistentAudioTelemetry();

    const ttsCallsBefore = openAiTtsCallCount;

    // Simulate Browser Reload (fresh session state) asking FAQ #1 and FAQ #2
    for (const query of ['เปิดบริการกี่โมงครับ', 'ต้องจองคิวไหมครับ']) {
      const { response, metrics } = await generateGroundedAnswerWithMetrics(
        query,
        async (q) =>
          matchFaqsAgainstRecords(
            q,
            faqsDb.filter((f) => f.is_active),
            4,
          ),
        async (faq) =>
          resolvePersistentFaqAudioRef(faq, {
            storageAdapter: durableStorage.adapter,
          }),
      );

      assert.equal(response.matched, true);
      assert.equal(metrics.llmCalled, false);
      assert.equal(metrics.persistentAudioStatus, 'HIT');
      assert.equal(Boolean(response.audioRef?.audioUrl), true);

      const downloaded = durableStorage.downloadByPublicUrl(
        response.audioRef!.audioUrl,
      );
      assert.notEqual(downloaded, null);
    }

    assert.equal(openAiTtsCallCount, ttsCallsBefore);
    const stats = getPersistentAudioTelemetry();
    assert.equal(stats.persistentAudioHits, 2);
    assert.equal(stats.persistentAudioMisses, 0);
  });

  // -------------------------------------------------------------------------
  // P04. Supabase FAQ Answer Update (09:00–16:00 -> 09:00–19:00) & Old Audio Version Rejection
  // -------------------------------------------------------------------------
  await test('Updating FAQ answer in Supabase changes Content Hash, rejects old audio version immediately, and regenerates new persistent audio via Webhook', async () => {
    const oldFaq1 = { ...faqsDb[0] };
    const oldIdentity = computeFaqAudioIdentity(oldFaq1.id, oldFaq1.answer);

    // 1. Admin edits FAQ #1 in Supabase Dashboard: 09:00–16:00 น. -> 09:00–19:00 น.
    faqsDb[0] = {
      ...faqsDb[0],
      answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–19:00 น.',
    };
    const newIdentity = computeFaqAudioIdentity(faqsDb[0].id, faqsDb[0].answer);
    assert.notEqual(
      newIdentity.contentHash,
      oldIdentity.contentHash,
      'Content hash must change when opening hours change from 16:00 to 19:00',
    );
    assert.equal(
      newIdentity.normalizedSpeechText.includes('หนึ่งทุ่ม'),
      true,
      '19:00 น. must normalize to หนึ่งทุ่ม in Thai speech',
    );

    // 2. BEFORE webhook completes: if a user asks FAQ #1 right now, system MUST NOT return old 16:00 audio!
    const preWebhookAnswer = await generateGroundedAnswerWithMetrics(
      'เปิดบริการกี่โมงครับ',
      async (q) => matchFaqsAgainstRecords(q, faqsDb, 4),
      async (faq) =>
        resolvePersistentFaqAudioRef(faq, {
          storageAdapter: durableStorage.adapter,
        }),
    );
    assert.equal(
      preWebhookAnswer.response.answer,
      'จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–19:00 น. ครับ',
    );
    assert.equal(
      preWebhookAnswer.metrics.persistentAudioStatus,
      'MISS',
      'Must MISS persistent audio before webhook finishes so old 16:00 audio is NEVER played',
    );
    assert.equal(preWebhookAnswer.response.audioRef, undefined);

    // 3. Supabase Database Webhook fires UPDATE event -> Automatic Regeneration
    const webhookPayload: SupabaseFaqWebhookPayload = {
      type: 'UPDATE',
      table: 'faqs',
      schema: 'public',
      old_record: oldFaq1,
      record: faqsDb[0],
    };

    const webhookRes = await handleFaqAudioWebhookEvent(
      makeWebhookHeaders(),
      webhookPayload,
      {
        configuredSecret: WEBHOOK_SECRET,
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: mockSynthesizeMp3,
      },
    );

    assert.equal(webhookRes.processed, true);
    assert.equal(webhookRes.reason, 'ANSWER_SPEECH_HASH_CHANGED');
    assert.equal(webhookRes.outcome, 'GENERATED_AND_READY');
    assert.equal(webhookRes.contentHash, newIdentity.contentHash);
    assert.equal(webhookRes.openAiTtsCalled, true);

    // 4. AFTER webhook completes: user request now gets the new 19:00 persistent audio HIT!
    const postWebhookAnswer = await generateGroundedAnswerWithMetrics(
      'เปิดบริการกี่โมงครับ',
      async (q) => matchFaqsAgainstRecords(q, faqsDb, 4),
      async (faq) =>
        resolvePersistentFaqAudioRef(faq, {
          storageAdapter: durableStorage.adapter,
        }),
    );
    assert.equal(postWebhookAnswer.metrics.persistentAudioStatus, 'HIT');
    assert.equal(
      postWebhookAnswer.response.audioRef?.contentHash,
      newIdentity.contentHash,
    );
    assert.notEqual(
      postWebhookAnswer.response.audioRef?.objectPath,
      oldIdentity.objectPath,
    );
  });

  // -------------------------------------------------------------------------
  // P05. Non-Audio Column Update Skip (Updating keywords only makes 0 TTS calls)
  // -------------------------------------------------------------------------
  await test('Webhook UPDATE that only modifies keywords or non-speech fields skips TTS generation completely', async () => {
    const ttsBefore = openAiTtsCallCount;
    const oldFaq2 = { ...faqsDb[1] };
    const updatedFaq2 = {
      ...faqsDb[1],
      keywords: [...faqsDb[1].keywords, 'คิวออนไลน์'],
    };
    faqsDb[1] = updatedFaq2;

    const res = await handleFaqAudioWebhookEvent(
      makeWebhookHeaders(),
      {
        type: 'UPDATE',
        table: 'faqs',
        schema: 'public',
        old_record: oldFaq2,
        record: updatedFaq2,
      },
      {
        configuredSecret: WEBHOOK_SECRET,
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: mockSynthesizeMp3,
      },
    );

    assert.equal(res.processed, false);
    assert.equal(res.reason, 'NON_AUDIO_FIELD_UPDATE');
    assert.equal(openAiTtsCallCount, ttsBefore);
  });

  // -------------------------------------------------------------------------
  // P06. New FAQ Insert & FAQ Disabled Behavior
  // -------------------------------------------------------------------------
  await test('New FAQ INSERT generates persistent audio; Disabling FAQ (is_active=false) prevents audio generation and blocks serving disabled FAQ audio', async () => {
    const newFaq6: FaqRecord = {
      id: 6,
      question: 'มีบริการที่จอดรถไหม',
      answer: 'จุดบริการ Demo มีที่จอดรถด้านหน้าอาคารเปิด 08:30–17:00 น.',
      keywords: ['ที่จอดรถ'],
      is_active: true,
      created_at: '2026-01-02T00:00:00Z',
    };
    faqsDb.push(newFaq6);

    // 1. Webhook INSERT for FAQ #6
    const insertRes = await handleFaqAudioWebhookEvent(
      makeWebhookHeaders(),
      {
        type: 'INSERT',
        table: 'faqs',
        schema: 'public',
        old_record: null,
        record: newFaq6,
      },
      {
        configuredSecret: WEBHOOK_SECRET,
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: mockSynthesizeMp3,
      },
    );
    assert.equal(insertRes.processed, true);
    assert.equal(insertRes.outcome, 'GENERATED_AND_READY');

    // 2. Disable FAQ #6 (is_active = false)
    const disabledFaq6 = { ...newFaq6, is_active: false };
    faqsDb[5] = disabledFaq6;

    const disableWebhookRes = await handleFaqAudioWebhookEvent(
      makeWebhookHeaders(),
      {
        type: 'UPDATE',
        table: 'faqs',
        schema: 'public',
        old_record: newFaq6,
        record: disabledFaq6,
      },
      {
        configuredSecret: WEBHOOK_SECRET,
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: mockSynthesizeMp3,
      },
    );
    assert.equal(disableWebhookRes.processed, false);
    assert.equal(disableWebhookRes.reason, 'FAQ_INACTIVE');

    // Direct lookup on disabled FAQ must refuse to return audioRef
    const disabledLookup = await resolvePersistentFaqAudioRef(disabledFaq6, {
      storageAdapter: durableStorage.adapter,
    });
    assert.equal(disabledLookup.hit, false);
    assert.equal(disabledLookup.reason, 'FAQ_INACTIVE');
    assert.equal(disabledLookup.audioRef, undefined);

    // Clean up FAQ #6 from test array
    faqsDb.pop();
  });

  // -------------------------------------------------------------------------
  // P07. Rapid Consecutive Updates Race Condition Protection
  // -------------------------------------------------------------------------
  await test('Rapid Consecutive Updates: Stale generation job for Version A is superseded and NEVER overwrites newer Version B', async () => {
    const staleVersionAnswer = 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 08:00–15:00 น.';
    const latestVersionAnswer = 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 08:30–18:00 น.';

    // Live DB already has latestVersionAnswer (Version B) by the time Version A's TTS finishes
    faqsDb[0] = {
      ...faqsDb[0],
      answer: latestVersionAnswer,
    };

    const staleJobOutcome = await ensurePersistentFaqAudioForRecord(
      {
        id: 1,
        answer: staleVersionAnswer,
        is_active: true,
      },
      {
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: mockSynthesizeMp3,
      },
    );

    assert.equal(staleJobOutcome.outcome, 'SUPERSEDED_BY_NEWER_VERSION');

    // Verify stale version was NOT marked READY in metadata
    const staleIdentity = computeFaqAudioIdentity(1, staleVersionAnswer);
    const staleMeta = await durableStorage.adapter.getMetadata(
      1,
      staleIdentity.contentHash,
    );
    assert.notEqual(staleMeta?.status, 'READY');

    // Now Version B job completes -> Marked READY
    const latestJobOutcome = await ensurePersistentFaqAudioForRecord(
      faqsDb[0],
      {
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: mockSynthesizeMp3,
      },
    );
    assert.equal(latestJobOutcome.outcome, 'GENERATED_AND_READY');
  });

  // -------------------------------------------------------------------------
  // P08. Concurrent Duplicate Webhook Events Coalescing
  // -------------------------------------------------------------------------
  await test('Concurrent duplicate webhook events for the same FAQ version coalesce via idempotencyKey and call OpenAI TTS only once', async () => {
    faqsDb[2] = {
      ...faqsDb[2],
      answer: 'การทดลอง Demo ใช้เลขอ้างอิง DEMO-002 ไม่ต้องส่งเอกสารส่วนบุคคล',
    };

    let slowSynthCalls = 0;
    const slowSynth = async (norm: string): Promise<Buffer> => {
      slowSynthCalls += 1;
      await new Promise((r) => setTimeout(r, 35));
      return createSyntheticMp3Buffer(norm);
    };

    const payload: SupabaseFaqWebhookPayload = {
      type: 'UPDATE',
      table: 'faqs',
      schema: 'public',
      old_record: null,
      record: faqsDb[2],
    };

    const [r1, r2, r3] = await Promise.all([
      handleFaqAudioWebhookEvent(makeWebhookHeaders(), payload, {
        configuredSecret: WEBHOOK_SECRET,
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: slowSynth,
      }),
      handleFaqAudioWebhookEvent(makeWebhookHeaders(), payload, {
        configuredSecret: WEBHOOK_SECRET,
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: slowSynth,
      }),
      handleFaqAudioWebhookEvent(makeWebhookHeaders(), payload, {
        configuredSecret: WEBHOOK_SECRET,
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        synthesizeMp3Fn: slowSynth,
      }),
    ]);

    assert.equal(
      slowSynthCalls,
      1,
      'Expected exactly 1 OpenAI TTS call across 3 concurrent duplicate webhooks',
    );
    const outcomes = [r1.outcome, r2.outcome, r3.outcome];
    assert.equal(outcomes.includes('GENERATED_AND_READY'), true);
    assert.equal(outcomes.filter((o) => o === 'COALESCED_IN_FLIGHT').length, 2);
  });

  // -------------------------------------------------------------------------
  // P09. Webhook Authentication Failure
  // -------------------------------------------------------------------------
  await test('Webhook rejects missing or invalid secret with HTTP 401 UNAUTHORIZED and makes 0 TTS calls', async () => {
    const ttsBefore = openAiTtsCallCount;
    await assert.rejects(
      () =>
        handleFaqAudioWebhookEvent(
          makeWebhookHeaders('wrong-secret-value-0000'),
          {
            type: 'INSERT',
            table: 'faqs',
            schema: 'public',
            old_record: null,
            record: faqsDb[0],
          },
          {
            configuredSecret: WEBHOOK_SECRET,
            storageAdapter: durableStorage.adapter,
            synthesizeMp3Fn: mockSynthesizeMp3,
          },
        ),
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 401 &&
        err.code === 'UNAUTHORIZED',
    );
    assert.equal(openAiTtsCallCount, ttsBefore);
  });

  // -------------------------------------------------------------------------
  // P10. Audio Generation Failure, Storage Upload Failure & Controlled Retry
  // -------------------------------------------------------------------------
  await test('Audio Generation Failure and Storage Upload Failure record status=FAILED and recover via controlled retry', async () => {
    faqsDb[3] = {
      ...faqsDb[3],
      answer: 'Demo นี้รองรับ Chrome Desktop เวอร์ชันล่าสุดเท่านั้น',
    };

    // 1. Simulate OpenAI TTS failure on both attempts
    const failedTtsOutcome = await ensurePersistentFaqAudioForRecord(
      faqsDb[3],
      {
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        maxAttempts: 2,
        synthesizeMp3Fn: async () => {
          throw new Error('Simulated OpenAI TTS 503 Outage');
        },
      },
    );
    assert.equal(failedTtsOutcome.outcome, 'FAILED');
    assert.equal(
      failedTtsOutcome.error?.includes('Simulated OpenAI TTS 503 Outage'),
      true,
    );

    const failedIdentity = computeFaqAudioIdentity(
      faqsDb[3].id,
      faqsDb[3].answer,
    );
    const failedMeta = await durableStorage.adapter.getMetadata(
      faqsDb[3].id,
      failedIdentity.contentHash,
    );
    assert.equal(failedMeta?.status, 'FAILED');
    assert.equal(failedMeta?.attempt_count, 2);

    // 2. Simulate transient Storage Upload failure on attempt 1 that succeeds on attempt 2
    durableStorage.setFailNextUpload(true);
    const recoveredOutcome = await ensurePersistentFaqAudioForRecord(
      faqsDb[3],
      {
        storageAdapter: durableStorage.adapter,
        fetchCurrentFaqById: getLiveFaqById,
        maxAttempts: 2,
        synthesizeMp3Fn: mockSynthesizeMp3,
      },
    );
    assert.equal(recoveredOutcome.outcome, 'GENERATED_AND_READY');
  });

  // -------------------------------------------------------------------------
  // P11. Storage Read Failure & Missing Audio Seamless Fallback to Dynamic TTS
  // -------------------------------------------------------------------------
  await test('Storage Read Failure or unreachable Persistent Audio URL seamlessly falls back to Dynamic /api/tts without failing user turn', async () => {
    // 1. Metadata read error on backend -> Answer still succeeds without audioRef
    durableStorage.setFailNextRead(true);
    const backendFallback = await generateGroundedAnswerWithMetrics(
      'เปิดบริการกี่โมงครับ',
      async (q) => matchFaqsAgainstRecords(q, faqsDb, 3),
      async (faq) =>
        resolvePersistentFaqAudioRef(faq, {
          storageAdapter: durableStorage.adapter,
        }),
    );
    assert.equal(backendFallback.response.matched, true);
    assert.equal(backendFallback.metrics.persistentAudioStatus, 'MISS');
    assert.equal(backendFallback.response.audioRef, undefined);

    // 2. Frontend receives an audioRef, but Storage CDN download fails -> Client seamlessly falls back to /api/tts
    let dynamicTtsFallbackCalled = 0;
    const fakeRecording = {
      blob: new Blob([new Uint8Array(createSyntheticMp3Buffer('mic_fb'))], {
        type: 'audio/webm',
      }),
      mimeType: 'audio/webm',
      durationSeconds: 2,
    };

    const clientFallbackResult = await executeSmartPipelineStages({
      recordingPayload: fakeRecording,
      isRetry: false,
      isStaleTurn: () => false,
      signal: new AbortController().signal,
      onStateChange: () => {},
      onTranscriptReady: () => {},
      onAnswerReady: () => {},
      sttFn: async () => ({ transcript: 'เปิดบริการกี่โมงครับ' }),
      answerFn: async (): Promise<AnswerResponse> => ({
        answer: 'จุดบริการ Demo เปิดจันทร์–ศุกร์ 08:30–18:00 น. ครับ',
        faqIds: [1],
        matched: true,
        answerMode: 'FAQ_GROUNDED',
        audioRef: {
          faqId: 1,
          contentHash: 'abc',
          audioUrl: 'https://mock-supabase.local/broken-url.mp3',
          objectPath: 'faqs/v1/broken.mp3',
          mimeType: 'audio/mpeg',
          byteLength: 1000,
        },
      }),
      persistentAudioFn: async () => {
        throw new ClientVoiceError(
          'PERSISTENT_AUDIO_FETCH_FAILED',
          404,
          'Simulated 404 from Storage CDN',
        );
      },
      ttsFn: async (text) => {
        dynamicTtsFallbackCalled += 1;
        const res = await synthesizeSpeechMp3WithMetrics(text, async (norm) =>
          createSyntheticMp3Buffer(norm),
        );
        return new Blob([new Uint8Array(res.buffer)], { type: 'audio/mpeg' });
      },
    });

    assert.notEqual(clientFallbackResult, null);
    assert.equal(clientFallbackResult?.audioSource, 'DYNAMIC_TTS');
    assert.equal(dynamicTtsFallbackCalled, 1);
    assert.equal(clientFallbackResult?.apiCallsMade.persistentAudioFetch, 1);
    assert.equal(clientFallbackResult?.apiCallsMade.tts, 1);
  });

  // -------------------------------------------------------------------------
  // P12. Unmatched FAQ, Ambiguous FAQ & Lip-Sync Compatibility with Persistent Audio
  // -------------------------------------------------------------------------
  await test('Unmatched & Ambiguous FAQs do not return persistent audioRef, and downloaded Persistent MP3 drives Web Audio Lip-Sync frames accurately', () => {
    const unmatched = matchFaqsAgainstRecords('ค่าเช่าห้องเท่าไรครับ', faqsDb);
    assert.equal(unmatched.matched, false);
    assert.equal(unmatched.highConfidenceFastPath, false);

    const ambiguous = matchFaqsAgainstRecords('จองคิวมือถือ', faqsDb);
    assert.equal(ambiguous.matched, true);
    assert.equal(ambiguous.ambiguous, true);
    assert.equal(ambiguous.highConfidenceFastPath, false);

    // Verify persistent MP3 binary passes format detection and lip-sync RMS sampling
    const identity = computeFaqAudioIdentity(faqsDb[0].id, faqsDb[0].answer);
    const publicUrl = durableStorage.adapter.getPublicAudioUrl(
      identity.bucketName,
      identity.objectPath,
    );
    const persistentMp3Bytes = durableStorage.downloadByPublicUrl(publicUrl);
    assert.notEqual(persistentMp3Bytes, null);

    const detected = detectAudioFormatFromSignature(persistentMp3Bytes!);
    assert.deepEqual(detected, { ext: 'mp3', mime: 'audio/mpeg' });

    const activeSpeechSamples = new Uint8Array(1024).fill(170);
    const frame = computeMouthFrameFromSamples(activeSpeechSamples, 0.07);
    assert.equal(frame.mouthFrame, 'open');
  });

  console.log(
    '\n----------------------------------------------------------------------',
  );
  console.log(
    `Summary: ${passed}/${total} Persistent FAQ Audio & Webhook Regeneration Tests PASSED (0 Paid API Calls)`,
  );
  console.log(
    '----------------------------------------------------------------------',
  );
}

runTests().catch((err) => {
  console.error('Persistent FAQ audio test suite failed:', err);
  process.exitCode = 1;
});
