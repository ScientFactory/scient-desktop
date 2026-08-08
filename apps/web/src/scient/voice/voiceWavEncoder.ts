// Pure, dependency-light audio encoding for local voice dictation.
//
// The recorder captures mono `Float32Array` frames at the AudioContext's native
// sample rate (commonly 48 kHz). Before a clip crosses the IPC boundary it must
// be normalised to the shape the local transcription core accepts: 24 kHz mono
// 16-bit PCM inside a standard 44-byte WAV container, base64-encoded so it
// survives JSON transport.
//
// Everything here is a pure function of its inputs (no DOM, no globals besides
// `Math`), so it is exhaustively unit-tested in `voiceWavEncoder.test.ts`.

import * as Encoding from "effect/Encoding";

/** Sample rate every emitted clip is resampled to before transcription. */
export const VOICE_CLIP_SAMPLE_RATE_HZ = 24_000;

const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const NUM_CHANNELS = 1;
const WAV_HEADER_BYTES = 44;

/** A transcription-ready clip: WAV bytes plus their base64 projection. */
export interface VoiceWavClip {
  readonly wavBytes: Uint8Array;
  readonly base64: string;
  readonly sampleRateHz: typeof VOICE_CLIP_SAMPLE_RATE_HZ;
  readonly durationMs: number;
}

/** Root-mean-square amplitude of a frame, in the `[0, 1]` range for `[-1, 1]` input. */
export function computeRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sumOfSquares = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = frame[i]!;
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / frame.length);
}

/**
 * Encode accumulated mono frames into a 24 kHz 16-bit PCM WAV clip.
 *
 * Frames are already mono (the recorder requests a single channel), so the only
 * transforms are: concatenate → linear-resample to 24 kHz → quantise to 16-bit
 * PCM → wrap in a WAV header → base64.
 */
export function encodeWavClip(
  frames: readonly Float32Array[],
  inputSampleRate: number,
): VoiceWavClip {
  const mono = concatFrames(frames);
  const resampled = resampleLinear(mono, inputSampleRate, VOICE_CLIP_SAMPLE_RATE_HZ);
  const wavBytes = encodeWav(resampled);
  const base64 = Encoding.encodeBase64(wavBytes);
  const durationMs = Math.round((resampled.length / VOICE_CLIP_SAMPLE_RATE_HZ) * 1000);
  return { wavBytes, base64, sampleRateHz: VOICE_CLIP_SAMPLE_RATE_HZ, durationMs };
}

function concatFrames(frames: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const frame of frames) total += frame.length;
  const merged = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    merged.set(frame, offset);
    offset += frame.length;
  }
  return merged;
}

/**
 * Linear-interpolating resampler. Adequate for speech dictation — the input is
 * already band-limited by the capture pipeline and the target rate is a clean
 * fraction of the common 48 kHz capture rate. The output length is
 * `round(inputLength * outputRate / inputRate)`.
 */
function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  const safeInputRate = inputRate > 0 ? inputRate : outputRate;
  if (safeInputRate === outputRate) return input.slice();

  const outputLength = Math.max(1, Math.round((input.length * outputRate) / safeInputRate));
  const output = new Float32Array(outputLength);
  // Map output index → fractional input index across the full span so the
  // first and last samples are preserved exactly.
  const step = outputLength > 1 ? (input.length - 1) / (outputLength - 1) : 0;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * step;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const fraction = position - leftIndex;
    const left = input[leftIndex]!;
    const right = input[rightIndex]!;
    output[i] = left + (right - left) * fraction;
  }
  return output;
}

function encodeWav(samples: Float32Array): Uint8Array {
  const dataSize = samples.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);
  const byteRate = VOICE_CLIP_SAMPLE_RATE_HZ * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE;

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // RIFF chunk size
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, VOICE_CLIP_SAMPLE_RATE_HZ, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(offset, floatSampleToPcm16(samples[i]!), true);
    offset += BYTES_PER_SAMPLE;
  }
  return new Uint8Array(buffer);
}

function floatSampleToPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
