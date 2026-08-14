// @effect-diagnostics nodeBuiltinImport:off -- Build work directories are keyed by a host SHA-256 digest.
/**
 * Coordinates one LaTeX build per logical document. The service owns the only
 * mutable build state on the server: a map keyed by logical document key, one
 * supervised fiber per active build, and the handshake with
 * `GeneratedDocumentStore` that turns a produced PDF into an immutable
 * revision the viewer can render.
 *
 * Four invariants shape the code below:
 *   - A rebuild requested while one is in flight coalesces into a single
 *     follow-up run, so a save-happy editor cannot queue a hundred compiles.
 *   - At most `MAX_CONCURRENT_COMPILES` documents compile at once; the rest
 *     sit in `queued` until a permit frees.
 *   - Aux files never touch the workspace; every engine writes into
 *     `<latexDir>/builds/<digest>/`.
 *   - A build that loses the binding race (`superseded`) reports itself
 *     cancelled and leaves the store alone; only the newest generation may
 *     record a failure.
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

import * as ServerConfig from "../../config.ts";
import {
  GeneratedDocumentStore,
  type GeneratedDocumentProductionHandle,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { LatexPackageInstaller, layer as packageInstallerLayer } from "./LatexPackageInstaller.ts";
import { LatexToolchain } from "./LatexToolchain.ts";
import { buildLatexInvocation, latexEngineEnvironment } from "./latexCommand.ts";
import { parseLatexLog, summarizeLatexFailure } from "./latexLog.ts";
import { missingLatexPackages } from "./latexMissingPackages.ts";
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
/** A compile is CPU- and disk-bound; three at once keeps a laptop usable. */
const MAX_CONCURRENT_COMPILES = 3;
/**
 * How many times one build may fetch packages and compile again. A document
 * reveals what it is missing in layers — a package pulled in by the package
 * that was just installed — so one round is not always enough; a third would
 * mean a document that never stops building.
 */
const MAX_PACKAGE_RESOLUTION_ROUNDS = 2;

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

interface LatexBuildEntry {
  readonly logicalDocumentKey: string;
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

interface ResolvedLatexTarget {
  readonly logicalDocumentKey: string;
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
  /** Non-null when the requested source could not be read; no build is possible. */
  readonly failureSummary: string | null;
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
  const packageInstaller = yield* LatexPackageInstaller;
  const processes = yield* LocalExecutionProcess.ExecutionProcess;
  const hostEnvironment = yield* HostProcessEnvironment;
  const pathDelimiter = (yield* HostProcessPlatform) === "win32" ? ";" : ":";
  const entriesRef = yield* Ref.make(new Map<string, LatexBuildEntry>());
  // Build fibers outlive the request that started them, so they are supervised
  // by the service instead of a request scope.
  const buildScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(buildScope, Exit.void));
  // Admission control for the compile itself. A fiber holds no permit while it
  // waits, which is what keeps the `queued` state honest.
  const admission = yield* Semaphore.make(MAX_CONCURRENT_COMPILES);

