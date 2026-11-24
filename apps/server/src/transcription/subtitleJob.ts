// @effect-diagnostics nodeBuiltinImport:off - Shares the transcription ledger's Promise boundary.
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { atomicWrite, fingerprint, openLedger, timestamp, type Segment } from "./ledger.ts";
import { decodePcm } from "./media.ts";
import { readSubtitles, SubtitleInputError, type SubtitleInput } from "./subtitleMedia.ts";
import { alignSubtitles, assessSubtitles } from "./subtitleQuality.ts";
import { sampleRate, scoreSpeech, planWindows, type Window } from "./windows.ts";
import type { Engine, Job } from "./job.ts";

export async function prepareSubtitles(
  job: Job,
  selection: SubtitleInput,
  score: Parameters<typeof scoreSpeech>[1],
  signal: AbortSignal,
  openSampleEngine?: () => Promise<Engine>,
) {
  const track = await readSubtitles(job.source, selection, job.settings.ffmpeg, signal);
  if (track.file && "file" in selection) selection = { ...selection, file: track.file };
  const decode = () => decodePcm(job.settings.ffmpeg, job.source, signal);
  const speech: { start: number; end: number }[] = [];
  let samples = 0;
  const frames = async function* () {
    for await (const frame of scoreSpeech(decode(), score)) {
      const start = samples / sampleRate;
      samples += frame.pcm.length;
      if (frame.speech) {
        const previous = speech.at(-1);
        if (previous?.end === start) previous.end = samples / sampleRate;
        else speech.push({ start, end: samples / sampleRate });
      }
      yield frame;
    }
  };
  const plans: Omit<Window, "pcm">[] = [];
  if (job.settings.subtitleMode === "both") {
    for await (const { id, start, end, mapping } of planWindows(frames(), job.settings.rule)) {
      plans.push({ id, start, end, mapping });
    }
  } else {
    for await (const _frame of frames()) signal.throwIfAborted();
  }
  const duration = samples / sampleRate;
  const { cues: aligned, correction, ...timing } = alignSubtitles(speech, track.cues);
  const cues = aligned
    .filter((cue) => cue.start < duration)
    .map((cue) => ({ ...cue, end: Math.min(duration, cue.end) }));
  if (!cues.length)
    throw new SubtitleInputError({ detail: "The subtitle selection contains no usable cues." });
  const comparisons = [];
  let sampledSeconds = 0;
  const sampleWindows: { start: number; end: number }[] = [];
  if (openSampleEngine && speech.length) {
    const windows = [];
    for (let i = 0; i < 7; i++) {
      const target = (duration * (i + 0.5)) / 7;
      const previous = windows.at(-1);
      const startCue = cues.findIndex(
        (cue) =>
          cue.start >= (previous?.end ?? 0) &&
          (cue.start >= target - 10 || (cue.end - cue.start > 25 && cue.end > target)),
      );
      if (startCue < 0) continue;
      const start = cues[startCue]!.start;
      const selected = [];
      let end = start;
      for (let j = startCue; j < cues.length; j++) {
        const cue = cues[j]!;
        if (j > startCue && (cue.end > start + 25 || cue.start >= start + 20)) break;
        selected.push(cue.text);
        end = Math.max(end, cue.end);
      }
      if (end - start < Math.min(15, duration * 0.7)) continue;
      windows.push({ start, end, subtitle: selected.join(" ") });
    }
    const engine = await openSampleEngine();
    try {
      for (const window of windows) {
        const recognized = [];
        // Keep complete cue text and bound the PCM allocation for long speaker turns.
        for (let start = window.start; start < window.end; start += 25) {
          const end = Math.min(start + 25, window.end);
          const pcm = new Float32Array(Math.ceil((end - start) * sampleRate));
          let offset = 0;
          for await (const frame of decodePcm(
            job.settings.ffmpeg,
            job.source,
            signal,
            start,
            end,
            job.settings.standaloneMedia,
          )) {
            const count = Math.min(frame.length, pcm.length - offset);
            pcm.set(frame.subarray(0, count), offset);
            offset += count;
          }
          if (offset) recognized.push(...(await engine.recognize(pcm.subarray(0, offset), false)));
          sampledSeconds += offset / sampleRate;
        }
        comparisons.push({ subtitle: window.subtitle, recognized });
        sampleWindows.push({ start: window.start, end: window.end });
      }
    } finally {
      await engine.close();
    }
  }
  signal.throwIfAborted();
  const input = await fingerprint(job.source);
  if (JSON.stringify(input) !== JSON.stringify(job.input))
    throw new Error("Source changed during subtitle processing.");
  if (track.file && track.input) {
    const current = await NodeFSP.stat(track.file);
    if (current.size !== track.input.size || current.mtimeMs !== track.input.mtimeMs) {
      throw new Error("Subtitle source changed during processing.");
    }
  }
  return {
    cues,
    plans,
    provenance: {
      selection,
      ...(track.input ? { input: track.input } : {}),
      source: track.imported ? ("import" as const) : ("subtitles" as const),
      language:
        track.language ??
        (openSampleEngine
          ? undefined
          : job.settings.language === "auto"
            ? undefined
            : job.settings.language),
      hearingImpaired: track.hearingImpaired ?? false,
      correction,
      alignmentApplied: correction.offset !== 0 || correction.scale !== 1,
      timing,
      assessment: openSampleEngine
        ? { engine: job.settings.engine, model: job.settings.model, windows: sampleWindows }
        : null,
      quality: openSampleEngine
        ? assessSubtitles(timing, track.language, track.forced ?? false, comparisons, {
            duration,
            sampledSeconds,
            model: job.settings.model,
            imported: track.imported ?? false,
            auto: track.auto || /\b(auto|asr|generated)\b/i.test(track.title ?? ""),
          })
        : null,
    },
  };
}

