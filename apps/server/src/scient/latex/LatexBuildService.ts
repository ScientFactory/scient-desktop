// @effect-diagnostics nodeBuiltinImport:off -- Build work directories are keyed by a host SHA-256 digest.
/**
 * Coordinates one LaTeX build per logical document. The service owns the only
 * mutable build state on the server: a map keyed by logical document key, one
 * supervised fiber per active build, and the handshake with
 * `GeneratedDocumentStore` that turns a produced PDF into an immutable
 * revision the viewer can render.
 *
 * Six invariants shape the code below:
 *   - A rebuild requested while one is in flight coalesces into a single
 *     follow-up run, so a save-happy editor cannot queue a hundred compiles.
 *   - At most `MAX_CONCURRENT_COMPILES` documents compile at once; the rest
 *     sit in `queued` until a permit frees.
 *   - Aux files never touch the workspace; every engine writes into
 *     `<latexDir>/builds/<digest>/`.
 *   - A build that loses the binding race (`superseded`) reports itself
 *     cancelled and leaves the store alone; only the newest generation may
 *     record a failure.
 *   - Only a run that exited clean publishes. An error-carrying run fails and
 *     the last PDF that did compile stays visible, marked stale.
 *   - A PDF is only reported `succeeded` while the files it was built from
 *     still hash to what they hashed then; see `latexBuildEvidence.ts`.
 */
import * as NodeCrypto from "node:crypto";

import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
  type PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { ExecutionRunId, type ExecutionProcessHandle } from "@scientfactory/execution";
