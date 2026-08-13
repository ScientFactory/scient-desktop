// @effect-diagnostics nodeBuiltinImport:off -- Build work directories are keyed by a host SHA-256 digest.
/**
 * Coordinates one LaTeX build per logical document. The service owns the only
 * mutable build state on the server: a map keyed by logical document key, one
 * supervised fiber per active build, and the handshake with
 * `GeneratedDocumentStore` that turns a produced PDF into an immutable
 * revision the viewer can render.
 *
 * Three invariants shape the code below:
 *   - A rebuild requested while one is in flight coalesces into a single
 *     follow-up run, so a save-happy editor cannot queue a hundred compiles.
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
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import {
  GeneratedDocumentStore,
  type GeneratedDocumentProductionHandle,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { LatexToolchain } from "./LatexToolchain.ts";
import { buildLatexInvocation } from "./latexCommand.ts";
import { parseLatexLog, summarizeLatexFailure } from "./latexLog.ts";
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
const MAX_LOGICAL_DOCUMENT_KEY_LENGTH = 1_024;

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

interface LatexBuildEntry {
  readonly logicalDocumentKey: string;
  /** Absolute, resolved workspace root; also the compiler's cwd. */
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

interface TranscriptState {
  readonly text: string;
  readonly bytes: number;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

/** Stable across separator and trailing-slash differences so one document keeps one key. */
function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const posix = toPosixPath(workspaceRoot);
  return posix.length > 1 ? posix.replace(/\/+$/u, "") : posix;
}

function escapesRoot(relativePath: string): boolean {
  return (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  );
}

function workDirectoryName(logicalDocumentKey: string): string {
  return NodeCrypto.createHash("sha256").update(logicalDocumentKey).digest("hex").slice(0, 16);
}

function documentTitle(rootRelativePath: string): string {
  const baseName = rootRelativePath.split("/").at(-1) ?? rootRelativePath;
  return baseName.replace(/\.\w+$/u, "") || baseName;
}

function appendBoundedTranscript(state: TranscriptState, text: string): TranscriptState {
  const remaining = MAX_TRANSCRIPT_BYTES - state.bytes;
  if (remaining <= 0) return state;
  const byteLength = Buffer.byteLength(text);
  if (byteLength <= remaining) {
    return { text: state.text + text, bytes: state.bytes + byteLength };
  }
  return {
    text: `${state.text}${text.slice(0, remaining)}\n[truncated]`,
    bytes: MAX_TRANSCRIPT_BYTES,
  };
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* GeneratedDocumentStore;
  const toolchainProbe = yield* LatexToolchain;
  const processes = yield* LocalExecutionProcess.ExecutionProcess;
  const entriesRef = yield* Ref.make(new Map<string, LatexBuildEntry>());
  // Build fibers outlive the request that started them, so they are supervised
  // by the service instead of a request scope.
  const buildScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(buildScope, Exit.void));

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
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* processes.start({
          runId: ExecutionRunId.make(NodeCrypto.randomUUID()),
          executable: input.command,
          args: input.args,
          cwd: input.cwd,
          environment: {},
        });
        yield* updateEntry(input.key, (entry) => ({ ...entry, handle }));
        // A cancel that raced the spawn still has to reach this process tree.
        if (yield* isCancelled(input.key)) yield* handle.cancel.pipe(Effect.ignoreCause());
        const transcriptRef = yield* Ref.make<TranscriptState>({ text: "", bytes: 0 });
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
          transcript: transcript.text,
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

  const runOnce = (key: string) =>
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

      const invocation = buildLatexInvocation({
        toolchain: {
          kind: toolchain.kind,
          executable: toolchain.executable,
          version: toolchain.version ?? "unknown",
        },
        rootAbsolutePath: path.join(entry.workspaceRoot, entry.rootRelativePath),
        workDirectory,
      });

      const outcome = yield* runProcess({
        key,
        command: invocation.command,
        args: invocation.args,
        cwd: entry.workspaceRoot,
      });
      // A cancel that landed while the engine ran already wrote the terminal
      // state and told the store; do not overwrite it with the kill's exit code.
      if (yield* isCancelled(key)) return;

      const diagnostics = parseLatexLog(outcome.transcript);
      if (outcome.exitCode === null) {
        yield* recordFailure({ key, production, summary: TIMEOUT_SUMMARY, diagnostics });
        return;
      }
      if (outcome.exitCode !== 0) {
        yield* recordFailure({
          key,
          production,
          summary: summarizeLatexFailure(diagnostics),
          diagnostics,
        });
        return;
      }
      if (!(yield* fileSystem.exists(invocation.pdfPath))) {
        yield* recordFailure({ key, production, summary: MISSING_PDF_SUMMARY, diagnostics });
        return;
      }
      yield* publish({
        key,
        production,
        pdfPath: invocation.pdfPath,
        title: documentTitle(entry.rootRelativePath),
        diagnostics,
      });
    }).pipe(
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
      const workspaceRoot = path.resolve(input.workspaceRoot.trim());
      const requested = input.relativePath.trim();
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
      if (escapesRoot(requestedRelative)) return yield* invalidPath();

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

      const contents = yield* fileSystem
        .readFileString(path.resolve(workspaceRoot, requestedRelative))
        .pipe(
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
      if (escapesRoot(rootRelativePath)) return yield* invalidPath();
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
      yield* finishBuild(target.logicalDocumentKey, (current) => ({
        ...current,
        state: "cancelled",
        failureSummary: null,
      }));
      return yield* readEntrySnapshot(target.logicalDocumentKey);
    });

  return LatexBuildService.of({ requestBuild, status, cancel });
});

export const layer = Layer.effect(LatexBuildService, make);