  /** Reads only the head of a source file; see `ROOT_RESOLUTION_HEAD_BYTES`. */
  const readSourceHead = (absolutePath: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(absolutePath, { flag: "r" });
        const chunk = yield* file.readAlloc(ROOT_RESOLUTION_HEAD_BYTES);
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

  const updateEntry = (key: string, update: (entry: LatexBuildEntry) => LatexBuildEntry) =>
    Ref.update(entriesRef, (entries) => {
      const current = entries.get(key);
      if (current === undefined) return entries;
      const next = new Map(entries);
      next.set(key, update(current));
      return next;
    });

  const isCancelled = (key: string) =>
    getEntry(key).pipe(Effect.map((entry) => entry === null || entry.cancelRequested));

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
  const finishBuild = (key: string, update: (entry: LatexBuildEntry) => LatexBuildEntry) =>
    Effect.gen(function* () {
      const finishedAtEpochMs = yield* Clock.currentTimeMillis;
      yield* updateEntry(key, (entry) => ({
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

  const recordFailure = (input: {
    readonly key: string;
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
      yield* finishBuild(input.key, (entry) => ({
        ...entry,
        state: "failed",
        failureSummary: input.summary,
        diagnostics: input.diagnostics,
        descriptor: descriptor ?? entry.descriptor,
      }));
    });

  const runProcess = (input: {
    readonly key: string;
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
        yield* updateEntry(input.key, (entry) => ({ ...entry, handle }));
        // A cancel that raced the spawn still has to reach this process tree.
        if (yield* isCancelled(input.key)) yield* handle.cancel.pipe(Effect.ignoreCause());
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
    readonly production: GeneratedDocumentProductionHandle;
    readonly pdfPath: string;
    readonly title: string;
    readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
  }) =>
    Effect.gen(function* () {
      const bytes = yield* fileSystem.readFile(input.pdfPath);
      yield* updateEntry(input.key, (entry) => ({ ...entry, state: "publishing" }));
      yield* store
        .publishPdf({
          ...input.production,
          bytes,
          title: input.title,
          provenanceKind: "document-build",
        })
        .pipe(
          Effect.flatMap((descriptor) =>
            finishBuild(input.key, (entry) => ({
              ...entry,
              state: "succeeded",
              descriptor,
              // Warnings survive a successful build; they are the point of the log.
              diagnostics: input.diagnostics,
              failureSummary: null,
            })),
          ),
          Effect.catch((error) => {
            if (error.reason === "superseded") {
              // A newer build owns the binding. Report cancelled and leave the
              // store untouched so the winner's own outcome stands.
              return finishBuild(input.key, (entry) => ({
                ...entry,
                state: "cancelled",
                diagnostics: input.diagnostics,
              }));
            }
            if (error.reason === "validation-rejected") {
              // The store already recorded this failure while rejecting the PDF.
              return finishBuild(input.key, (entry) => ({
                ...entry,
                state: "failed",
                failureSummary: error.detail,
                diagnostics: input.diagnostics,
              }));
            }
            return recordFailure({
              key: input.key,
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
    readonly packages: ReadonlyArray<string>;
    readonly binDirectory: string;
  }) =>
    Effect.gen(function* () {
      yield* updateEntry(input.key, (entry) => ({
        ...entry,
        installingPackages: input.packages,
      }));
      const outcome = yield* packageInstaller.install({
        packages: input.packages,
        binDirectory: input.binDirectory,
      });
      yield* updateEntry(input.key, (entry) => ({ ...entry, installingPackages: null }));
      if (outcome.failed.length > 0) {
        yield* Effect.logDebug("latex packages could not be installed", {
          logicalDocumentKey: input.key,
          packages: outcome.failed,
        });
      }
      return outcome.installed.length > 0;
    });

  const compileAndPublish = (key: string) =>
    Effect.gen(function* () {
      const entry = yield* getEntry(key);
      if (entry === null || entry.cancelRequested) return;
      yield* updateEntry(key, (current) => ({ ...current, state: "running" }));

      const toolchain = yield* toolchainProbe.probe(false);
      if (toolchain.kind === null || toolchain.executable === null) {
        // Without an engine there is nothing to produce, so the binding stays
        // exactly as the last real build left it.
        yield* finishBuild(key, (current) => ({
          ...current,
          state: "failed",
          failureSummary: NO_TOOLCHAIN_SUMMARY,
        }));
        return;
      }
      if (yield* isCancelled(key)) return;

      const workDirectory = path.join(config.latexDir, "builds", workDirectoryName(key));
      yield* fileSystem.makeDirectory(workDirectory, { recursive: true });

      const production = yield* store.beginProduction({
        logicalDocumentKey: LogicalDocumentKey.make(key),
        operationId: ProducingOperationId.make(NodeCrypto.randomUUID()),
        producerId: LATEX_PRODUCER_ID,
      });
      yield* updateEntry(key, (current) => ({ ...current, production }));

      const rootAbsolutePath = path.join(entry.workspaceRoot, entry.rootRelativePath);
      const invocation = buildLatexInvocation({
        toolchain: {
          kind: toolchain.kind,
          executable: toolchain.executable,
          version: toolchain.version ?? "unknown",
        },
        rootAbsolutePath,
        workDirectory,
      });

      // TeX resolves `\input{sections/intro}` against the working directory,
      // not against the root document, so a root under `paper/` only builds
      // when the engine runs from `paper/`.
      const compileDirectory = path.dirname(rootAbsolutePath);
      // Non-null only for the distribution Scient installed, which is the only
      // one it may extend: `tlmgr` lives beside the engine in that tree.
      const managedBinDirectory =
        toolchain.source === "scient-managed" ? path.dirname(toolchain.executable) : null;
      const environment = latexEngineEnvironment({
        base: TEX_OUTPUT_ENVIRONMENT,
        hostEnvironment,
        binDirectory: managedBinDirectory,
        pathDelimiter,
      });
      // Every package this build has already asked for, so one no repository
      // has cannot send the same document round the loop again.
      const attempted = new Set<string>();

      for (let round = 0; ; round += 1) {
        // The work directory outlives a single build, so the previous run's PDF
        // is still sitting at `pdfPath`. Drop it first: afterwards "a PDF is
        // there" means "this run produced one", which is what lets a run that
        // exits non-zero still publish honestly.
        yield* fileSystem.remove(invocation.pdfPath, { force: true }).pipe(Effect.ignoreCause());

        const outcome = yield* runProcess({
          key,
          command: invocation.command,
          args: invocation.args,
          cwd: compileDirectory,
          environment,
        });
        // A cancel that landed while the engine ran already wrote the terminal
        // state and told the store; do not overwrite it with the kill's exit code.
        if (yield* isCancelled(key)) return;

        const parsed = rebaseDiagnostics({
          workspaceRoot: entry.workspaceRoot,
          compileDirectory,
          diagnostics: parseLatexLog(outcome.transcript),
        });
        if (outcome.exitCode === null) {
          yield* recordFailure({ key, production, summary: TIMEOUT_SUMMARY, diagnostics: parsed });
          return;
        }

        // A missing `.sty` usually aborts the commands that package defines, so
        // this is read whether or not the run managed to typeset something.
        const missingPackages = missingLatexPackages(outcome.transcript);
        const wanted =
          managedBinDirectory === null
            ? []
            : missingPackages.filter((packageName) => !attempted.has(packageName));
        if (
          managedBinDirectory !== null &&
          wanted.length > 0 &&
          round < MAX_PACKAGE_RESOLUTION_ROUNDS
        ) {
          for (const packageName of wanted) attempted.add(packageName);
          const placed = yield* installMissingPackages({
            key,
            packages: wanted,
            binDirectory: managedBinDirectory,
          });
          // A cancel during the fetch already wrote the terminal state.
          if (yield* isCancelled(key)) return;
          if (placed) continue;
        }
        const diagnostics =
          managedBinDirectory === null && missingPackages.length > 0
            ? [...parsed, ...missingPackages.map(missingPackageDiagnostic)]
            : parsed;

        // Overleaf parity: a document with errors that still typeset a PDF is
        // published, with the errors alongside it. Only an empty-handed run
        // fails, because then there is nothing new for the viewer to show.
        const producedBytes = yield* fileSystem.stat(invocation.pdfPath).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        if (producedBytes <= 0) {
          yield* recordFailure({
            key,
            production,
            summary:
              outcome.exitCode === 0 ? MISSING_PDF_SUMMARY : summarizeLatexFailure(diagnostics),
            diagnostics,
          });
          return;
        }
        yield* publish({
          key,
          production,
          pdfPath: invocation.pdfPath,
          title: documentTitle(entry.rootRelativePath),
          diagnostics,
        });
        return;
      }
    });

  /**
   * One pass of the build loop. The permit is taken around the compile itself,
   * so a build that is waiting its turn stays in `queued` — the state a client
   * polls — instead of claiming to be running.
   */
  const runOnce = (key: string) =>
    admission
      .withPermits(1)(compileAndPublish(key))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("latex build failed", { logicalDocumentKey: key, cause });
            const entry = yield* getEntry(key);
            if (entry === null || !ACTIVE_STATES.has(entry.state)) return;
            if (entry.production !== null) {
              yield* recordStoreFailure(entry.production, UNEXPECTED_FAILURE_SUMMARY);
            }
            yield* finishBuild(key, (current) => ({
              ...current,
              state: "failed",
              failureSummary: UNEXPECTED_FAILURE_SUMMARY,
            }));
          }),
        ),
      );

  /** Consumes a coalesced rebuild request and re-arms the entry for another pass. */
  const consumePendingRerun = (key: string) =>
    Effect.gen(function* () {
      const startedAtEpochMs = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(entriesRef, (entries) => {
        const current = entries.get(key);
        if (current === undefined || !current.pendingRerun || current.cancelRequested) {
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

  const runBuildLoop = (key: string) =>
    Effect.gen(function* () {
      let again = true;
      while (again) {
        yield* runOnce(key);
        again = yield* consumePendingRerun(key);
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

      const contents = yield* readSourceHead(path.resolve(workspaceRoot, requestedRelative)).pipe(
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
      // build can still have a PDF (and a recorded reason it went stale).
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

  const requestBuild = (input: LatexBuildInput) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget("build", input);
      if (target.failureSummary !== null) return yield* syntheticSnapshot(target);
      const startedAtEpochMs = yield* Clock.currentTimeMillis;
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
          workspaceRoot: target.workspaceRoot,
          rootRelativePath: target.rootRelativePath,
          state: "queued",
          // Last finished diagnostics and descriptor stay visible while the new
          // build runs; they are replaced only when it produces its own.
          diagnostics: current?.diagnostics ?? [],
          descriptor: current?.descriptor ?? null,
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
      if (started) yield* Effect.forkIn(runBuildLoop(target.logicalDocumentKey), buildScope);
      return yield* readEntrySnapshot(target.logicalDocumentKey);
    });

  const status = (input: LatexBuildInput) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget("status", input);
      const entry = yield* getEntry(target.logicalDocumentKey);
      if (entry === null || target.failureSummary !== null) return yield* syntheticSnapshot(target);
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
        yield* recordStoreFailure(entry.production, CANCELLED_SUMMARY);
      }
      // Same re-read as `recordFailure`: cancelling a build that owned the
      // binding marks it stale in the store, and the snapshot this call returns
      // has to say so rather than echo the `current` status it was holding.
      const descriptor = yield* store
        .getDescriptor(LogicalDocumentKey.make(target.logicalDocumentKey))
        .pipe(Effect.orElseSucceed(() => null));
      yield* finishBuild(target.logicalDocumentKey, (current) => ({
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
 * The package installer is owned here rather than asked for: it is only ever
 * pointed at the distribution this service already resolved, and nothing else
 * on the server has a use for it.
 */
export const layer = Layer.effect(LatexBuildService, make).pipe(
  Layer.provide(packageInstallerLayer),
);
