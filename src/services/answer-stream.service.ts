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
import { synthesizeSpeechMp3WithMetrics } from '@/services/speech.service';
import { ThaiSentenceSplitter } from '@/lib/voice/thai-sentence-splitter';
import type { ConversationTurn } from '@/types/api';
import type { FaqRecord } from '@/types/faq';

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
  let chunkIndex = 0;
  const heldSentences: Array<{
    text: string;
    initialStatus: SentenceGroundingResult['status'];
  }> = [];
  const approvedSpokenSentences: string[] = [];

  const tLlmStart = performance.now();

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

    for await (const token of tokenStream) {
      if (signal?.aborted) return;
      fullAccumulatedText += token;

      yield {
        event: 'text_chunk',
        data: {
          delta: token,
          accumulated: fullAccumulatedText,
        },
      };

      // Split into sentences progressively
      const completedSentences = sentenceSplitter.feed(token);
      for (const sentence of completedSentences) {
        yield {
          event: 'sentence_ready',
          data: {
            sentenceIndex: chunkIndex,
            text: sentence,
          },
        };

        // Strict Sentence-Level Grounding Validation
        const groundCheck: SentenceGroundingResult = isMatchedFaq
          ? evaluateSentenceGrounding(sentence, retrieval.faqs)
          : {
              status: 'GROUNDED_SAFE',
              reason: 'UNMATCHED_GUARDED',
              sanitizedText: sentence,
            };

        if (groundCheck.status === 'GROUNDED_SAFE') {
          // Immediately synthesize speech for this sentence!
          const ttsRes = await synthesizeSpeechMp3WithMetrics(
            sentence,
            customTtsGenerator,
          );
          const audioBase64 = ttsRes.buffer.toString('base64');
          const audioDataUri = `data:audio/mpeg;base64,${audioBase64}`;
          approvedSpokenSentences.push(sentence);

          yield {
            event: 'audio_chunk_ready',
            data: {
              chunkIndex: chunkIndex++,
              text: sentence,
              audioDataUri,
              cached: ttsRes.cacheStatus === 'HIT',
              latencyMs: ttsRes.ttsLatencyMs,
              isLast: false,
            },
          };
        } else if (groundCheck.status === 'FABRICATION_DETECTED') {
          // Never synthesize rejected text. Full-answer validation below will
          // replace it with verified canonical evidence.
          heldSentences.push({
            text: sentence,
            initialStatus: groundCheck.status,
          });
        } else {
          heldSentences.push({
            text: sentence,
            initialStatus: groundCheck.status,
          });
        }
      }
    }

    // Flush any trailing sentence
    const finalTrailing = sentenceSplitter.flush();
    if (finalTrailing) {
      const trailingCheck: SentenceGroundingResult = isMatchedFaq
        ? evaluateSentenceGrounding(finalTrailing, retrieval.faqs)
        : {
            status: 'GROUNDED_SAFE',
            reason: 'UNMATCHED_GUARDED',
            sanitizedText: finalTrailing,
          };

      if (trailingCheck.status === 'GROUNDED_SAFE') {
        const ttsRes = await synthesizeSpeechMp3WithMetrics(
          finalTrailing,
          customTtsGenerator,
        );
        const audioBase64 = ttsRes.buffer.toString('base64');
        approvedSpokenSentences.push(finalTrailing);
        yield {
          event: 'audio_chunk_ready',
          data: {
            chunkIndex: chunkIndex++,
            text: finalTrailing,
            audioDataUri: `data:audio/mpeg;base64,${audioBase64}`,
            cached: ttsRes.cacheStatus === 'HIT',
            latencyMs: ttsRes.ttsLatencyMs,
            isLast: false,
          },
        };
      } else {
        heldSentences.push({
          text: finalTrailing,
          initialStatus: trailingCheck.status,
        });
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
          llmMs: llmDurationMs,
        },
      },
    };
  } catch (err) {
    if (signal?.aborted) return;
    yield {
      event: 'error',
      data: {
        code: err instanceof ApiError ? err.code : 'STREAM_ERROR',
        message:
          err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการสตรีมคำตอบ',
      },
    };
  }
}
