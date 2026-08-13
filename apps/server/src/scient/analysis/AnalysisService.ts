// @effect-diagnostics nodeBuiltinImport:off -- local execution receipts use host SHA-256.
import * as NodeCrypto from "node:crypto";

import { inspectScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  AnalysisOperationError,
  AnalysisSourceRevision,
  summarizeAnalysisRun,
  type AnalysisCancelRunInput,
  type AnalysisConfigureRuntimeInput,
  type AnalysisGetRunInput,
  type AnalysisInspectRuntimesInput,
  type AnalysisListRunsInput,
  type AnalysisRunSnapshot,
  type AnalysisRunSummary,
  type AnalysisRunStreamEvent,
  type AnalysisRuntimeAdapter,
  type AnalysisRuntimeInspection,
  type AnalysisRuntimeProfile,
  type AnalysisStartRunInput,
  type AnalysisSubscribeRunsInput,
} from "@scientfactory/analysis";
import {
  ExecutionRunId,
  TERMINAL_EXECUTION_STATUSES,
  executionOutputContentParts,
  transitionExecutionStatus,
  type ExecutionOutputChunk,
  type ExecutionProcessHandle,
  type ExecutionProcessOutput,
  type ExecutionStatus,
} from "@scientfactory/execution";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalAnalysisStore from "./LocalAnalysisStore.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { matlabRuntimeAdapter } from "./MatlabAdapter.ts";

const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAXIMUM_OUTPUT_CHUNK_BYTES = 256 * 1024;
const RUN_HISTORY_DEFAULT_LIMIT = 20;
const OUTPUT_COALESCE_MAX_CHUNK = 64;
const OUTPUT_COALESCE_WINDOW = Duration.millis(25);
const runtimeAdapters: ReadonlyArray<AnalysisRuntimeAdapter> = [matlabRuntimeAdapter];

type AnalysisOperation = AnalysisOperationError["operation"];
type AnalysisReason = AnalysisOperationError["reason"];

function analysisError(
  operation: AnalysisOperation,
  reason: AnalysisReason,
  message: string,
  cause?: unknown,
): AnalysisOperationError {
  return new AnalysisOperationError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isTerminal(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status);
}

function outputContentHash(chunks: ReadonlyArray<ExecutionOutputChunk>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of executionOutputContentParts(chunks)) hash.update(part, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function utf8Boundary(bytes: Uint8Array, requested: number): number {
  if (requested >= bytes.byteLength) return bytes.byteLength;
  let boundary = requested;
  while (boundary > 0 && (bytes[boundary]! & 0xc0) === 0x80) boundary -= 1;
  return boundary;
}

function decodeUtf8Chunks(bytes: Uint8Array): ReadonlyArray<string> {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const boundary = utf8Boundary(
      bytes,
      Math.min(bytes.byteLength, offset + MAXIMUM_OUTPUT_CHUNK_BYTES),
    );
    if (boundary <= offset) break;
    chunks.push(new TextDecoder().decode(bytes.subarray(offset, boundary)));
    offset = boundary;
  }
  return chunks;
}

function coalesceProcessOutput(
  outputs: ReadonlyArray<ExecutionProcessOutput>,
): ReadonlyArray<ExecutionProcessOutput> {
  const coalesced: Array<ExecutionProcessOutput> = [];
  for (const output of outputs) {
    if (output.text.length === 0) continue;
    const previous = coalesced.at(-1);
    if (previous?.stream === output.stream) {
      coalesced[coalesced.length - 1] = {
        stream: previous.stream,
        text: previous.text + output.text,
      };
    } else {
      coalesced.push(output);
    }
  }
  return coalesced;
}

function matchesSubscription(
  event: AnalysisRunStreamEvent,
  input: AnalysisSubscribeRunsInput,
): boolean {
  const source = event._tag === "run-output" ? event.source : event.run.source;
  return (
    source.cwd === input.cwd &&
    (input.relativePath === undefined || source.relativePath === input.relativePath)
  );
}

