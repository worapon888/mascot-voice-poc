import {
  extractQuestionCore,
  normalizeThaiText,
  stripLeadingConversationalPrefixes,
  stripLocativeDemonstratives,
  stripTrailingPoliteParticles,
} from '@/services/faq-matching.service';
import type { FaqRecord } from '@/types/faq';
import type { LexicalSearchResult } from './types';

/**
 * Tokenizes normalized Thai query into n-grams and word tokens for inverted index search.
 */
export function tokenizeThai(text: string): string[] {
  const norm = normalizeThaiText(text);
  const politeStripped = stripTrailingPoliteParticles(norm);
  const convStripped = stripLeadingConversationalPrefixes(politeStripped);
  const locStripped = stripLocativeDemonstratives(convStripped);
  const core = extractQuestionCore(locStripped);

  const tokens = new Set<string>();

  // Word segments split by space
  for (const part of locStripped.split(/\s+/)) {
    if (part.length >= 2) tokens.add(part);
  }
  for (const part of core.split(/\s+/)) {
    if (part.length >= 2) tokens.add(part);
  }

  // Spaceless full string and core string
  const spacelessLoc = locStripped.replace(/\s+/g, '');
  const spacelessCore = core.replace(/\s+/g, '');
  if (spacelessLoc.length >= 2) tokens.add(spacelessLoc);
  if (spacelessCore.length >= 2) tokens.add(spacelessCore);

  // Sub-phrases (3-grams, 4-grams, 5-grams)
  const full = spacelessCore;
  for (let len = 3; len <= 8; len++) {
    for (let i = 0; i <= full.length - len; i++) {
      tokens.add(full.slice(i, i + len));
    }
  }

  return Array.from(tokens);
}

/**
 * Pure scalable Lexical Search Engine using TF-IDF / BM25 style inverted index
 * across `question`, `keywords`, and `answer`. Zero hardcoded question IDs.
 */
export class LexicalSearchEngine {
  private indexedFaqs: FaqRecord[] = [];
  private tokenIndex = new Map<string, Set<number>>();
  private idToFaq = new Map<number, FaqRecord>();
  private docFrequencies = new Map<string, number>();

  constructor(faqs: FaqRecord[]) {
    this.buildIndex(faqs);
  }

  public buildIndex(faqs: FaqRecord[]): void {
    this.indexedFaqs = faqs;
    this.tokenIndex.clear();
    this.idToFaq.clear();
    this.docFrequencies.clear();

    for (const faq of faqs) {
      this.idToFaq.set(faq.id, faq);

      const docText = `${faq.question} ${(faq.keywords ?? []).join(' ')} ${faq.answer}`;
      const tokens = tokenizeThai(docText);

      for (const tok of tokens) {
        if (!this.tokenIndex.has(tok)) {
          this.tokenIndex.set(tok, new Set());
        }
        this.tokenIndex.get(tok)!.add(faq.id);
      }
    }

    for (const [tok, docIds] of this.tokenIndex.entries()) {
      this.docFrequencies.set(tok, docIds.size);
    }
  }

  public search(query: string, topK = 10): LexicalSearchResult[] {
    const queryTokens = tokenizeThai(query);
    const scores = new Map<number, { score: number; terms: string[] }>();
    const totalDocs = this.indexedFaqs.length || 1;

    const normQuery = normalizeThaiText(query);
    const locStripped = stripLocativeDemonstratives(
      stripLeadingConversationalPrefixes(
        stripTrailingPoliteParticles(normQuery),
      ),
    );
    const spacelessQuery = locStripped.replace(/\s+/g, '');
    const coreQuery = extractQuestionCore(locStripped).replace(/\s+/g, '');

    for (const faq of this.indexedFaqs) {
      let docScore = 0;
      const matchedTerms: string[] = [];

      const normQ = normalizeThaiText(faq.question).replace(/\s+/g, '');
      const coreQ = extractQuestionCore(normQ).replace(/\s+/g, '');

      // 1. Exact or near-exact question match (highest boost)
      if (spacelessQuery === normQ || coreQuery === coreQ) {
        docScore += 100;
        matchedTerms.push('exact_question');
      } else if (spacelessQuery.includes(normQ) || normQ.includes(coreQuery)) {
        docScore += 60;
        matchedTerms.push('contains_question');
      }

      // 2. Keyword exact match
      for (const kw of faq.keywords ?? []) {
        const normKw = normalizeThaiText(kw).replace(/\s+/g, '');
        if (
          normKw.length >= 2 &&
          (spacelessQuery.includes(normKw) || normKw.includes(coreQuery))
        ) {
          const kwBoost = 25 + normKw.length * 3;
          docScore += kwBoost;
          matchedTerms.push(`kw:${normKw}`);
        }
      }

      // 3. BM25-like token overlap
      for (const tok of queryTokens) {
        if (tok.length >= 3) {
          const docCount = this.docFrequencies.get(tok) ?? 0;
          if (docCount > 0 && this.tokenIndex.get(tok)?.has(faq.id)) {
            // IDF: rare terms carry higher weight
            const idf = Math.log(
              1 + (totalDocs - docCount + 0.5) / (docCount + 0.5),
            );
            const tfWeight = Math.min(tok.length * 1.5, 12);
            docScore += Math.max(idf, 0.5) * tfWeight;
            matchedTerms.push(tok);
          }
        }
      }

      if (docScore > 0) {
        scores.set(faq.id, { score: docScore, terms: matchedTerms });
      }
    }

    const sorted = Array.from(scores.entries())
      .map(([id, data]) => ({
        faq: this.idToFaq.get(id)!,
        score: Math.round(data.score * 10) / 10,
        matchedTerms: data.terms,
        rank: 0,
      }))
      .sort((a, b) => b.score - a.score || a.faq.id - b.faq.id)
      .slice(0, topK);

    sorted.forEach((item, idx) => {
      item.rank = idx + 1;
    });

    return sorted;
  }
}
