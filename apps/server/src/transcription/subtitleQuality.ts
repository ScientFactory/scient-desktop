import type { Cue } from "./subtitleParsers.ts";
import type { Recognition } from "./job.ts";

type Interval = Pick<Cue, "start" | "end">;
type Correction = { offset: number; scale: number };

function union(intervals: readonly Interval[]) {
  const merged: Interval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.end >= interval.start) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

const length = (intervals: readonly Interval[]) =>
  intervals.reduce((sum, i) => sum + i.end - i.start, 0);

function overlap(a: readonly Interval[], b: readonly Interval[], { offset, scale }: Correction) {
  let sum = 0;
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    const speech = a[left]!;
    const cue = b[right]!;
    const end = cue.end * scale + offset;
    sum += Math.max(
      0,
      Math.min(speech.end, end) - Math.max(speech.start, cue.start * scale + offset),
    );
    if (speech.end < end) left++;
    else right++;
  }
  return sum;
}

export function alignSubtitles(speech: readonly Interval[], cues: readonly Cue[]) {
  const reference = union(speech);
  const valid = cues.filter(
    (cue) =>
      Number.isFinite(cue.start) &&
      Number.isFinite(cue.end) &&
      cue.start >= 0 &&
      cue.end > cue.start &&
      cue.text.trim(),
  );
  const track = union(valid);
  const identity = { offset: 0, scale: 1 };
  const duration = reference.at(-1)?.end ?? 0;
  const speechLength = length(reference);
  const limit = Math.min(300, Math.max(60, duration / 4));
  // Run-length representation of a 50 ms binary grid, including zero padding.
  const grid = (time: number) => Math.round(time * 20);
  const referenceGrid = union(
    reference.map(({ start, end }) => ({ start: grid(start), end: grid(end) })),
  );
  const a = length(referenceGrid);
  const domain = grid(Math.max(duration, (track.at(-1)?.end ?? 0) * 1.05) + 2 * limit + 2);
  function bestAtScale(scale: number, center = 0, radius = limit, step = 5) {
    const scaled = union(
      track.map(({ start, end }) => ({ start: grid(start * scale), end: grid(end * scale) })),
    );
    const b = length(scaled);
    const denominator = Math.sqrt(a * (1 - a / domain) * b * (1 - b / domain));
    const score = (offset: number) =>
      denominator
        ? (overlap(referenceGrid, scaled, { offset, scale: 1 }) - (a * b) / domain) / denominator
        : 0;
    let offset = center;
    let correlation = score(center);
    for (let i = center - grid(radius); i <= center + grid(radius); i += step) {
      const candidate = score(i);
      if (candidate > correlation + 1e-9) {
        offset = i;
        correlation = candidate;
      }
    }
    return { scale, offset: offset / 20, correlation, baseline: score(0) };
  }
  const pure = bestAtScale(1);
  const refined = bestAtScale(1, grid(pure.offset), 0.25, 1);
  const shifted =
    refined.correlation - refined.baseline >= 0.035
      ? refined
      : { ...identity, correlation: refined.baseline };
  const thirds = (correction: Correction) =>
    [0, 1, 2].map((index) => {
      const regions = reference
        .map(({ start, end }) => ({
          start: Math.max(start, (duration * index) / 3),
          end: Math.min(end, (duration * (index + 1)) / 3),
        }))
        .filter(({ start, end }) => end > start);
      const total = length(regions);
      return total > 0 ? overlap(regions, track, correction) / total : null;
    });
  let best = shifted;
  if (
    duration >= 120 &&
    speechLength / duration >= 0.01 &&
    speechLength / duration <= 0.9 &&
    reference.length >= 6
  ) {
    for (const scale of [
      1000 / 1001,
      1001 / 1000,
      24 / 25,
      25 / 24,
      24000 / 25025,
      25025 / 24000,
    ]) {
      const coarse = bestAtScale(scale);
      const candidate = bestAtScale(scale, grid(coarse.offset), 0.25, 1);
      const before = thirds(shifted);
      const after = thirds(candidate);
      if (
        candidate.correlation > best.correlation &&
        candidate.correlation >= shifted.correlation + 0.05 &&
        after.every(
          (coverage, index) => coverage === null || coverage >= (before[index] ?? 0) - 0.05,
        )
      )
        best = candidate;
    }
  }
  const correction = { offset: best.offset, scale: best.scale };
  const thirdCoverages = thirds(correction);
  const measured = thirdCoverages.filter((value): value is number => value !== null);
  const nonLinearDrift =
    measured.length === 3 &&
    Math.min(...measured) < 0.7 &&
    Math.max(...measured) - Math.min(...measured) > 0.22;
  return {
    correction,
    thirdCoverages,
    preAlignmentCoverage: speechLength ? overlap(reference, track, identity) / speechLength : null,
    nonLinearDrift,
    coverage: speechLength ? overlap(reference, track, correction) / speechLength : null,
    totalCues: cues.length,
    emptyCues: cues.filter((cue) => !cue.text.trim()).length,
    invalidCues: cues.filter(
      (cue) =>
        !Number.isFinite(cue.start) ||
        !Number.isFinite(cue.end) ||
        cue.start < 0 ||
        cue.end <= cue.start,
    ).length,
    cues: valid
      .map((cue) => ({
        ...cue,
        start: Math.max(0, cue.start * correction.scale + correction.offset),
        end: cue.end * correction.scale + correction.offset,
      }))
      .filter((cue) => cue.end > cue.start)
      .sort((a, b) => a.start - b.start),
  };
}