function eventProjectId(event: AnalysisRunStreamEvent): string {
  return event._tag === "run-output" ? event.projectId : event.run.projectId;
}

export class AnalysisService extends Context.Service<
  AnalysisService,
  {
    readonly inspectRuntimes: (
      input: AnalysisInspectRuntimesInput,
    ) => Effect.Effect<AnalysisRuntimeInspection, AnalysisOperationError>;
    readonly configureRuntime: (
      input: AnalysisConfigureRuntimeInput,
    ) => Effect.Effect<AnalysisRuntimeInspection, AnalysisOperationError>;
    readonly startRun: (
      input: AnalysisStartRunInput,
    ) => Effect.Effect<AnalysisRunSnapshot, AnalysisOperationError>;
    readonly cancelRun: (
      input: AnalysisCancelRunInput,
    ) => Effect.Effect<AnalysisRunSnapshot, AnalysisOperationError>;
    readonly listRuns: (
      input: AnalysisListRunsInput,
    ) => Effect.Effect<
      { readonly runs: ReadonlyArray<AnalysisRunSummary> },
      AnalysisOperationError
    >;
    readonly getRun: (
      input: AnalysisGetRunInput,
    ) => Effect.Effect<AnalysisRunSnapshot, AnalysisOperationError>;
    readonly subscribeRuns: (
      input: AnalysisSubscribeRunsInput,
    ) => Effect.Effect<Stream.Stream<AnalysisRunStreamEvent>, AnalysisOperationError, Scope.Scope>;
  }