import type {
  ScientLatexBuildSnapshot,
  ScientLatexBuildState,
  ScientLatexDiagnostic,
  ScientLatexToolchainStatus,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";
import {
  GeneratedDocumentStore,
  type GeneratedDocumentProductionHandle,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { LatexPackageInstaller } from "./LatexPackageInstaller.ts";
import { LatexToolchain } from "./LatexToolchain.ts";
import { LatexSyncTex } from "./LatexSyncTex.ts";
import { parseLatexRecorderManifest } from "./flsManifest.ts";
import {
  EMPTY_EVIDENCE_MARKS,
  collectLatexBuildEvidence,
  decodeLatexBuildEvidence,
  encodeLatexBuildEvidence,
  latexEvidenceMatches,
  probeLatexEvidence,
  type LatexBuildEvidence,
  type LatexEvidenceMarks,
} from "./latexBuildEvidence.ts";
import { buildLatexInvocation, latexEngineEnvironment } from "./latexCommand.ts";
import { evaluateLatexEngineGate } from "./latexEngineGate.ts";
import { parseLatexLog, summarizeLatexFailure, transcriptFailureDiagnostic } from "./latexLog.ts";
import { missingLatexPackageInputs } from "./latexMissingPackages.ts";
import { latexPreambleIncludes, latexPreamblePackages } from "./latexPreamble.ts";
import { resolveLatexRoot } from "./latexRoot.ts";

export interface LatexBuildInput {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}

export class LatexBuildError extends Schema.TaggedErrorClass<LatexBuildError>()("LatexBuildError", {
  operation: Schema.Literals(["build", "status", "cancel"]),
  reason: Schema.Literals(["invalid-path", "document-key-too-long"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class LatexBuildService extends Context.Service<
  LatexBuildService,
  {
    readonly requestBuild: (
      input: LatexBuildInput,
    ) => Effect.Effect<ScientLatexBuildSnapshot, LatexBuildError>;
    readonly status: (
      input: LatexBuildInput,
    ) => Effect.Effect<ScientLatexBuildSnapshot, LatexBuildError>;
    readonly cancel: (
      input: LatexBuildInput,
    ) => Effect.Effect<ScientLatexBuildSnapshot, LatexBuildError>;
  }
>()("t3/scient/latex/LatexBuildService") {}

const LATEX_PRODUCER_ID = ArtifactProducerId.make("latex");
const BUILD_TIMEOUT = "240 seconds";
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** The banner and the engine's own summary of the run live at the very top. */
const TRANSCRIPT_HEAD_BYTES = 2 * 1024;
const MAX_LOGICAL_DOCUMENT_KEY_LENGTH = 1_024;
/**
 * Root resolution never needs more than the head of a file: the magic-comment
 * scan stops at 4 000 characters and `\documentclass` sits in the preamble, so
 * a status poll on a multi-megabyte source reads one block instead of all of it.
 */
const ROOT_RESOLUTION_HEAD_BYTES = 8 * 1_024;
/**
 * How much of the root document the upfront package scan reads. A preamble is
 * the first page or two of a file, but a document that defines its own macros
 * before the last `\usepackage` can push one a long way down, and this read is
 * paid once per build rather than per poll.
 */
const PREAMBLE_SCAN_HEAD_BYTES = 64 * 1_024;
/**
 * And of each file the root pulls in. A chapter's own `\usepackage` lines sit
 * at its top or not at all, and there are up to eight of these reads.
 */
const INCLUDED_PREAMBLE_SCAN_HEAD_BYTES = 16 * 1_024;
/** Across the root and everything it pulls in, after deduplication. */
const MAX_PREAMBLE_PACKAGES_PER_BUILD = 40;
/** A compile is CPU- and disk-bound; three at once keeps a laptop usable. */
const MAX_CONCURRENT_COMPILES = 3;
/**
 * How many times one build may fetch packages and compile again.
 *
 * A compile reveals exactly one missing package, however many the document
 * needs: LaTeX takes an emergency stop at the first input it cannot find, and
 * `nonstopmode` does not change that. So a paper whose preamble wants five
 * packages the distribution does not have needs five rounds, and a low ceiling
 * is not a safety rail — it is a document that can never build. This bound is
 * therefore set well above a real preamble and is not what ends the loop: a
 * round that places nothing new ends it, and the per-build `attempted` set
 * keeps a package no repository has from being asked for twice.
 */
const MAX_PACKAGE_RESOLUTION_ROUNDS = 15;

/**
 * TeX wraps its own messages at 79 columns by default, which cuts file paths
 * and error text in half before the parser ever sees them. These are the
 * documented `texmf.cnf` knobs for that, and every engine reads them from the
 * environment.
 */
const TEX_OUTPUT_ENVIRONMENT: Readonly<Record<string, string>> = {
  max_print_line: "1000",
  error_line: "254",
  half_error_line: "238",
};

const NO_TOOLCHAIN_SUMMARY =
  "No LaTeX toolchain found. Install latexmk (TeX Live or MiKTeX) or tectonic, then try again.";
const TIMEOUT_SUMMARY = "Build timed out.";
const CANCELLED_SUMMARY = "Build cancelled.";
const MISSING_PDF_SUMMARY = "The LaTeX engine reported success but produced no PDF.";
const UNEXPECTED_FAILURE_SUMMARY = "The LaTeX build could not be completed.";

const ACTIVE_STATES: ReadonlySet<ScientLatexBuildState> = new Set([
  "queued",
  "running",
  "publishing",
]);

/**
 * What a build says about a package it cannot install itself. A TeX Live or
 * MiKTeX installation is the user's own, so Scient names the package and the
 * command that places it rather than reaching into an installation it does not
 * own. The engine's own error stays alongside this.
 */
function missingPackageDiagnostic(packageName: string): ScientLatexDiagnostic {
  return {
    severity: "error",
    file: null,
    line: null,
    message: `Missing LaTeX package '${packageName}'. Install it with your TeX distribution (tlmgr install ${packageName}, or the MiKTeX Console), then rebuild.`,
  };
}

/**
 * What a build says when its own distribution could not supply a package: the
 * machine was offline, the repository has moved on from what this frozen TeX
 * Live knows, or the name is the author's own file and no repository ever had
 * it. The engine's error stays alongside this, because it is the one that says
 * where in the document the name came from.
 */
function unresolvedPackageDiagnostic(packageName: string): ScientLatexDiagnostic {
  return {
    severity: "error",
    file: null,
    line: null,
    message: `Scient tried to install '${packageName}' automatically and could not. If this is your own file, check its path; otherwise retry when online.`,
  };
}

/**
 * A failed build always says why.
 *
 * Every terminal failure below goes through here, because the one thing a
 * reader cannot act on is a build that reports nothing. The gap this closes is
 * real and was reachable in production: `latexmk` declining to redo a target it
 * had already failed prints only its own prose, `parseLatexLog` finds no
 * `file:line:` in it and returns nothing, and the build then recorded an empty
 * diagnostics list under `summarizeLatexFailure`'s bare fallback — the reader
 * was told "LaTeX build failed." and given nothing else, on a run that had
 * plenty to say.
 */
function withFailureReason(
  diagnostics: ReadonlyArray<ScientLatexDiagnostic>,
  reason: string | (() => ScientLatexDiagnostic),
): ReadonlyArray<ScientLatexDiagnostic> {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return diagnostics;
  return [
    ...diagnostics,
    typeof reason === "string"
      ? { severity: "error" as const, file: null, line: null, message: reason }
      : reason(),
  ];
}

interface LatexBuildEntry {
  readonly logicalDocumentKey: string;
  /**
   * Which build this entry belongs to. `requestBuild` stamps a fresh number
   * every time it replaces the entry, so a fiber that wakes up after its own
   * build was cancelled and rebuilt can tell that it no longer speaks here.
   */
  readonly generation: number;
  /** Absolute, resolved workspace root; every path a client sees is relative to it. */
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
  readonly state: ScientLatexBuildState;
  readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
  readonly descriptor: PdfSourceDescriptor | null;
  readonly failureSummary: string | null;
  readonly startedAtEpochMs: number | null;
  readonly finishedAtEpochMs: number | null;
  readonly pendingRerun: boolean;
  readonly cancelRequested: boolean;
  /** Non-null only while this build is fetching packages the compile asked for. */
  readonly installingPackages: ReadonlyArray<string> | null;
  /** Live only while a build owns the binding; cleared on every terminal state. */
  readonly production: GeneratedDocumentProductionHandle | null;
  readonly handle: ExecutionProcessHandle | null;
}

/**
 * One document's build-input evidence as this process holds it, plus the stat
 * memory that keeps re-checking it cheap. `evidence: null` is a real answer —
 * "this document has none on disk" — cached so a poll does not re-read a file
 * that is not there.
 */
interface LatexEvidenceCacheEntry {
  readonly evidence: LatexBuildEvidence | null;
  readonly marks: LatexEvidenceMarks;
}

interface ResolvedLatexTarget {
  readonly logicalDocumentKey: string;
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
  /** Non-null when the requested source could not be read; no build is possible. */
  readonly failureSummary: string | null;
}

interface LatexPreambleHeads {
  readonly rootText: string;
  readonly includedTexts: ReadonlyArray<string>;
}

/**
 * The transcript is bounded but the interesting part is at the end: the final
 * error, the rerun decision, and `Output written on …` all arrive last. The
 * state therefore keeps a short head (the engine banner) plus the newest bytes
 * that fit, and drops the middle.
 */
interface TranscriptState {
  readonly head: string;
  readonly headBytes: number;
  /** Oldest first; whole chunks fall off the front as newer ones arrive. */
  readonly tail: ReadonlyArray<TranscriptChunk>;
  readonly tailBytes: number;
  readonly dropped: boolean;
}

interface TranscriptChunk {
  readonly text: string;
  readonly bytes: number;
}

export const emptyTranscript: TranscriptState = {
  head: "",
  headBytes: 0,
  tail: [],
  tailBytes: 0,
  dropped: false,
};

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

/** Stable across separator and trailing-slash differences so one document keeps one key. */
function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const posix = toPosixPath(workspaceRoot);
  return posix.length > 1 ? posix.replace(/\/+$/u, "") : posix;
}

/** `/etc/passwd`, `C:/other/x.tex` — what `path.relative` returns when it cannot stay relative. */
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:)/u;

/**
 * Containment guard for a path already made relative to the workspace root and
 * normalized to forward slashes. `..` walks are the obvious escape; the absolute
 * form is the quiet one, because `path.relative` gives up and returns an
 * absolute path whenever the two sides sit on different Windows drives — which
 * is exactly what a drive-relative request like `C:evil\x.tex` produces.
 */
export function escapesWorkspaceRoot(relativePath: string): boolean {
  return (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    ABSOLUTE_PATH_PATTERN.test(relativePath)
  );
}

function workDirectoryName(logicalDocumentKey: string): string {
  return NodeCrypto.createHash("sha256").update(logicalDocumentKey).digest("hex").slice(0, 16);
}

function documentTitle(rootRelativePath: string): string {
  const baseName = rootRelativePath.split("/").at(-1) ?? rootRelativePath;
  return baseName.replace(/\.\w+$/u, "") || baseName;
}

/** Splits on a codepoint boundary at or before `maxBytes` so neither side gains a replacement character. */
function splitAtBytes(text: string, maxBytes: number): readonly [string, string] {
  if (maxBytes <= 0) return ["", text];
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return [text, ""];
  let cut = maxBytes;
  while (cut > 0 && ((buffer[cut] ?? 0) & 0b1100_0000) === 0b1000_0000) cut -= 1;
  return [buffer.toString("utf8", 0, cut), buffer.toString("utf8", cut)];
}

const TRANSCRIPT_TAIL_BYTES = MAX_TRANSCRIPT_BYTES - TRANSCRIPT_HEAD_BYTES;
const TRANSCRIPT_TRUNCATION_MARKER = "\n[transcript truncated]\n";

export function appendBoundedTranscript(state: TranscriptState, text: string): TranscriptState {
  const [headPart, overflow] = splitAtBytes(text, TRANSCRIPT_HEAD_BYTES - state.headBytes);
  const head = state.head + headPart;
  const headBytes = state.headBytes + Buffer.byteLength(headPart);
  if (overflow.length === 0) return { ...state, head, headBytes };

  const tail = [...state.tail, { text: overflow, bytes: Buffer.byteLength(overflow) }];
  let tailBytes = state.tailBytes + Buffer.byteLength(overflow);
  let dropped = state.dropped;
  while (tailBytes > TRANSCRIPT_TAIL_BYTES && tail.length > 0) {
    const oldest = tail[0];
    if (oldest === undefined) break;
    dropped = true;
    const excess = tailBytes - TRANSCRIPT_TAIL_BYTES;
    if (oldest.bytes <= excess) {
      tail.shift();
      tailBytes -= oldest.bytes;
      continue;
    }
    const [discarded, kept] = splitAtBytes(oldest.text, excess);
    const discardedBytes = Buffer.byteLength(discarded);
    // Snapping to a codepoint boundary can leave the last few bytes in place;
    // stop rather than spin, a handful of bytes over a four-megabyte budget.
    if (discardedBytes === 0) break;
    tail[0] = { text: kept, bytes: oldest.bytes - discardedBytes };
    tailBytes -= discardedBytes;
  }
  return { head, headBytes, tail, tailBytes, dropped };
}

/** Head, a marker where the middle was dropped, then the newest output. */
export function renderTranscript(state: TranscriptState): string {
  const tail = state.tail.map((chunk) => chunk.text).join("");
  return state.dropped ? `${state.head}${TRANSCRIPT_TRUNCATION_MARKER}${tail}` : state.head + tail;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* GeneratedDocumentStore;
  const toolchainProbe = yield* LatexToolchain;
  const syncTex = yield* LatexSyncTex;
  const packageInstaller = yield* LatexPackageInstaller;
  const processes = yield* LocalExecutionProcess.ExecutionProcess;
  const hostEnvironment = yield* HostProcessEnvironment;
  const pathDelimiter = (yield* HostProcessPlatform) === "win32" ? ";" : ":";
  const entriesRef = yield* Ref.make(new Map<string, LatexBuildEntry>());
  const evidenceRef = yield* Ref.make(new Map<string, LatexEvidenceCacheEntry>());
  // Monotonic across the process; only `requestBuild` hands one out.
  const generationRef = yield* Ref.make(0);
  // Build fibers outlive the request that started them, so they are supervised
  // by the service instead of a request scope.
  const buildScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(buildScope, Exit.void));
  // Admission control for the compile itself. A fiber holds no permit while it
  // waits, which is what keeps the `queued` state honest.
  const admission = yield* Semaphore.make(MAX_CONCURRENT_COMPILES);

  /** Reads only the head of a source file; never the whole of a large one. */
  const readSourceHead = (absolutePath: string, maxBytes: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(absolutePath, { flag: "r" });
        const chunk = yield* file.readAlloc(maxBytes);
        return Option.isNone(chunk) ? "" : new TextDecoder().decode(chunk.value);
      }),
    );

  /**
   * TeX resolves `\input` against its working directory, so a build compiles
   * from the root document's folder and every printed path is relative to that
   * folder. Clients only understand workspace-relative paths, so rebase them
   * here. A path that lands outside the workspace keeps its message and loses
   * its file, because no client could open it anyway.
   */
  const rebaseDiagnostics = (input: {
    readonly workspaceRoot: string;
    readonly compileDirectory: string;
    readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
  }): ReadonlyArray<ScientLatexDiagnostic> =>
    input.diagnostics.map((diagnostic) => {
      if (diagnostic.file === null) return diagnostic;
      const relative = toPosixPath(
        path.relative(input.workspaceRoot, path.resolve(input.compileDirectory, diagnostic.file)),
      );
      return { ...diagnostic, file: escapesWorkspaceRoot(relative) ? null : relative };
    });

  const getEntry = (key: string) =>
    Ref.get(entriesRef).pipe(Effect.map((entries) => entries.get(key) ?? null));

  const updateEntryWhen = (
    key: string,
    matches: (entry: LatexBuildEntry) => boolean,
    update: (entry: LatexBuildEntry) => LatexBuildEntry,
  ) =>
    Ref.update(entriesRef, (entries) => {
      const current = entries.get(key);
      if (current === undefined || !matches(current)) return entries;
      const next = new Map(entries);
      next.set(key, update(current));
      return next;
    });

  const updateEntry = (key: string, update: (entry: LatexBuildEntry) => LatexBuildEntry) =>
    updateEntryWhen(key, () => true, update);

  /**
   * The write a build fiber is allowed to make: only while the entry is still
   * the one that fiber was started for. A fiber parked in a package fetch can
   * wake after a cancel and a fresh `requestBuild` have replaced the entry
   * underneath it, and without this it would stamp its own state and process
   * handle over the live build's.
   */
  const updateOwnEntry = (
    key: string,
    generation: number,
    update: (entry: LatexBuildEntry) => LatexBuildEntry,
  ) => updateEntryWhen(key, (entry) => entry.generation === generation, update);

  /** True once this build may no longer speak for the entry: cancelled, or replaced. */
  const isSuperseded = (key: string, generation: number) =>
    getEntry(key).pipe(
      Effect.map(
        (entry) => entry === null || entry.generation !== generation || entry.cancelRequested,
      ),
    );

  const snapshotOf = (
    entry: LatexBuildEntry,
    toolchain: ScientLatexToolchainStatus,
  ): ScientLatexBuildSnapshot => ({
    logicalDocumentKey: entry.logicalDocumentKey,
    rootRelativePath: entry.rootRelativePath,
    state: entry.state,
    diagnostics: entry.diagnostics,
    descriptor: entry.descriptor,
    failureSummary: entry.failureSummary,
    startedAtEpochMs: entry.startedAtEpochMs,
    finishedAtEpochMs: entry.finishedAtEpochMs,
    toolchain,
    pendingRerun: entry.pendingRerun,
    // Absent unless a fetch is running, so an ordinary poll carries nothing new.
    ...(entry.installingPackages === null ? {} : { installingPackages: entry.installingPackages }),
  });

  const withToolchain = (entry: LatexBuildEntry) =>
    toolchainProbe.probe(false).pipe(Effect.map((toolchain) => snapshotOf(entry, toolchain)));

  const readEntrySnapshot = (key: string) =>
    getEntry(key).pipe(
      Effect.flatMap((entry) =>
        entry === null ? Effect.die(`latex build entry disappeared: ${key}`) : withToolchain(entry),
      ),
    );

  /** Terminal transition; always clears the process handle and binding handle. */
  const finishBuild = (
    key: string,
    generation: number,
    update: (entry: LatexBuildEntry) => LatexBuildEntry,
  ) =>
    Effect.gen(function* () {
      const finishedAtEpochMs = yield* Clock.currentTimeMillis;
      yield* updateOwnEntry(key, generation, (entry) => ({
        ...update(entry),
        finishedAtEpochMs,
        production: null,
        handle: null,
        installingPackages: null,
      }));
    });

  const recordStoreFailure = (production: GeneratedDocumentProductionHandle, reason: string) =>
    store.failProduction({ ...production, reason }).pipe(
      Effect.asVoid,
      // `superseded` means a newer build already owns the binding, which is the
      // expected outcome of a rebuild racing its predecessor.
      Effect.catch((error) =>
        error.reason === "superseded"
          ? Effect.void
          : Effect.logWarning("latex build failure could not be recorded", { error }),
      ),
    );

  /**
   * Releases a production without discrediting the sources it was reading.
   *
   * The distinction from `recordStoreFailure` is the whole point: failing a
   * production stales whatever PDF is currently published, and staling is a
   * statement about the sources — "what you are looking at no longer matches
   * them". A cancel, a supersession, and an infrastructure error are none of
   * them that, so they end here instead. Idempotent in the store, so any
   * number of paths may run it for the same handle.
   */
  const recordStoreAbandon = (production: GeneratedDocumentProductionHandle, reason: string) =>
    store.abandonProduction({ ...production, reason }).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("latex build production could not be released", { error }),
      ),
    );

  const recordFailure = (input: {
    readonly key: string;
    readonly generation: number;
    readonly production: GeneratedDocumentProductionHandle;
    readonly summary: string;
    readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
  }) =>
    Effect.gen(function* () {
      yield* recordStoreFailure(input.production, input.summary);
      // Re-read the binding so the snapshot carries the stale status the store
      // just recorded instead of the status the descriptor had while current.
      const descriptor = yield* store
        .getDescriptor(LogicalDocumentKey.make(input.key))
        .pipe(Effect.orElseSucceed(() => null));
      // Last line of defence for the invariant: whatever else a caller passed,
      // the summary itself is a reason and belongs in the list.
      const diagnostics = withFailureReason(input.diagnostics, input.summary);
      yield* finishBuild(input.key, input.generation, (entry) => ({
        ...entry,
        state: "failed",
        failureSummary: input.summary,
        diagnostics,
        descriptor: descriptor ?? entry.descriptor,
      }));
    });

  const runProcess = (input: {
    readonly key: string;
    readonly generation: number;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* processes.start({
          runId: ExecutionRunId.make(NodeCrypto.randomUUID()),
          executable: input.command,
          args: input.args,
          cwd: input.cwd,
          environment: input.environment,
        });
        yield* updateOwnEntry(input.key, input.generation, (entry) => ({ ...entry, handle }));
        // A cancel that raced the spawn still has to reach this process tree.
        if (yield* isSuperseded(input.key, input.generation)) {
          yield* handle.cancel.pipe(Effect.ignoreCause());
        }
        const transcriptRef = yield* Ref.make<TranscriptState>(emptyTranscript);
        const outputFiber = yield* handle.output.pipe(
          Stream.runForEach((chunk) =>
            Ref.update(transcriptRef, (state) => appendBoundedTranscript(state, chunk.text)),
          ),
          Effect.catchCause((cause) =>
            Effect.logDebug("latex build output stream ended early", { cause }),
          ),
          Effect.forkScoped,
        );
        const exitCode = yield* handle.exitCode.pipe(Effect.timeoutOption(BUILD_TIMEOUT));
        // The port's cancel is a tree kill, so a wedged engine cannot outlive us.
        if (Option.isNone(exitCode)) yield* handle.cancel.pipe(Effect.ignoreCause());
        yield* Fiber.join(outputFiber).pipe(Effect.ignoreCause());
        const transcript = yield* Ref.get(transcriptRef);
        return {
          exitCode: Option.isNone(exitCode) ? null : exitCode.value,
          transcript: renderTranscript(transcript),
        };
      }),
    );

  const publish = (input: {
    readonly key: string;
    readonly generation: number;
    readonly production: GeneratedDocumentProductionHandle;
    readonly pdfPath: string;
    readonly syncTexPath: string;
    readonly workspaceRoot: string;
    readonly rootRelativePath: string;
    readonly compileDirectory: string;
    readonly toolchainExecutable: string;
    readonly managedToolchain: boolean;
    readonly title: string;
    readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
  }) =>
    Effect.gen(function* () {
      const bytes = yield* fileSystem.readFile(input.pdfPath);
      yield* updateOwnEntry(input.key, input.generation, (entry) => ({
        ...entry,
        state: "publishing",
      }));
      yield* store
        .publishPdf({
          ...input.production,
          bytes,
          title: input.title,
          provenanceKind: "document-build",
        })
        .pipe(
          Effect.flatMap((descriptor) =>
            Effect.gen(function* () {
              if (descriptor._tag !== "generated-pdf") {
                return yield* Effect.die("LaTeX publication returned a non-generated PDF");
              }
              // The index is auxiliary: persist it before the terminal build
              // state becomes visible, but never discredit an otherwise valid
              // PDF if navigation data was absent or could not be retained.
              yield* syncTex
                .publishIndex({
                  artifactId: descriptor.artifactId,
                  revisionId: descriptor.revisionId,
                  workspaceRoot: input.workspaceRoot,
                  rootRelativePath: input.rootRelativePath,
                  compileDirectory: input.compileDirectory,
                  syncTexPath: input.syncTexPath,
                  toolchainExecutable: input.toolchainExecutable,
                  managed: input.managedToolchain,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("latex synctex index could not be persisted", {
                      logicalDocumentKey: input.key,
                      cause,
                    }),
                  ),
                );
              yield* finishBuild(input.key, input.generation, (entry) => ({
                ...entry,
                state: "succeeded",
                descriptor,
                // Warnings survive a successful build; they are the point of the log.
                diagnostics: input.diagnostics,
                failureSummary: null,
              }));
            }),
          ),
          Effect.catch((error) => {
            if (error.reason === "superseded") {
              // A newer build owns the binding. Report cancelled and leave the
              // store untouched so the winner's own outcome stands.
              return finishBuild(input.key, input.generation, (entry) => ({
                ...entry,
                state: "cancelled",
                diagnostics: input.diagnostics,
              }));
            }
            if (error.reason === "validation-rejected") {
              // The store already recorded this failure while rejecting the PDF.
              return finishBuild(input.key, input.generation, (entry) => ({
                ...entry,
                state: "failed",
                failureSummary: error.detail,
                diagnostics: withFailureReason(input.diagnostics, error.detail),
              }));
            }
            return recordFailure({
              key: input.key,
              generation: input.generation,
              production: input.production,
              summary: error.detail,
              diagnostics: input.diagnostics,
            });
          }),
        );
    });

  /**
   * Fetches what the last compile said it was missing, with the snapshot saying
   * so while it runs. The state stays `running`, so a client polls exactly as
   * it already does. Answers whether anything new landed, which is the only
   * reason to compile again.
   */
  const installMissingPackages = (input: {
    readonly key: string;
    readonly generation: number;
    readonly packages: ReadonlyArray<string>;
    /** What each package was fetched for; the installer holds the fetch to these. */
    readonly files: ReadonlyArray<string>;
    readonly binDirectory: string;
  }) =>
    Effect.gen(function* () {
      yield* updateOwnEntry(input.key, input.generation, (entry) => ({
        ...entry,
        installingPackages: input.packages,
      }));
      const outcome = yield* packageInstaller.install({
        packages: input.packages,
        binDirectory: input.binDirectory,
        expectedFiles: input.files,
      });
      yield* updateOwnEntry(input.key, input.generation, (entry) => ({
        ...entry,
        installingPackages: null,
      }));
      if (outcome.failed.length > 0) {
        yield* Effect.logDebug("latex packages could not be installed", {
          logicalDocumentKey: input.key,
          packages: outcome.failed,
        });
      }
      return outcome.installed.length > 0;
    });

  /**
   * Everything the document says it needs that this distribution does not
   * already have, read before the first compile.
   *
   * The reactive resolver can only ever learn one name per compile, because
   * LaTeX stops at the first input it cannot find. A first build of an
   * ordinary paper against a fresh TinyTeX therefore spends a compile and a
   * `tlmgr` run per package — minutes of a progress strip naming one package
   * at a time — for information that was sitting in the preamble the whole
   * time. This reads it: the root's own `\usepackage`/`\RequirePackage` names
   * plus those of the files it pulls in one level down, dropped to the ones
   * `kpsewhich` cannot already find, so a distribution that has them pays a
   * few probes and no fetch. The reactive loop still runs afterwards, for the
   * packages a package pulls in.
   */
  const readPreambleHeads = (rootAbsolutePath: string) =>
    Effect.gen(function* () {
      const rootText = yield* readSourceHead(rootAbsolutePath, PREAMBLE_SCAN_HEAD_BYTES).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (rootText === null) return null;
      const includedTexts: string[] = [];
      const rootDirectory = path.dirname(rootAbsolutePath);
      for (const include of latexPreambleIncludes(rootText)) {
        const includedText = yield* readSourceHead(
          path.resolve(rootDirectory, include),
          INCLUDED_PREAMBLE_SCAN_HEAD_BYTES,
        ).pipe(Effect.orElseSucceed(() => null));
        if (includedText !== null) includedTexts.push(includedText);
      }
      return { rootText, includedTexts } satisfies LatexPreambleHeads;
    });

  const preamblePackagesToFetch = (input: {
    readonly preamble: LatexPreambleHeads;
    readonly binDirectory: string;
  }) =>
    Effect.gen(function* () {
      const names = [
        ...latexPreamblePackages(input.preamble.rootText),
        ...input.preamble.includedTexts.flatMap((text) => latexPreamblePackages(text)),
      ];
      // Nine files' worth of preambles is more names than any real document
      // has; the cap is what stops a generated one becoming a giant argv.
      const requested = [...new Set(names)].slice(0, MAX_PREAMBLE_PACKAGES_PER_BUILD);
      if (requested.length === 0) return [];
      const unresolved = new Set(
        (yield* packageInstaller.unresolvedFiles({
          files: requested.map((name) => `${name}.sty`),
          binDirectory: input.binDirectory,
        })).map((fileName) => fileName.toLowerCase()),
      );
      return requested.filter((name) => unresolved.has(`${name.toLowerCase()}.sty`));
    });

  /**
   * The evidence modules ask for the platform services by name so their own
   * tests can drive them directly; the service already holds both, and its
   * public methods declare no requirements, so they are handed over here.
   */
  const withPlatform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  /** Beside the build work directory, keyed the same way, one file per document. */
  const evidenceFilePath = (key: string) =>
    path.join(config.latexDir, "evidence", `${workDirectoryName(key)}.json`);

  const loadEvidence = (key: string) =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(evidenceRef).pipe(Effect.map((all) => all.get(key)));
      if (cached !== undefined) return cached;
      const source = yield* fileSystem
        .readFileString(evidenceFilePath(key))
        .pipe(Effect.orElseSucceed(() => null));
      const entry: LatexEvidenceCacheEntry = {
        evidence: source === null ? null : decodeLatexBuildEvidence(source),
        marks: EMPTY_EVIDENCE_MARKS,
      };
      yield* Ref.update(evidenceRef, (all) => new Map(all).set(key, entry));
      return entry;
    });

  /**
   * What the document itself says it reads, for an engine that keeps no
   * recorder: the root plus the files it `\input`s or `\include`s one level
   * down. Narrower than a recorder manifest — no `.bib`, no image, nothing a
   * package pulled in — and honest about being narrower, because the root is
   * still the file most edits land in.
   */
  const preambleDependencies = (input: {
    readonly workspaceRoot: string;
    readonly rootRelativePath: string;
    readonly rootAbsolutePath: string;
  }) =>
    Effect.gen(function* () {
      const head = yield* readSourceHead(input.rootAbsolutePath, PREAMBLE_SCAN_HEAD_BYTES).pipe(
        Effect.orElseSucceed(() => ""),
      );
      const rootDirectory = path.dirname(input.rootAbsolutePath);
      const dependencies: string[] = [];
      for (const include of latexPreambleIncludes(head)) {
        const relative = toPosixPath(
          path.relative(input.workspaceRoot, path.resolve(rootDirectory, include)),
        );
        if (!escapesWorkspaceRoot(relative)) dependencies.push(relative);
      }
      return dependencies;
    });

  /**
   * Reads what this compile was built from, between the engine's exit and the
   * publish that makes its PDF the document.
   *
   * The ordering is the point. A status poll that lands after the entry says
   * `succeeded` and before the evidence exists would find a published PDF with
   * nothing behind it, conclude it cannot be vouched for, and start a rebuild —
   * on every build of every document, forever. So the evidence is in place
   * before the state that would be checked against it, and the compile's own
   * inputs are read the moment the compile stops rather than after a round trip
   * through the artifact store.
   */
  const collectBuildEvidence = (input: {
    readonly key: string;
    readonly workspaceRoot: string;
    readonly rootRelativePath: string;
    readonly rootAbsolutePath: string;
    readonly compileDirectory: string;
    readonly workDirectory: string;
    readonly recorderManifestPath: string | null;
  }) =>
    Effect.gen(function* () {
      const manifest =
        input.recorderManifestPath === null
          ? null
          : yield* fileSystem.readFileString(input.recorderManifestPath).pipe(
              Effect.map((contents) =>
                parseLatexRecorderManifest({
                  contents,
                  workspaceRoot: input.workspaceRoot,
                  compileDirectory: input.compileDirectory,
                  workDirectory: input.workDirectory,
                }),
              ),
              Effect.orElseSucceed(() => null),
            );
      // No recorder output at all — tectonic, or a `.fls` this run did not
      // write — leaves the preamble scan, which is what there is.
      const dependencies =
        manifest === null
          ? yield* preambleDependencies({
              workspaceRoot: input.workspaceRoot,
              rootRelativePath: input.rootRelativePath,
              rootAbsolutePath: input.rootAbsolutePath,
            })
          : manifest.dependencies;
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const collected = yield* withPlatform(
        collectLatexBuildEvidence({
          workspaceRoot: input.workspaceRoot,
          rootRelativePath: input.rootRelativePath,
          dependencies,
          truncated: manifest?.truncated ?? false,
          nowEpochMs,
        }),
      );
      yield* Ref.update(evidenceRef, (all) =>
        new Map(all).set(input.key, { evidence: collected.evidence, marks: collected.marks }),
      );
      return collected.evidence;
    });

  /**
   * Puts the evidence where the next process start will find it, once the
   * publish it belongs to has actually stood. Best-effort: a state directory
   * that cannot be written costs a re-check after restart and nothing else,
   * because the in-memory copy is already in place.
   */
  const persistBuildEvidence = (input: {
    readonly key: string;
    readonly generation: number;
    readonly evidence: LatexBuildEvidence;
  }) =>
    Effect.gen(function* () {
      const settled = yield* getEntry(input.key);
      // A publish that lost the binding race, or a build already replaced, has
      // nothing to say about what the document currently shows.
      if (settled === null || settled.generation !== input.generation) return;
      // The narrow window this accepts: a cancel landing after `publish` won
      // the binding settles the entry `cancelled`, and abandoning the
      // production leaves that fresh revision current at its new generation.
      // So the binding is right, the PDF is right, and the evidence for it is
      // never written — the document earns one spurious rebuild the first time
      // it is polled after a restart, and that rebuild records the evidence.
      // One extra compile in a race a reader caused deliberately is a better
      // trade than persisting evidence for an entry that did not settle
      // `succeeded`, which would risk vouching for a PDF that never published.
      if (settled.state !== "succeeded") return;
      yield* writeFileStringAtomically({
        filePath: evidenceFilePath(input.key),
        contents: `${encodeLatexBuildEvidence(input.evidence)}\n`,
      }).pipe(
        withPlatform,
        Effect.catchCause((cause) =>
          Effect.logDebug("latex build evidence could not be persisted", {
            logicalDocumentKey: input.key,
            cause,
          }),
        ),
      );
    });

  /**
   * Whether the PDF this document currently shows was built from what is on
   * disk now. `false` also covers "there is no evidence": a binding written
   * before this check existed, or one whose evidence file was lost, is not a
   * PDF anyone can vouch for, so it earns exactly one rebuild — after which
   * there is evidence and this answers on facts.
   */
  const evidenceIsCurrent = (target: ResolvedLatexTarget) =>
    Effect.gen(function* () {
      const cached = yield* loadEvidence(target.logicalDocumentKey);
      if (cached.evidence === null) return false;
      const probe = yield* withPlatform(
        probeLatexEvidence({
          workspaceRoot: target.workspaceRoot,
          evidence: cached.evidence,
          marks: cached.marks,
        }),
      );
      yield* Ref.update(evidenceRef, (all) =>
        new Map(all).set(target.logicalDocumentKey, {
          evidence: cached.evidence,
          marks: probe.marks,
        }),
      );
      if (!probe.changed) return true;
      // The probe is a fast path — one `stat` per dependency and a hash only
      // where that leaves the question open — and it is the only thing standing
      // between a status poll and a full compile. Before spending one, re-read
      // the identity of every dependency the slow way and check that the two
      // agree. When they do not, the probe was wrong about this poll, and
      // rebuilding would not change what the next poll sees: the same
      // disagreement, the same rebuild, once every 1.5 seconds for as long as
      // whatever caused it lasts. This one comparison is what bounds that at a
      // single rebuild.
      const recollected = yield* withPlatform(
        collectLatexBuildEvidence({
          workspaceRoot: target.workspaceRoot,
          rootRelativePath: cached.evidence.rootRelativePath,
          dependencies: cached.evidence.dependencies.map((dependency) => dependency.path),
          truncated: cached.evidence.truncated,
          nowEpochMs: cached.evidence.recordedAtEpochMs,
        }),
      );
      if (latexEvidenceMatches(recollected.evidence, cached.evidence)) {
        yield* Effect.logDebug("latex evidence probe disagreed with a full re-read", {
          logicalDocumentKey: target.logicalDocumentKey,
          changedPath: probe.changedPath,
        });
        // The freshly verified marks, so the next poll is cheap again rather
        // than re-entering this path.
        yield* Ref.update(evidenceRef, (all) =>
          new Map(all).set(target.logicalDocumentKey, {
            evidence: cached.evidence,
            marks: recollected.marks,
          }),
        );
        return true;
      }
      yield* Effect.logDebug("latex build inputs changed since the published PDF", {
        logicalDocumentKey: target.logicalDocumentKey,
        changedPath: probe.changedPath,
      });
      return false;
    });

  const compileAndPublish = (key: string, generation: number) => {
    let candidatePdfPath: string | null = null;
    return Effect.gen(function* () {
      const entry = yield* getEntry(key);
      if (entry === null || entry.generation !== generation || entry.cancelRequested) return;
      yield* updateOwnEntry(key, generation, (current) => ({ ...current, state: "running" }));

      const toolchain = yield* toolchainProbe.probe(false);
      if (toolchain.kind === null || toolchain.executable === null) {
        // Without an engine there is nothing to produce, so the binding stays
        // exactly as the last real build left it.
        yield* finishBuild(key, generation, (current) => ({
          ...current,
          state: "failed",
          failureSummary: NO_TOOLCHAIN_SUMMARY,
          diagnostics: withFailureReason([], NO_TOOLCHAIN_SUMMARY),
        }));
        return;
      }
      if (yield* isSuperseded(key, generation)) return;
      // Keep the narrowing across the cleanup finalizer below.
      const toolchainExecutable = toolchain.executable;

      const workDirectory = path.join(config.latexDir, "builds", workDirectoryName(key));
      yield* fileSystem.makeDirectory(workDirectory, { recursive: true });

      const production = yield* store.beginProduction({
        logicalDocumentKey: LogicalDocumentKey.make(key),
        operationId: ProducingOperationId.make(NodeCrypto.randomUUID()),
        producerId: LATEX_PRODUCER_ID,
      });
      yield* updateOwnEntry(key, generation, (current) => ({ ...current, production }));
      // A cancel that landed between `beginProduction` and the write above read
      // `entry.production === null`, found nothing to release, and left. Without
      // this the binding would stay `producing` until the next build or a
      // restart reconciled it — the same window `runProcess` closes around the
      // spawn, and closed the same way. `abandonProduction` is idempotent, so a
      // cancel that did reach the handle running it too costs nothing.
      if (yield* isSuperseded(key, generation)) {
        yield* recordStoreAbandon(production, CANCELLED_SUMMARY);
        return;
      }

      const rootAbsolutePath = path.join(entry.workspaceRoot, entry.rootRelativePath);
      const preamble =
        toolchain.kind === "latexmk" ? yield* readPreambleHeads(rootAbsolutePath) : null;

      // A document that names another engine is refused before anything runs.
      // `latexmk -pdf` drives pdfLaTeX, and handing it a fontspec or
      // `% !TEX program = xelatex` document yields pages of confusing macro
      // errors instead of one honest sentence. Tectonic's engine is XeTeX-based,
      // so only the latexmk path is gated.
      if (toolchain.kind === "latexmk" && preamble !== null) {
        const verdict = evaluateLatexEngineGate(preamble);
        if (!verdict.supported) {
          yield* recordFailure({
            key,
            generation,
            production,
            summary: verdict.message,
            diagnostics: [
              {
                severity: "error",
                file: entry.rootRelativePath,
                line: null,
                // The gate's message already names the engine and quotes the
                // line that asked for it.
                message: verdict.message,
              },
            ],
          });
          return;
        }
      }

      const invocation = buildLatexInvocation({
        toolchain: {
          kind: toolchain.kind,
          executable: toolchainExecutable,
          version: toolchain.version ?? "unknown",
        },
        rootFileName: path.basename(rootAbsolutePath),
        workDirectory,
        // The work directory outlives a build and `latexmk` keeps its own
        // decision state in it, which is state about a run whose inputs this
        // service has since changed underneath it. Every build here is a build
        // that was asked for and whose PDF has just been deleted, so there is
        // no run this would wrongly force.
        forceReprocess: true,
      });
      candidatePdfPath = invocation.pdfPath;

      // TeX resolves `\input{sections/intro}` against the working directory,
      // not against the root document, so a root under `paper/` only builds
      // when the engine runs from `paper/`.
      const compileDirectory = path.dirname(rootAbsolutePath);
      // Non-null only for the distribution Scient installed, which is the only
      // one it may extend: `tlmgr` lives beside the engine in that tree.
      const managedBinDirectory =
        toolchain.source === "scient-managed" ? path.dirname(toolchainExecutable) : null;
      const environment = latexEngineEnvironment({
        base: TEX_OUTPUT_ENVIRONMENT,
        hostEnvironment,
        binDirectory: managedBinDirectory,
        pathDelimiter,
      });
      // Every package this build has already asked for, so one no repository
      // has cannot send the same document round the loop again.
      const attempted = new Set<string>();

      // One fetch for everything the document already says it wants, so the
      // reactive loop below only has to cover what a package pulls in.
      if (managedBinDirectory !== null && preamble !== null) {
        const upfront = yield* preamblePackagesToFetch({
          preamble,
          binDirectory: managedBinDirectory,
        });
        if (upfront.length > 0) {
          yield* installMissingPackages({
            key,
            generation,
            packages: upfront,
            files: upfront.map((packageName) => `${packageName}.sty`),
            binDirectory: managedBinDirectory,
          });
          if (yield* isSuperseded(key, generation)) return;
        }
      }

      for (let round = 0; ; round += 1) {
        // The work directory outlives a single build, so the previous run's PDF
        // is still sitting at `pdfPath`. Drop it first: afterwards "a PDF is
        // there" means "this run produced one", so a run that fails cannot be
        // credited with its predecessor's output.
        yield* fileSystem.remove(invocation.pdfPath, { force: true }).pipe(Effect.ignoreCause());

        const outcome = yield* runProcess({
          key,
          generation,
          command: invocation.command,
          args: invocation.args,
          cwd: compileDirectory,
          environment,
        });
        // A cancel that landed while the engine ran already wrote the terminal
        // state and told the store; do not overwrite it with the kill's exit code.
        if (yield* isSuperseded(key, generation)) return;

        const parsed = rebaseDiagnostics({
          workspaceRoot: entry.workspaceRoot,
          compileDirectory,
          diagnostics: parseLatexLog(outcome.transcript),
        });
        if (outcome.exitCode === null) {
          yield* recordFailure({
            key,
            generation,
            production,
            summary: TIMEOUT_SUMMARY,
            diagnostics: withFailureReason(parsed, () =>
              transcriptFailureDiagnostic({ transcript: outcome.transcript, exitCode: null }),
            ),
          });
          return;
        }

        const producedBytes = yield* fileSystem.stat(invocation.pdfPath).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        // A run that both exited clean and wrote a PDF has nothing left to
        // resolve, whatever the transcript mentions in passing, so a working
        // document never pays for a `tlmgr` round. Everything else is read for
        // missing packages, because a missing `.sty` usually aborts the
        // commands that package defines whether or not the engine typeset
        // something.
        const missing =
          producedBytes > 0 && outcome.exitCode === 0
            ? []
            : missingLatexPackageInputs(outcome.transcript);
        const wanted =
          managedBinDirectory === null
            ? []
            : missing.filter((entryMissing) => !attempted.has(entryMissing.packageName));
        if (
          managedBinDirectory !== null &&
          wanted.length > 0 &&
          round < MAX_PACKAGE_RESOLUTION_ROUNDS
        ) {
          for (const entryMissing of wanted) attempted.add(entryMissing.packageName);
          const placed = yield* installMissingPackages({
            key,
            generation,
            packages: wanted.map((entryMissing) => entryMissing.packageName),
            // The installer only reports these placed once the engine can find
            // the very files this compile stopped on, so a retry never runs
            // against a tree that has the bytes but not yet the index.
            files: wanted.map((entryMissing) => entryMissing.fileName),
            binDirectory: managedBinDirectory,
          });
          // A cancel during the fetch already wrote the terminal state, and a
          // rebuild during it left this fiber with nothing to say.
          if (yield* isSuperseded(key, generation)) return;
          if (placed) continue;
        }
        // Reaching here with names still missing means resolution is over:
        // either Scient does not own this distribution, or it owns it and
        // could not place them. Both need saying, in the voice that fits.
        const diagnostics =
          missing.length === 0
            ? parsed
            : [
                ...parsed,
                ...missing.map((entryMissing) =>
                  managedBinDirectory === null
                    ? missingPackageDiagnostic(entryMissing.packageName)
                    : unresolvedPackageDiagnostic(entryMissing.packageName),
                ),
              ];

        // A run the engine ended in error does not publish, whatever it left at
        // `pdfPath`.
        //
        // The engine still runs to the end of the document — that is what makes
        // the diagnostics complete — but "it typeset some pages" is not the same
        // claim as "this is the document". A PDF from an error-carrying run is
        // missing whatever the error swallowed: the section after it, a
        // bibliography that never ran, every cross-reference that resolved to
        // `??`. Publishing it puts "Built" over a document nobody produced, and
        // the errors shown beside it read as advisory. So the attempt fails, and
        // `failProduction` leaves the last PDF that did compile in place, marked
        // stale with this run's reason — the reader keeps something true to look
        // at and is told plainly that it is behind the source.
        if (outcome.exitCode !== 0) {
          const failureDiagnostics = withFailureReason(diagnostics, () =>
            transcriptFailureDiagnostic({
              transcript: outcome.transcript,
              exitCode: outcome.exitCode,
            }),
          );
          yield* recordFailure({
            key,
            generation,
            production,
            summary: summarizeLatexFailure(failureDiagnostics),
            diagnostics: failureDiagnostics,
          });
          return;
        }
        if (producedBytes <= 0) {
          // Exited clean and produced nothing: still a failure, and one whose
          // reason the transcript does not carry, so it is stated outright.
          const failureDiagnostics = withFailureReason(diagnostics, MISSING_PDF_SUMMARY);
          yield* recordFailure({
            key,
            generation,
            production,
            summary: MISSING_PDF_SUMMARY,
            diagnostics: failureDiagnostics,
          });
          return;
        }
        // A build already replaced or cancelled must not stamp its own
        // evidence over the one the winner has recorded for its own PDF.
        if (yield* isSuperseded(key, generation)) return;
        const evidence = yield* collectBuildEvidence({
          key,
          workspaceRoot: entry.workspaceRoot,
          rootRelativePath: entry.rootRelativePath,
          rootAbsolutePath,
          compileDirectory,
          workDirectory,
          recorderManifestPath: invocation.recorderManifestPath,
        });
        yield* publish({
          key,
          generation,
          production,
          pdfPath: invocation.pdfPath,
          syncTexPath: invocation.syncTexPath,
          workspaceRoot: entry.workspaceRoot,
          rootRelativePath: entry.rootRelativePath,
          compileDirectory,
          toolchainExecutable,
          managedToolchain: managedBinDirectory !== null,
          title: documentTitle(entry.rootRelativePath),
          diagnostics,
        });
        yield* persistBuildEvidence({ key, generation, evidence });
        return;
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          candidatePdfPath === null
            ? Effect.void
            : // The artifact store owns the immutable published bytes. Keeping
              // the engine output too would leave an unbounded duplicate PDF
              // per work directory; aux files remain for latexmk's own reuse.
              fileSystem.remove(candidatePdfPath, { force: true }).pipe(Effect.ignoreCause()),
        ),
      ),
    );
  };

  /**
   * One pass of the build loop. The permit is taken around the compile itself,
   * so a build that is waiting its turn stays in `queued` — the state a client
   * polls — instead of claiming to be running.
   */
  const runOnce = (key: string, generation: number) =>
    admission
      .withPermits(1)(compileAndPublish(key, generation))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // Shutdown closes `buildScope`, which interrupts every in-flight
            // build fiber straight into this handler. An interrupt is not a
            // build outcome and has nothing to report: re-raise it untouched
            // so the fiber dies as interrupted, leaving the entry and the
            // binding for the store's startup reconciliation to settle.
            if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
            yield* Effect.logWarning("latex build failed", { logicalDocumentKey: key, cause });
            const entry = yield* getEntry(key);
            if (entry === null || entry.generation !== generation) return;
            if (!ACTIVE_STATES.has(entry.state)) return;
            if (entry.production !== null) {
              // Everything that reaches here is infrastructure — a full disk, a
              // state directory that vanished, a defect in this service. None
              // of it is a claim about the document's sources, so the
              // production is released rather than failed and the PDF the
              // reader is looking at keeps its `current` binding. The entry
              // below still reports `failed` with the reason, which is the part
              // that is actually true.
              yield* recordStoreAbandon(entry.production, UNEXPECTED_FAILURE_SUMMARY);
            }
            yield* finishBuild(key, generation, (current) => ({
              ...current,
              state: "failed",
              failureSummary: UNEXPECTED_FAILURE_SUMMARY,
              // Without this the snapshot keeps whatever the last finished
              // build said — nothing, on a first build — and the reader is
              // left with a generic sentence and an empty list.
              diagnostics: withFailureReason(current.diagnostics, UNEXPECTED_FAILURE_SUMMARY),
            }));
          }),
        ),
      );

  /** Consumes a coalesced rebuild request and re-arms the entry for another pass. */
  const consumePendingRerun = (key: string, generation: number) =>
    Effect.gen(function* () {
      const startedAtEpochMs = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(entriesRef, (entries) => {
        const current = entries.get(key);
        if (
          current === undefined ||
          current.generation !== generation ||
          !current.pendingRerun ||
          current.cancelRequested
        ) {
          return [false, entries] as const;
        }
        const next = new Map(entries);
        next.set(key, {
          ...current,
          state: "queued",
          startedAtEpochMs,
          finishedAtEpochMs: null,
          pendingRerun: false,
          production: null,
          handle: null,
          installingPackages: null,
        });
        return [true, next] as const;
      });
    });

  const runBuildLoop = (key: string, generation: number) =>
    Effect.gen(function* () {
      let again = true;
      while (again) {
        yield* runOnce(key, generation);
        again = yield* consumePendingRerun(key, generation);
      }
    });

  const resolveTarget = (operation: LatexBuildError["operation"], input: LatexBuildInput) =>
    Effect.gen(function* () {
      // Both fields arrive through `Schema.Trimmed`, so there is nothing left
      // to trim off them here.
      const workspaceRoot = path.resolve(input.workspaceRoot);
      const requested = input.relativePath;
      const invalidPath = () =>
        new LatexBuildError({
          operation,
          reason: "invalid-path",
          detail: "The document path must be relative to the workspace root.",
        });
      if (path.isAbsolute(requested)) return yield* invalidPath();
      const requestedRelative = toPosixPath(
        path.relative(workspaceRoot, path.resolve(workspaceRoot, requested)),
      );
      if (escapesWorkspaceRoot(requestedRelative)) return yield* invalidPath();

      const makeTarget = (
        rootRelativePath: string,
        failureSummary: string | null,
      ): Effect.Effect<ResolvedLatexTarget, LatexBuildError> => {
        const logicalDocumentKey = `latex:${normalizeWorkspaceRoot(workspaceRoot)}:${rootRelativePath}`;
        if (logicalDocumentKey.length > MAX_LOGICAL_DOCUMENT_KEY_LENGTH) {
          return Effect.fail(
            new LatexBuildError({
              operation,
              reason: "document-key-too-long",
              detail: "The document path is too long for Scient to track a build against it.",
            }),
          );
        }
        return Effect.succeed({
          logicalDocumentKey,
          workspaceRoot,
          rootRelativePath,
          failureSummary,
        });
      };

      const contents = yield* readSourceHead(
        path.resolve(workspaceRoot, requestedRelative),
        ROOT_RESOLUTION_HEAD_BYTES,
      ).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      if (Option.isNone(contents)) {
        return yield* makeTarget(
          requestedRelative,
          `Unable to read ${requestedRelative}. Save the file and try again.`,
        );
      }

      const resolution = resolveLatexRoot({
        relativePath: requestedRelative,
        contents: contents.value,
      });
      const rootRelativePath = toPosixPath(
        path.relative(workspaceRoot, path.resolve(workspaceRoot, resolution.rootRelativePath)),
      );
      if (escapesWorkspaceRoot(rootRelativePath)) return yield* invalidPath();
      return yield* makeTarget(rootRelativePath, null);
    });

  /** The answer for a document this process has never built in memory. */
  const syntheticSnapshot = (target: ResolvedLatexTarget) =>
    Effect.gen(function* () {
      const toolchain = yield* toolchainProbe.probe(false);
      const base = {
        logicalDocumentKey: target.logicalDocumentKey,
        rootRelativePath: target.rootRelativePath,
        diagnostics: [] as ReadonlyArray<ScientLatexDiagnostic>,
        startedAtEpochMs: null,
        finishedAtEpochMs: null,
        toolchain,
        pendingRerun: false,
      };
      if (target.failureSummary !== null) {
        return {
          ...base,
          state: "failed" as const,
          descriptor: null,
          failureSummary: target.failureSummary,
        };
      }
      // A published binding survives restarts, so a document with no in-memory
      // build can still have a PDF (and a recorded reason it went stale). What
      // the binding cannot say is whether that PDF still matches its sources;
      // `status` puts the `succeeded` answer below through the evidence check
      // before letting it stand.
      const descriptor = yield* store
        .getDescriptor(LogicalDocumentKey.make(target.logicalDocumentKey))
        .pipe(Effect.orElseSucceed(() => null));
      if (descriptor === null) {
        // Never built in this process and nothing persisted: the document is idle.
        return { ...base, state: "idle" as const, descriptor: null, failureSummary: null };
      }
      const stale = descriptor._tag === "generated-pdf" && descriptor.bindingStatus === "stale";
      return {
        ...base,
        state: stale ? ("failed" as const) : ("succeeded" as const),
        descriptor,
        failureSummary:
          descriptor._tag === "generated-pdf" && stale ? descriptor.staleReason : null,
      };
    });

  /**
   * Starts one build pass for an already-resolved document, or coalesces into
   * the one already running. Every caller goes through here — the client's own
   * request and the freshness check that finds a PDF older than its sources —
   * so an auto-triggered rebuild takes the same admission permit and the same
   * `pendingRerun` coalescing as one a reader asked for, and adds no
   * concurrency of its own.
   *
   * `seedDescriptor` is what the reader keeps looking at while the rebuild
   * runs: on a restart there is no in-memory entry to inherit a descriptor
   * from, and starting one without it would blank a viewer that has a perfectly
   * good — if stale — PDF to show.
   */
  const startBuild = (
    target: ResolvedLatexTarget,
    seedDescriptor: PdfSourceDescriptor | null = null,
  ) =>
    Effect.gen(function* () {
      const startedAtEpochMs = yield* Clock.currentTimeMillis;
      // Claimed before the entry is written, so the build this call may start
      // is the only one that owns the entry from here on.
      const generation = yield* Ref.updateAndGet(generationRef, (current) => current + 1);
      const started = yield* Ref.modify(entriesRef, (entries) => {
        const current = entries.get(target.logicalDocumentKey);
        const next = new Map(entries);
        if (current !== undefined && ACTIVE_STATES.has(current.state)) {
          // Coalesce: one follow-up run regardless of how many saves land.
          next.set(target.logicalDocumentKey, { ...current, pendingRerun: true });
          return [false, next] as const;
        }
        next.set(target.logicalDocumentKey, {
          logicalDocumentKey: target.logicalDocumentKey,
          generation,
          workspaceRoot: target.workspaceRoot,
          rootRelativePath: target.rootRelativePath,
          state: "queued",
          // Last finished diagnostics and descriptor stay visible while the new
          // build runs; they are replaced only when it produces its own.
          diagnostics: current?.diagnostics ?? [],
          descriptor: current?.descriptor ?? seedDescriptor,
          failureSummary: current?.failureSummary ?? null,
          startedAtEpochMs,
          finishedAtEpochMs: null,
          pendingRerun: false,
          cancelRequested: false,
          production: null,
          handle: null,
          installingPackages: null,
        });
        return [true, next] as const;
      });
      if (started) {
        yield* Effect.forkIn(runBuildLoop(target.logicalDocumentKey, generation), buildScope);
      }
      return yield* readEntrySnapshot(target.logicalDocumentKey);
    });

  const requestBuild = (input: LatexBuildInput) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget("build", input);
      if (target.failureSummary !== null) return yield* syntheticSnapshot(target);
      return yield* startBuild(target);
    });

  const status = (input: LatexBuildInput) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget("status", input);
      if (target.failureSummary !== null) return yield* syntheticSnapshot(target);
      const entry = yield* getEntry(target.logicalDocumentKey);
      if (entry === null) {
        const restored = yield* syntheticSnapshot(target);
        // A binding that outlived this process says a PDF was published once,
        // not that it still matches the sources. Nothing in the request carries
        // a revision, so the only honest answer comes from the files: report
        // `succeeded` when the evidence still holds, and otherwise say the
        // document is building — which is true, because it is started here.
        if (restored.state !== "succeeded") return restored;
        if (yield* evidenceIsCurrent(target)) return restored;
        return yield* startBuild(target, restored.descriptor);
      }
      // Only a finished, successful entry can be wrong about being current: an
      // active one is already going to answer with its own compile, and a
      // failed one is already telling the reader not to trust what it shows.
      if (entry.state === "succeeded" && !entry.pendingRerun) {
        if (!(yield* evidenceIsCurrent(target))) {
          return yield* startBuild(target, entry.descriptor);
        }
      }
      return yield* withToolchain(entry);
    });

  const cancel = (input: LatexBuildInput) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget("cancel", input);
      const entry = yield* getEntry(target.logicalDocumentKey);
      if (entry === null) return yield* syntheticSnapshot(target);
      if (!ACTIVE_STATES.has(entry.state)) return yield* withToolchain(entry);
      yield* updateEntry(target.logicalDocumentKey, (current) => ({
        ...current,
        cancelRequested: true,
        pendingRerun: false,
      }));
      if (entry.handle !== null) yield* entry.handle.cancel.pipe(Effect.ignoreCause({ log: true }));
      if (entry.production !== null) {
        // A cancel says nothing about the sources, so the production is
        // abandoned, not failed: a published PDF stays current instead of
        // being staled by a build the reader chose to stop. Safe to run
        // unconditionally — a handle that lost the binding is a no-op.
        yield* recordStoreAbandon(entry.production, CANCELLED_SUMMARY);
      }
      // Same re-read as `recordFailure`: the snapshot this call returns has to
      // carry whatever the store now says about the binding rather than echo
      // the status it was holding before the cancel.
      const descriptor = yield* store
        .getDescriptor(LogicalDocumentKey.make(target.logicalDocumentKey))
        .pipe(Effect.orElseSucceed(() => null));
      yield* finishBuild(target.logicalDocumentKey, entry.generation, (current) => ({
        ...current,
        state: "cancelled",
        failureSummary: CANCELLED_SUMMARY,
        descriptor: descriptor ?? current.descriptor,
      }));
      return yield* readEntrySnapshot(target.logicalDocumentKey);
    });

  return LatexBuildService.of({ requestBuild, status, cancel });
});

/**
 * The package installer is asked for rather than owned: the managed install
 * fetches collections through the same service, and `tlmgr` serializes against
 * one distribution tree. Both callers therefore have to hold the same
 * instance, which the server layer mounts once for both rather than leaving to
 * layer memoization.
 */
export const layer = Layer.effect(LatexBuildService, make);
