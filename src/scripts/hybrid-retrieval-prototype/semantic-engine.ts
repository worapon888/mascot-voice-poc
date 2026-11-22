import { createHash } from 'node:crypto';
import type { FaqRecord } from '@/types/faq';
import type { SemanticSearchResult, SemanticVector } from './types';

/**
 * Computes cosine similarity between two unit-normalized float arrays.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Computes a deterministic content hash for a FAQ to invalidate/refresh embeddings only when changed.
 */
export function computeFaqEmbeddingHash(faq: FaqRecord): string {
  const payload = `${faq.id}|${faq.question}|${faq.answer}|${(faq.keywords ?? []).sort().join(',')}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * High-performance In-Memory Semantic Search Engine simulating PostgreSQL + pgvector (HNSW).
 */
export class SemanticSearchEngine {
  private vectorStore = new Map<number, SemanticVector>();
  private idToFaq = new Map<number, FaqRecord>();
  private embeddingCache = new Map<string, number[]>();

  constructor(faqs: FaqRecord[] = []) {
    if (faqs.length > 0) {
      this.indexFaqs(faqs);
    }
  }

  public indexFaqs(
    faqs: FaqRecord[],
    embedder?: (text: string) => Promise<number[]> | number[],
  ): void {
    this.vectorStore.clear();
    this.idToFaq.clear();

    for (const faq of faqs) {
      this.idToFaq.set(faq.id, faq);
      const textToEmbed = `คำถาม: ${faq.question} คำสำคัญ: ${(faq.keywords ?? []).join(' ')} คำตอบ: ${faq.answer}`;
      const hash = computeFaqEmbeddingHash(faq);

      let vector = this.embeddingCache.get(hash);
      if (!vector) {
        vector = embedder
          ? (embedder(textToEmbed) as number[])
          : this.generateDeterministicVector(textToEmbed);
        this.embeddingCache.set(hash, vector);
      }

      this.vectorStore.set(faq.id, {
        faqId: faq.id,
        embedding: vector,
        contentHash: hash,
      });
    }
  }

  /**
   * Deterministic Semantic Vector Projection (128-dim dense representation)
   * used for high-throughput synthetic offline evaluation without paid external API rate-limits.
   */
  public generateDeterministicVector(text: string, dim = 128): number[] {
    const vector = new Array<number>(dim).fill(0);
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);

    for (const word of words) {
      const hash = createHash('sha256').update(word).digest();
      for (let i = 0; i < dim; i++) {
        const byte = hash[i % hash.length];
        const val = (byte - 128) / 128;
        vector[i] += val;
      }
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) vector[i] /= norm;

    return vector;
  }

  public search(queryVector: number[], topK = 10): SemanticSearchResult[] {
    const results: Array<{ faq: FaqRecord; similarity: number }> = [];

    for (const [id, vec] of this.vectorStore.entries()) {
      const faq = this.idToFaq.get(id);
      if (!faq) continue;

      const sim = cosineSimilarity(queryVector, vec.embedding);
      results.push({ faq, similarity: Math.round(sim * 1000) / 1000 });
    }

    const sorted = results
      .sort((a, b) => b.similarity - a.similarity || a.faq.id - b.faq.id)
      .slice(0, topK);

    return sorted.map((item, idx) => ({
      faq: item.faq,
      similarity: item.similarity,
      rank: idx + 1,
    }));
  }
}
