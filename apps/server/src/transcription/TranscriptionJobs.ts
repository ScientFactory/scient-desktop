// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off processEnvInEffect:off - Promise job admission owns filesystem paths and atomic publication.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  NonNegativeInt,
  LEGACY_WORDS_TRANSITION_ENABLED,
  ProviderInstanceId,
  ModelSelection,
  type ProjectId,
  SpeechCustomWords,
  type DictationVocabulary,
  DictationWordsError,
  type WordsCommand,
  type WordsCommandResult,
  type ThreadId,
  TranscriptionWord,
  TranscriptionWords,
  type RecordingEngineSelection,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { acquireTranscriptionHold } from "../background/KeepAwake.ts";
import * as Cloud from "./CloudEngines.ts";
import {
  type EngineInventory,
  InventoryInput,
  arabicAlternative,
  audioTranscriptionHourUsd,
  englishFast,
  getTranscriptionModel,
  modelCandidates,
  supportsLanguage,
  transcriptionModels,
} from "./engineInventory.ts";
import * as PubSub from "effect/PubSub";
import { isCloudResponseError } from "./cloud.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { AgentInvocationContext } from "../scient/operations/AgentInvocationContext.ts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { moveToTrash, type TrashHost } from "../scient/workspace/WorkspaceTrash.ts";
import * as SpeechModelStore from "../speech/SpeechModelStore.ts";
import {
  atomicWrite,
  checkpointCount,
  readCheckpoints,
  createRevision,
  fingerprint,
  timestamp,
  type Segment,
} from "./ledger.ts";
import { canResume, runJob, type Job, type State } from "./job.ts";
import { openSharedLocalEngine, openVad } from "./local.ts";
import {
  CorrectionMode,
  correctSegments,
  estimateCorrection,
  promptVersion,
  type ReviewItem,
  type CorrectionOutcome,
} from "./correction.ts";
import { mergeWords, recognitionTerms, wordKey } from "./words.ts";
import { createOverrideRateTable, lookupRate } from "../usage/usagePricing.ts";
import { decodePcm, probeRecordingDuration, recordingDuration } from "./media.ts";
import { type DiscoveredMedia, discoverProjectMedia } from "./mediaDiscovery.ts";
import { sampleSpeechLanguage } from "./languageSample.ts";
import { scoreSpeech } from "./windows.ts";
import { relistenPass } from "./relisten.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as ChatGpt from "./chatgpt.ts";

import * as ServerSettings from "../serverSettings.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { reconcileLegacySpeechWords } from "@t3tools/shared/serverSettings";
import * as Speech from "../speech/SpeechService.ts";
import { SILERO_VAD } from "../speech/silero.ts";
import serverManifest from "../../package.json" with { type: "json" };

import {
  MediaToolUnavailable,
  SubtitleInputError,
  probeSubtitles,
  runMediaTool,
} from "./subtitleMedia.ts";
import {
  finishCapture,
  isCaptureFinished,
  readCaptions,
  recoverCaptures,
  saveCaption,
  saveCaptureChunk,
  touchCapture,
} from "./RecordingCapture.ts";
import { connectLessonTalk, LessonTalkError, lessonInstructions } from "./lessonTalk.ts";

const isLessonTalkError = Schema.is(LessonTalkError);
import {
  prepareImportedTranscript,
  prepareSubtitles,
  publishSubtitles,
  salientTerms,
} from "./subtitleJob.ts";

