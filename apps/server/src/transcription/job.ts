// @effect-diagnostics nodeBuiltinImport:off - The streaming pipeline shares the Promise filesystem boundary with the ledger.
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { atomicWrite, fingerprint, openLedger, timestamp, type Segment } from "./ledger.ts";
import type { ModelSelection, TranscriptionWord } from "@t3tools/contracts";
import type { CorrectionMode, CorrectionEstimate, CorrectionOutcome } from "./correction.ts";
import { recognitionTerms } from "./words.ts";
import { decodePcm } from "./media.ts";
import type { prepareSubtitles } from "./subtitleJob.ts";
import {
  looksRepetitive,
  planWindows,
  replayWindows,
  sourceSeconds,
  scoreSpeech,
  type Window,
  type WindowRule,
} from "./windows.ts";

export type Settings = {
  ffmpeg: string;
  decoderVersion: string;
  engine: string;
  model: string;
  engineFingerprint: string;
  language: string;
  rule: WindowRule;
  standaloneMedia?: true;
  rangeStart?: number;
  rangeEnd?: number;
  maxAudioBytes?: number;
  accountName?: string;
  endpointOrigin?: string;
  uploadConsent?: true;
  subtitleMode?: "transcribe-only" | "both" | "assess-subtitles";
};

export type Job = {
  id: string;
  source: string;
  input: Awaited<ReturnType<typeof fingerprint>>;
  settings: Settings;
  previousRevision?: string;
  correctionOnly?: true;
  transcriptOnly?: true;
  recording?: string;
  words?: readonly TranscriptionWord[];
  correction?: {
    mode: CorrectionMode;
    modelSelection?: ModelSelection;
    promptVersion: number;
    estimate?: CorrectionEstimate;
    estimateId?: string;
    unavailable?: "model-not-configured" | "model-unsupported";
    notes?: string;
    relisten?: { model: string; audioSeconds: number; wallSeconds: number; providerCost: 0 };
  };
};

const sameFields = <T extends object>(left: T, right: T) =>
  Object.keys(left).length === Object.keys(right).length &&
  (Object.keys(right) as (keyof T)[]).every((key) => left[key] === right[key]);

export function canResume(previous: Job, candidate: Pick<Job, "source" | "input" | "settings">) {
  const recognitionSettings = ({
    accountName: _name,
    endpointOrigin: _origin,
    uploadConsent: _consent,
    ...settings
  }: Settings) => settings;
  return (
    previous.source === candidate.source &&
    sameFields(previous.input, candidate.input) &&
    sameFields(recognitionSettings(previous.settings), recognitionSettings(candidate.settings))
  );
}

export type Recognition = {
  text: string;
  start?: number;
  end?: number;
  language?: string;
  confidence?: number;
  needsReview?: boolean;
};

export type RecognitionHints = {
  readonly terms?: readonly string[];
  readonly prompt?: string;
};

export interface Engine {
  retryWithSplit?: boolean;
  commitReceivedOnCancel?: boolean;
  readonly recognitionHints?: boolean;
  readonly supportsLanguageDetection?: boolean;
  readonly supportsPrompt?: boolean;
  recognize(
    pcm: Float32Array,
    retry: boolean,
    hints?: RecognitionHints,
  ): Promise<readonly Recognition[]>;
  close(): Promise<void>;
}

export type State =
  | {
      stage: "decoding" | "writing" | "transcribing" | "completed" | "canceled" | "interrupted";
      completed: number;
      total?: number;
      correction?: CorrectionOutcome;
    }
  | { stage: "failed"; completed: number; error?: { code: string; message: string } }
  | { stage: "paused"; reason: "rate-limited"; completed: number };

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "TranscriptionRateLimited",
  {},
) {}
const isRateLimited = Schema.is(RateLimited);