>()("t3/scient/analysis/AnalysisService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hostEnvironment = yield* HostProcessEnvironment;
  const hostPlatform = yield* HostProcessPlatform;
  const processes = yield* LocalExecutionProcess.ExecutionProcess;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const store = yield* LocalAnalysisStore.LocalAnalysisStore;
  const executionScope = yield* Scope.make("sequential");
  const startLock = yield* Semaphore.make(1);
  const runsRef = yield* Ref.make(new Map<string, AnalysisRunSnapshot>());
  const loadedProjectsRef = yield* Ref.make(new Set<string>());
  const handlesRef = yield* Ref.make(new Map<string, ExecutionProcessHandle>());
  const runtimeProfilesRef = yield* Ref.make(new Map<string, AnalysisRuntimeProfile>());
  const eventSequenceRef = yield* Ref.make(0);
  const pubsub = yield* PubSub.bounded<AnalysisRunStreamEvent>(256);

  yield* Effect.addFinalizer(() => Scope.close(executionScope, Exit.void));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const nextEventSequence = Ref.getAndUpdate(eventSequenceRef, (value) => value + 1);

  const publish = (run: AnalysisRunSnapshot) =>
    Effect.gen(function* () {
      const eventSequence = yield* nextEventSequence;
      yield* PubSub.publish(pubsub, {
        _tag: "run-updated" as const,
        eventSequence,
        run: summarizeAnalysisRun(run),
      });
    });

  const publishOutput = (run: AnalysisRunSnapshot, chunks: ReadonlyArray<ExecutionOutputChunk>) =>
    Effect.gen(function* () {
      const eventSequence = yield* nextEventSequence;
      yield* PubSub.publish(pubsub, {
        _tag: "run-output" as const,
        eventSequence,
        projectId: run.projectId,
        runId: run.receipt.runId,
        source: run.source,
        chunks,
        outputTruncated: run.receipt.outputTruncated,
        outputByteLength: run.receipt.outputByteLength,
      });
    });

  const persist = (operation: AnalysisOperation, run: AnalysisRunSnapshot) =>
    store
      .persistRun(run)
      .pipe(
        Effect.mapError((cause) =>
          analysisError(
            operation,
            "persistence-failed",
            "Unable to persist the local run journal.",
            cause,
          ),
        ),
      );

  const putRun = (operation: AnalysisOperation, run: AnalysisRunSnapshot) =>
    Effect.gen(function* () {
      yield* Ref.update(runsRef, (runs) => {
        const next = new Map(runs);
        next.set(run.receipt.runId, run);
        return next;
      });
      yield* persist(operation, run);
      yield* publish(run);
      return run;
    });

  const identityForCwd = (operation: AnalysisOperation, cwd: string) =>
    Effect.tryPromise({
      try: async () => {
        const inspection = await inspectScientProject(cwd);
        return inspection.state === "initialized" ? readScientProjectIdentity(cwd) : null;
      },
      catch: (cause) =>
        analysisError(
          operation,
          "operation-failed",
          "Unable to inspect the Scient project identity.",
          cause,
        ),
    }).pipe(
      Effect.flatMap((identity) =>
        identity === null
          ? Effect.fail(
              analysisError(
                operation,
                "project-not-initialized",
                "Initialize this folder as a Scient project before running analysis files.",
              ),
            )
          : Effect.succeed(identity),
      ),
    );

  const inspectProfile = (adapter: AnalysisRuntimeAdapter, refresh: boolean) =>
    Effect.gen(function* () {
      const cached = (yield* Ref.get(runtimeProfilesRef)).get(adapter.kind);
      if (cached !== undefined && !refresh) return cached;
      const customExecutablePath = yield* store
        .readRuntimeExecutablePath(adapter.kind)
        .pipe(
          Effect.mapError((cause) =>
            analysisError(
              "inspect",
              "persistence-failed",
              `Unable to read ${adapter.kind} settings.`,
              cause,
            ),
          ),
        );
      const inspectedAt = yield* nowIso;
      const profile = yield* Effect.tryPromise({
        try: () =>
          adapter.inspect({
            inspectedAt,
            platform: hostPlatform,
            environment: hostEnvironment,
            ...(customExecutablePath === null ? {} : { customExecutablePath }),
          }),
        catch: (cause) =>
          analysisError(
            "inspect",
            "operation-failed",
            `Unable to inspect the ${adapter.kind} runtime.`,
            cause,
          ),
      });
      yield* Ref.update(runtimeProfilesRef, (profiles) =>
        new Map(profiles).set(adapter.kind, profile),
      );
      return profile;
    });

  const inspectRuntimes = (input: AnalysisInspectRuntimesInput) =>
    Effect.map(
      Effect.forEach(runtimeAdapters, (adapter) => inspectProfile(adapter, input.refresh === true)),
      (runtimes) => ({ contractVersion: 1 as const, runtimes }),
    );

  const configureRuntime = (input: AnalysisConfigureRuntimeInput) =>
    Effect.gen(function* () {
      const adapter = runtimeAdapters.find((candidate) => candidate.kind === input.runtimeKind);
      if (adapter === undefined) {
        return yield* analysisError(
          "configure",
          "runtime-invalid",
          `Unsupported analysis runtime '${input.runtimeKind}'.`,
        );
      }
      yield* store
        .writeRuntimeExecutablePath(adapter.kind, input.executablePath)
        .pipe(
          Effect.mapError((cause) =>
            analysisError(
              "configure",
              "persistence-failed",
              `Unable to save ${adapter.kind} settings.`,
              cause,
            ),
          ),
        );
      yield* Ref.update(runtimeProfilesRef, (profiles) => {
        const next = new Map(profiles);
        next.delete(adapter.kind);
        return next;
      });
      return yield* inspectRuntimes({ cwd: input.cwd, refresh: true });
    });

  const ensureProjectRunsLoaded = (projectId: string) =>
    Effect.gen(function* () {
      const loaded = yield* Ref.get(loadedProjectsRef);
      if (loaded.has(projectId)) return;
      const loadedRuns = yield* store
        .loadRuns(projectId)
        .pipe(
          Effect.mapError((cause) =>
            analysisError("list", "persistence-failed", "Unable to load local run history.", cause),
          ),
        );
      const observedAt = yield* nowIso;
      for (const loadedRun of loadedRuns) {
        let run = loadedRun;
        if (!isTerminal(loadedRun.receipt.status)) {
          const recovered = yield* store
            .loadRun(projectId, loadedRun.receipt.runId)
            .pipe(
              Effect.mapError((cause) =>
                analysisError(
                  "list",
                  "persistence-failed",
                  "Unable to recover an interrupted run.",
                  cause,
                ),
              ),
            );
          const recoveredReceipt = recovered?.receipt ?? loadedRun.receipt;
          run = {
            ...loadedRun,
            receipt: {
              ...recoveredReceipt,
              status: "lost" as const,
              finishedAt: observedAt,
              failureMessage: "The app stopped before this run reached a terminal state.",
              outputContentHash: outputContentHash(recoveredReceipt.output),
              output: [],
            },
          };
        }
        yield* Ref.update(runsRef, (runs) => {
          const next = new Map(runs);
          next.set(run.receipt.runId, run);
          return next;
        });
        if (run !== loadedRun) yield* persist("list", run);
      }
      yield* Ref.update(loadedProjectsRef, (projects) => new Set(projects).add(projectId));
    });

  const updateReceipt = (
    runId: string,
    operation: AnalysisOperation,
    update: (run: AnalysisRunSnapshot) => AnalysisRunSnapshot,
  ) =>
    Effect.gen(function* () {
      const run = yield* Ref.modify(runsRef, (runs) => {
        const current = runs.get(runId);
        if (!current) return [null, runs] as const;
        const nextRun = update(current);
        const next = new Map(runs);
        next.set(runId, nextRun);
        return [nextRun, next] as const;
      });
      if (run === null) {
        return yield* analysisError(
          operation,
          "run-not-found",
          "The analysis run no longer exists.",
        );
      }
      yield* persist(operation, run);
      yield* publish(run);
      return run;
    });

  const appendOutput = (runId: string, outputs: ReadonlyArray<ExecutionProcessOutput>) =>
    Effect.gen(function* () {
      const coalesced = coalesceProcessOutput(outputs);
      if (coalesced.length === 0) return;
      const observedAt = yield* nowIso;
      const update = yield* Ref.modify(runsRef, (runs) => {
        const run = runs.get(runId);
        if (!run) return [null, runs] as const;
        const chunks: ExecutionOutputChunk[] = [];
        let outputByteLength = run.receipt.outputByteLength;
        let outputTruncated = run.receipt.outputTruncated;
        for (const output of coalesced) {
          const remainingBytes = Math.max(0, MAXIMUM_OUTPUT_BYTES - outputByteLength);
          const encoded = new TextEncoder().encode(output.text);
          const acceptedByteLength = utf8Boundary(
            encoded,
            Math.min(encoded.byteLength, remainingBytes),
          );
          for (const acceptedText of decodeUtf8Chunks(encoded.subarray(0, acceptedByteLength))) {
            chunks.push({
              sequence: run.receipt.output.length + chunks.length,
              stream: output.stream,
              text: acceptedText,
              observedAt,
            });
          }
          outputByteLength += acceptedByteLength;
          if (encoded.byteLength > remainingBytes && !outputTruncated) {
            outputTruncated = true;
            chunks.push({
              sequence: run.receipt.output.length + chunks.length,
              stream: "system",
              text: `Output was truncated at the ${MAXIMUM_OUTPUT_BYTES}-byte limit.\n`,
              observedAt,
            });
          }
        }
        if (chunks.length === 0) return [{ run, chunks }, runs] as const;
        const nextRun = {
          ...run,
          receipt: {
            ...run.receipt,
            output: [...run.receipt.output, ...chunks],
            outputTruncated,
            outputByteLength,
          },
        } satisfies AnalysisRunSnapshot;
        const next = new Map(runs);
        next.set(runId, nextRun);
        return [{ run: nextRun, chunks }, next] as const;
      });
      if (update === null || update.chunks.length === 0) return;
      for (const chunk of update.chunks) {
        yield* store
          .appendOutput(update.run.projectId, runId, chunk)
          .pipe(
            Effect.mapError((cause) =>
              analysisError("start", "persistence-failed", "Unable to append run output.", cause),
            ),
          );
      }
      if (update.run.receipt.outputTruncated) yield* persist("start", update.run);
      yield* publishOutput(update.run, update.chunks);
    });

  const finishRun = (
    runId: string,
    status: Extract<ExecutionStatus, "succeeded" | "failed" | "cancelled" | "lost">,
    exitCode: number | null,
    failureMessage: string | null,
  ) =>
    Effect.gen(function* () {
      const finishedAt = yield* nowIso;
      const current = (yield* Ref.get(runsRef)).get(runId);
      const contentHash = current === undefined ? null : outputContentHash(current.receipt.output);
      const finished = yield* updateReceipt(runId, "start", (run) => ({
        ...run,
        receipt: {
          ...run.receipt,
          status: transitionExecutionStatus(run.receipt.status, status),
          exitCode,
          failureMessage,
          finishedAt,
          outputContentHash: contentHash,
        },
      }));
      yield* Ref.update(runsRef, (runs) => {
        const next = new Map(runs);
        next.set(runId, {
          ...finished,
          receipt: { ...finished.receipt, output: [] },
        });
        return next;
      });
      return finished;
    });

  const runProcess = (
    runId: string,
    adapter: AnalysisRuntimeAdapter,
    profile: AnalysisRuntimeProfile,
    absoluteSourcePath: string,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const startingAt = yield* nowIso;
        const startingRun = yield* updateReceipt(runId, "start", (run) => ({
          ...run,
          receipt: {
            ...run.receipt,
            status: transitionExecutionStatus(run.receipt.status, "starting"),
            startedAt: startingAt,
          },
        }));
        const prepared = adapter.prepare({
          runId: startingRun.receipt.runId,
          projectId: startingRun.projectId,
          runtime: profile,
          source: startingRun.source,
          absoluteSourcePath,
        });
        const handle = yield* processes.start({
          runId: startingRun.receipt.runId,
          executable: prepared.executable,
          args: prepared.args,
          cwd: prepared.cwd,
          environment: prepared.environment,
        });
        yield* Ref.update(handlesRef, (handles) => new Map(handles).set(runId, handle));
        const running = yield* updateReceipt(runId, "start", (run) => ({
          ...run,
          receipt: {
            ...run.receipt,
            status: transitionExecutionStatus(run.receipt.status, "running"),
          },
        }));
        if (running.receipt.cancellationRequested) {
          yield* handle.cancel;
        }
        const [, exitCode] = yield* Effect.all(
          [
            handle.output.pipe(
              Stream.groupedWithin(OUTPUT_COALESCE_MAX_CHUNK, OUTPUT_COALESCE_WINDOW),
              Stream.runForEach((outputs) => appendOutput(runId, outputs)),
            ),
            handle.exitCode,
          ],
          { concurrency: 2 },
        );
        const latest = (yield* Ref.get(runsRef)).get(runId);
        if (latest?.receipt.cancellationRequested) {
          yield* finishRun(runId, "cancelled", exitCode, null);
        } else if (exitCode === 0) {
          yield* finishRun(runId, "succeeded", 0, null);
        } else {
          yield* finishRun(
            runId,
            "failed",
            exitCode,
            `${profile.label} exited with code ${exitCode}.`,
          );
        }
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const latest = (yield* Ref.get(runsRef)).get(runId);
          if (!latest || isTerminal(latest.receipt.status)) return;
          const status = latest.receipt.cancellationRequested
            ? "cancelled"
            : Cause.hasInterruptsOnly(cause)
              ? "lost"
              : "failed";
          yield* finishRun(
            runId,
            status,
            null,
            status === "cancelled"
              ? null
              : status === "lost"
                ? `Scient stopped before the ${profile.label} run completed.`
                : `${profile.label} could not be started or completed.`,
          ).pipe(Effect.ignoreCause({ log: true }));
          if (status === "failed") {
            yield* Ref.update(runtimeProfilesRef, (profiles) => {
              const next = new Map(profiles);
              next.delete(adapter.kind);
              return next;
            });
          }
          yield* Effect.logWarning("analysis run process failed", { runId, cause });
        }),
      ),
      Effect.ensuring(
        Ref.update(handlesRef, (handles) => {
          const next = new Map(handles);
          next.delete(runId);
          return next;
        }),
      ),
    );

  const startRun = (input: AnalysisStartRunInput) =>
    startLock.withPermits(1)(
      Effect.gen(function* () {
        const adapter = runtimeAdapters.find((candidate) => candidate.id === input.runtimeId);
        if (adapter === undefined) {
          return yield* analysisError(
            "start",
            "runtime-invalid",
            "The selected analysis runtime is unavailable.",
          );
        }
        const lowerPath = input.relativePath.toLowerCase();
        if (!adapter.fileExtensions.some((extension) => lowerPath.endsWith(extension))) {
          return yield* analysisError(
            "start",
            "invalid-source",
            `${adapter.kind} cannot run this source file.`,
          );
        }
        const identity = yield* identityForCwd("start", input.cwd);
        yield* ensureProjectRunsLoaded(identity.projectId);
        const activeRun = [...(yield* Ref.get(runsRef)).values()].find(
          (run) =>
            run.projectId === identity.projectId &&
            run.source.relativePath === input.relativePath &&
            !isTerminal(run.receipt.status),
        );
        if (activeRun) {
          return yield* analysisError(
            "start",
            "run-already-active",
            "This analysis file already has an active run.",
          );
        }
        const file = yield* workspaceFiles
          .readFile({ cwd: input.cwd, relativePath: input.relativePath })
          .pipe(
            Effect.mapError((cause) =>
              analysisError(
                "start",
                "invalid-source",
                `Unable to read the ${adapter.kind} source file.`,
                cause,
              ),
            ),
          );
        if (file.truncated) {
          return yield* analysisError(
            "start",
            "invalid-source",
            "This file exceeds the editable source limit and cannot be run from the viewer.",
          );
        }
        if (file.revision !== input.sourceRevision) {
          return yield* analysisError(
            "start",
            "source-changed",
            "The source file changed after it was opened. Wait for save or reload it before running.",
          );
        }
        const profile = yield* inspectProfile(adapter, false);
        if (profile.availability !== "available" || profile.executablePath === null) {
          return yield* analysisError(
            "start",
            profile.availability === "invalid" ? "runtime-invalid" : "runtime-missing",
            profile.detail ?? `${profile.label} is unavailable.`,
          );
        }
        if (!profile.capabilities.includes("run-file")) {
          return yield* analysisError(
            "start",
            "runtime-invalid",
            `${profile.label} does not advertise Run File support.`,
          );
        }
        const target = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
          })
          .pipe(
            Effect.mapError((cause) =>
              analysisError("start", "invalid-source", "The source path is invalid.", cause),
            ),
          );
        const runId = ExecutionRunId.make(
          yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) =>
              analysisError(
                "start",
                "operation-failed",
                "Unable to create the analysis run identifier.",
                cause,
              ),
            ),
          ),
        );
        const startedAt = yield* nowIso;
        const run: AnalysisRunSnapshot = {
          contractVersion: 1,
          projectId: identity.projectId,
          action: "run-file",
          runtime: profile,
          source: {
            cwd: input.cwd,
            relativePath: file.relativePath,
            revision: AnalysisSourceRevision.make(file.revision),
          },
          receipt: {
            runId,
            status: "queued",
            startedAt,
            finishedAt: null,
            exitCode: null,
            failureMessage: null,
            cancellationRequested: false,
            outputTruncated: false,
            outputByteLength: 0,
            outputContentHash: null,
            output: [],
          },
        };
        yield* putRun("start", run);
        yield* Effect.forkIn(
          runProcess(runId, adapter, profile, target.absolutePath),
          executionScope,
        );
        return run;
      }),
    );

  const cancelRun = (input: AnalysisCancelRunInput) =>
    Effect.gen(function* () {
      const identity = yield* identityForCwd("cancel", input.cwd);
      yield* ensureProjectRunsLoaded(identity.projectId);
      const run = (yield* Ref.get(runsRef)).get(input.runId);
      if (!run || run.projectId !== identity.projectId) {
        return yield* analysisError(
          "cancel",
          "run-not-found",
          "The analysis run no longer exists.",
        );
      }
      if (isTerminal(run.receipt.status)) {
        return yield* analysisError(
          "cancel",
          "run-already-finished",
          "This analysis run has already finished.",
        );
      }
      const updated = yield* updateReceipt(input.runId, "cancel", (current) => ({
        ...current,
        receipt: { ...current.receipt, cancellationRequested: true },
      }));
      const handle = (yield* Ref.get(handlesRef)).get(input.runId);
      if (handle) {
        yield* handle.cancel.pipe(
          Effect.mapError((cause) =>
            analysisError(
              "cancel",
              "process-failed",
              `Unable to stop the ${run.runtime.label} process tree.`,
              cause,
            ),
          ),
        );
      }
      return (yield* Ref.get(runsRef)).get(input.runId) ?? updated;
    });

  const listRuns = (input: AnalysisListRunsInput) =>
    Effect.gen(function* () {
      const identity = yield* identityForCwd("list", input.cwd);
      yield* ensureProjectRunsLoaded(identity.projectId);
      const limit = input.limit ?? RUN_HISTORY_DEFAULT_LIMIT;
      const runs = [...(yield* Ref.get(runsRef)).values()]
        .filter(
          (run) =>
            run.projectId === identity.projectId &&
            (input.relativePath === undefined || run.source.relativePath === input.relativePath),
        )
        .toSorted((left, right) => right.receipt.startedAt.localeCompare(left.receipt.startedAt))
        .slice(0, limit)
        .map(summarizeAnalysisRun);
      return { runs };
    });

  const getRun = (input: AnalysisGetRunInput) =>
    Effect.gen(function* () {
      const identity = yield* identityForCwd("get", input.cwd);
      yield* ensureProjectRunsLoaded(identity.projectId);
      const run = (yield* Ref.get(runsRef)).get(input.runId);
      if (!run || run.projectId !== identity.projectId) {
        return yield* analysisError("get", "run-not-found", "The analysis run no longer exists.");
      }
      if (!isTerminal(run.receipt.status)) return run;
      const persistedRun = yield* store
        .loadRun(identity.projectId, input.runId)
        .pipe(
          Effect.mapError((cause) =>
            analysisError(
              "get",
              "persistence-failed",
              "Unable to load the local run output.",
              cause,
            ),
          ),
        );
      if (persistedRun === null) {
        return yield* analysisError("get", "run-not-found", "The analysis run no longer exists.");
      }
      return persistedRun;
    });

  const subscribeRuns = (input: AnalysisSubscribeRunsInput) =>
    Effect.gen(function* () {
      const identity = yield* identityForCwd("subscribe", input.cwd);
      yield* ensureProjectRunsLoaded(identity.projectId);
      const subscription = yield* PubSub.subscribe(pubsub);
      const boundarySequence = yield* Ref.get(eventSequenceRef);
      const matchingRuns = [...(yield* Ref.get(runsRef)).values()]
        .filter(
          (run) =>
            run.projectId === identity.projectId &&
            matchesSubscription(
              { _tag: "run-snapshot", eventSequence: boundarySequence, run },
              input,
            ),
        )
        .toSorted((left, right) => left.receipt.startedAt.localeCompare(right.receipt.startedAt));
      const latestRunId = matchingRuns.at(-1)?.receipt.runId;
      const snapshots = matchingRuns
        .filter((run) => !isTerminal(run.receipt.status) || run.receipt.runId === latestRunId)
        .map((run) => ({
          _tag: "run-snapshot" as const,
          eventSequence: boundarySequence,
          run,
        }));
      return Stream.concat(
        Stream.fromIterable(snapshots),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (event) =>
              event.eventSequence >= boundarySequence &&
              eventProjectId(event) === identity.projectId &&
              matchesSubscription(event, input),
          ),
        ),
      );
    });

  return AnalysisService.of({
    inspectRuntimes,
    configureRuntime,
    startRun,
    cancelRun,
    listRuns,
    getRun,
    subscribeRuns,
  });
});

export const layer = Layer.effect(AnalysisService, make);