const clean = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\[[^\]\n]{1,80}\]|\((?:music|applause|laughter|inaudible|silence)\)/gi, " ")
    .replace(/[\u0591-\u05bd\u05bf-\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g, "");
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const words = (value: string) =>
  [...segmenter.segment(clean(value))]
    .filter((word) => word.isWordLike)
    .map((word) => word.segment);

function inferLanguage(text: string) {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 10) return undefined;
  for (const [pattern, language] of [
    [/\p{Script=Hebrew}/gu, "he"],
    [/\p{Script=Arabic}/gu, "ar"],
    [/\p{Script=Hangul}/gu, "ko"],
    [/\p{Script=Hiragana}|\p{Script=Katakana}/gu, "ja"],
  ] as const) {
    if ((text.match(pattern)?.length ?? 0) > letters * 0.2) return language;
  }
  const tokens = words(text);
  const markers = tokens.filter((token) =>
    /^(the|and|is|of|that|you|this|are|with|have|for|it|from|to)$/.test(token),
  );
  return markers.length >= 4 && markers.length / tokens.length >= 0.12 ? "en" : undefined;
}

function distance(a: string[], b: string[]) {
  let row = b.map((_, index) => index + 1);
  row.unshift(0);
  for (const [index, word] of a.entries()) {
    const next = [index + 1];
    for (const [j, other] of b.entries())
      next.push(Math.min(row[j + 1]! + 1, next[j]! + 1, row[j]! + Number(word !== other)));
    row = next;
  }
  return row[b.length]!;
}

const aliases: Record<string, string> = {
  iw: "he",
  in: "id",
  eng: "en",
  heb: "he",
  ara: "ar",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  spa: "es",
  zho: "zh",
  chi: "zh",
  por: "pt",
  rus: "ru",
  jpn: "ja",
  ita: "it",
};
function languageKey(value?: string) {
  const base = value?.toLowerCase().split(/[-_]/)[0];
  return base && base !== "und" && base !== "auto" ? (aliases[base] ?? base) : undefined;
}

