import 'server-only';
import { OPENAI_MODELS } from '@/lib/openai/client';
import { getFaqAudioBucketName } from '@/lib/validations/env';
import { getAllFaqs, getFaqById } from '@/repositories/faq.repository';
import {
  createSupabaseFaqAudioStorageAdapter,
  ensureFaqAudioBucketExists,
  type FaqAudioStorageAdapter,
} from '@/repositories/faq-audio.repository';
import {
  computeFaqAudioIdentity,
  ensurePersistentFaqAudioForRecord,
  type FaqAudioGenerationOutcome,
} from '@/services/faq-audio.service';
import type { FaqRecord } from '@/types/faq';

/**
 * Conservative cost estimate constants for OpenAI `gpt-4o-mini-tts`.
 * Assumed rate: ~$0.015 per minute of synthesized speech (~15 characters/sec in Thai).
 */
const ESTIMATED_USD_PER_1000_THAI_CHARS = 0.0018;

export interface FaqAudioPlanItem {
  faqId: number;
  question: string;
  isActive: boolean;
  canonicalAnswer: string;
  normalizedSpeechText: string;
  contentHash: string;
  objectPath: string;
  alreadyReady: boolean;
  action: 'SKIP_INACTIVE' | 'SKIP_ALREADY_READY' | 'GENERATE_TTS';
  charCount: number;
  estimatedCostUsd: number;
}

export interface FaqAudioSyncPlanReport {
  mode: 'DRY_RUN' | 'EXECUTE';
  bucketName: string;
  totalFaqs: number;
  activeFaqs: number;
  alreadyReadyCount: number;
  toGenerateCount: number;
  totalCharsToGenerate: number;
  totalEstimatedCostUsd: number;
  items: FaqAudioPlanItem[];
  executionOutcomes?: FaqAudioGenerationOutcome[];
}

export interface RunFaqAudioSyncOptions {
  execute: boolean;
  faqs?: FaqRecord[];
  storageAdapter?: FaqAudioStorageAdapter;
  fetchCurrentFaqById?: (id: number) => Promise<FaqRecord | null>;
  synthesizeMp3Fn?: (normalizedSpeechText: string) => Promise<Buffer>;
  ensureBucketFn?: (
    bucketName: string,
  ) => Promise<{ created: boolean; bucketName: string }>;
}

/**
 * Inspects all FAQs and builds a deterministic reconciliation / pre-generation plan.
 * Never invokes OpenAI TTS unless `options.execute === true`.
 */
export async function runFaqAudioReconciliation(
  options: RunFaqAudioSyncOptions,
): Promise<FaqAudioSyncPlanReport> {
  const bucketName = getFaqAudioBucketName();
  const adapter =
    options.storageAdapter ?? createSupabaseFaqAudioStorageAdapter();
  const faqs = options.faqs ?? (await getAllFaqs());

  if (options.execute) {
    const ensureBucket = options.ensureBucketFn ?? ensureFaqAudioBucketExists;
    await ensureBucket(bucketName);
  }

  const items: FaqAudioPlanItem[] = [];

  for (const faq of faqs) {
    const identity = computeFaqAudioIdentity(faq.id, faq.answer, bucketName);
    const charCount = identity.normalizedSpeechText.length;

    if (!faq.is_active) {
      items.push({
        faqId: faq.id,
        question: faq.question,
        isActive: false,
        canonicalAnswer: identity.canonicalAnswer,
        normalizedSpeechText: identity.normalizedSpeechText,
        contentHash: identity.contentHash,
        objectPath: identity.objectPath,
        alreadyReady: false,
        action: 'SKIP_INACTIVE',
        charCount,
        estimatedCostUsd: 0,
      });
      continue;
    }

    let alreadyReady = false;
    try {
      const meta = await adapter.getMetadata(faq.id, identity.contentHash);
      if (
        meta &&
        meta.status === 'READY' &&
        meta.content_hash === identity.contentHash &&
        meta.byte_length > 0
      ) {
        alreadyReady = await adapter.objectExistsInStorage(
          meta.bucket_name,
          meta.object_path,
        );
      }
    } catch {
      alreadyReady = false;
    }

    const action = alreadyReady ? 'SKIP_ALREADY_READY' : 'GENERATE_TTS';
    const estimatedCostUsd =
      action === 'GENERATE_TTS'
        ? Number(
            ((charCount / 1000) * ESTIMATED_USD_PER_1000_THAI_CHARS).toFixed(6),
          )
        : 0;

    items.push({
      faqId: faq.id,
      question: faq.question,
      isActive: true,
      canonicalAnswer: identity.canonicalAnswer,
      normalizedSpeechText: identity.normalizedSpeechText,
      contentHash: identity.contentHash,
      objectPath: identity.objectPath,
      alreadyReady,
      action,
      charCount,
      estimatedCostUsd,
    });
  }

  const toGenerateItems = items.filter((i) => i.action === 'GENERATE_TTS');
  const totalCharsToGenerate = toGenerateItems.reduce(
    (sum, i) => sum + i.charCount,
    0,
  );
  const totalEstimatedCostUsd = Number(
    toGenerateItems.reduce((sum, i) => sum + i.estimatedCostUsd, 0).toFixed(6),
  );

  const report: FaqAudioSyncPlanReport = {
    mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
    bucketName,
    totalFaqs: faqs.length,
    activeFaqs: items.filter((i) => i.isActive).length,
    alreadyReadyCount: items.filter((i) => i.alreadyReady).length,
    toGenerateCount: toGenerateItems.length,
    totalCharsToGenerate,
    totalEstimatedCostUsd,
    items,
  };

  if (!options.execute) {
    return report;
  }

  const executionOutcomes: FaqAudioGenerationOutcome[] = [];
  for (const faq of faqs) {
    if (!faq.is_active) {
      continue;
    }
    const outcome = await ensurePersistentFaqAudioForRecord(faq, {
      storageAdapter: adapter,
      fetchCurrentFaqById: options.fetchCurrentFaqById ?? getFaqById,
      synthesizeMp3Fn: options.synthesizeMp3Fn,
    });
    executionOutcomes.push(outcome);
  }

  report.executionOutcomes = executionOutcomes;
  return report;
}

