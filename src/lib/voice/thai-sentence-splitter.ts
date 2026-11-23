/**
 * Thai Sentence Boundary Splitter for Realtime Voice Streaming.
 *
 * Buffers incoming LLM tokens and yields complete, natural Thai speech sentences.
 * Specifically designed to preserve:
 * 1. Time expressions (e.g. "09:00–16:00 น.", "9.00 น.") without cutting at "น."
 * 2. Abbreviations (e.g. "พ.ศ.", "รหัส DEMO-001")
 * 3. Natural polite particle boundaries ("ครับ", "ค่ะ", "นะครับ", "นะคะ", "ครับผม")
 * 4. Punctuation and newlines ("\n", "!", "?")
 * 5. Minimum length threshold to ensure natural TTS prosody (avoiding choppy 1-word audio chunks)
 */

const MIN_CHUNK_CHARS = 24;
const CLAUSE_SPLIT_MIN_CHARS = 36;
const MIN_CLAUSE_PREFIX_CHARS = 28;

// Polite sentence terminators must be followed by an explicit delimiter
// (never end-of-buffer `$`) so split tokens like "ครับ" + "ผม" are not
// prematurely severed across streaming deltas.
const POLITE_PARTICLE_BOUNDARY_REGEX =
  /(ครับผม|นะครับ|นะคะ|ครับ|ค่ะ|คะ)([\s\n.,!?])/u;

// Safe Thai clause connectors for early TTS pipelining on long single-sentence
// responses that place the polite particle only at the very end.
const SAFE_CLAUSE_CONNECTOR_REGEX = /\s+(?=(?:โดย|ดังนั้น|ส่วน|เพราะ|ซึ่ง|ทั้งนี้))/u;

const INCOMPLETE_TAIL_REGEX =
  /(?:เวลา|ตั้งแต่|ถึง|จนถึง|วันที่|วัน|ชั้น|ราคา|รหัส|ประมาณ|\d+)$/u;

export class ThaiSentenceSplitter {
  private buffer = '';
  private completedSentences: string[] = [];

  /**
   * Feeds a delta token from the LLM stream.
   * Returns any newly completed sentences ready for validation and TTS.
   */
  public feed(token: string): string[] {
    if (!token) {
      return [];
    }

    this.buffer += token;
    const ready: string[] = [];

    while (this.buffer.length >= MIN_CHUNK_CHARS) {
      const splitIdx = this.findBoundaryIndex(this.buffer);
      if (splitIdx === -1) {
        break;
      }

      const candidate = this.buffer.slice(0, splitIdx).trim();
      this.buffer = this.buffer.slice(splitIdx).trimStart();

      if (candidate.length > 0) {
        ready.push(candidate);
        this.completedSentences.push(candidate);
      }
    }

    return ready;
  }

  /**
   * Flushes any remaining characters in the buffer when the LLM stream ends.
   */
  public flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining.length > 0) {
      this.completedSentences.push(remaining);
      return remaining;
    }
    return null;
  }

  /**
   * Returns all completed sentences accumulated so far.
   */
  public getAllCompleted(): readonly string[] {
    return this.completedSentences;
  }

  /**
   * Resets the splitter state for a new turn.
   */
  public reset(): void {
    this.buffer = '';
    this.completedSentences = [];
  }

  /**
   * Finds the earliest natural speech boundary index that satisfies minimum length.
   */
  private findBoundaryIndex(text: string): number {
    // 1. Check for explicit newline
    const newlineIdx = text.indexOf('\n');
    if (newlineIdx >= MIN_CHUNK_CHARS) {
      return newlineIdx + 1;
    }

    // 2. Check for polite particle boundary
    // Scan only beyond MIN_CHUNK_CHARS to ensure natural prosodic duration
    const searchSlice = text.slice(MIN_CHUNK_CHARS);
    const match = POLITE_PARTICLE_BOUNDARY_REGEX.exec(searchSlice);
    if (match) {
      const boundaryRelative = match.index + match[0].length;
      const boundaryAbsolute = MIN_CHUNK_CHARS + boundaryRelative;

      // Ensure we don't cut inside a time range like "09:00 น. ถึง 16:00 น."
      const candidate = text.slice(0, boundaryAbsolute);
      if (!isUnfinishedTimeRange(candidate)) {
        return boundaryAbsolute;
      }
    }

    // 3. Safe Thai clause boundary for long single-sentence responses
    if (text.length >= CLAUSE_SPLIT_MIN_CHARS) {
      const clauseSlice = text.slice(MIN_CLAUSE_PREFIX_CHARS);
      const clauseMatch = SAFE_CLAUSE_CONNECTOR_REGEX.exec(clauseSlice);
      if (clauseMatch) {
        const boundaryAbsolute =
          MIN_CLAUSE_PREFIX_CHARS + clauseMatch.index + clauseMatch[0].length;
        const candidate = text.slice(0, boundaryAbsolute).trim();
        if (
          candidate.length >= MIN_CLAUSE_PREFIX_CHARS &&
          !isUnfinishedTimeRange(candidate) &&
          !INCOMPLETE_TAIL_REGEX.test(candidate)
        ) {
          return boundaryAbsolute;
        }
      }
    }

    // 4. Fallback: if buffer grows too large (> 120 chars without boundary),
    // find the last whitespace to prevent unbounded latency.
    if (text.length >= 120) {
      const lastSpaceIdx = text.lastIndexOf(' ', 120);
      if (lastSpaceIdx >= MIN_CHUNK_CHARS) {
        return lastSpaceIdx + 1;
      }
      return 120;
    }

    return -1;
  }
}

/**
 * Checks if a candidate sentence opens a time range (e.g. "ตั้งแต่เวลา 09:00 น.")
 * but hasn't closed the range with the end time (e.g. "ถึง 16:00 น.").
 */
function isUnfinishedTimeRange(text: string): boolean {
  const hasOpening = /ตั้งแต่|เริ่มเวลา|เปิดเวลา/u.test(text);
  const hasTo = /ถึง|จนถึง|–|-/u.test(text);
  const timeCount = (text.match(/\d{1,2}[:.]\d{2}/g) || []).length;

  if (hasOpening && !hasTo && timeCount === 1) {
    return true;
  }
  return false;
}

/**
 * Splits a full static text string into sentences.
 */
export function splitThaiSentences(fullText: string): string[] {
  const splitter = new ThaiSentenceSplitter();
  const sentences = splitter.feed(fullText);
  const flushed = splitter.flush();
  if (flushed) {
    sentences.push(flushed);
  }
  return sentences;
}
