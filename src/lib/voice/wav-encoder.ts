/**
 * Pure, deterministic utility for encoding 16-bit Linear PCM audio into standard WAV (RIFF WAVE) format.
 * Enables sample-accurate audio recording and pre-roll buffers in the browser without container corruption.
 */

export interface PcmRingBufferOptions {
  sampleRate: number;
  maxBufferDurationMs: number;
}

/**
 * High-performance circular Ring Buffer for raw 32-bit float PCM audio samples.
 * Maintains rolling pre-speech audio without allocating memory continuously.
 */
export class PcmRingBuffer {
  private readonly buffer: Float32Array;
  private readonly capacity: number;
  private writeIndex = 0;
  private totalSamplesWritten = 0;

  constructor(options: PcmRingBufferOptions) {
    const { sampleRate, maxBufferDurationMs } = options;
    this.capacity = Math.max(
      1,
      Math.floor((sampleRate * maxBufferDurationMs) / 1000),
    );
    this.buffer = new Float32Array(this.capacity);
  }

  /**
   * Pushes incoming audio samples into the circular buffer.
   */
  public push(samples: Float32Array): void {
    const len = samples.length;
    for (let i = 0; i < len; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.totalSamplesWritten += 1;
    }
  }

  /**
   * Retrieves the most recent `durationMs` of audio samples in chronological order.
   */
  public getRecentSamples(
    durationMs: number,
    sampleRate: number,
  ): Float32Array {
    const requestedCount = Math.floor((sampleRate * durationMs) / 1000);
    const availableCount = Math.min(this.totalSamplesWritten, this.capacity);
    const count = Math.min(requestedCount, availableCount);

    if (count <= 0) {
      return new Float32Array(0);
    }

    const output = new Float32Array(count);
    const startIndex =
      (this.writeIndex - count + this.capacity) % this.capacity;

    for (let i = 0; i < count; i++) {
      const idx = (startIndex + i) % this.capacity;
      output[i] = this.buffer[idx];
    }

    return output;
  }

  /**
   * Resets the buffer to empty state.
   */
  public clear(): void {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.totalSamplesWritten = 0;
  }
}

/**
 * Concatenates multiple Float32Array chunks into a single Float32Array.
 */
export function mergeFloat32Arrays(
  chunks: ReadonlyArray<Float32Array>,
): Float32Array {
  let totalLength = 0;
  for (let i = 0; i < chunks.length; i++) {
    totalLength += chunks[i].length;
  }

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    merged.set(chunks[i], offset);
    offset += chunks[i].length;
  }

  return merged;
}

/**
 * Downsamples Float32Array from `inputSampleRate` to `targetSampleRate` using linear interpolation.
 */
export function downsamplePcm(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (inputSampleRate === targetSampleRate || input.length === 0) {
    return input;
  }

  if (targetSampleRate > inputSampleRate) {
    // Upsampling not required for speech STT
    return input;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const originalPos = i * ratio;
    const index1 = Math.floor(originalPos);
    const index2 = Math.min(input.length - 1, index1 + 1);
    const interpolation = originalPos - index1;
    result[i] =
      input[index1] * (1 - interpolation) + input[index2] * interpolation;
  }

  return result;
}

/**
 * Encodes raw single-channel (mono) Float32Array PCM samples into standard 16-bit WAV (RIFF WAVE) format.
 * Produces valid, compliant audio that OpenAI Whisper decodes with zero container corruption.
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  const bytesPerSample = 2; // 16-bit
  const channelCount = 1; // mono
  const dataByteLength = samples.length * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataByteLength);
  const buffer = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // RIFF Chunk Descriptor
  writeAsciiString(buffer, 0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true); // File size - 8
  writeAsciiString(buffer, 8, 'WAVE');

  // fmt Subchunk
  writeAsciiString(buffer, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = Linear PCM)
  view.setUint16(22, channelCount, true); // NumChannels (1 = Mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true); // ByteRate
  view.setUint16(32, channelCount * bytesPerSample, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // data Subchunk
  writeAsciiString(buffer, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  // Write 16-bit PCM samples with clipping protection
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp sample between -1.0 and 1.0
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Scale to signed 16-bit integer (-32768 to 32767)
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return buffer;
}

function writeAsciiString(
  target: Uint8Array,
  offset: number,
  string: string,
): void {
  for (let i = 0; i < string.length; i++) {
    target[offset + i] = string.charCodeAt(i);
  }
}