const revision = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[\p{L}\p{N}\p{M}-]+-[a-f0-9]{8}$/u;
const path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const subtitleSelection = Schema.Union([
  Schema.Struct({ stream: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Struct({
    file: path,
    format: Schema.optionalKey(Schema.Literals(["zoom-vtt", "teams-docx"])),
    language: Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)),
    ),
  }),
]);
export const RevisionId = Schema.String.check(Schema.isPattern(revision));
const estimateId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const correctionInput = {
  correctionModel: Schema.optionalKey(ModelSelection),
  mode: Schema.optionalKey(CorrectionMode),
  notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  relisten: Schema.optionalKey(
    Schema.Struct({
      model: path,
      audioSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300 })),
      wallSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
    }),
  ),
};
const wordScope = {
  level: Schema.Literals(["global", "project", "recording"]),
  id: Schema.optionalKey(RevisionId),
};
const Range = Schema.Struct({
  start: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
});
export const StartRequest = Schema.Struct({
  action: Schema.Literal("start"),
  project: path,
  source: path,
  engine: Schema.Literals(["local", "openai", "xai", "openrouter", "cloud", "chatgpt"]),
  model: path,
  cloudEngineId: Schema.optionalKey(path),
  language: Schema.String.check(Schema.isPattern(/^(auto|[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*)$/)),
  rule: Schema.optionalKey(Schema.Literals(["meetily", "fixed", "short"])),
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  resume: Schema.optionalKey(Schema.String.check(Schema.isPattern(revision))),
  revisionMode: Schema.optionalKey(Schema.Literals(["resume", "rerun"])),
  range: Schema.optionalKey(Range),
  estimateId: Schema.optionalKey(estimateId),
  ...correctionInput,
  useWords: Schema.optionalKey(Schema.Boolean),
  subtitles: Schema.optionalKey(subtitleSelection),
  subtitleMode: Schema.optionalKey(
    Schema.Literals(["transcribe-only", "both", "assess-subtitles"]),
  ),
});
export const BatchStartRequest = Schema.Struct({
  ...StartRequest.fields,
  action: Schema.Literal("start-batch"),
  sources: Schema.Array(path).check(Schema.isMinLength(2), Schema.isMaxLength(20)),
});
const captureId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
);
const lessonLanguage = Schema.String.check(
  Schema.isPattern(/^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/),
);
const captureIndex = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(100_000_000),
);
export const Request = Schema.Union([
  StartRequest,
  Schema.Struct({
    action: Schema.Literals(["status", "cancel", "pause"]),
    project: path,
    id: RevisionId,
  }),
  Schema.Struct({
    action: Schema.Literal("list"),
    project: path,
    includeCreated: Schema.optionalKey(Schema.Boolean),
    query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
    source: Schema.optionalKey(path),
  }),
  Schema.Struct({ action: Schema.Literal("sample-language"), project: path, source: path }),
  Schema.Struct({ action: Schema.Literal("media-list"), project: path }),
  Schema.Struct({
    action: Schema.Literal("capture-chunk"),
    project: path,
    id: captureId,
    format: Schema.Literals(["webm", "m4a"]),
    index: captureIndex,
    bytes: Schema.String.check(
      Schema.isMaxLength(22_000),
      Schema.isPattern(/^[a-zA-Z0-9+/]+={0,2}$/),
    ),
  }),
  Schema.Struct({ action: Schema.Literal("capture-recover"), project: path }),
  Schema.Struct({ action: Schema.Literal("capture-touch"), project: path, id: captureId }),
  /** A lesson's start: keeps its lease and names the engine its live captions use. */
  Schema.Struct({
    action: Schema.Literal("capture-start"),
    project: path,
    id: captureId,
    language: Schema.optionalKey(lessonLanguage),
  }),
  Schema.Struct({
    action: Schema.Literal("capture-caption"),
    project: path,
    id: captureId,
    window: captureIndex,
    start: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    end: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    text: Schema.String.check(Schema.isMaxLength(20_000)),
  }),
  /** A spoken question with the user's OpenAI key: the window's offer, answered by OpenAI. */
  Schema.Struct({
    action: Schema.Literal("capture-talk"),
    project: path,
    id: captureId,
    sdpOffer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("capture-finish"),
    project: path,
    id: captureId,
    /** Recorded as a lesson: transcribe it with the recording default, then make its notes. */
    lesson: Schema.optionalKey(Schema.Struct({ language: lessonLanguage })),
  }),
  Schema.Struct({
    action: Schema.Literal("media-register"),
    project: path,
    source: path,
    onlyInProject: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("recording-rename"),
    project: path,
    source: path,
    /** Shown in place of the file name; empty goes back to the file name. */
    title: Schema.String.check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({ action: Schema.Literal("recording-trash"), project: path, source: path }),
  Schema.Struct({ action: Schema.Literal("revision"), project: path, id: RevisionId }),
  Schema.Struct({ action: Schema.Literal("inventory"), project: path, ...InventoryInput.fields }),
  Schema.Struct({
    action: Schema.Literal("correct"),
    project: path,
    id: RevisionId,
    estimateId: Schema.optionalKey(estimateId),
    ...correctionInput,
  }),
  Schema.Struct({ action: Schema.Literal("suggestions-list"), project: path, id: RevisionId }),
  Schema.Struct({
    action: Schema.Literal("correction-estimate"),
    project: path,
    id: Schema.optionalKey(RevisionId),
    source: Schema.optionalKey(path),
    language: Schema.optionalKey(Schema.String),
    useWords: Schema.optionalKey(Schema.Boolean),
    ...correctionInput,
    resume: Schema.optionalKey(RevisionId),
  }),
  Schema.Struct({
    action: Schema.Literals(["review-accept", "review-reject"]),
    project: path,
    id: RevisionId,
    item: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ action: Schema.Literal("words-list"), project: path, ...wordScope }),
  Schema.Struct({
    action: Schema.Literals(["words-add", "words-remove"]),
    project: path,
    ...wordScope,
    word: TranscriptionWord,
  }),
  Schema.Struct({
    action: Schema.Literal("words-accept"),
    project: path,
    ...wordScope,
    suggestionRevision: RevisionId,
    word: TranscriptionWord,
  }),
  Schema.Struct({ action: Schema.Literal("discover-subtitles"), project: path, source: path }),
  Schema.Struct({
    action: Schema.Literal("import-transcript"),
    project: path,
    file: path,
    source: Schema.optionalKey(path),
    format: Schema.optionalKey(Schema.Literals(["zoom-vtt", "teams-docx"])),
    previousId: Schema.optionalKey(RevisionId),
  }),
  Schema.Struct({
    action: Schema.Literal("use-subtitles"),
    project: path,
    source: path,
    subtitles: subtitleSelection,
  }),
]);

type StartInput = typeof StartRequest.Type;
type ScopedStart = Omit<StartInput, "action" | "project" | "engine" | "model" | "language"> &
  Partial<Pick<StartInput, "engine" | "model" | "language">>;
type Request = typeof Request.Type;
type SubtitleProvenance = Awaited<ReturnType<typeof prepareSubtitles>>["provenance"];
const RecordingSource = Schema.Struct({
  source: path,
  size: Schema.Number,
  created: Schema.Number,
  duration: Schema.optionalKey(Schema.Number),
  queued: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
});
const decodeRecordingSource = Schema.decodeUnknownSync(RecordingSource);
type RecordingSource = typeof RecordingSource.Type;
export type Status = {
  job: Job;
  state: State;
  subtitles?: SubtitleProvenance;
  created?: number;
  reviewCount?: number;
  duration?: number;
  modelName?: string;
  snippet?: string;
  matchTime?: number;
};
export function findTranscriptMatch(
  segments: readonly { text: string; start: number }[],
  query: string,
) {
  const needle = query.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  if (!needle) return undefined;
  let text = "";
  const offsets: { end: number; start: number }[] = [];
  for (const segment of segments) {
    if (text) text += " ";
    text += segment.text.trim().replace(/\s+/gu, " ");
    offsets.push({ end: text.length, start: segment.start });
  }
  const offset = text.toLocaleLowerCase().indexOf(needle);
  if (offset < 0) return undefined;
  const cue = offsets.find(({ end }) => end > offset);
  return (
    cue && {
      snippet: text.slice(Math.max(0, offset - 35), offset + needle.length + 85),
      matchTime: cue.start,
    }
  );
}

type Discovery = Awaited<ReturnType<typeof probeSubtitles>>;
export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()(
  "TranscriptionError",
  {
    code: Schema.Literals([
      "busy",
      "not-found",
      "invalid-input",
      "model-unavailable",
      "cloud-upload-disabled",
      "io",
      "consent-required",
      "agent-cloud-disabled",
      "tool-unavailable",
    ]),
    detail: Schema.String,
  },
) {}
type JobOptions = {
  scoped?: boolean;
  projectOnly?: boolean;
  waitSeconds?: number;
  threadId?: ThreadId;
  /** A lesson's transcription: its notes follow when it completes. */
  lesson?: boolean;
};

export type SettledTranscription = {
  /** The thread that started the job, told when it settles. */
  threadId?: ThreadId;
  id: string;
  stage: "completed" | "failed" | "canceled";
  /** A lesson's job, with its project folder, so its notes can be made. */
  lesson?: { project: string };
};

export class TranscriptionJobs extends Context.Service<
  TranscriptionJobs,
  {
    readonly execute: (
      input: Request,
      options?: JobOptions,
    ) => Effect.Effect<
      | Status
      | Status[]
      | { media: RecordingSource[] }
      | {
          captured: true;
          source?: string;
          transcription?: "started" | "queued" | "unavailable";
        }
      | {
          captured: true;
          language: string;
          captions?: RecordingEngineSelection;
          transcription?: "unavailable";
          talk: { openai: boolean };
        }
      | { sdpAnswer: string }
      | { trashed: true }
      | { detectedLanguage: string | null }
      | Published
      | typeof EngineInventory.Type
      | TranscriptionWord[]
      | NonNullable<Job["correction"]>
      | Discovery
      | { assessment: SubtitleProvenance },
      TranscriptionError
    >;
    readonly enqueue: (
      input: typeof BatchStartRequest.Type,
    ) => Effect.Effect<{ queued: number }, TranscriptionError>;
    readonly startScoped: (
      project: string,
      input: ScopedStart,
      waitSeconds: number,
      threadId?: ThreadId,
    ) => Effect.Effect<Status | Status[], TranscriptionError>;
    readonly engines: (
      project: string,
      input: typeof InventoryInput.Type,
    ) => Effect.Effect<typeof EngineInventory.Type, TranscriptionError>;
    readonly manageWords: (
      input: WordsCommand,
    ) => Effect.Effect<WordsCommandResult, DictationWordsError>;
    readonly readDictationWords: (input: {
      readonly projectId?: ProjectId;
      readonly language: string;
    }) => Effect.Effect<DictationVocabulary, DictationWordsError>;
    readonly subscribeSettled: () => Effect.Effect<
      PubSub.Subscription<SettledTranscription>,
      never,
      Scope.Scope
    >;
  }
>()("t3/transcription/TranscriptionJobs") {}

const inside = (root: string, source: string) => {
  const relative = NodePath.relative(root, source);
  return (
    relative !== ".." && !relative.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(relative)
  );
};

const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const isTranscriptionError = Schema.is(TranscriptionError);
const isSubtitleInputError = Schema.is(SubtitleInputError);
const isMediaToolUnavailable = Schema.is(MediaToolUnavailable);
const failureResponse = (cause: unknown) =>
  isTranscriptionError(cause)
    ? cause
    : isSubtitleInputError(cause)
      ? invalid(cause.detail)
      : isMediaToolUnavailable(cause)
        ? new TranscriptionError({ code: "tool-unavailable", detail: cause.message })
        : missing(cause)
          ? new TranscriptionError({
              code: "not-found",
              detail: "The project, source, or revision was not found.",
            })
          : new TranscriptionError({
              code: "io",
              detail: "The server could not access or process the transcription files.",
            });
const invalid = (detail: string) => new TranscriptionError({ code: "invalid-input", detail });
const busy = () =>
  new TranscriptionError({
    code: "busy",
    detail: "A local speech worker or transcription job is active.",
  });

const WordsFile = Schema.Struct({
  words: TranscriptionWords,
  legacyProjectWordsImported: Schema.Boolean,
  legacyProjectWordsSnapshot: Schema.optionalKey(SpeechCustomWords),
  legacyProjectWordWritesApplied: Schema.optionalKey(NonNegativeInt),
});
const decodeWordsFile = Schema.decodeUnknownSync(Schema.Union([TranscriptionWords, WordsFile]));
const isWordsFile = Schema.is(WordsFile);

const readJson = async <A>(root: string, name: string): Promise<A> => {
  const file = NodePath.join(root, name);
  if (!(await NodeFSP.lstat(file)).isFile()) throw new Error("Invalid transcription file.");
  return JSON.parse(await NodeFSP.readFile(file, "utf8")) as A;
};

const jobFailure = (cause: unknown, stage: State["stage"] | undefined) => {
  if (isSubtitleInputError(cause)) return { code: "invalid-input", message: cause.detail };
  if (isMediaToolUnavailable(cause)) return { code: "tool-unavailable", message: cause.message };
  if (isTranscriptionError(cause)) return { code: cause.code, message: cause.detail };
  if (isCloudResponseError(cause)) {
    const message = {
      "provider-key-rejected": "The provider rejected the speech key.",
      "provider-response-too-large": "The provider response exceeded the size limit.",
      "recognition-failed": "The cloud provider could not transcribe this window.",
    }[cause.code];
    return { code: cause.code, message };
  }
  const failure = cause as { _tag?: string; reason?: string } | undefined;
  if (failure?._tag === "ChatGptDictationError" && failure.reason === "signed-out") {
    return { code: "signed-out", message: "Sign in to ChatGPT in the selected Codex instance." };
  }
  if (
    failure?._tag === "CloudSpeechError" &&
    ["missing-key", "unreadable-key", "rejected-key"].includes(failure.reason ?? "")
  ) {
    return {
      code: "provider-credentials",
      message: "Check the transcription provider credentials.",
    };
  }
  if (stage === "decoding")
    return { code: "decode-failed", message: "Could not decode the recording or score speech." };
  if (stage === "writing")
    return { code: "write-failed", message: "Could not save the transcription output." };
  return {
    code: "recognition-failed",
    message: "The transcription engine could not recognize this recording.",
  };
};

type Published = {
  segments: Segment[];
  recognitionHints?: boolean;
  suggestions?: TranscriptionWord[];
  reviewItems?: ReviewItem[];
  appliedEdits?: ReviewItem[];
  correctionOutcome?: CorrectionOutcome;
  reviewDecisions?: Array<{
    item: ReviewItem;
    revision: string;
    index: number;
    decision: "accepted" | "rejected";
  }>;
};

const make = Effect.gen(function* () {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const cloud = yield* Cloud.CloudEngines;
  const chatgpt = yield* ChatGpt.ChatGptEngineServices;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStoreV2;
  const speech = yield* Speech.SpeechService;
  const generation = yield* TextGeneration;
  const pendingReviews = new Map<string, Promise<unknown>>();
  let pendingWords: Promise<unknown> = Promise.resolve();
  const serializeWords = <A>(operation: () => Promise<A>): Promise<A> => {
    const done = pendingWords.then(operation);
    pendingWords = done.catch(() => undefined);
    return done;
  };
  type Active = {
    root: string;
    /** The recording the job reads, once known; Trash leaves it alone. */
    source?: string;
    id?: string;
    status?: Status;
    controller: AbortController;
    done?: Promise<void>;
    paused?: boolean;
  };
  let active: Active | undefined;
  /** Moves to the Trash in progress; no job starts meanwhile. */
  let trashing = 0;
  const queuedSources = new Set<string>();
  const trashHost: TrashHost = {
    platform: yield* HostProcess.Platform,
    homeDirectory: yield* HostProcess.HomeDirectory,
    environment: yield* HostProcess.Environment,
    userId: yield* HostProcess.UserId,
  };
  const jobsScope = yield* Scope.make();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      active?.controller.abort();
      await active?.done?.catch(() => undefined);
    }).pipe(Effect.ensuring(Scope.close(jobsScope, Exit.void))),
  );

  const holdContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof acquireTranscriptionHold>>>();
  const run = Effect.runPromiseWith(holdContext);
  const captureGate = Semaphore.makeUnsafe(1);
  const durationGate = Semaphore.makeUnsafe(4);
  const durationCache = new Map<
    string,
    { fingerprint: string; result: Promise<number | undefined> }
  >();
  const durationFor = async (project: string, source: string | undefined) => {
    if (!source) return undefined;
    try {
      const file = await NodeFSP.realpath(source);
      if (!inside(project, file)) return undefined;
      const stat = await NodeFSP.stat(file);
      if (!stat.isFile()) return undefined;
      const fingerprint = `${stat.size}:${stat.mtimeMs}`;
      const cached = durationCache.get(file);
      if (cached?.fingerprint === fingerprint) return await cached.result;
      const ffmpeg = process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg";
      const result = run(
        durationGate.withPermit(
          Effect.promise(() => probeRecordingDuration(ffmpeg, file, AbortSignal.timeout(5000))),
        ),
      ).catch(() => undefined);
      if (durationCache.size >= 512) {
        const oldest = durationCache.keys().next();
        if (!oldest.done) durationCache.delete(oldest.value);
      }
      durationCache.set(file, { fingerprint, result });
      return await result;
    } catch {
      return undefined;
    }
  };
  // A found file's duration is listed once probed; the listing never waits for the probe, and
  // the entry, set before the probe, keeps later polls from queueing it again.
  const foundDurations = new Map<string, { fingerprint: string; value?: number }>();
  const probedDuration = (project: string, file: DiscoveredMedia) => {
    const fingerprint = `${file.size}:${file.mtime}`;
    const known = foundDurations.get(file.source);
    if (known?.fingerprint === fingerprint) return known.value;
    if (foundDurations.size >= 4096) {
      const oldest = foundDurations.keys().next();
      if (!oldest.done) foundDurations.delete(oldest.value);
    }
    const entry: { fingerprint: string; value?: number } = { fingerprint };
    foundDurations.set(file.source, entry);
    void durationFor(project, file.source).then((value) => {
      if (value !== undefined) entry.value = value;
    });
    return undefined;
  };
  const discoveries = new Map<string, { at: number; files: Promise<DiscoveredMedia[]> }>();
  const discoveredMedia = (project: string, now: number) => {
    const cached = discoveries.get(project);
    if (cached && now - cached.at < 10_000) return cached.files;
    if (!cached && discoveries.size >= 64) {
      const oldest = discoveries.keys().next();
      if (!oldest.done) discoveries.delete(oldest.value);
    }
    const files = discoverProjectMedia(project).catch(() => []);
    discoveries.set(project, { at: now, files });
    return files;
  };
  const settled = yield* PubSub.unbounded<SettledTranscription>();
  const requireCloudUpload = Effect.fn("TranscriptionJobs.requireCloudUpload")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failureResponse));
    if (!settings.transcription.agentsMayUseCloudEngines)
      return yield* new TranscriptionError({
        code: "cloud-upload-disabled",
        detail: "Enable Agents may send audio to cloud engines to use this engine.",
      });
  });
  const readWordsFile = (directory: string): Promise<typeof WordsFile.Type> =>
    readJson<unknown>(directory, "words.json")
      .then(decodeWordsFile)
      .then((saved) =>
        isWordsFile(saved) ? saved : { words: saved, legacyProjectWordsImported: false },
      )
      .catch((error: unknown) => {
        if (missing(error)) return { words: [], legacyProjectWordsImported: false };
        throw error;
      });
  const readProjectWords = async (
    root: string,
    projectId: () => Promise<ProjectId | undefined>,
  ) => {
    const saved = await readWordsFile(root);
    if (!LEGACY_WORDS_TRANSITION_ENABLED) return saved;
    const settings = await run(serverSettings.getSettings);
    if (
      Object.keys(settings.legacyProjectSpeechWordWrites).length === 0 &&
      !Object.values(settings.projectSettingsOverrides).some((entry) =>
        Object.hasOwn(entry, "speechProjectCustomWords"),
      )
    )
      return saved;
    const id = await projectId();
    const legacy =
      id === undefined
        ? undefined
        : settings.projectSettingsOverrides[id]?.speechProjectCustomWords;
    const writes = id === undefined ? [] : (settings.legacyProjectSpeechWordWrites[id] ?? []);
    if (legacy === undefined && writes.length === 0) return saved;
    const previous = saved.legacyProjectWordsSnapshot;
    const count = saved.legacyProjectWordWritesApplied ?? 0;
    if (previous && Equal.equals(previous, legacy ?? writes.at(-1)) && count === writes.length)
      return saved;
    let snapshot =
      previous ?? (saved.legacyProjectWordsImported ? (writes[0] ?? legacy) : []) ?? [];
    let words = saved.words;
    for (const write of [...writes.slice(count), ...(legacy ? [legacy] : [])]) {
      if (!Equal.equals(snapshot, write))
        words = reconcileLegacySpeechWords(words, snapshot, write);
      snapshot = write;
    }
    const migrated = {
      words,
      legacyProjectWordsSnapshot: snapshot,
      legacyProjectWordWritesApplied: writes.length,
      legacyProjectWordsImported: true,
    };
    await NodeFSP.mkdir(root, { recursive: true });
    await atomicWrite(NodePath.join(root, "words.json"), JSON.stringify(migrated));
    return migrated;
  };

  const readDictationWords = Effect.fn("TranscriptionJobs.readDictationWords")(
    function* ({
      projectId,
      language,
    }: {
      readonly projectId?: ProjectId;
      readonly language: string;
    }) {
      const settings = yield* serverSettings.getSettings;
      const row = projectId === undefined ? Option.none() : yield* projects.get(projectId);
      const projectWords = Option.isNone(row)
        ? []
        : yield* Effect.tryPromise({
            try: () =>
              serializeWords(async () => {
                const project = await NodeFSP.realpath(row.value.workspaceRoot);
                const root = NodePath.join(project, "Transcripts");
                const stat = await NodeFSP.lstat(root).catch((error: unknown) => {
                  if (missing(error)) return undefined;
                  throw error;
                });
                if (stat && !stat.isDirectory()) throw invalid("Invalid transcription directory.");
                return (await readProjectWords(root, async () => projectId)).words;
              }),
            catch: failureResponse,
          });
      const levels = [settings.transcriptionWords, projectWords];
      return {
        words: mergeWords(levels, language, "", Infinity),
        hints: recognitionTerms(
          mergeWords(levels, language, Option.isNone(row) ? "" : row.value.title),
        ),
      };
    },
    Effect.mapError(() => new DictationWordsError({ message: "Could not read dictation Words." })),
  );
  const engines = Effect.fn("TranscriptionJobs.engines")(function* (
    project: string,
    input: typeof InventoryInput.Type,
  ) {
    const ffmpeg = process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg";
    const mediaAvailable = yield* Effect.promise((signal) =>
      runMediaTool(ffmpeg, ["-version"], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      }).then(
        () => true,
        () => false,
      ),
    );
    const supported = (yield* speech.status).supported;
    const settings = yield* serverSettings.getSettings;
    const installed = new Set(
      supported
        ? yield* Effect.filter(transcriptionModels, (model) => store.isReady(model), {
            concurrency: 8,
          }).pipe(Effect.map((models) => models.map((model) => model.id)))
        : [],
    );
    const languages = input.language ? [input.language] : ["auto", "he", "ar", "en"];
    const recommendations: Record<
      string,
      (typeof EngineInventory.Type)["recommendations"][string]
    > = {};
    const shown = new Set(installed);
    const suggest = (
      key: string,
      id: string,
      role: "recommended" | "faster" | "more-accurate" | "alternative" = "recommended",
    ) => {
      recommendations[key] = {
        id,
        installed: installed.has(id),
        ...(input.details ? { role } : {}),
      };
      shown.add(id);
    };
    if (supported) {
      for (const language of languages) {
        const candidates = modelCandidates(language);
        const primary =
          candidates.find((model) => installed.has(model.id)) ??
          (language.split("-")[0] === "he" ? modelCandidates("auto")[0] : candidates[0]);
        if (primary) suggest(language, primary.id);
        for (const model of candidates.filter((model) => !installed.has(model.id)).slice(0, 2))
          shown.add(model.id);
      }
      if (languages.includes("ar")) suggest("arAlternative", arabicAlternative, "alternative");
      if (languages.includes("en")) suggest("enFast", englishFast, "faster");
    }
    const local = supported
      ? transcriptionModels
          .filter(
            (model) =>
              (input.details || shown.has(model.id)) &&
              (!input.language || supportsLanguage(model, input.language)),
          )
          .map((model) => {
            const accuracy: Readonly<Record<string, { grade: string; errorPercent: number }>> =
              model.benchmark.accuracy;
            const grade =
              accuracy[input.language ?? "en"]?.grade ??
              accuracy[input.language?.split("-")[0] ?? "en"]?.grade;
            return {
              id: model.id,
              name: model.name,
              size: model.size,
              installed: installed.has(model.id),
              ...(grade ? { grade } : {}),
              secondsPer30s: model.benchmark.secondsPer30s,
              ...(input.details ? { languages: model.languages, accuracy } : {}),
            };
          })
      : [];
    const configs = yield* cloud.execute({ action: "list" });
    const cloudInventory = Array.isArray(configs)
      ? yield* Effect.forEach(configs, ({ id, provider, model, ...binding }) =>
          input.details && cloud.describe
            ? cloud.describe({ id, provider, model, ...binding }).pipe(
                Effect.orElseSucceed(() => ({})),
                Effect.map((description) => ({ id, provider, model, ...description })),
              )
            : Effect.succeed({ id, provider, model }),
        )
      : [];
    const provider = yield* chatgpt.resolve();
    const signedIn = provider ? yield* provider.signedIn(project) : false;
    return {
      local,
      mediaAvailable,
      chatgpt: { enabled: provider !== undefined, signedIn, model: "chatgpt" as const },
      agentsMayUseCloudEngines: settings.transcription.agentsMayUseCloudEngines,
      cloud: cloudInventory.map((engine) => {
        const audioHourUsd = audioTranscriptionHourUsd(engine.provider, engine.model);
        return { ...engine, ...(audioHourUsd === undefined ? {} : { audioHourUsd }) };
      }),
      recommendations,
    };
  }, Effect.mapError(failureResponse));

  const execute = Effect.fn("TranscriptionJobs.execute")(function* (
    request: Request,
    opts?: JobOptions,
  ) {
    const defaults =
      (request.action === "start" || request.action === "correction-estimate") &&
      request.mode === undefined
        ? (yield* serverSettings.getSettings.pipe(Effect.mapError(failureResponse)))
            .recordingDefaults
        : undefined;
    const input: Request =
      defaults && (request.action === "start" || request.action === "correction-estimate")
        ? { ...request, mode: defaults.correction }
        : request;
    const agent =
      opts?.scoped === true ||
      Option.isSome(yield* Effect.serviceOption(McpInvocationContext)) ||
      Option.isSome(yield* Effect.serviceOption(AgentInvocationContext));
    if (input.action === "inventory") return yield* engines(input.project, input);
    if (agent && input.action === "import-transcript")
      return yield* invalid("Import a transcript from the Recordings page.");
    if (agent && input.action.startsWith("capture-"))
      return yield* invalid("Only the user can record from their microphone.");
    const nowMs = yield* Clock.currentTimeMillis;
    const cloudUpload = input.action === "start" && input.engine !== "local";
    if (agent) {
      const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failureResponse));
      if (
        settings.transcription.agentsMayTranscribe === false &&
        ["start", "status", "list"].includes(input.action)
      ) {
        return yield* invalid("Agent transcription is disabled in settings.");
      }
      if (
        settings.transcription.agentsMaySuggestWords === false &&
        input.action === "suggestions-list"
      ) {
        return yield* invalid("Agent Words suggestions are disabled in settings.");
      }
      if (cloudUpload && !settings.transcription.agentsMayUseCloudEngines) {
        return yield* new TranscriptionError({
          code: "agent-cloud-disabled",
          detail: "Enable Agents may send audio to cloud engines first.",
        });
      }
    }
    return yield* Effect.tryPromise({
      catch: failureResponse,
      try: async (waitSignal) => {
        if (!NodePath.isAbsolute(input.project))
          throw invalid("Expected an absolute project path.");
        const project = await NodeFSP.realpath(input.project);
        if (opts?.scoped && NodePath.relative(input.project, project) !== "")
          throw invalid("The registered project path has changed.");
        const root = NodePath.join(project, "Transcripts");
        const projectId = async () => {
          const registered = await run(projects.findActiveByWorkspaceRoot(input.project));
          const match =
            Option.isNone(registered) && input.project !== project
              ? await run(projects.findActiveByWorkspaceRoot(project))
              : registered;
          return Option.isSome(match) ? match.value.projectId : undefined;
        };
        const rootStat = await NodeFSP.lstat(root).catch((error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (rootStat && !rootStat.isDirectory()) throw invalid("Invalid transcription directory.");
        if (!rootStat && input.action === "list") return [];
        if (input.action === "sample-language") {
          if (!NodePath.isAbsolute(input.source)) throw invalid("Expected an absolute media path.");
          const source = await NodeFSP.realpath(input.source);
          if (!inside(project, source) || !(await NodeFSP.stat(source)).isFile())
            throw invalid("The recording must live in the project.");
          const speechStatus = await run(speech.status);
          if (
            active ||
            trashing ||
            !speechStatus.supported ||
            speechStatus.state === "transcribing"
          )
            return { detectedLanguage: null };
          const controller = new AbortController();
          const sampling: Active = { root, controller };
          active = sampling;
          const signal = AbortSignal.any([
            controller.signal,
            waitSignal,
            AbortSignal.timeout(30000),
          ]);
          const result = (async () => {
            let installed: string | undefined;
            for (const candidate of modelCandidates("auto")) {
              if (!candidate.supportsLanguageDetection) continue;
              installed = await run(store.installedPath(candidate), { signal });
              if (installed) break;
            }
            if (!installed) return null;
            const model = installed;
            const settings = await run(serverSettings.getSettings, { signal });
            const vad = await openVad(speech, signal);
            try {
              const ffmpeg = process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg";
              return await sampleSpeechLanguage(
                scoreSpeech(decodePcm(ffmpeg, source, signal, 0, 30, true), vad.score),
                () =>
                  openSharedLocalEngine(speech, model, "auto", signal, settings.speechAcceleration),
              );
            } finally {
              await vad.close();
            }
          })();
          sampling.done = result.then(
            () => undefined,
            () => undefined,
          );
          try {
            return { detectedLanguage: await result };
          } finally {
            if (active === sampling) active = undefined;
          }
        }
        const mediaRecordPath = (source: string) =>
          NodePath.join(
            root,
            `recording-${NodeCrypto.createHash("sha256").update(source).digest("hex")}.json`,
          );
        const readMediaRecord = (source: string) =>
          NodeFSP.readFile(mediaRecordPath(source), "utf8").then(
            (text) => decodeRecordingSource(JSON.parse(text)),
            (error: unknown) => {
              if (missing(error)) return undefined;
              throw error;
            },
          );
        const registerMedia = async (path: string) => {
          if (!NodePath.isAbsolute(path)) throw invalid("Expected an absolute media path.");
          const source = await NodeFSP.realpath(path);
          if (!inside(project, source)) throw invalid("The recording must live in the project.");
          const stat = await NodeFSP.stat(source);
          if (!stat.isFile()) throw invalid("Expected a media file.");
          const duration = await recordingDuration(
            process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg",
            source,
            AbortSignal.timeout(5000),
          ).catch(() => undefined);
          const media = {
            source,
            size: stat.size,
            created: stat.birthtimeMs || stat.mtimeMs,
            ...(duration !== undefined && Number.isFinite(duration) && duration > 0
              ? { duration }
              : {}),
          };
          const title = (await readMediaRecord(source))?.title;
          const record = { ...media, ...(title ? { title } : {}) };
          await NodeFSP.mkdir(root, { recursive: true });
          await atomicWrite(mediaRecordPath(source), JSON.stringify(record));
          return record;
        };
        if (input.action === "media-register") {
          // A file outside the project registers nothing, so the caller can copy it in instead.
          if (input.onlyInProject) {
            const source = await NodeFSP.realpath(input.source).catch(() => undefined);
            if (!source || !inside(project, source)) return { media: [] };
          }
          return { media: [await registerMedia(input.source)] };
        }
        if (input.action === "recording-rename") {
          if (!NodePath.isAbsolute(input.source)) throw invalid("Expected an absolute media path.");
          const source = await NodeFSP.realpath(input.source);
          if (!inside(project, source)) throw invalid("The recording must live in the project.");
          const { title: _previous, ...media } =
            (await readMediaRecord(source)) ?? (await registerMedia(source));
          const title = input.title.trim();
          await atomicWrite(
            mediaRecordPath(source),
            JSON.stringify({ ...media, ...(title ? { title } : {}) }),
          );
          return { media: [{ ...media, ...(title ? { title } : {}) }] };
        }
        if (input.action === "recording-trash") {
          if (!NodePath.isAbsolute(input.source)) throw invalid("Expected an absolute media path.");
          trashing += 1;
          try {
            // The file may already be gone; its transcripts still go.
            const source = await NodeFSP.realpath(input.source).catch(() =>
              NodePath.resolve(input.source),
            );
            if (!inside(project, source)) throw invalid("The recording must live in the project.");
            // A job whose recording is not known yet, or a review being saved, may be using it.
            if (
              queuedSources.has(source) ||
              pendingReviews.size > 0 ||
              (active?.root === root &&
                (active.source === undefined ||
                  active.source === source ||
                  active.status?.job.source === source))
            )
              throw invalid("Stop transcribing this recording first.");
            const revisions = rootStat
              ? (
                  await Promise.all(
                    (await NodeFSP.readdir(root, { withFileTypes: true }))
                      .filter((entry) => entry.isDirectory() && revision.test(entry.name))
                      .map(async (entry) => {
                        const job = await readJson<Job>(
                          NodePath.join(root, entry.name),
                          "job.json",
                        ).catch(() => undefined);
                        return job?.source === source ? NodePath.join(root, entry.name) : undefined;
                      }),
                  )
                ).filter((directory) => directory !== undefined)
              : [];
            const file = await NodeFSP.stat(source).then(
              (stat) => (stat.isFile() ? [source] : []),
              () => [],
            );
            const outcomes = await moveToTrash(trashHost, [...file, ...revisions]);
            const failed = outcomes.find((outcome) => !outcome.ok);
            if (failed && !failed.ok) throw new Error(failed.message);
            await NodeFSP.rm(mediaRecordPath(source), { force: true });
            return { trashed: true as const };
          } finally {
            trashing -= 1;
          }
        }
        if (input.action === "capture-start") {
          await run(
            captureGate.withPermit(Effect.promise(() => touchCapture(root, input.id, nowMs))),
          );
          const language = input.language ?? "auto";
          const engine = await run(
            resolveDefaultEngine(project, { language }, false).pipe(Effect.option),
          );
          const captions = Option.isNone(engine)
            ? undefined
            : engine.value.engine === "local"
              ? { kind: "local" as const, modelId: engine.value.model }
              : engine.value.engine === "cloud" &&
                  engine.value.cloudEngineId &&
                  // Dictation carries no project, so a key kept for this project can't caption.
                  Option.isSome(
                    await run(cloud.resolve(engine.value.cloudEngineId).pipe(Effect.option)),
                  )
                ? { kind: "cloud" as const, engineId: engine.value.cloudEngineId }
                : engine.value.engine === "chatgpt" && engine.value.providerInstanceId
                  ? { kind: "chatgpt" as const, instanceId: engine.value.providerInstanceId }
                  : undefined;
          const key = await run(
            cloud.realtimeKey(await projectId()).pipe(Effect.orElseSucceed(() => undefined)),
          );
          return {
            captured: true as const,
            language,
            ...(captions ? { captions } : {}),
            ...(Option.isSome(engine) ? {} : { transcription: "unavailable" as const }),
            talk: { openai: key !== undefined },
          };
        }
        if (input.action === "capture-talk") {
          const key = await run(
            cloud.realtimeKey(await projectId()).pipe(Effect.orElseSucceed(() => undefined)),
          );
          if (!key) throw invalid("Add an OpenAI speech engine to talk with your key.");
          try {
            const sdpAnswer = await connectLessonTalk({
              key: Redacted.value(key),
              sdpOffer: input.sdpOffer,
              instructions: lessonInstructions(await readCaptions(root, input.id)),
              signal: AbortSignal.timeout(20_000),
            });
            return { sdpAnswer };
          } catch (cause) {
            throw new TranscriptionError({
              code: "model-unavailable",
              detail: isLessonTalkError(cause)
                ? cause.message
                : "OpenAI could not start the conversation.",
            });
          }
        }
        if (
          input.action === "capture-chunk" ||
          input.action === "capture-touch" ||
          input.action === "capture-caption" ||
          input.action === "capture-finish"
        ) {
          if (input.action !== "capture-finish" && isCaptureFinished(input.id))
            throw invalid("This recording was already saved.");
          const result = await run(
            captureGate.withPermit(
              Effect.promise(async () => {
                if (input.action === "capture-chunk") {
                  await saveCaptureChunk(root, input.id, input.format, input.index, input.bytes);
                  return { captured: true as const };
                }
                if (input.action === "capture-touch") {
                  await touchCapture(root, input.id, nowMs);
                  return { captured: true as const };
                }
                if (input.action === "capture-caption") {
                  await saveCaption(root, input.id, {
                    window: input.window,
                    start: input.start,
                    end: Math.max(input.start, input.end),
                    text: input.text.trim(),
                  });
                  return { captured: true as const };
                }
                const source = await finishCapture(root, input.id, registerMedia);
                return { captured: true as const, ...(source ? { source } : {}) };
              }),
            ),
          );
          if (input.action !== "capture-finish" || !input.lesson || !("source" in result))
            return result;
          const transcription = await run(
            startLesson(project, result.source, input.lesson.language).pipe(
              Effect.orElseSucceed(() => "unavailable" as const),
            ),
          );
          return { ...result, transcription };
        }
        if (input.action === "capture-recover" || input.action === "media-list") {
          if (rootStat && !agent)
            await run(
              captureGate.withPermit(
                Effect.promise(() => recoverCaptures(root, registerMedia, nowMs)),
              ),
            );
          if (input.action === "capture-recover") return { captured: true as const };
          const entries = rootStat ? await NodeFSP.readdir(root, { withFileTypes: true }) : [];
          const media = await Promise.all(
            entries
              .filter(
                (entry) => entry.isFile() && /^recording-[a-f0-9]{64}\.json$/.test(entry.name),
              )
              .map(async (entry) => {
                try {
                  const record = decodeRecordingSource(await readJson<unknown>(root, entry.name));
                  if (!inside(project, record.source)) return undefined;
                  const duration = record.duration ?? (await durationFor(project, record.source));
                  return {
                    ...record,
                    ...(duration === undefined ? {} : { duration }),
                    queued: queuedSources.has(record.source),
                  };
                } catch {
                  return undefined;
                }
              }),
          );
          const registered = media.filter((record) => record !== undefined);
          const known = new Set(registered.map(({ source }) => source));
          const found = (await discoveredMedia(project, nowMs)).flatMap((file) => {
            if (known.has(file.source)) return [];
            const duration = probedDuration(project, file);
            return [
              {
                source: file.source,
                size: file.size,
                created: file.created,
                ...(duration === undefined ? {} : { duration }),
                queued: queuedSources.has(file.source),
              },
            ];
          });
          return { media: [...registered, ...found] };
        }
        const status = async (id: string): Promise<Status> => {
          if (active?.root === root && active.id === id && active.status) return active.status;
          const directory = NodePath.join(root, id);
          if (!(await NodeFSP.lstat(directory)).isDirectory())
            throw new Error("Invalid transcript revision.");
          const job = await readJson<Job>(directory, "job.json");
          if (job.id !== id) throw new Error("Invalid transcription job ID.");
          const saved = await readJson<State>(directory, "state.json").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return { stage: "decoding", completed: 0 } as const;
              throw error;
            },
          );
          const stage = saved.stage;
          const subtitles = await readJson<SubtitleProvenance>(directory, "subtitles.json").catch(
            (error: unknown) => {
              if (missing(error)) return undefined;
              throw error;
            },
          );
          return {
            job,
            ...(subtitles ? { subtitles } : {}),
            state:
              stage === "writing" || stage === "transcribing" || stage === "decoding"
                ? { ...saved, stage: "interrupted", completed: await checkpointCount(directory) }
                : saved,
          };
        };

        const wait = async (running: Active | undefined, id: string) => {
          if (running?.root === root && running.id === id && running.done && opts?.waitSeconds) {
            const done = running.done;
            await run(
              Effect.promise(() => done).pipe(
                Effect.timeoutOption(Duration.seconds(opts.waitSeconds)),
              ),
              { signal: waitSignal },
            );
          }
        };

        const projectWords = () => readProjectWords(root, projectId);
        const readWords = async (directory: string) =>
          (await (directory === root ? serializeWords(projectWords) : readWordsFile(directory)))
            .words;
        if (
          input.action === "words-list" ||
          input.action === "words-add" ||
          input.action === "words-remove" ||
          input.action === "words-accept"
        ) {
          const operation = async () => {
            let directory = root;
            if (input.level === "recording") {
              if (!input.id) throw invalid("Select a recording revision.");
              const { job } = await status(input.id);
              const recording = job.recording ?? job.id;
              if (!revision.test(recording)) throw invalid("Invalid recording ID.");
              await status(recording);
              directory = NodePath.join(root, recording);
            }
            const saved =
              input.level === "global"
                ? {
                    words: (await run(serverSettings.getSettings)).transcriptionWords,
                    legacyProjectWordsImported: false,
                  }
                : await (input.level === "project" ? projectWords() : readWordsFile(directory));
            const { words } = saved;
            if (input.action === "words-list") return [...words];
            const existing = words.find((entry) => wordKey(entry) === wordKey(input.word));
            const word = { ...input.word, source: existing?.source ?? "user" };
            let accepted: TranscriptionWord | undefined;
            if (input.action === "words-accept") {
              if ((await status(input.suggestionRevision)).state.stage !== "completed")
                throw invalid("Select a completed suggestion revision.");
              const transcript = await readJson<Published>(
                NodePath.join(root, input.suggestionRevision),
                "transcript.json",
              );
              accepted = transcript.suggestions?.find(
                (candidate) => wordKey(candidate) === wordKey(word),
              );
              if (!accepted) throw invalid("This suggestion is unavailable.");
            }
            const next = words.filter((entry) => wordKey(entry) !== wordKey(word));
            if (input.action !== "words-remove")
              next.push(accepted ? { ...accepted, source: "suggested-accepted" } : word);
            if (next.length > Math.max(256, words.length))
              throw invalid("This vocabulary already contains 256 words.");
            if (input.level === "global") {
              const updated = await run(
                serverSettings.updateSettings({
                  editTranscriptionWord: {
                    operation: input.action === "words-remove" ? "remove" : "save",
                    word: accepted ? { ...accepted, source: "suggested-accepted" } : word,
                  },
                }),
              );
              return [...updated.transcriptionWords];
            } else {
              await NodeFSP.mkdir(directory, { recursive: true });
              await atomicWrite(
                NodePath.join(directory, "words.json"),
                JSON.stringify(saved.legacyProjectWordsImported ? { ...saved, words: next } : next),
              );
            }
            return next;
          };
          return serializeWords(operation);
        }

        const correctionOptions = async (
          request: Pick<
            Extract<Request, { action: "start" }>,
            "mode" | "notes" | "relisten" | "correctionModel"
          >,
          settings: Awaited<ReturnType<typeof readSettings>>,
          firstModel?: string,
        ): Promise<NonNullable<Job["correction"]>> => {
          const selection =
            request.correctionModel ??
            settings.recordingCorrectionModelSelection ??
            settings.textGenerationModelSelection;
          const provider = settings.providerInstances[selection.instanceId];
          const generator = settings.textGenerators[selection.instanceId];
          const configured = generator?.enabled ?? !!provider?.enabled;
          if (request.correctionModel && !configured)
            throw invalid("Select an enabled text model for correction.");
          const unsupported =
            !settings.textGenerators[selection.instanceId] &&
            ["omp", "droid", "antigravity"].some((driver) => provider?.driver === driver);
          const mode =
            request.mode ??
            (settings.recordingDefaults?.correction === "quick" && configured ? "quick" : "off");
          if (request.relisten && mode !== "thorough")
            throw invalid("Re-listen requires Thorough correction.");
          let relisten: NonNullable<Job["correction"]>["relisten"];
          if (request.relisten) {
            const catalog = getTranscriptionModel(request.relisten.model);
            const model = catalog
              ? await run(store.installedPath(catalog))
              : NodePath.isAbsolute(request.relisten.model)
                ? await NodeFSP.realpath(request.relisten.model)
                : undefined;
            if (!model || model === firstModel || !(await NodeFSP.stat(model)).isFile())
              throw invalid("Select a distinct installed local model for re-listen.");
            relisten = { ...request.relisten, model, providerCost: 0 };
          }
          return {
            mode,
            promptVersion,
            ...(mode !== "off" && configured && !unsupported ? { modelSelection: selection } : {}),
            ...(request.mode !== "off" && (unsupported || !configured)
              ? {
                  unavailable: unsupported
                    ? ("model-unsupported" as const)
                    : ("model-not-configured" as const),
                }
              : {}),
            ...(request.notes !== undefined ? { notes: request.notes } : {}),
            ...(relisten ? { relisten } : {}),
          };
        };
        const readSettings = () => run(serverSettings.getSettings);
        const revisionWords = async (
          job: Job,
          settings: Awaited<ReturnType<typeof readSettings>>,
          segments: readonly Segment[],
          notes?: string,
        ) => {
          const recording = job.recording ?? job.id;
          if (!revision.test(recording)) throw invalid("Invalid recording ID.");
          await status(recording);
          return mergeWords(
            [
              settings.transcriptionWords,
              await readWords(root),
              await readWords(NodePath.join(root, recording)),
            ],
            job.settings.language,
            (notes ?? "") + " " + segments.map(({ text }) => text).join(" "),
          );
        };
        const withEstimate = (
          correction: NonNullable<Job["correction"]>,
          settings: Awaited<ReturnType<typeof readSettings>>,
          words: readonly TranscriptionWord[],
          sourceIdentity: unknown,
          segments?: readonly Segment[],
          duration = 0,
        ) => {
          const estimate = estimateCorrection(
            correction.mode,
            words,
            !!correction.modelSelection,
            correction.relisten,
            segments,
            duration,
            correction.notes,
          );
          const model = correction.modelSelection?.model;
          const rate = model
            ? lookupRate(
                createOverrideRateTable(settings.usagePriceOverrides),
                settings.usageModelAliases[model] ?? model,
              )
            : null;
          const priced = {
            ...estimate,
            textCostUsd:
              rate && estimate.maxCalls
                ? estimate.inputTokens * rate.inputCostPerToken +
                  estimate.outputTokens * rate.outputCostPerToken
                : estimate.textCostUsd,
          };
          const id = NodeCrypto.createHash("sha256")
            .update(JSON.stringify([root, sourceIdentity, correction, words, priced]))
            .digest("hex");
          return { ...correction, estimate: priced, estimateId: id };
        };
        const checkEstimate = (requested: string | undefined, actual: string, mode: string) => {
          if (mode === "thorough" && !requested)
            throw invalid("Preview Thorough correction and provide its estimate ID.");
          if (requested && requested !== actual)
            throw invalid("The correction estimate changed. Preview it again.");
        };
        const firstLocalModel = async (job: Job, relisten: unknown) => {
          if (!relisten || job.settings.engine !== "local") return;
          const catalog = getTranscriptionModel(job.settings.model);
          return catalog ? await run(store.installedPath(catalog)) : job.settings.model;
        };
        const completedRevision = async (id: string) => {
          const parent = await status(id);
          if (parent.state.stage !== "completed")
            throw invalid("Select a completed transcript revision.");
          const published = await readJson<Published>(NodePath.join(root, id), "transcript.json");
          return { parent, published };
        };
        if (input.action === "correction-estimate") {
          const settings = await readSettings();
          if (input.id && !input.source) {
            const { parent, published } = await completedRevision(input.id);
            return withEstimate(
              await correctionOptions(
                input,
                settings,
                await firstLocalModel(parent.job, input.relisten),
              ),
              settings,
              await revisionWords(parent.job, settings, published.segments, input.notes),
              parent.job.id,
              published.segments,
            );
          }
          if (!input.source || input.id || !NodePath.isAbsolute(input.source))
            throw invalid("Provide one completed revision ID or absolute recording path.");
          const source = await NodeFSP.realpath(input.source);
          if (!(await NodeFSP.stat(source)).isFile())
            throw invalid("Expected a regular audio file.");
          const previous = input.resume ? await status(input.resume) : undefined;
          const recording =
            previous?.job.source === source
              ? (previous.job.recording ?? previous.job.id)
              : undefined;
          if (recording) {
            if (!revision.test(recording)) throw invalid("Invalid recording ID.");
            await status(recording);
          }
          const words =
            input.useWords === false
              ? []
              : mergeWords(
                  [
                    settings.transcriptionWords,
                    await readWords(root),
                    recording ? await readWords(NodePath.join(root, recording)) : [],
                  ],
                  input.language ?? "auto",
                  NodePath.basename(source) + " " + (input.notes ?? ""),
                );
          return withEstimate(
            await correctionOptions(input, settings),
            settings,
            words,
            [source, await fingerprint(source)],
            undefined,
            await recordingDuration(
              process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg",
              source,
              AbortSignal.timeout(120_000),
            ),
          );
        }
        if (input.action === "suggestions-list") {
          if ((await status(input.id)).state.stage !== "completed")
            throw invalid("Select a completed transcript revision.");
          return (
            (await readJson<Published>(NodePath.join(root, input.id), "transcript.json"))
              .suggestions ?? []
          );
        }
        const publishTranscript = async (directory: string, job: Job, published: Published) => {
          await atomicWrite(
            NodePath.join(directory, "transcript.md"),
            published.segments
              .map((segment) => "[" + timestamp(segment.start) + "] " + segment.text)
              .join("\n\n") + "\n",
          );
          await atomicWrite(
            NodePath.join(directory, "transcript.json"),
            JSON.stringify({ ...published, job }, null, 2),
          );
        };
        const latestRevision = async (job: Job) => {
          const recording = job.recording ?? job.id;
          const entries = await NodeFSP.readdir(root, { withFileTypes: true });
          const completed = (
            await Promise.all(
              entries
                .filter((entry) => entry.isDirectory() && revision.test(entry.name))
                .map((entry) => status(entry.name).catch(() => undefined)),
            )
          ).filter(
            (entry) =>
              entry?.state.stage === "completed" &&
              (entry.job.recording ?? entry.job.id) === recording,
          );
          const parents = new Set(completed.map((entry) => entry?.job.previousRevision));
          const leaves = await Promise.all(
            completed.flatMap((entry) =>
              !entry || parents.has(entry.job.id)
                ? []
                : [
                    NodeFSP.stat(NodePath.join(root, entry.job.id, "state.json")).then((stat) => ({
                      id: entry.job.id,
                      written: stat.mtimeMs,
                    })),
                  ],
            ),
          );
          leaves.sort((a, b) => b.written - a.written || b.id.localeCompare(a.id));
          return leaves[0]?.id ?? job.id;
        };
        if (input.action === "review-accept" || input.action === "review-reject") {
          const requested = await completedRevision(input.id);
          if (active || trashing) throw busy();
          const recording = requested.parent.job.recording ?? requested.parent.job.id;
          const key = NodePath.join(root, recording);
          const operation = async () => {
            const item = requested.published.reviewItems?.[input.item];
            if (!item) throw invalid("This review item no longer matches the transcript.");
            const latest = await latestRevision(requested.parent.job);
            const { parent, published } =
              latest === input.id ? requested : await completedRevision(latest);
            const reviews = published.reviewItems ?? [];
            const index = reviews.findIndex(
              (candidate) =>
                candidate.segmentId === item.segmentId &&
                candidate.before === item.before &&
                candidate.after === item.after &&
                candidate.reason === item.reason,
            );
            const segment = published.segments.find(({ id }) => id === item.segmentId);
            if (index < 0 || !segment || segment.text !== item.before)
              throw invalid("This review item no longer matches the transcript.");
            const accepted = input.action === "review-accept";
            const id = await createRevision(root, parent.job.source);
            const directory = NodePath.join(root, id);
            const job: Job = {
              ...parent.job,
              id,
              recording: parent.job.recording ?? parent.job.id,
              previousRevision: parent.job.id,
              correctionOnly: true,
            };
            const reviewItems = reviews.filter(
              (candidate, position) =>
                position !== index && (!accepted || candidate.segmentId !== item.segmentId),
            );
            const segments = published.segments.map((candidate) =>
              candidate.id === item.segmentId && accepted
                ? { ...candidate, text: item.after, needsReview: false }
                : candidate,
            );
            const state = { ...parent.state, stage: "completed" } as const;
            await atomicWrite(NodePath.join(directory, "job.json"), JSON.stringify(job));
            await publishTranscript(directory, job, {
              ...published,
              segments,
              reviewItems,
              appliedEdits: [
                ...(published.appliedEdits ?? []),
                ...(accepted ? [{ ...item, reason: "Accepted review item." }] : []),
              ],
              reviewDecisions: [
                ...(published.reviewDecisions ?? []),
                {
                  item,
                  revision: input.id,
                  index: input.item,
                  decision: accepted ? "accepted" : "rejected",
                },
              ],
            });
            await atomicWrite(NodePath.join(directory, "state.json"), JSON.stringify(state));
            return { job, state };
          };
          const done = (pendingReviews.get(key) ?? Promise.resolve()).then(operation);
          const settled = done.catch(() => undefined);
          pendingReviews.set(key, settled);
          try {
            return await done;
          } finally {
            if (pendingReviews.get(key) === settled) pendingReviews.delete(key);
          }
        }
        const publishCorrection = async (
          directory: string,
          job: Job,
          published: Published,
          signal: AbortSignal,
          acceleration: string,
        ): Promise<CorrectionOutcome | undefined> => {
          const correction = job.correction;
          if (!correction) return;
          const pass =
            correction.relisten && (correction.estimate?.relistenSeconds ?? 0) > 0
              ? relistenPass(
                  job,
                  { ...correction.relisten, audioSeconds: correction.estimate!.relistenSeconds },
                  signal,
                  async (deadline) => {
                    return openSharedLocalEngine(
                      speech,
                      correction.relisten!.model,
                      job.settings.language,
                      deadline,
                      acceleration,
                    );
                  },
                )
              : undefined;
          const selection = correction.modelSelection;
          const generate =
            selection &&
            (async (prompt: string, structuredCorrection: "initial" | "repair") =>
              (
                await run(
                  generation
                    .generateTranscriptionPostProcessing({
                      cwd: input.project,
                      modelSelection: selection,
                      prompt,
                      structuredCorrection,
                    })
                    .pipe(Effect.timeout("45 seconds")),
                  { signal },
                )
              ).transcription);
          try {
            const result = await correctSegments(published.segments, {
              mode: correction.mode,
              ...(correction.unavailable ? { unavailable: correction.unavailable } : {}),
              ...(correction.notes !== undefined ? { notes: correction.notes } : {}),
              words: job.words ?? [],
              signal,
              ...(correction.estimate ? { maxCalls: correction.estimate.maxCalls } : {}),
              ...(generate ? { generate } : {}),
              ...(pass ? { relisten: pass.recognize } : {}),
            });
            signal.throwIfAborted();
            await publishTranscript(directory, job, {
              ...published,
              ...result,
              reviewItems: [
                ...result.reviewItems,
                ...(published.reviewItems ?? []).filter(
                  (item) =>
                    result.segments.some(
                      ({ id, text }) => id === item.segmentId && text === item.before,
                    ) &&
                    !result.reviewItems.some(
                      (candidate) =>
                        candidate.segmentId === item.segmentId &&
                        candidate.before === item.before &&
                        candidate.after === item.after,
                    ),
                ),
              ],
              appliedEdits: [...(published.appliedEdits ?? []), ...result.appliedEdits],
            });
            return result.correctionOutcome;
          } finally {
            await pass?.close();
          }
        };
        if (input.action === "revision") {
          const current = await status(input.id);
          const directory = NodePath.join(root, input.id);
          if (current.state.stage === "completed") {
            return await readJson<Published>(directory, "transcript.json");
          }
          return {
            segments: await readCheckpoints(directory)
              .then((rows) => rows.flatMap((row) => row.segments))
              .catch((error: unknown) => {
                if (missing(error)) return [];
                throw error;
              }),
          } satisfies Published;
        }
        if (input.action === "list") {
          const source =
            input.source === undefined
              ? undefined
              : await NodeFSP.realpath(input.source).catch(() => null);
          if (source === null) return [];
          const entries = await NodeFSP.readdir(root, { withFileTypes: true });
          const revisions = await Promise.all(
            entries
              .filter((entry) => entry.isDirectory() && revision.test(entry.name))
              .map(async (entry) => {
                try {
                  const current = await status(entry.name);
                  if (source !== undefined && current.job.source !== source) return undefined;
                  if (!input.includeCreated) return current;
                  const metadata = await NodeFSP.stat(NodePath.join(root, entry.name, "job.json"));
                  const corrected =
                    current.state.stage === "completed" &&
                    (current.job.correctionOnly ||
                      (current.job.correction && current.job.correction.mode !== "off"));
                  const query = input.query?.trim().toLocaleLowerCase();
                  const published =
                    corrected || (query && current.state.stage === "completed")
                      ? await readJson<Published>(
                          NodePath.join(root, entry.name),
                          "transcript.json",
                        ).catch(() => undefined)
                      : undefined;
                  const match =
                    query && published ? findTranscriptMatch(published.segments, query) : undefined;
                  const duration = current.job.transcriptOnly
                    ? undefined
                    : await durationFor(project, current.job.source);
                  const modelName =
                    current.job.settings?.engine === "local"
                      ? getTranscriptionModel(current.job.settings.model)?.name
                      : undefined;
                  const reviewCount = published?.reviewItems?.length;
                  return {
                    ...current,
                    created: metadata.birthtimeMs || metadata.mtimeMs,
                    ...(reviewCount === undefined ? {} : { reviewCount }),
                    ...match,
                    ...(duration === undefined ? {} : { duration }),
                    ...(modelName ? { modelName } : {}),
                  };
                } catch (error) {
                  if (missing(error)) return undefined;
                  if ((error as NodeJS.ErrnoException)?.code) throw error;
                  await run(
                    Effect.logWarning("Skipping unreadable transcription revision", {
                      revision: entry.name,
                    }),
                  );
                  return undefined;
                }
              }),
          );
          const available = revisions.filter((entry) => entry !== undefined);
          return input.includeCreated
            ? available.sort(
                (left, right) =>
                  (right.created ?? 0) - (left.created ?? 0) ||
                  right.job.id.localeCompare(left.job.id),
              )
            : available;
        }
        if (
          opts?.scoped &&
          (input.action === "use-subtitles" || input.action === "discover-subtitles")
        )
          throw invalid("Subtitle actions require the server API.");
        const ffmpeg = process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg";
        if (input.action === "discover-subtitles") {
          if (!NodePath.isAbsolute(input.source)) throw invalid("Expected an absolute media path.");
          const source = await NodeFSP.realpath(input.source);
          if (!(await NodeFSP.stat(source)).isFile())
            throw invalid("Expected a regular media file.");
          return probeSubtitles(
            source,
            AbortSignal.any([waitSignal, AbortSignal.timeout(30_000)]),
            ffmpeg,
          );
        }
        if (input.action === "use-subtitles" || input.action === "import-transcript") {
          if (active || trashing) throw busy();
          const imported = input.action === "import-transcript" ? input : undefined;
          const requestedSource = input.source ?? imported?.file;
          const standalone = imported !== undefined && imported.source === undefined;
          if (!requestedSource || !NodePath.isAbsolute(requestedSource))
            throw invalid("Expected an absolute project file path.");
          const selection =
            input.action === "use-subtitles"
              ? input.subtitles
              : {
                  file: await NodeFSP.realpath(input.file),
                  ...(input.format ? { format: input.format } : {}),
                };
          if ("file" in selection && !NodePath.isAbsolute(selection.file))
            throw invalid("Expected an absolute subtitle path.");
          if (imported && "file" in selection && !inside(project, selection.file))
            throw invalid("The transcript must live in the project.");
          const controller = new AbortController();
          const current: Active = { root, controller };
          active = current;
          const signal = controller.signal;
          current.source = NodePath.resolve(requestedSource);
          try {
            const source = await NodeFSP.realpath(requestedSource);
            current.source = source;
            if ((imported && !inside(project, source)) || !(await NodeFSP.stat(source)).isFile())
              throw invalid("Expected a regular project file.");
            const previous = imported?.previousId ? await status(imported.previousId) : undefined;
            if (previous && previous.job.source !== source)
              throw invalid("The previous transcript belongs to a different recording.");
            const decoder = standalone
              ? ""
              : (await runMediaTool(ffmpeg, ["-version"], { signal })).stdout.trim();
            const fingerprinted = await fingerprint(source);
            const standaloneTranscript =
              standalone && "file" in selection
                ? await prepareImportedTranscript(selection, ffmpeg, signal)
                : undefined;
            await NodeFSP.mkdir(root, { recursive: true });
            const id = await createRevision(root, source);
            let job: Job = {
              id,
              source,
              input: fingerprinted,
              ...(standaloneTranscript ? { transcriptOnly: true as const } : {}),
              ...(previous
                ? {
                    previousRevision: previous.job.id,
                    recording: previous.job.recording ?? previous.job.id,
                  }
                : {}),
              settings: {
                ffmpeg,
                decoderVersion: decoder,
                engine: "subtitles",
                model: "",
                engineFingerprint: SILERO_VAD.sha256,
                language: "auto",
                rule: "fixed",
              },
            };
            const directory = NodePath.join(root, id);
            const initial = { stage: "decoding", completed: 0 } as const;
            await atomicWrite(NodePath.join(directory, "job.json"), JSON.stringify(job));
            await atomicWrite(NodePath.join(directory, "state.json"), JSON.stringify(initial));
            current.id = id;
            current.status = { job, state: initial };
            const background = Effect.scoped(
              Effect.gen(function* () {
                const hold = yield* Scope.Scope;
                yield* Effect.promise(async () => {
                  let vad: Awaited<ReturnType<typeof openVad>> | undefined;
                  let state: State;
                  try {
                    if (!standaloneTranscript) {
                      await run(acquireTranscriptionHold().pipe(Scope.provide(hold)), { signal });
                      vad = await openVad(speech, signal);
                    }
                    const prepared =
                      standaloneTranscript ??
                      (await prepareSubtitles(job, selection, vad!.score, signal));
                    if (imported) prepared.provenance.source = "import";
                    signal.throwIfAborted();
                    if (prepared.provenance.language) {
                      job = {
                        ...job,
                        settings: { ...job.settings, language: prepared.provenance.language },
                      };
                      await atomicWrite(NodePath.join(directory, "job.json"), JSON.stringify(job));
                    }
                    await publishSubtitles(directory, job, prepared);
                    await atomicWrite(
                      NodePath.join(directory, "subtitles.json"),
                      JSON.stringify(prepared.provenance),
                    );
                    current.status = { job, state: initial, subtitles: prepared.provenance };
                    state = { stage: "completed", completed: 1 };
                  } catch (cause) {
                    state = signal.aborted
                      ? { stage: "canceled", completed: 0 }
                      : { stage: "failed", completed: 0, error: jobFailure(cause, "decoding") };
                  } finally {
                    await vad?.close();
                  }
                  await atomicWrite(NodePath.join(directory, "state.json"), JSON.stringify(state));
                  current.status = { ...current.status, job, state };
                });
              }),
            );
            current.done = run(
              Effect.forkIn(background, jobsScope).pipe(Effect.flatMap(Fiber.join)),
            ).finally(() => {
              active = undefined;
            });
            void current.done.catch(() =>
              run(Effect.logError("Could not finalize subtitle import")),
            );
            if (standaloneTranscript) await current.done;
            return current.status;
          } catch (error) {
            active = undefined;
            throw error;
          }
        }
        if (input.action === "correct") {
          if (active || trashing || pendingReviews.size > 0) throw busy();
          const controller = new AbortController();
          const current: Active = { root, controller };
          active = current;
          try {
            const parent = await status(input.id);
            current.source = parent.job.source;
            if (parent.state.stage !== "completed")
              throw invalid("Select a completed transcript revision.");
            const published = await readJson<Published>(
              NodePath.join(root, input.id),
              "transcript.json",
            );
            const settings = await readSettings();
            const original = parent.job;
            if ((await latestRevision(original)) !== original.id)
              throw invalid("Select the latest completed revision for correction.");
            const recording = original.recording ?? original.id;
            const firstModel = await firstLocalModel(original, input.relisten);
            const words = await revisionWords(original, settings, published.segments, input.notes);
            const correction = withEstimate(
              await correctionOptions(input, settings, firstModel),
              settings,
              words,
              original.id,
              published.segments,
            );
            checkEstimate(input.estimateId, correction.estimateId, correction.mode);
            const id = await createRevision(root, original.source);
            const directory = NodePath.join(root, id);
            const job: Job = {
              ...original,
              id,
              recording,
              previousRevision: original.id,
              correctionOnly: true,
              words,
              correction,
            };
            const initial = { stage: "writing", completed: parent.state.completed } as const;
            await atomicWrite(NodePath.join(directory, "job.json"), JSON.stringify(job));
            await atomicWrite(NodePath.join(directory, "state.json"), JSON.stringify(initial));
            current.id = id;
            current.status = { job, state: initial };
            current.done = (async () => {
              let state: State;
              try {
                const correctionOutcome = await publishCorrection(
                  directory,
                  job,
                  published,
                  controller.signal,
                  settings.speechAcceleration,
                );
                state = {
                  ...initial,
                  stage: "completed",
                  ...(correctionOutcome ? { correction: correctionOutcome } : {}),
                };
              } catch {
                state = controller.signal.aborted
                  ? { ...initial, stage: "canceled" }
                  : { ...initial, stage: "failed", error: jobFailure(undefined, "writing") };
              }
              await atomicWrite(NodePath.join(directory, "state.json"), JSON.stringify(state));
              current.status = { job, state };
            })().finally(() => {
              active = undefined;
            });
            void current.done.catch(() =>
              run(Effect.logError("Could not finalize correction revision")),
            );
            return { job, state: initial };
          } catch (error) {
            active = undefined;
            throw error;
          }
        }
        if (input.action === "status" || input.action === "cancel" || input.action === "pause") {
          if (input.action !== "status" && active?.root === root && active.id === input.id) {
            if (input.action === "pause") {
              if (
                !active.status ||
                !["decoding", "transcribing"].includes(active.status.state.stage)
              ) {
                throw invalid("This job cannot be paused now.");
              }
              active.paused = true;
            }
            active.controller.abort();
            await active.done;
          }
          if (input.action === "status") await wait(active, input.id);
          return status(input.id);
        }
        if (active || trashing || pendingReviews.size > 0) throw busy();
        if (input.action !== "start") throw invalid("Invalid transcription action.");
        if (input.mode === "thorough" && !input.estimateId)
          throw invalid("Preview Thorough correction and provide its estimate ID.");
        const sourcePath = opts?.scoped
          ? NodePath.resolve(input.project, input.source)
          : input.source;
        if (
          input.range &&
          (input.range.end - input.range.start < 1 / 16_000 ||
            input.range.end > Number.MAX_SAFE_INTEGER / 16_000)
        )
          throw invalid("Expected a range with an end after its start.");
        if (opts?.scoped && !inside(input.project, sourcePath))
          throw invalid("The audio file must resolve inside this project.");
        if (!NodePath.isAbsolute(sourcePath)) throw invalid("Expected an absolute audio path.");
        const subtitleMode =
          input.subtitleMode === "both" || input.subtitleMode === "assess-subtitles";
        const selection = subtitleMode ? input.subtitles : undefined;
        if (!subtitleMode && input.subtitles)
          throw invalid("Choose both or assess-subtitles when providing subtitles.");
        if (subtitleMode && input.resume && input.revisionMode !== "rerun")
          throw invalid("Subtitle processing starts a fresh job.");
        if (subtitleMode && !selection) throw invalid("Select a subtitle source.");
        if (selection && "file" in selection && !NodePath.isAbsolute(selection.file))
          throw invalid("Expected an absolute subtitle path.");
        if (input.subtitleMode === "assess-subtitles" && input.engine !== "local")
          throw invalid("Subtitle assessment requires a local engine.");
        if (
          input.subtitleMode === "both" &&
          input.engine !== "xai" &&
          input.engine !== "openai" &&
          input.engine !== "local"
        )
          throw invalid(
            "Select an engine that accepts subtitle vocabulary hints (OpenAI, xAI or a hint-capable local model).",
          );
        if (input.engine === "local" && input.rule === "short") {
          throw invalid("Short windows require a text-only engine.");
        }
        const controller = new AbortController();
        const current: Active = { root, controller };
        active = current;
        const signal = controller.signal;
        try {
          const userSettings = await readSettings();
          const acceleration = userSettings.speechAcceleration;
          const chatProvider =
            input.engine === "chatgpt"
              ? await run(chatgpt.resolve(input.providerInstanceId), { signal })
              : undefined;
          if (input.engine === "chatgpt" && !chatProvider)
            throw invalid("Select an enabled Codex provider instance.");
          const isCloud = input.engine !== "local" && input.engine !== "chatgpt";
          const cloudProjectId = isCloud && input.cloudEngineId ? await projectId() : undefined;
          const cloudEngine =
            isCloud && input.cloudEngineId
              ? await run(cloud.resolve(input.cloudEngineId, cloudProjectId).pipe(Effect.result), {
                  signal,
                })
              : undefined;
          if (cloudEngine?._tag === "Failure" && cloudEngine.failure.code === "consent-required") {
            throw new TranscriptionError({
              code: "consent-required",
              detail: cloudEngine.failure.detail,
            });
          }
          current.source = NodePath.resolve(sourcePath);
          const source = await NodeFSP.realpath(sourcePath);
          current.source = source;
          if ((opts?.scoped || opts?.projectOnly) && !inside(NodePath.dirname(root), source))
            throw invalid("The audio file must resolve inside this project.");
          const bound = cloudEngine?._tag === "Success" ? cloudEngine.success : undefined;
          if (
            isCloud &&
            (!bound ||
              bound.model !== input.model ||
              (input.engine !== "cloud" && input.engine !== bound.provider))
          ) {
            throw invalid("Select a configured cloud engine and its model.");
          }
          if (!(await NodeFSP.stat(source)).isFile())
            throw invalid("Expected a regular audio file.");
          const inputFingerprint = await fingerprint(source);
          const { stdout } = await runMediaTool(ffmpeg, ["-version"], { signal });
          const catalog = input.engine === "local" ? getTranscriptionModel(input.model) : undefined;
          if (opts?.scoped && input.engine === "local" && !catalog)
            throw invalid("Select a local model from scient_transcription_engines.");
          const model =
            input.engine !== "local"
              ? input.model
              : catalog
                ? await run(store.installedPath(catalog), { signal })
                : NodePath.isAbsolute(input.model)
                  ? await NodeFSP.realpath(input.model)
                  : undefined;
          if (!model)
            throw new TranscriptionError({
              code: "model-unavailable",
              detail: "Install the local speech model first.",
            });
          if (input.engine === "chatgpt" && model !== "chatgpt") {
            throw invalid("The selected provider does not expose that model.");
          }
          const settings = {
            engine: bound?.provider ?? input.engine,
            ...(bound
              ? {
                  accountName: bound.accountName,
                  maxAudioBytes: bound.maxAudioBytes,
                  endpointOrigin: bound.origin,
                  uploadConsent: true as const,
                }
              : {}),
            ...(selection && input.subtitleMode ? { subtitleMode: input.subtitleMode } : {}),
            model: input.model,
            language: input.language,
            rule:
              input.rule ??
              (input.engine === "local" && /cohere/i.test(catalog?.id ?? input.model)
                ? "fixed"
                : "meetily"),
            ffmpeg,
            ...(input.range ? { rangeStart: input.range.start, rangeEnd: input.range.end } : {}),
            ...(opts?.scoped ? { standaloneMedia: true } : {}),
            decoderVersion: stdout.trim(),
            engineFingerprint: JSON.stringify({
              pipeline: 2,
              nativeRuntime: serverManifest.dependencies["transcribe-cpp"],
              acceleration: input.engine === "local" ? acceleration : undefined,
              providerInstanceId: chatProvider?.id,
              cloud: bound?.fingerprint,
              vad: SILERO_VAD.sha256,
              model: input.engine === "local" ? await fingerprint(model) : model,
            }),
          } satisfies Job["settings"];
          if (input.subtitleMode === "assess-subtitles" && selection) {
            const assess = Effect.scoped(
              Effect.gen(function* () {
                yield* acquireTranscriptionHold();
                return yield* Effect.tryPromise({
                  catch: failureResponse,
                  try: async () => {
                    const vad = await openVad(speech, signal);
                    try {
                      const prepared = await prepareSubtitles(
                        { id: "", source, input: inputFingerprint, settings },
                        selection,
                        vad.score,
                        signal,
                        () => openSharedLocalEngine(speech, model, "auto", signal, acceleration),
                      );
                      return prepared.provenance;
                    } finally {
                      await vad.close();
                    }
                  },
                });
              }),
            );
            const cancelAssessment = () => controller.abort();
            waitSignal.addEventListener("abort", cancelAssessment, { once: true });
            if (waitSignal.aborted) cancelAssessment();
            const result = run(Effect.forkIn(assess, jobsScope).pipe(Effect.flatMap(Fiber.join)));
            current.done = result.then(
              () => undefined,
              () => undefined,
            );
            try {
              return { assessment: await result };
            } finally {
              waitSignal.removeEventListener("abort", cancelAssessment);
              active = undefined;
            }
          }
          const previous = input.resume ? await status(input.resume) : undefined;
          const recording =
            previous?.job.source === source
              ? (previous.job.recording ?? previous.job.id)
              : undefined;
          if (recording && !revision.test(recording)) throw invalid("Invalid recording ID.");
          if (
            recording &&
            previous &&
            (await latestRevision(previous.job)) !== previous.job.id &&
            previous.state.stage === "completed"
          )
            throw invalid("Select the latest completed revision to start again.");
          if (recording) await status(recording);
          const words =
            input.useWords === false
              ? []
              : mergeWords(
                  [
                    userSettings.transcriptionWords,
                    await readWords(root),
                    recording ? await readWords(NodePath.join(root, recording)) : [],
                  ],
                  input.language,
                  NodePath.basename(source) + " " + (input.notes ?? ""),
                );
          const options = await correctionOptions(
            input,
            userSettings,
            input.engine === "local" ? model : undefined,
          );
          const correction = withEstimate(
            options,
            userSettings,
            words,
            [source, inputFingerprint],
            undefined,
            options.modelSelection || input.estimateId
              ? await recordingDuration(ffmpeg, source, signal)
              : 0,
          );
          checkEstimate(input.estimateId, correction.estimateId, correction.mode);
          const resume =
            input.revisionMode !== "rerun" &&
            !selection &&
            !previous?.job.settings.subtitleMode &&
            previous &&
            previous.state.stage !== "completed" &&
            !previous.job.correctionOnly &&
            canResume(previous.job, { source, input: inputFingerprint, settings }) &&
            JSON.stringify(previous.job.words ?? []) === JSON.stringify(words) &&
            (previous.job.correction === undefined
              ? correction.mode === "off"
              : JSON.stringify(previous.job.correction) === JSON.stringify(correction));
          if ((input.revisionMode === "resume" || (opts?.scoped && input.resume)) && !resume)
            throw invalid("This revision cannot be resumed with the current source and settings.");
          await NodeFSP.mkdir(root, { recursive: true });
          const id = resume ? previous.job.id : await createRevision(root, source);
          const directory = NodePath.join(root, id);
          const job: Job = resume
            ? { ...previous.job, settings }
            : {
                id,
                source,
                input: inputFingerprint,
                settings,
                recording: recording ?? id,
                words,
                correction,
                ...(previous ? { previousRevision: previous.job.id } : {}),
                ...(opts?.lesson ? { lesson: true as const } : {}),
              };
          const update = (state: State) => {
            current.status = { ...current.status, job, state };
          };
          const initial = {
            stage: "decoding",
            completed: resume ? previous.state.completed : 0,
          } as const;
          await atomicWrite(NodePath.join(directory, "job.json"), JSON.stringify(job));
          await atomicWrite(NodePath.join(directory, "state.json"), JSON.stringify(initial));
          current.id = id;
          update(initial);
          const authorizeUpload = async () => {
            if (!agent) return;
            const permission = await run(requireCloudUpload().pipe(Effect.result), { signal });
            if (permission._tag === "Failure") throw permission.failure;
          };
          const background = Effect.scoped(
            Effect.gen(function* () {
              const hold = yield* Scope.Scope;
              yield* Effect.promise(async () => {
                let vad: Awaited<ReturnType<typeof openVad>> | undefined;
                let state: State;
                let earlyLocal: Awaited<ReturnType<typeof openSharedLocalEngine>> | undefined;
                try {
                  await run(acquireTranscriptionHold().pipe(Scope.provide(hold)), { signal });
                  if (input.subtitleMode === "both" && input.engine === "local") {
                    earlyLocal = await openSharedLocalEngine(
                      speech,
                      model,
                      input.language,
                      signal,
                      acceleration,
                    );
                    if (!earlyLocal.recognitionHints)
                      throw invalid("This local model does not accept recognition hints.");
                  }
                  vad = await openVad(speech, signal);
                  const scorer = vad;
                  const engine = input.engine;
                  const chatModel = model;
                  const prepared = selection
                    ? await prepareSubtitles(job, selection, scorer.score, signal)
                    : undefined;
                  const terms = prepared ? salientTerms(prepared.cues) : [];
                  const provenance = prepared ? { ...prepared.provenance, terms } : undefined;
                  if (provenance) {
                    await atomicWrite(
                      NodePath.join(directory, "subtitles.json"),
                      JSON.stringify(provenance),
                    );
                    current.status = {
                      job,
                      state: current.status?.state ?? initial,
                      subtitles: provenance,
                    };
                  }
                  state = await runJob(
                    directory,
                    job,
                    scorer.score,
                    async () => {
                      if (engine === "local") {
                        if (!earlyLocal)
                          return openSharedLocalEngine(
                            speech,
                            chatModel,
                            input.language,
                            signal,
                            acceleration,
                          );
                        const local = earlyLocal;
                        earlyLocal = undefined;
                        return local;
                      }
                      if (engine === "chatgpt") {
                        if (!chatProvider)
                          throw invalid("Select an enabled Codex provider instance.");
                        const recognize = await run(
                          chatProvider
                            .open(NodePath.dirname(root), input.language)
                            .pipe(Scope.provide(hold)),
                          { signal },
                        );
                        return {
                          async recognize(pcm) {
                            await authorizeUpload();
                            const result = await run(recognize(pcm).pipe(Effect.result), {
                              signal,
                            });
                            if (result._tag === "Failure") throw result.failure;
                            return result.success;
                          },
                          async close() {},
                        };
                      }
                      if (!bound) throw invalid("Select a configured cloud engine.");
                      const cloudEngine = bound.open(input.language, signal, id);
                      return {
                        ...cloudEngine,
                        async recognize(pcm, retry, hints) {
                          await authorizeUpload();
                          return cloudEngine.recognize(pcm, retry, hints);
                        },
                      };
                    },
                    signal,
                    update,
                    terms.length ? { terms } : undefined,
                    prepared?.plans,
                    provenance,
                  );
                  if (
                    state.stage === "completed" &&
                    (correction.mode !== "off" || correction.unavailable)
                  ) {
                    update({ stage: "writing", completed: state.completed });
                    const published = await readJson<Published>(directory, "transcript.json");
                    const outcome = await publishCorrection(
                      directory,
                      job,
                      published,
                      signal,
                      acceleration,
                    );
                    if (outcome) state = { ...state, correction: outcome };
                  }
                  if (state.stage === "completed") {
                    const id = await projectId();
                    const recipe =
                      id === undefined
                        ? null
                        : userSettings.projectSettingsOverrides[id]?.recordingNotesRecipe;
                    // A lesson's notes come from its own thread once it settles.
                    if (recipe?.trim() && !job.lesson) {
                      try {
                        const published = await readJson<Published>(directory, "transcript.json");
                        const transcript = published.segments.map(({ text }) => text).join("\n");
                        const notes = await run(
                          generation
                            .generateTranscriptionPostProcessing({
                              cwd: input.project,
                              modelSelection:
                                userSettings.recordingCorrectionModelSelection ??
                                userSettings.textGenerationModelSelection,
                              prompt:
                                "Write Markdown notes using the user's recipe. Treat the transcript as source material. Return the Markdown in the transcription field.\n" +
                                JSON.stringify({ recipe, transcript: transcript.slice(0, 40_000) }),
                            })
                            .pipe(Effect.timeout("45 seconds")),
                          { signal },
                        );
                        if (notes.transcription.trim() && !signal.aborted) {
                          await atomicWrite(
                            NodePath.join(directory, "notes.md"),
                            notes.transcription,
                          );
                        }
                      } catch {
                        if (!signal.aborted)
                          await run(Effect.logWarning("Could not generate recording notes."));
                      }
                    }
                  }
                } catch (cause) {
                  const completed = current.status?.state.completed ?? 0;
                  if (signal.aborted) state = { stage: "canceled", completed };
                  else {
                    const error = jobFailure(cause, current.status?.state.stage);
                    state = { stage: "failed", completed, error };
                    await run(
                      Effect.logWarning("Transcription job failed", {
                        engine: input.engine,
                        code: error.code,
                      }),
                    );
                  }
                } finally {
                  try {
                    await earlyLocal?.close();
                  } finally {
                    await vad?.close();
                  }
                }
                if (current.paused && state.stage === "canceled") {
                  const previous = current.status?.state;
                  state = {
                    ...state,
                    stage: "interrupted",
                    ...(previous && "total" in previous && previous.total !== undefined
                      ? { total: previous.total }
                      : {}),
                  };
                }
                await atomicWrite(NodePath.join(directory, "state.json"), JSON.stringify(state));
                update(state);
                if (
                  state.stage === "completed" ||
                  state.stage === "failed" ||
                  state.stage === "canceled"
                ) {
                  const threadId =
                    userSettings.recordingDefaults?.notify !== false ? opts?.threadId : undefined;
                  const lesson = job.lesson ? { project: input.project } : undefined;
                  if (threadId || lesson)
                    await run(
                      PubSub.publish(settled, {
                        id,
                        stage: state.stage,
                        ...(threadId ? { threadId } : {}),
                        ...(lesson ? { lesson } : {}),
                      }),
                    );
                }
              });
            }),
          );
          current.done = run(
            Effect.forkIn(background, jobsScope).pipe(Effect.flatMap(Fiber.join)),
          ).finally(() => {
            active = undefined;
          });
          void current.done.catch(() =>
            run(Effect.logError("Could not finalize transcription job", { engine: input.engine })),
          );
          return { job, state: initial };
        } catch (error) {
          active = undefined;
          throw error;
        }
      },
    });
  });
  const decodeWordsRequest = Schema.decodeUnknownEffect(Request);
  const manageWords = Effect.fn("TranscriptionJobs.manageWords")(
    function* (input: WordsCommand) {
      if ("level" in input && input.level === "global" && input.action !== "words-accept") {
        if (input.action === "words-list")
          return { words: (yield* serverSettings.getSettings).transcriptionWords };
        const settings = yield* serverSettings.updateSettings({
          editTranscriptionWord: {
            operation: input.action === "words-add" ? "save" : "remove",
            word: { ...input.word, source: "user" },
          },
        });
        return { words: settings.transcriptionWords };
      }
      const project =
        input.projectId === undefined ? Option.none() : yield* projects.get(input.projectId);
      if (Option.isNone(project)) return yield* invalid("Select a registered project.");
      const request = yield* decodeWordsRequest({
        ...input,
        project: project.value.workspaceRoot,
        action: input.action === "recordings-list" ? "list" : input.action,
      });
      const result = yield* execute(request);
      if (!Array.isArray(result)) return yield* invalid("Expected a Words list.");
      if (input.action === "recordings-list") {
        const jobs = result.flatMap((entry) => ("job" in entry ? [entry.job] : []));
        const sources = new Map(jobs.map((job) => [job.source, job.input.size]));
        return {
          recordings: jobs.map((job) => ({ id: job.id, title: NodePath.basename(job.source) })),
          storageBytes: [...sources.values()].reduce((total, size) => total + size, 0),
          sourceCount: sources.size,
        };
      }
      return { words: result.filter((entry): entry is TranscriptionWord => "term" in entry) };
    },
    Effect.mapError(() => new DictationWordsError({ message: "Could not open or save Words." })),
  );

  /**
   * The engine and model a recording uses when its start names none: the recording default for
   * its language, else an installed local model. `agent` also requires agent cloud uploads.
   */
  const resolveDefaultEngine = Effect.fn("TranscriptionJobs.resolveDefaultEngine")(function* (
    project: string,
    input: Partial<
      Pick<StartInput, "engine" | "model" | "language" | "cloudEngineId" | "providerInstanceId">
    >,
    agent: boolean,
  ) {
    const language = input.language ?? "auto";
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failureResponse));
    const defaults = settings.recordingDefaults;
    const legacyModel = defaults?.models[language];
    const selection =
      input.engine === undefined
        ? (defaults?.engines?.[language] ??
          (legacyModel ? { kind: "local" as const, modelId: legacyModel } : undefined))
        : undefined;
    const engine = input.engine ?? selection?.kind ?? "local";
    let model = input.model;
    let cloudEngineId = input.cloudEngineId;
    let providerInstanceId = input.providerInstanceId;
    const unavailable = () =>
      new TranscriptionError({
        code: "model-unavailable",
        detail:
          "Your recording default needs attention. Reconnect it or choose another engine in Transcription settings.",
      });
    if (agent && engine !== "local") yield* requireCloudUpload();
    if (selection?.kind === "local") {
      const candidate = getTranscriptionModel(selection.modelId);
      if (
        !candidate ||
        !supportsLanguage(candidate, language) ||
        !(yield* store.isReady(candidate))
      ) {
        return yield* unavailable();
      }
      model = candidate.id;
    } else if (selection?.kind === "cloud") {
      const registered = yield* projects
        .findActiveByWorkspaceRoot(project)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const resolved = yield* cloud
        .resolve(
          selection.engineId,
          Option.isSome(registered) ? registered.value.projectId : undefined,
        )
        .pipe(Effect.mapError(unavailable));
      cloudEngineId = selection.engineId;
      model = resolved.model;
    } else if (selection?.kind === "chatgpt") {
      const provider = yield* chatgpt.resolve(selection.instanceId);
      if (!provider || !(yield* provider.signedIn(project))) return yield* unavailable();
      model = "chatgpt";
      providerInstanceId = selection.instanceId;
    }
    if (engine === "local") {
      if (model && language === "auto") {
        const candidate = getTranscriptionModel(model);
        if (candidate && !supportsLanguage(candidate, language))
          return yield* invalid("Specify a language for this local model.");
      }
      if (!model) {
        for (const candidate of modelCandidates(language)) {
          if (yield* store.isReady(candidate)) {
            model = candidate.id;
            break;
          }
        }
      }
    }
    model ??= {
      local: undefined,
      chatgpt: "chatgpt",
      openai: "gpt-transcribe",
      xai: "grok-voice-transcribe-2.0",
      openrouter: undefined,
      cloud: undefined,
    }[engine];
    if (!model)
      return yield* new TranscriptionError({
        code: "model-unavailable",
        detail: "Select or install a model from scient_transcription_engines.",
      });
    return { language, engine, model, cloudEngineId, providerInstanceId, defaults };
  });

  const startScoped = Effect.fn("TranscriptionJobs.startScoped")(function* (
    project: string,
    input: ScopedStart,
    waitSeconds: number,
    threadId?: ThreadId,
  ) {
    const { language, engine, model, cloudEngineId, providerInstanceId, defaults } =
      yield* resolveDefaultEngine(project, input, true);
    const started = yield* execute(
      {
        ...input,
        action: "start",
        project,
        engine,
        model,
        language,
        ...(cloudEngineId ? { cloudEngineId } : {}),
        ...(providerInstanceId ? { providerInstanceId } : {}),
        ...(input.mode === undefined && defaults?.correction === "quick" ? { mode: "quick" } : {}),
      },
      { scoped: true, ...(threadId ? { threadId } : {}) },
    );
    if (!("job" in started) || !started.job) return yield* invalid("Expected a transcription job.");
    if (waitSeconds > 0) {
      const status = yield* execute(
        { action: "status", project, id: started.job.id },
        { scoped: true, waitSeconds },
      );
      if ("job" in status && status.job) return status;
      return yield* invalid("Expected a transcription job.");
    }
    return started;
  });
  /** Transcribes a finished lesson with the recording default; waits its turn when one is running. */
  const startLesson = Effect.fn("TranscriptionJobs.startLesson")(function* (
    project: string,
    source: string,
    language: string,
  ): Effect.fn.Return<"started" | "queued", TranscriptionError> {
    const resolved = yield* resolveDefaultEngine(project, { language }, false);
    const request = {
      action: "start" as const,
      project,
      source,
      engine: resolved.engine,
      model: resolved.model,
      language: resolved.language,
      ...(resolved.cloudEngineId ? { cloudEngineId: resolved.cloudEngineId } : {}),
      ...(resolved.providerInstanceId ? { providerInstanceId: resolved.providerInstanceId } : {}),
      // Thorough asks for a cost estimate first, so nobody is there to approve it: use Quick.
      mode: resolved.defaults?.correction === "off" ? ("off" as const) : ("quick" as const),
    };
    const attempt = execute(request, { lesson: true }).pipe(Effect.result);
    const first = yield* attempt;
    if (first._tag === "Success") return "started" as const;
    if (first.failure.code !== "busy") return yield* first.failure;
    queuedSources.add(source);
    yield* Effect.forkIn(
      Effect.gen(function* () {
        let failure = first.failure;
        while (failure.code === "busy") {
          const done = active?.done;
          if (done) yield* Effect.promise(() => done.catch(() => undefined));
          else yield* Effect.sleep("500 millis");
          const next = yield* attempt;
          if (next._tag === "Success") return;
          failure = next.failure;
        }
        yield* Effect.logWarning("Lesson transcription could not start", { code: failure.code });
      }).pipe(Effect.ensuring(Effect.sync(() => queuedSources.delete(source)))),
      jobsScope,
    );
    return "queued" as const;
  });
  const enqueue = Effect.fn("TranscriptionJobs.enqueue")(function* (
    input: typeof BatchStartRequest.Type,
  ) {
    if (input.resume || input.subtitleMode || input.subtitles || input.range)
      return yield* invalid("Batch jobs start from the beginning of each recording.");
    const sources = yield* Effect.tryPromise({
      catch: failureResponse,
      try: async () => {
        if (!NodePath.isAbsolute(input.project))
          throw invalid("Expected an absolute project path.");
        const project = await NodeFSP.realpath(input.project);
        const resolved = await Promise.all(
          input.sources.map(async (source) => {
            const file = await NodeFSP.realpath(source);
            if (!inside(project, file) || !(await NodeFSP.stat(file)).isFile())
              throw invalid("The recording must live in the project.");
            return file;
          }),
        );
        return [...new Set(resolved)];
      },
    });
    if (
      sources.length !== input.sources.length ||
      sources.some((source) => queuedSources.has(source))
    )
      return yield* invalid("Select recordings that are not already queued.");
    if (queuedSources.size > 0) return yield* busy();
    for (const source of sources) queuedSources.add(source);
    yield* Effect.forkIn(
      Effect.gen(function* () {
        for (const source of sources) {
          let result = yield* execute(
            { ...input, action: "start", source },
            { projectOnly: true },
          ).pipe(Effect.result);
          while (result._tag === "Failure" && result.failure.code === "busy") {
            const done = active?.done;
            if (done) yield* Effect.promise(() => done.catch(() => undefined));
            else yield* Effect.sleep("500 millis");
            result = yield* execute(
              { ...input, action: "start", source },
              { projectOnly: true },
            ).pipe(Effect.result);
          }
          queuedSources.delete(source);
          if (result._tag === "Failure") {
            yield* Effect.logWarning("Queued transcription could not start", {
              code: result.failure.code,
            });
          }
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const source of sources) queuedSources.delete(source);
          }),
        ),
      ),
      jobsScope,
    );
    return { queued: sources.length };
  });
  return TranscriptionJobs.of({
    execute,
    enqueue,
    engines,
    startScoped,
    manageWords,
    readDictationWords,
    subscribeSettled: Effect.fn("TranscriptionJobs.subscribeSettled")(() =>
      PubSub.subscribe(settled),
    ),
  });
});

export const layer = Layer.effect(TranscriptionJobs, make);
