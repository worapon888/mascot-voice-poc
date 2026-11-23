import 'server-only';
import { ApiError } from '@/lib/api/errors';
import { getOpenAIClient, OPENAI_MODELS } from '@/lib/openai/client';
import { MAX_TEXT_CHARS } from '@/lib/validations/voice';
import {
  formatCanonicalFaqAnswer,
  GROUNDED_FAQ_SYSTEM_INSTRUCTIONS,
  GUARDED_FALLBACK_SYSTEM_INSTRUCTIONS,
  MAX_LLM_OUTPUT_TOKENS,
  STANDARD_FALLBACK_ANSWER,
} from '@/services/answer.service';
import {
  resolvePersistentFaqAudioRef,
  resolvePersistentFallbackAudioRef,
} from '@/services/faq-audio.service';
import {
  isConfidentOutOfScopeOrUnknownQuery,
  retrieveMatchingFaqs,
} from '@/services/faq-matching.service';
import {
  evaluateCompleteAnswerGrounding,
  evaluateSentenceGrounding,
  type SentenceGroundingResult,
} from '@/services/sentence-grounding.service';
import {
  synthesizeSpeechMp3WithMetrics,
  type TtsSynthesisResult,
} from '@/services/speech.service';
import { ThaiSentenceSplitter } from '@/lib/voice/thai-sentence-splitter';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

const MAX_CONCURRENT_TTS = 2;

interface OrderedTtsJob {
  text: string;
  settled: boolean;
  result?: TtsSynthesisResult;
  error?: unknown;
  doneSignal: Promise<void>;
  resolveDone: () => void;
}

class OrderedTtsQueue {
  private readonly jobs: OrderedTtsJob[] = [];
  private readonly waitingRunners: Array<() => void> = [];
  private readonly customTtsGenerator?: (text: string) => Promise<Buffer>;
  private activeCount = 0;
  private aborted = false;

  constructor(customTtsGenerator?: (text: string) => Promise<Buffer>) {
    this.customTtsGenerator = customTtsGenerator;
  }

  get length(): number {
    return this.jobs.length;
  }

  enqueue(text: string): void {
    if (this.aborted) {
      return;
    }

    let resolveDone!: () => void;
    const doneSignal = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const job: OrderedTtsJob = {
      text,
      settled: false,
      doneSignal,
      resolveDone,
    };
    this.jobs.push(job);

    const run = () => {
      if (this.aborted) {
        job.settled = true;
        job.resolveDone();
        return;
      }

      this.activeCount += 1;
      synthesizeSpeechMp3WithMetrics(text, this.customTtsGenerator)
        .then((res) => {
          if (!this.aborted) {
            job.result = res;
          }
        })
        .catch((err: unknown) => {
          if (!this.aborted) {
            job.error = err;
          }
        })
        .finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1);
          job.settled = true;
          job.resolveDone();
          this.drainNext();
        });
    };

    if (this.activeCount < MAX_CONCURRENT_TTS) {
      run();
    } else {
      this.waitingRunners.push(run);
    }
  }

  private drainNext(): void {
    while (!this.aborted && this.activeCount < MAX_CONCURRENT_TTS) {
      const next = this.waitingRunners.shift();
      if (!next) break;
      next();
    }
  }

  isSettled(index: number): boolean {
    return Boolean(this.jobs[index]?.settled);
  }

  get(index: number): OrderedTtsJob | undefined {
    return this.jobs[index];
  }

  waitFor(index: number): Promise<void> {
    const job = this.jobs[index];
    return job ? job.doneSignal : Promise.resolve();
  }

  abort(): void {
    this.aborted = true;
    while (this.waitingRunners.length > 0) {
      this.waitingRunners.shift();
    }
    for (const job of this.jobs) {
      if (!job.settled) {
        job.settled = true;
        job.resolveDone();
      }
    }
  }
}

export interface AnswerStreamEvent {
  event:
    | 'tier'
    | 'retrieval_complete'
    | 'text_chunk'
    | 'sentence_ready'
    | 'audio_chunk_ready'
    | 'done'
    | 'error';
  data: Record<string, unknown>;
}