export async function prepareImportedTranscript(
  selection: Extract<SubtitleInput, { file: string }>,
  ffmpeg: string,
  signal: AbortSignal,
) {
  const track = await readSubtitles(null, selection, ffmpeg, signal);
  const { cues, correction, ...timing } = alignSubtitles([], track.cues);
  if (!cues.length) throw new Error("The transcript contains no usable cues.");
  return {
    cues,
    plans: [],
    provenance: {
      selection,
      ...(track.input ? { input: track.input } : {}),
      source: "import" as const,
      language: track.language,
      hearingImpaired: track.hearingImpaired ?? false,
      correction,
      alignmentApplied: false,
      timing,
      assessment: null,
      quality: null,
    },
  };
}

export async function publishSubtitles(
  directory: string,
  job: Job,
  prepared: Awaited<ReturnType<typeof prepareSubtitles>>,
) {
  const { cues, provenance } = prepared;
  const { source } = provenance;
  const segments: Segment[] = cues.map((cue, index) => ({
    ...cue,
    id: "0-" + index,
    textRaw: cue.text,
    language: provenance.language ?? "und",
    windowId: 0,
    engine: source,
    model: "",
    source,
  }));
  const ledger = await openLedger(directory);
  await ledger.append({ windowId: 0, mapping: [], segments });
  await atomicWrite(
    NodePath.join(directory, "transcript.json"),
    JSON.stringify({ job, segments, subtitles: provenance }, null, 2),
  );
  await atomicWrite(
    NodePath.join(directory, "transcript.md"),
    segments
      .map(
        (segment) =>
          "[" +
          timestamp(segment.start) +
          "] " +
          (segment.speaker ? segment.speaker + ": " : "") +
          segment.text,
      )
      .join("\n\n") + "\n",
  );
}

export function salientTerms(cues: readonly { text: string }[]) {
  const counts = new Map<
    string,
    { form: string; count: number; unusual: boolean; shortRtlTerm: boolean }
  >();
  for (const { text } of cues) {
    for (const term of text.match(/[\p{L}][\p{L}\p{M}\p{N}-]{1,39}/gu) ?? []) {
      const key = term.toLowerCase();
      if (
        /^(this|that|these|those|have|will|with|from|there|here|what|when|where|they|then|your|about|which|some|just|today|welcome|everyone|going|because|really|something)$/.test(
          key,
        )
      )
        continue;
      const unusual = /\p{N}|-|[a-z][A-Z]|^[A-Z]{2,}$/u.test(term);
      const shortRtlTerm =
        /^[\p{Script=Hebrew}\p{Script=Arabic}\p{M}]{2,6}$/u.test(term) &&
        !/^(שלום|مرحبا|של|את|על|עם|לא|כן|זה|גם|או|כל|מה|אני|הוא|היא|في|من|عن|إلى|على|مع|لا|ما|هو|هي|هذا|هذه|كان|أن|إن)$/u.test(
          key,
        );
      const previous = counts.get(key);
      counts.set(key, {
        form: previous?.form ?? term,
        shortRtlTerm,
        unusual: unusual || Boolean(previous?.unusual),
        count: (previous?.count ?? 0) + 1,
      });
    }
  }
  return [...counts.values()]
    .filter((term) => term.unusual || term.shortRtlTerm || term.form.length >= 7)
    .sort(
      (a, b) =>
        Number(b.unusual) - Number(a.unusual) || b.count - a.count || b.form.length - a.form.length,
    )
    .slice(0, 32)
    .map((term) => term.form);
}