export async function runJob(
  directory: string,
  job: Job,
  score: (frames: readonly Float32Array[]) => Promise<readonly number[]>,
  openEngine: () => Promise<Engine>,
  signal: AbortSignal,
  progress: (state: State) => void,
  hints?: RecognitionHints,
  preparedPlans?: Omit<Window, "pcm">[],
  subtitleProvenance?: Awaited<ReturnType<typeof prepareSubtitles>>["provenance"] & {
    terms: readonly string[];
  },
): Promise<State> {
  const ledger = await openLedger(directory);
  let hintsUsed = false;
  const publish = async () => {
    const segments = ledger.rows.flatMap((row) => row.segments);
    await atomicWrite(
      NodePath.join(directory, "transcript.json"),
      JSON.stringify(
        {
          job,
          ...(subtitleProvenance ? { subtitles: subtitleProvenance } : {}),
          segments,
          recognitionHints: hintsUsed || ledger.rows.some((row) => row.recognitionHints),
        },
        null,
        2,
      ),
    );
    await atomicWrite(
      NodePath.join(directory, "transcript.md"),
      segments.map((segment) => "[" + timestamp(segment.start) + "] " + segment.text).join("\n\n") +
        "\n",
    );
  };
  let engine: Engine | undefined;
  try {
    progress({ stage: "writing", completed: ledger.rows.length });
    await publish();
    const { ffmpeg, rule, language, model } = job.settings;
    progress({ stage: "decoding", completed: ledger.rows.length });
    const offset = Math.round((job.settings.rangeStart ?? 0) * 16_000) / 16_000;
    const decode = () =>
      decodePcm(
        ffmpeg,
        job.source,
        signal,
        offset,
        job.settings.rangeEnd,
        job.settings.standaloneMedia,
      );
    const plans: Omit<Window, "pcm">[] = preparedPlans ?? [];
    if (!preparedPlans)
      for await (const { id, start, end, mapping } of planWindows(
        scoreSpeech(decode(), score),
        rule,
        job.settings.maxAudioBytes,
      )) {
        plans.push({ id, start, end, mapping });
      }
    signal.throwIfAborted();
    if (JSON.stringify(await fingerprint(job.source)) !== JSON.stringify(job.input)) {
      throw new Error("Source changed during decoding.");
    }
    for (const row of ledger.rows) {
      if (JSON.stringify(row.mapping) !== JSON.stringify(plans[row.windowId]?.mapping)) {
        throw new Error("Decoded windows differ from the checkpoint.");
      }
    }
    const plan = { total: plans.length };
    for await (const window of replayWindows(decode(), plans, ledger.rows.length)) {
      signal.throwIfAborted();
      progress({ stage: "transcribing", completed: ledger.rows.length, ...plan });
      engine ??= await openEngine();
      const terms = engine.recognitionHints ? recognitionTerms(job.words ?? [], hints?.terms) : [];
      const prompt = engine.supportsPrompt
        ? [hints?.prompt, job.correction?.notes?.trim()].filter(Boolean).join("\n")
        : undefined;
      hintsUsed = terms.length > 0 || Boolean(prompt);
      let recognized = await engine.recognize(
        window.pcm,
        false,
        hintsUsed ? { terms, ...(prompt ? { prompt } : {}) } : undefined,
      );
      const repetitive = (parts: readonly Recognition[]) =>
        parts.some((part) => looksRepetitive(part.text)) ||
        looksRepetitive(parts.map((part) => part.text).join(" "));
      if (engine.retryWithSplit && repetitive(recognized)) {
        recognized = await engine.recognize(window.pcm, true);
      }
      if (!engine.commitReceivedOnCancel) signal.throwIfAborted();
      const windowNeedsReview = repetitive(recognized);
      const segments: Segment[] = recognized
        .filter((part) => part.text.trim() || part.needsReview)
        .map((part, index) => {
          const start = sourceSeconds(window, part.start ?? 0);
          const end =
            part.end === undefined ? window.end / 16_000 : sourceSeconds(window, part.end);
          return {
            id: window.id + "-" + index,
            start: start + offset,
            end: Math.max(start, end) + offset,
            text: part.text.trim(),
            textRaw: part.text,
            language: [part.language, language].find((value) => value && value !== "auto") ?? "und",
            speaker: null,
            windowId: window.id,
            engine: job.settings.engine,
            model,
            ...(part.confidence === undefined ? {} : { confidence: part.confidence }),
            ...(windowNeedsReview || part.needsReview ? { needsReview: true } : {}),
          };
        });
      const current = await NodeFSP.stat(job.source);
      if (current.size !== job.input.size || current.mtimeMs !== job.input.mtimeMs) {
        throw new Error("Source changed during transcription.");
      }
      progress({ stage: "writing", completed: ledger.rows.length, ...plan });
      if (!engine.commitReceivedOnCancel) signal.throwIfAborted();
      await ledger.append({
        windowId: window.id,
        mapping: window.mapping,
        segments,
        ...(hintsUsed ? { recognitionHints: true } : {}),
      });
      progress({ stage: "writing", completed: ledger.rows.length, ...plan });
      await publish();
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (ledger.rows.length !== plans.length) {
      throw new Error("Decoded windows differ from the plan.");
    }
    return { stage: "completed", completed: ledger.rows.length };
  } catch (error) {
    if (signal.aborted) return { stage: "canceled", completed: ledger.rows.length };
    if (isRateLimited(error)) {
      return { stage: "paused", reason: "rate-limited", completed: ledger.rows.length };
    }
    throw error;
  } finally {
    await engine?.close();
  }
}