export interface StreamGroundedAnswerOptions {
  rawTranscript: string;
  conversationHistory?: ReadonlyArray<ConversationTurn>;
  signal?: AbortSignal;
  customRetriever?: typeof retrieveMatchingFaqs;
  customLlmStreamer?: (
    prompt: string,
    evidenceFaqs: ReadonlyArray<FaqRecord>,
  ) => AsyncIterable<string>;
  customTtsGenerator?: (text: string) => Promise<Buffer>;
}

/**
 * Builds the grounded user prompt identical to answer.service.ts
 */
function buildGroundedUserPrompt(
  faqs: ReadonlyArray<FaqRecord>,
  sanitizedQuestion: string,
  history: ReadonlyArray<ConversationTurn> = [],
): string {
  const boundedContext = faqs
    .map(
      (f, idx) =>
        `[FAQ ${idx + 1}] คำถาม: ${f.question}\nคำตอบ: ${f.answer}\nคำสำคัญ: ${(f.keywords ?? []).join(', ')}`,
    )
    .join('\n\n');

  const historyBlock = history
    .slice(-4)
    .map((t) => `${t.role === 'user' ? 'ผู้ใช้' : 'ผู้ช่วย'}: ${t.text}`)
    .join('\n');

  if (historyBlock) {
    return `<faq_evidence>\n${boundedContext}\n</faq_evidence>\n\n<conversation_history>\n${historyBlock}\n</conversation_history>\n\n<user_question>\n${sanitizedQuestion}\n</user_question>`;
  }

  return `<faq_evidence>\n${boundedContext}\n</faq_evidence>\n\n<user_question>\n${sanitizedQuestion}\n</user_question>`;
}

/**
 * Server-Sent Event generator orchestrating Tier 1 Fast Path, Tier 3 Fallback,
 * and Tier 2 Token Streaming with Sentence-Level TTS pipelining.
 */