async function main(): Promise<void> {
  const isExecute = process.argv.includes('--execute');

  console.log(
    '======================================================================',
  );
  console.log(
    ' Mascot Voice POC — Persistent FAQ Audio Setup & Reconciliation CLI  ',
  );
  console.log(
    '======================================================================',
  );
  console.log(
    `Mode:        ${isExecute ? 'EXECUTE (Will call OpenAI TTS for missing versions)' : 'DRY-RUN (0 Paid API Calls — inspection & cost estimate only)'}`,
  );
  console.log(
    `TTS Model:   ${OPENAI_MODELS.TTS} (voice: ${OPENAI_MODELS.TTS_VOICE})\n`,
  );

  const report = await runFaqAudioReconciliation({ execute: isExecute });

  console.log(`Target Storage Bucket: ${report.bucketName}`);
  console.log(
    `FAQs Found:            ${report.totalFaqs} total (${report.activeFaqs} active)`,
  );
  console.log(`Already READY:         ${report.alreadyReadyCount}`);
  console.log(`Need TTS Generation:   ${report.toGenerateCount}`);
  console.log(`Characters to Synth:   ${report.totalCharsToGenerate} chars`);
  console.log(
    `Estimated OpenAI Cost: ~$${report.totalEstimatedCostUsd.toFixed(6)} USD\n`,
  );

  console.log('--- FAQ Audio Version Plan ---');
  for (const item of report.items) {
    console.log(
      `[FAQ #${item.faqId}] (${item.action}) "${item.question}" -> hash=${item.contentHash.slice(0, 12)}...`,
    );
    console.log(`         Speech Text: "${item.normalizedSpeechText}"`);
    console.log(`         Object Path: ${item.objectPath}`);
  }

  if (!isExecute) {
    console.log(
      '\n[DRY-RUN COMPLETE] No OpenAI TTS API calls were made. Pass `--execute` to generate and upload missing MP3 files.',
    );
    return;
  }

  console.log('\n--- Execution Results ---');
  let failedCount = 0;
  for (const out of report.executionOutcomes ?? []) {
    console.log(
      `[FAQ #${out.faqId}] Outcome=${out.outcome} | OpenAI_TTS_Called=${out.openAiTtsCalled} | Uploaded=${out.storageUploaded} | Bytes=${out.byteLength}`,
    );
    if (out.audioUrl) {
      console.log(`         URL: ${out.audioUrl}`);
    }
    if (out.error) {
      console.log(`         Error: ${out.error}`);
    }
    if (out.outcome === 'FAILED') {
      failedCount += 1;
    }
  }

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

const isDirectCliExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, '/')
    .endsWith('src/scripts/generate-faq-audio.ts');

if (isDirectCliExecution) {
  main().catch((err) => {
    console.error(
      'Unhandled error in generate-faq-audio CLI:',
      err instanceof Error ? err.message : 'Unknown error',
    );
    process.exitCode = 1;
  });
}