export function assessSubtitles(
  timing: {
    coverage: number | null;
    invalidCues: number;
    totalCues?: number;
    emptyCues?: number;
    nonLinearDrift?: boolean;
    thirdCoverages?: readonly (number | null)[];
  },
  language: string | undefined,
  forced: boolean,
  samples: readonly { subtitle: string; recognized: readonly Recognition[] }[],
  options: {
    model?: string;
    duration?: number;
    sampledSeconds?: number;
    auto?: boolean;
    imported?: boolean;
  } = {},
) {
  let errors = 0;
  let evaluatedWords = 0;
  let sampleCount = 0;
  const detected = new Map<string, number>();
  for (const sample of samples) {
    const reference = words(
      sample.recognized
        .map((part) => part.text)
        .join(" ")
        .slice(0, 4096),
    );
    if (!reference.length) continue;
    sampleCount++;
    evaluatedWords += reference.length;
    const hypothesis = words(sample.subtitle.slice(0, 4096));
    errors += distance(reference, hypothesis);

    for (const part of sample.recognized) {
      const key = languageKey(part.language);
      if (key) detected.set(key, (detected.get(key) ?? 0) + words(part.text).length);
    }
  }
  const subtitleLanguage =
    languageKey(language) ?? inferLanguage(samples.map((sample) => sample.subtitle).join(" "));
  const dominant = [...detected].sort((a, b) => b[1] - a[1])[0];
  const audioLanguage = dominant
    ? dominant[1] >= 0.6 * [...detected.values()].reduce((sum, weight) => sum + weight, 0)
      ? dominant[0]
      : undefined
    : inferLanguage(
        samples.flatMap((sample) => sample.recognized.map((part) => part.text)).join(" "),
      );
  const languageMatch =
    subtitleLanguage && audioLanguage ? subtitleLanguage === audioLanguage : null;
  const model = options.model?.toLowerCase() ?? "";
  const expectedAsrError =
    subtitleLanguage === "en" && model.includes("parakeet")
      ? 0.134
      : subtitleLanguage === "en" && model.includes("whisper")
        ? 0.07
        : subtitleLanguage === "he" && model.includes("ivrit")
          ? 0.29
          : subtitleLanguage === "he" && model.includes("whisper")
            ? 0.35
            : 0.15;
  const useThreshold = Math.min(0.45, 1.4 * expectedAsrError + 0.1);
  const bothThreshold = Math.min(0.75, 1.6 * expectedAsrError + 0.3);
  const wordErrorRate = evaluatedWords ? errors / evaluatedWords : null;
  const duration = options.duration ?? Infinity;
  const adequate =
    evaluatedWords >= 150 ||
    (duration <= 90 && evaluatedWords >= 25 && (options.sampledSeconds ?? 0) >= duration * 0.7);
  const total = Math.max(1, timing.totalCues ?? timing.invalidCues);
  const invalidRatio = timing.invalidCues / total;
  const coverage = timing.coverage ?? 0;
  const dialect = subtitleLanguage === "ar" && languageMatch === true && coverage >= 0.85;
  const usable =
    languageMatch !== false &&
    !forced &&
    invalidRatio <= 0.05 &&
    (timing.emptyCues ?? 0) / total <= 0.25;
  const recommendation =
    usable &&
    adequate &&
    wordErrorRate !== null &&
    languageMatch === true &&
    !options.auto &&
    !timing.nonLinearDrift &&
    invalidRatio <= 0.02 &&
    coverage >= (options.imported ? 0.7 : 0.8) &&
    wordErrorRate <= useThreshold
      ? "use-subtitles"
      : usable &&
          adequate &&
          wordErrorRate !== null &&
          coverage >= 0.4 &&
          (wordErrorRate <= bothThreshold || dialect)
        ? "both"
        : "transcribe-only";
  return {
    ...timing,
    subtitleLanguage,
    audioLanguage,
    languageMatch,
    detectedLanguages: [...detected.keys()].sort(),
    expectedAsrError,
    useThreshold,
    bothThreshold,
    wordErrorRate,
    evaluatedWords,
    sampleCount,
    recommendation,
  };
}