export async function* streamGroundedAnswerEvents(
  options: StreamGroundedAnswerOptions,
): AsyncGenerator<AnswerStreamEvent, void, unknown> {
  const {
    rawTranscript,
    conversationHistory = [],
    signal,
    customRetriever = retrieveMatchingFaqs,
    customLlmStreamer,
    customTtsGenerator,
  } = options;

  const sanitizedQuestion = rawTranscript.trim().slice(0, MAX_TEXT_CHARS);

  // 1. Retrieve matching FAQs live from Supabase (or hybrid engine)
  const t0 = performance.now();
  const retrieval = await customRetriever(rawTranscript, conversationHistory);
  const retrievalLatencyMs = Math.round(performance.now() - t0);

  yield {
    event: 'retrieval_complete',
    data: {
      latencyMs: retrievalLatencyMs,
      faqCount: retrieval.faqs.length,
      matched: retrieval.matched,
      highConfidenceFastPath: retrieval.highConfidenceFastPath,
      ...(retrieval.retrievalMetrics
        ? { retrievalMetrics: retrieval.retrievalMetrics }
        : {}),
    },
  };

  if (signal?.aborted) return;

  // ---------------------------------------------------------------------------
  // Tier 1 — Safe High-Confidence FAQ Fast Path (0 LLM, 0 Dynamic TTS)
  // ---------------------------------------------------------------------------
  if (retrieval.highConfidenceFastPath && retrieval.faqs.length === 1) {
    const primaryFaq = retrieval.faqs[0];
    const canonicalAnswer = formatCanonicalFaqAnswer(primaryFaq.answer);
    const audioLookup = await resolvePersistentFaqAudioRef(primaryFaq);

    yield {
      event: 'tier',
      data: {
        tier: 'TIER_1',
        matched: true,
        faqIds: [primaryFaq.id],
        answer: canonicalAnswer,
        audioUrl: audioLookup.hit ? audioLookup.audioRef?.audioUrl : null,
      },
    };

    yield {
      event: 'done',
      data: {
        tier: 'TIER_1',
        fullAnswer: canonicalAnswer,
        totalChunks: 1,
        timings: {
          retrievalMs: retrievalLatencyMs,
          llmMs: 0,
          ttsMs: 0,
          persistentAudioLookupMs: audioLookup.lookupLatencyMs,
          persistentAudioCacheHit:
            audioLookup.hit && audioLookup.lookupLatencyMs === 0,
          ...(retrieval.retrievalMetrics
            ? { retrievalMetrics: retrieval.retrievalMetrics }
            : {}),
        },
      },
    };
    return;
  }

  // ---------------------------------------------------------------------------
  // Tier 3 — Confident Out-of-Scope Fallback (0 LLM, 0 Dynamic TTS)
  // ---------------------------------------------------------------------------
  if (
    isConfidentOutOfScopeOrUnknownQuery(
      retrieval,
      rawTranscript,
      conversationHistory,
    )
  ) {
    const fallbackAudio = await resolvePersistentFallbackAudioRef();

    yield {
      event: 'tier',
      data: {
        tier: 'TIER_3',
        matched: false,
        faqIds: [],
        answer: STANDARD_FALLBACK_ANSWER,
        audioUrl: fallbackAudio.hit ? fallbackAudio.audioRef?.audioUrl : null,
      },
    };

    yield {
      event: 'done',
      data: {
        tier: 'TIER_3',
        fullAnswer: STANDARD_FALLBACK_ANSWER,
        totalChunks: 1,
        timings: {
          retrievalMs: retrievalLatencyMs,
          llmMs: 0,
          ttsMs: 0,
          persistentAudioLookupMs: fallbackAudio.lookupLatencyMs,
          persistentAudioCacheHit:
            fallbackAudio.hit && fallbackAudio.lookupLatencyMs === 0,
          ...(retrieval.retrievalMetrics
            ? { retrievalMetrics: retrieval.retrievalMetrics }
            : {}),
        },
      },
    };
    return;
  }

  // ---------------------------------------------------------------------------
  // Tier 2 — Contextual Grounded Answer (LLM Token Streaming + Sentence TTS)
  // ---------------------------------------------------------------------------
  yield {
    event: 'tier',
    data: {
      tier: 'TIER_2',
      matched: retrieval.matched,
      faqIds: retrieval.faqs.map((f) => f.id),
    },
  };

  const isMatchedFaq = retrieval.matched && retrieval.faqs.length > 0;
  const userPrompt = isMatchedFaq
    ? buildGroundedUserPrompt(
        retrieval.faqs,
        sanitizedQuestion,
        conversationHistory,
      )
    : `<user_question>\n${sanitizedQuestion}\n</user_question>`;

  const instructions = isMatchedFaq
    ? GROUNDED_FAQ_SYSTEM_INSTRUCTIONS
    : GUARDED_FALLBACK_SYSTEM_INSTRUCTIONS;

  const sentenceSplitter = new ThaiSentenceSplitter();
  let fullAccumulatedText = '';
  let sentenceIndex = 0;
  let chunkIndex = 0;
  const heldSentences: Array<{
    text: string;
    initialStatus: SentenceGroundingResult['status'];
  }> = [];
  const approvedSpokenSentences: string[] = [];
  const ttsQueue = new OrderedTtsQueue(customTtsGenerator);

  const tLlmStart = performance.now();
  let llmTtftMs = 0;
  let firstSentenceMs = 0;
  let firstAudioReadyMs = 0;
  let totalTtsMs = 0;
  let iterator: AsyncIterator<string> | null = null;

  try {
    let tokenStream: AsyncIterable<string>;

    if (customLlmStreamer) {
      tokenStream = customLlmStreamer(userPrompt, retrieval.faqs);
    } else {
      const client = getOpenAIClient();
      // Use OpenAI Responses API streaming
      const stream = await client.responses.create({
        model: OPENAI_MODELS.LLM,
        instructions,
        input: userPrompt,
        max_output_tokens: MAX_LLM_OUTPUT_TOKENS,
        stream: true,
      });

      tokenStream = (async function* () {
        for await (const event of stream) {
          if (signal?.aborted) break;
          // In Responses API, text deltas arrive via response.output_text.delta
          if (
            'type' in event &&
            event.type === 'response.output_text.delta' &&
            'delta' in event &&
            typeof event.delta === 'string'
          ) {
            yield event.delta;
          }
        }
      })();
    }

    iterator = tokenStream[Symbol.asyncIterator]();
    let pendingNext: Promise<IteratorResult<string>> | null = null;
    let streamEnded = false;
    let nextEmitIndex = 0;

    const enqueueValidatedSentence = (sentence: string) => {
      if (firstSentenceMs === 0) {
        firstSentenceMs = Math.round(performance.now() - tLlmStart);
      }

      // Strict Sentence-Level Grounding Validation before any TTS call
      const groundCheck: SentenceGroundingResult = isMatchedFaq
        ? evaluateSentenceGrounding(sentence, retrieval.faqs)
        : {
            status: 'GROUNDED_SAFE',
            reason: 'UNMATCHED_GUARDED',
            sanitizedText: sentence,
          };

      if (groundCheck.status === 'GROUNDED_SAFE') {
        approvedSpokenSentences.push(sentence);
        ttsQueue.enqueue(sentence);
      } else {
        // Never synthesize rejected or held text during streaming.
        // Full-answer validation below will release or replace with canonical evidence.
        heldSentences.push({
          text: sentence,
          initialStatus: groundCheck.status,
        });
      }
    };

    while (!streamEnded || nextEmitIndex < ttsQueue.length) {
      if (signal?.aborted) {
        ttsQueue.abort();
        return;
      }

      // 1. Drain any completed TTS jobs strictly in sentence order
      while (
        nextEmitIndex < ttsQueue.length &&
        ttsQueue.isSettled(nextEmitIndex)
      ) {
        if (signal?.aborted) {
          ttsQueue.abort();
          return;
        }
        const job = ttsQueue.get(nextEmitIndex);
        nextEmitIndex += 1;
        if (!job) continue;

        if (job.error) {
          throw job.error;
        }
        if (job.result) {
          const ttsRes = job.result;
          totalTtsMs += ttsRes.ttsLatencyMs;
          if (firstAudioReadyMs === 0) {
            firstAudioReadyMs = Math.round(performance.now() - tLlmStart);
          }
          const audioBase64 = ttsRes.buffer.toString('base64');
          const audioDataUri = `data:audio/mpeg;base64,${audioBase64}`;

          yield {
            event: 'audio_chunk_ready',
            data: {
              chunkIndex: chunkIndex++,
              text: job.text,
              audioDataUri,
              cached: ttsRes.cacheStatus === 'HIT',
              latencyMs: ttsRes.ttsLatencyMs,
              isLast: false,
            },
          };
        }
      }

      if (streamEnded) {
        if (nextEmitIndex < ttsQueue.length) {
          await ttsQueue.waitFor(nextEmitIndex);
        }
        continue;
      }

      // 2. Advance LLM token stream concurrently with in-flight TTS jobs
      if (!pendingNext) {
        pendingNext = iterator.next();
      }

      let tokenResult: IteratorResult<string> | null = null;
      if (nextEmitIndex < ttsQueue.length) {
        const winner = await Promise.race([
          pendingNext.then((value) => ({ kind: 'token' as const, value })),
          ttsQueue
            .waitFor(nextEmitIndex)
            .then(() => ({ kind: 'tts' as const })),
        ]);
        if (winner.kind === 'tts') {
          continue;
        }
        pendingNext = null;
        tokenResult = winner.value;
      } else {
        tokenResult = await pendingNext;
        pendingNext = null;
      }

      if (signal?.aborted) {
        ttsQueue.abort();
        return;
      }

      if (tokenResult.done) {
        streamEnded = true;
        const finalTrailing = sentenceSplitter.flush();
        if (finalTrailing) {
          yield {
            event: 'sentence_ready',
            data: {
              sentenceIndex: sentenceIndex++,
              text: finalTrailing,
            },
          };
          enqueueValidatedSentence(finalTrailing);
        }
        continue;
      }

      const token = tokenResult.value;
      if (llmTtftMs === 0 && token.length > 0) {
        llmTtftMs = Math.round(performance.now() - tLlmStart);
      }
      fullAccumulatedText += token;

      yield {
        event: 'text_chunk',
        data: {
          delta: token,
          accumulated: fullAccumulatedText,
        },
      };

      const completedSentences = sentenceSplitter.feed(token);
      for (const sentence of completedSentences) {
        yield {
          event: 'sentence_ready',
          data: {
            sentenceIndex: sentenceIndex++,
            text: sentence,
          },
        };
        enqueueValidatedSentence(sentence);
      }
    }

    let approvedFullAnswer = fullAccumulatedText.trim();

    // Held text is released only if the completed answer passes grounding as a
    // whole. Otherwise it is replaced once with canonical verified evidence.
    if (heldSentences.length > 0) {
      const fullGrounding = isMatchedFaq
        ? evaluateCompleteAnswerGrounding(fullAccumulatedText, retrieval.faqs)
        : { approved: true };

      const releasableHeldText =
        fullGrounding.approved &&
        heldSentences.every(
          (pending) => pending.initialStatus !== 'FABRICATION_DETECTED',
        );
      let needsSafeRecovery = !releasableHeldText;

      if (releasableHeldText) {
        for (const pending of heldSentences) {
          if (signal?.aborted) return;
          const recheck = evaluateSentenceGrounding(
            pending.text,
            retrieval.faqs,
          );
          if (recheck.status !== 'GROUNDED_SAFE') {
            needsSafeRecovery = true;
            continue;
          }

          const ttsRes = await synthesizeSpeechMp3WithMetrics(
            recheck.sanitizedText,
            customTtsGenerator,
          );
          totalTtsMs += ttsRes.ttsLatencyMs;
          if (firstAudioReadyMs === 0) {
            firstAudioReadyMs = Math.round(performance.now() - tLlmStart);
          }
          const audioBase64 = ttsRes.buffer.toString('base64');
          approvedSpokenSentences.push(recheck.sanitizedText);
          yield {
            event: 'audio_chunk_ready',
            data: {
              chunkIndex: chunkIndex++,
              text: recheck.sanitizedText,
              audioDataUri: `data:audio/mpeg;base64,${audioBase64}`,
              cached: ttsRes.cacheStatus === 'HIT',
              latencyMs: ttsRes.ttsLatencyMs,
              isLast: false,
            },
          };
        }
      }

      if (needsSafeRecovery && isMatchedFaq && retrieval.faqs[0]) {
        const safeRecovery = formatCanonicalFaqAnswer(retrieval.faqs[0].answer);
        const recoveryCheck = evaluateSentenceGrounding(
          safeRecovery,
          retrieval.faqs,
        );
        if (
          recoveryCheck.status === 'GROUNDED_SAFE' &&
          !approvedSpokenSentences.includes(recoveryCheck.sanitizedText)
        ) {
          const ttsRes = await synthesizeSpeechMp3WithMetrics(
            recoveryCheck.sanitizedText,
            customTtsGenerator,
          );
          totalTtsMs += ttsRes.ttsLatencyMs;
          if (firstAudioReadyMs === 0) {
            firstAudioReadyMs = Math.round(performance.now() - tLlmStart);
          }
          const audioBase64 = ttsRes.buffer.toString('base64');
          approvedSpokenSentences.push(recoveryCheck.sanitizedText);
          yield {
            event: 'audio_chunk_ready',
            data: {
              chunkIndex: chunkIndex++,
              text: recoveryCheck.sanitizedText,
              audioDataUri: `data:audio/mpeg;base64,${audioBase64}`,
              cached: ttsRes.cacheStatus === 'HIT',
              latencyMs: ttsRes.ttsLatencyMs,
              isLast: false,
            },
          };
        }
        approvedFullAnswer = approvedSpokenSentences.join(' ').trim();
      }
    }

    const llmDurationMs = Math.round(performance.now() - tLlmStart);

    yield {
      event: 'done',
      data: {
        tier: 'TIER_2',
        fullAnswer: approvedFullAnswer,
        totalChunks: chunkIndex,
        timings: {
          retrievalMs: retrievalLatencyMs,
          llmTtftMs,
          firstSentenceMs,
          firstAudioReadyMs,
          llmMs: llmDurationMs,
          ttsMs: totalTtsMs,
          ...(retrieval.retrievalMetrics
            ? { retrievalMetrics: retrieval.retrievalMetrics }
            : {}),
        },
      },
    };
  } catch (err) {
    ttsQueue.abort();
    if (signal?.aborted) return;
    yield {
      event: 'error',
      data: {
        code: err instanceof ApiError ? err.code : 'STREAM_ERROR',
        message:
          err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการสตรีมคำตอบ',
      },
    };
  } finally {
    ttsQueue.abort();
    if (signal?.aborted && iterator?.return) {
      await iterator.return().catch(() => {});
    }
  }
}
