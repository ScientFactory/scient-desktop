import { fingerprint, type Segment } from "./ledger.ts";
import type { Engine, Job } from "./job.ts";
import { decodePcm } from "./media.ts";
import { sampleRate } from "./windows.ts";
import { recognitionTerms } from "./words.ts";

export function claimRelistenSpan(segment: Segment, remaining: number) {
  const duration = segment.end - segment.start;
  return Number.isFinite(duration) &&
    segment.start >= 0 &&
    duration >= 0.25 &&
    duration <= 28 &&
    duration <= remaining
    ? duration
    : undefined;
}

export function relistenPass(
  job: Job,
  estimate: NonNullable<NonNullable<Job["correction"]>["relisten"]>,
  signal: AbortSignal,
  open: (signal: AbortSignal) => Promise<Engine>,
) {
  let remaining = estimate.audioSeconds;
  let engine: Engine | undefined;
  let deadline: AbortSignal | undefined;
  let unavailable = false;
  return {
    async recognize(segment: Segment) {
      const duration = claimRelistenSpan(segment, remaining);
      if (duration === undefined || unavailable || deadline?.aborted) return;
      deadline ??= AbortSignal.any([signal, AbortSignal.timeout(estimate.wallSeconds * 1_000)]);
      remaining -= duration;
      try {
        if (JSON.stringify(await fingerprint(job.source)) !== JSON.stringify(job.input)) {
          unavailable = true;
          return;
        }
        engine ??= await open(deadline);
        const pcm = new Float32Array(Math.ceil(duration * sampleRate));
        let offset = 0;
        for await (const frame of decodePcm(
          job.settings.ffmpeg,
          job.source,
          deadline,
          segment.start,
          segment.end,
          job.settings.standaloneMedia,
        )) {
          const part = frame.subarray(0, pcm.length - offset);
          pcm.set(part, offset);
          offset += part.length;
        }
        if (offset === 0) return;
        if (JSON.stringify(await fingerprint(job.source)) !== JSON.stringify(job.input)) {
          unavailable = true;
          return;
        }
        const result = await engine.recognize(
          pcm.subarray(0, offset),
          false,
          engine.recognitionHints ? { terms: recognitionTerms(job.words ?? []) } : undefined,
        );
        return result
          .map(({ text }) => text.trim())
          .filter(Boolean)
          .join(" ");
      } catch {
        signal.throwIfAborted();
        unavailable = true;
      }
    },
    async close() {
      await engine?.close();
    },
  };
}
