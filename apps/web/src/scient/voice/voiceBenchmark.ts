// One-time decode-speed benchmark that decides whether live preview
// (transcribe-while-speaking) is allowed on THIS machine. We transcribe a short
// generated clip once, measure the real-time factor, and cache it — so slow or
// old computers never attempt the CPU-heavy snapshot loop (the final full-pass
// on stop still runs everywhere).

import type {
  VoiceBenchmarkResult,
  VoiceTranscribeRequest,
  VoiceTranscript,
} from "@t3tools/contracts";

import { VOICE_CLIP_SAMPLE_RATE_HZ, encodeWavClip } from "./voiceWavEncoder.ts";

const BENCHMARK_MODEL_ID = "whisper-small-multilingual-q5_1";
const BENCHMARK_SECONDS = 1.4;
const CACHE_KEY = "scient:voice:benchmark:v1";

/**
 * A short, deterministic low-amplitude noise clip. Content is irrelevant — we
 * only time the decode; noise makes whisper do representative work (unlike
 * silence, which it can skip near-instantly).
 */
function buildBenchmarkClip(): { audioBase64: string; sampleRateHz: number; durationMs: number } {
  const sampleCount = Math.round(VOICE_CLIP_SAMPLE_RATE_HZ * BENCHMARK_SECONDS);
  const frame = new Float32Array(sampleCount);
  let seed = 1234567;
  for (let i = 0; i < sampleCount; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    frame[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.05;
  }
  const clip = encodeWavClip([frame], VOICE_CLIP_SAMPLE_RATE_HZ);
  return { audioBase64: clip.base64, sampleRateHz: clip.sampleRateHz, durationMs: clip.durationMs };
}

/**
 * Transcribe the benchmark clip once and measure it. `loadMs` includes the
 * whisper process/model spin-up (the first snapshot pays the same cost).
 */
export async function runVoiceBenchmark(
  transcribe: (request: VoiceTranscribeRequest) => Promise<VoiceTranscript>,
): Promise<VoiceBenchmarkResult> {
  const clip = buildBenchmarkClip();
  const startedAt = performance.now();
  await transcribe({
    audioBase64: clip.audioBase64,
    mimeType: "audio/wav",
    sampleRateHz: clip.sampleRateHz,
    durationMs: clip.durationMs,
  });
  const elapsedMs = performance.now() - startedAt;
  return {
    modelId: BENCHMARK_MODEL_ID,
    rtf: clip.durationMs > 0 ? elapsedMs / clip.durationMs : Number.POSITIVE_INFINITY,
    loadMs: elapsedMs,
    sampleDurationMs: clip.durationMs,
  };
}

function isBenchmarkResult(value: unknown): value is VoiceBenchmarkResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { rtf?: unknown }).rtf === "number" &&
    typeof (value as { loadMs?: unknown }).loadMs === "number" &&
    typeof (value as { modelId?: unknown }).modelId === "string"
  );
}

export function getCachedBenchmark(): VoiceBenchmarkResult | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isBenchmarkResult(parsed) && parsed.modelId === BENCHMARK_MODEL_ID ? parsed : null;
  } catch {
    return null;
  }
}

export function setCachedBenchmark(result: VoiceBenchmarkResult): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(result));
  } catch {
    // Non-fatal: benchmark just re-runs next session.
  }
}
