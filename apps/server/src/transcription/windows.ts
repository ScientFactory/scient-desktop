export const sampleRate = 16_000;
export const frameSize = 512;

export type WindowRule = "meetily" | "fixed" | "short";
export type Frame = { pcm: Float32Array; speech: boolean };
export type Window = {
  id: number;
  start: number;
  end: number;
  pcm: Float32Array;
  mapping: { processedStart: number; sourceStart: number; length: number }[];
};

export async function* planWindows(
  frames: AsyncIterable<Frame>,
  rule: WindowRule,
  maxAudioBytes = Infinity,
) {
  let pending: Frame[] = [];
  let origin = 0;
  let id = 0;
  let trailingSilence = 0;
  const frameCount = (seconds: number) => Math.floor((seconds * sampleRate) / frameSize);
  const padding = frameCount(0.2);
  const cap = Math.min(
    frameCount(rule === "short" ? 15 : 28),
    Math.floor((maxAudioBytes - 44) / (2 * frameSize)),
  );
  if (cap < 1) throw new Error("WAV size limit cannot fit an audio frame.");
  const target = Math.min(cap, frameCount(rule === "short" ? 12 : 25));

  function take(count: number): Window | undefined {
    const selected = pending.splice(0, count);
    const sourceStart = origin;
    origin += selected.reduce((size, frame) => size + frame.pcm.length, 0);
    const first = selected.findIndex((frame) => frame.speech);
    if (first < 0) return;
    const last = selected.findLastIndex((frame) => frame.speech);
    const start = rule === "fixed" ? 0 : Math.max(0, first - padding);
    const end = rule === "fixed" ? selected.length : Math.min(selected.length, last + padding + 1);
    const length = selected.slice(start, end).reduce((size, frame) => size + frame.pcm.length, 0);
    const pcm = new Float32Array(length);
    let offset = 0;
    for (const frame of selected.slice(start, end)) {
      pcm.set(frame.pcm, offset);
      offset += frame.pcm.length;
    }
    const source =
      sourceStart + selected.slice(0, start).reduce((size, frame) => size + frame.pcm.length, 0);
    return {
      id: id++,
      start: source,
      end: source + length,
      pcm,
      mapping: [{ processedStart: 0, sourceStart: source, length }],
    };
  }

  for await (const frame of frames) {
    pending.push(frame);
    trailingSilence = frame.speech ? 0 : trailingSilence + 1;
    let cut = 0;
    if (
      rule !== "fixed" &&
      trailingSilence >= frameCount(2) &&
      pending.length > padding &&
      (rule !== "short" || pending.length >= frameCount(5))
    ) {
      cut = pending.length - padding;
    } else if (pending.length === cap) {
      cut = cap;
      if (rule !== "fixed") {
        let lowest = Infinity;
        for (let index = Math.max(0, target - frameCount(3)); index + 3 <= cap; index++) {
          let energy = 0;
          for (const candidate of pending.slice(index, index + 3)) {
            for (const sample of candidate.pcm) energy += sample * sample;
          }
          if (
            energy < lowest ||
            (energy === lowest && Math.abs(index + 1 - target) < Math.abs(cut - target))
          ) {
            lowest = energy;
            cut = index + 1;
          }
        }
      }
    }
    if (cut > 0) {
      const window = take(cut);
      trailingSilence = Math.min(trailingSilence, pending.length);
      if (window) yield window;
    }
  }
  const tail = take(pending.length);
  if (tail) yield tail;
}

export function sourceSeconds(window: Window, processedSeconds: number) {
  const sample = Math.max(
    0,
    Math.min(
      window.pcm.length,
      (Number.isFinite(processedSeconds) ? processedSeconds : 0) * sampleRate,
    ),
  );
  const span = window.mapping.findLast((entry) => entry.processedStart <= sample);
  return span
    ? (span.sourceStart + Math.min(span.length, sample - span.processedStart)) / sampleRate
    : window.start / sampleRate;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export function looksRepetitive(text: string) {
  const words = [...wordSegmenter.segment(text.normalize("NFKC").toLowerCase())]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
  return words.length >= 12 && new Set(words).size / words.length < 0.25;
}

export async function* replayWindows(
  frames: AsyncIterable<Float32Array>,
  plans: readonly Omit<Window, "pcm">[],
  completed: number,
): AsyncGenerator<Window> {
  let index = completed;
  let plan = plans[index];
  if (!plan) return;
  let pcm = new Float32Array(plan.end - plan.start);
  let source = 0;
  for await (const frame of frames) {
    const frameEnd = source + frame.length;
    while (plan && plan.start < frameEnd) {
      const start = Math.max(source, plan.start);
      const end = Math.min(frameEnd, plan.end);
      pcm.set(frame.subarray(start - source, end - source), start - plan.start);
      if (end !== plan.end) break;
      yield { ...plan, pcm };
      plan = plans[++index];
      if (!plan) return;
      pcm = new Float32Array(plan.end - plan.start);
    }
    source = frameEnd;
  }
  throw new Error("Decoded audio ended before the planned window.");
}

export async function* scoreSpeech(
  frames: AsyncIterable<Float32Array>,
  score: (frames: readonly Float32Array[]) => Promise<readonly number[]>,
): AsyncGenerator<Frame> {
  let batch: Float32Array[] = [];
  let onset: Float32Array[] = [];
  let voiced = false;
  const minimumSpeechSamples = sampleRate / 4;
  let onsetSamples = 0;
  async function* flush(): AsyncGenerator<Frame> {
    const scores = await score(batch);
    if (scores.length !== batch.length) throw new Error("Incomplete VAD score batch.");
    for (const [index, pcm] of batch.entries()) {
      const probability = scores[index] ?? 0;
      if (voiced && probability < 0.35) voiced = false;
      if (voiced) {
        yield { pcm, speech: true };
      } else if (probability >= (onset.length ? 0.35 : 0.5)) {
        onset.push(pcm);
        onsetSamples += pcm.length;
        if (onsetSamples >= minimumSpeechSamples) {
          voiced = true;
          for (const candidate of onset) yield { pcm: candidate, speech: true };
          onset = [];
          onsetSamples = 0;
        }
      } else {
        for (const candidate of onset) yield { pcm: candidate, speech: false };
        onset = [];
        onsetSamples = 0;
        yield { pcm, speech: false };
      }
    }
    batch = [];
  }
  for await (const pcm of frames) {
    batch.push(pcm);
    if (batch.length === 32) yield* flush();
  }
  if (batch.length) yield* flush();
  for (const pcm of onset) yield { pcm, speech: false };
}
