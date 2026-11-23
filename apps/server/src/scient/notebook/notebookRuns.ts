// @effect-diagnostics nodeBuiltinImport:off -- result staging and run identifiers are server-owned.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeResultsError,
  ComputeSessionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeExecutionRecord,
  type ComputeResultParameter,
  type ComputeResultsRerunResult,
  type NotebookFreshRunInput,
  type NotebookFreshRun,
  type NotebookFreshRunStatusInput,
  type NotebookFreshRunStopInput,
  type NotebookFreshRunSubscribeInput,
} from "@t3tools/contracts";
import { notebookCellRun } from "@t3tools/shared/notebookStaleness";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import { computeResultsStagingFolder } from "../compute/LocalComputeStore.ts";
import {
  makeResultsReader,
  mergeResultEnvironment,
  prepareResultRun,
  publishScriptRun,
  summarizeRevision,
  type SettledScriptRun,
} from "../results/resultRevisions.ts";
import {
  beginResultAttempt,
  clearResultFailuresThrough,
  forgetResultAttempt,
  recordFailedResultAttempt,
} from "../results/resultAttempts.ts";
import type { ComputeSettledRun } from "../compute/ComputeSessionService.ts";
import type { NotebookRunJobs, ReportNotebookJob } from "./NotebookRunJobs.ts";
import type { NotebookStore } from "./NotebookStore.ts";
import type { WorkspacePaths } from "../../workspace/WorkspacePaths.ts";
import { executedNotebookCells, notebookExecutionDigest } from "./notebookRevisionSource.ts";
import { planNotebookRun } from "./notebookRunPlan.ts";

const isComputeResultsError = Schema.is(ComputeResultsError);

async function mergedReads(
  executions: ReadonlyArray<ComputeExecutionRecord>,
): Promise<SettledScriptRun["reads"]> {
  type Reads = NonNullable<SettledScriptRun["reads"]>;
  const files = new Map<string, Reads["files"][number]>();
  const inputWrites = new Set(executions.flatMap(({ result }) => result?.reads?.inputWrites ?? []));
  const directories = new Map<string, NonNullable<Reads["directories"]>[number]>();
  let directoriesObserved = false;
  let readsOutsideProject: number | undefined;
  let outsideDataPaths: Set<string> | undefined;
  let tracked = false;
  let truncated = false;
  for (const execution of executions) {
    const reads = execution.result?.reads;
    if (reads === undefined) continue;
    tracked = true;
    truncated ||= reads.truncated;
    for (const file of reads.files) {
      if (files.has(file.path) || inputWrites.has(file.path)) continue;
      if (files.size >= 2_000) {
        truncated = true;
        break;
      }
      files.set(file.path, file);
    }
    if (reads.directories !== undefined) {
      directoriesObserved = true;
      for (const directory of reads.directories) {
        if (directories.has(directory.path)) continue;
        if (directories.size >= 128) {
          truncated = true;
          break;
        }
        directories.set(directory.path, directory);
      }
    }
    if (reads.outsideDataPaths !== undefined) {
      outsideDataPaths ??= new Set();
      for (const path of reads.outsideDataPaths) {
        if (outsideDataPaths.has(path) || outsideDataPaths.size < 64) outsideDataPaths.add(path);
        else truncated = true;
      }
    }
    if (reads.readsOutsideProject !== undefined) {
      readsOutsideProject = (readsOutsideProject ?? 0) + reads.readsOutsideProject;
    }
  }
  if (inputWrites.size > 0) {
    for (const path of files.keys()) {
      const resolved = await NodeFSP.realpath(path).catch(() => path);
      if (inputWrites.has(resolved)) files.delete(path);
    }
  }
  return tracked
    ? {
        files: [...files.values()],
        ...(directoriesObserved ? { directories: [...directories.values()] } : {}),
        ...(outsideDataPaths !== undefined
          ? {
              outsideDataPaths: [...outsideDataPaths].toSorted(),
              readsOutsideProject: outsideDataPaths.size,
            }
          : readsOutsideProject === undefined
            ? {}
            : { readsOutsideProject }),
        truncated,
      }
    : undefined;
}

export function makeNotebookRuns(deps: {
  readonly computeDir: string;
  readonly jobs: NotebookRunJobs["Service"];
  readonly workspacePaths: WorkspacePaths["Service"];
  readonly gateway: Pick<
    ComputeRpcGateway,
    | "projectWithAdmission"
    | "watchProject"
    | "startSession"
    | "stopSession"
    | "getSession"
    | "submitCells"
    | "listAllExecutions"
    | "settledRuns"
    | "settledRunRecorded"
  >;
  readonly notebooks: Pick<
    NotebookStore["Service"],
    "reserveFreshRun" | "freshSnapshot" | "saveFreshRun"
  >;
  readonly notebookOutputs: ReturnType<typeof makeComputeNotebookOutputs>;
}) {
  const { gateway, notebooks } = deps;
  const layout = { computeDir: deps.computeDir };

  type Request = NotebookFreshRunInput & { readonly threadId?: string };
  type Project = Effect.Success<ReturnType<typeof gateway.projectWithAdmission>>;
  type Snapshot = Effect.Success<ReturnType<typeof notebooks.freshSnapshot>>;
  type Attempt = {
    readonly sessionId: ComputeSessionId;
    readonly executionId: ComputeExecutionId;
    parameters?: ReadonlyArray<ComputeResultParameter>;
    failedCell?: ComputeExecutionRecord;
    cancelledCell?: ComputeExecutionRecord;
  };
  const projectForRun = (cwd: string) =>
    gateway
      .projectWithAdmission({ cwd })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ComputeResultsError({ message: "The project could not be opened.", cause }),
        ),
      );
  const jobKey = (project: Project, path: string) => {
    const scope = project.admission?.scope;
    return JSON.stringify([
      project.projectId,
      project.root,
      scope?.bindingId,
      scope?.authorityGeneration,
      path,
    ]);
  };
  const notebookPath = (project: Project, path: string) =>
    deps.workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: project.root, relativePath: path })
      .pipe(
        Effect.map(({ relativePath }) => relativePath),
        Effect.mapError(
          (cause) =>
            new ComputeResultsError({
              message: "Choose a notebook inside this project.",
              cause,
            }),
        ),
      );

  const execute = Effect.fn("NotebookRuns.execute")(function* (
    request: Request,
    project: Project,
    receipt: Snapshot,
    report: ReportNotebookJob,
    attempt?: Attempt,
  ) {
    const address = { cwd: project.root, path: request.scriptPath };
    const alternative = attempt === undefined;
    const setup = yield* Effect.tryPromise({
      try: () =>
        prepareResultRun(layout, {
          ...project,
          scriptPath: request.scriptPath,
          parameters: request.parameters,
          inputs: request.inputs,
        }),
      catch: (cause) =>
        new ComputeResultsError({
          message:
            cause instanceof Error ? cause.message : "The notebook inputs could not be read.",
          cause,
        }),
    });
    const overrides = Object.fromEntries(setup.parameters.map(({ name, value }) => [name, value]));
    const injectionId =
      receipt.cells.find((cell) => cell.injectedParameters)?.id ??
      NodeCrypto.randomUUID().slice(0, 12);
    const plan = yield* Effect.try({
      try: () => planNotebookRun(receipt, overrides, injectionId),
      catch: (cause) =>
        new ComputeResultsError({
          message:
            cause instanceof Error ? cause.message : "The notebook parameters could not be read.",
          cause,
        }),
    });
    const { parameterEnvironment, notebookSource } = plan;
    if (attempt !== undefined) attempt.parameters = plan.parameters;
    if (Buffer.byteLength(parameterEnvironment) > 30_000) {
      return {
        _tag: "failed" as const,
        message: "The parameters are too large to pass to the runtime.",
      };
    }
    const cells = plan.cells
      .filter((cell) => cell.source.trim() !== "")
      .map((cell, index) => ({
        cellId: cell.id,
        executionId:
          index === 0 && attempt !== undefined
            ? attempt.executionId
            : ComputeExecutionId.make(NodeCrypto.randomUUID()),
        code: cell.source,
      }));
    const firstCell = cells[0];
    const lastCell = cells.at(-1);
    if (firstCell === undefined || lastCell === undefined) {
      return { _tag: "failed" as const, message: "This notebook has no code to run." };
    }
    const plannedParameters = Object.fromEntries(
      plan.parameters.map(({ name, value }) => [name, value]),
    );
    report({
      parameters: plannedParameters,
      progress: { phase: "starting", cell: 0, total: cells.length },
    });
    const sessionId = attempt?.sessionId ?? ComputeSessionId.make(NodeCrypto.randomUUID());
    const executionId = firstCell.executionId;
    const sessionAddress = { cwd: project.root, sessionId };
    const stagingFolder = computeResultsStagingFolder(
      layout.computeDir,
      project.projectId,
      sessionId,
      executionId,
    );
    if (stagingFolder === null)
      return { _tag: "failed" as const, message: "This run could not name a results folder." };

    const operation = Effect.gen(function* () {
      yield* project.admission?.assertCurrent ?? Effect.void;
      const session = yield* gateway.startSession({
        ...sessionAddress,
        languageId: ComputeLanguageId.make(receipt.language),
        executable: null,
        owner: { _tag: "file", path: request.scriptPath },
        notebookRun: { executionId, parameters: parameterEnvironment },
      });
      const cellIds = new Map(cells.map(({ executionId, cellId }) => [executionId, cellId]));
      let completed = 0;
      let packages: ComputeSettledRun["packageEvidence"];
      const captured = yield* gateway.settledRuns.pipe(
        Stream.filter((run) => run.execution.request.sessionId === sessionId),
        Stream.take(cells.length),
        Stream.mapEffect(({ execution, packageEvidence }) => {
          packages = packageEvidence ?? packages;
          const { executionId } = execution.request;
          completed += 1;
          report({
            progress: {
              phase: "running",
              cell: Math.min(completed + 1, cells.length),
              total: cells.length,
            },
          });
          const output = alternative
            ? Effect.succeed({ outputs: [], executionCount: null, truncated: false })
            : deps.notebookOutputs({ ...sessionAddress, executionId });
          return output.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Notebook display output could not be copied", {
                executionId,
                cause,
              }).pipe(Effect.as({ outputs: [], executionCount: null, truncated: true })),
            ),
            Effect.map((output) => ({
              _tag: "run-result" as const,
              cellId: cellIds.get(executionId)!,
              run: notebookCellRun(execution),
              outputs: output.outputs,
              executionCount: output.executionCount ?? execution.result?.executionCount ?? null,
              truncated: output.truncated || execution.result?.truncated === true,
            })),
            Effect.ensuring(gateway.settledRunRecorded(executionId)),
          );
        }),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      report({ progress: { phase: "running", cell: 1, total: cells.length } });
      yield* gateway.submitCells({
        ...sessionAddress,
        expectedGeneration: session.generation,
        path: request.scriptPath,
        notebookRun: executionId,
        cells,
        ...(request.threadId === undefined
          ? {}
          : { actor: { _tag: "agent", threadId: request.threadId } }),
      });
      const { executions } = yield* Effect.gen(function* () {
        const executions = yield* gateway.listAllExecutions(sessionAddress);
        const current = yield* gateway.getSession(sessionAddress);
        return { executions, current };
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("200 millis"),
          until: ({ executions, current }) =>
            executions.some(
              (entry) =>
                entry.request.executionId === lastCell.executionId &&
                entry.result !== null &&
                TERMINAL_COMPUTE_EXECUTION_STATUSES.has(entry.result.status),
            ) ||
            current === null ||
            TERMINAL_COMPUTE_SESSION_STATUSES.has(current.status),
        }),
      );
      const byId = new Map(executions.map((entry) => [entry.request.executionId, entry]));
      const ran = cells.flatMap((cell) => {
        const record = byId.get(cell.executionId);
        return record === undefined ? [] : [record];
      });
      if (
        ran.length !== cells.length ||
        ran.some((entry) => entry.result?.status !== "succeeded")
      ) {
        const failure = ran.find((entry) => entry.result?.status === "failed");
        if (attempt !== undefined) {
          if (failure !== undefined) attempt.failedCell = failure;
          else {
            const cancelled = ran.find(
              (entry) => entry.result?.status === "cancelled" && entry.result.startedAt !== null,
            );
            if (cancelled !== undefined) attempt.cancelledCell = cancelled;
          }
        }
        return {
          _tag: "failed" as const,
          message:
            failure === undefined
              ? "The notebook stopped before all cells finished."
              : "A notebook cell failed. Open Compute history for its error.",
        };
      }

      // Copy each cell's transcript while later cells run. Once copied, storage can reclaim it.
      const results = yield* Fiber.join(captured);
      if (!report({ progress: { phase: "saving", cell: cells.length, total: cells.length } })) {
        return { _tag: "failed" as const, message: "The notebook run was stopped." };
      }
      const finish = ran.at(-1)?.result?.finishedAt ?? ran[0]!.request.submittedAt;
      const environment = mergeResultEnvironment(setup.environment, packages);
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* project.admission?.assertCurrent ?? Effect.void;
          const currentProject = yield* gateway.projectWithAdmission({ cwd: request.cwd });
          if (jobKey(currentProject, request.scriptPath) !== jobKey(project, request.scriptPath)) {
            return {
              _tag: "failed" as const,
              message: "The project changed during the notebook run.",
            };
          }
          const revision = yield* Effect.tryPromise({
            try: async () =>
              publishScriptRun(layout, {
                ...project,
                stagingFolder,
                scriptPath: request.scriptPath,
                kind: "notebook",
                ...(alternative ? { publication: "alternative" as const } : {}),
                ...setup,
                ...(environment === undefined ? {} : { environment }),
                parameters: plan.parameters,
                succeeded: true,
                language: session.label,
                code: notebookSource,
                sessionId,
                executionId,
                startedAt: ran[0]?.result?.startedAt ?? null,
                finishedAt: finish,
                threadId: request.threadId,
                runtime: {
                  executable: session.runtime?.executable ?? null,
                  version:
                    session.identity?.languageVersion ?? session.runtime?.languageVersion ?? null,
                  fingerprint: ran[0]?.request.environmentFingerprint?.hash ?? null,
                },
                reads: await mergedReads(ran),
              }),
            catch: (cause) =>
              new ComputeResultsError({
                message: "The notebook ran, but its results could not be published.",
                cause,
              }),
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Notebook results could not be published", {
                cause: error.cause,
              }).pipe(Effect.as({ _tag: "failed" as const, message: error.message })),
            ),
          );
          if (alternative && revision._tag === "failed") return revision;
          const notebookMessage = alternative
            ? undefined
            : yield* notebooks
                .saveFreshRun({
                  ...address,
                  snapshot: receipt.executionBasis,
                  injection: plan.injection,
                  parameterCellId: plan.parameterCellId,
                  parameters: plannedParameters,
                  overrides: plan.overrides,
                  codeSha256: notebookExecutionDigest(executedNotebookCells(notebookSource)),
                  executionId,
                  results,
                })
                .pipe(
                  Effect.match({ onSuccess: () => undefined, onFailure: (cause) => cause.message }),
                );
          if (revision._tag === "failed") {
            return {
              _tag: "completed" as const,
              notebookSaved: notebookMessage === undefined,
              ...(notebookMessage === undefined ? {} : { notebookMessage }),
              ...("empty" in revision && revision.empty === "nothing-written"
                ? {}
                : { message: revision.message }),
            };
          }
          if (!alternative) {
            const { counts } = yield* Effect.promise(() =>
              makeResultsReader(layout, project.projectId, project.root).published(
                revision.revision,
              ),
            );
            report({ publishedResults: counts });
          }
          const summary = summarizeRevision(
            revision.revision,
            [...revision.revision.inputs.files, ...(revision.revision.inputs.globs ?? [])].flatMap(
              (file) =>
                file.changedDuringRun
                  ? [{ kind: "input-changed-during-run" as const, path: file.path }]
                  : [],
            ),
          );
          return {
            _tag: "published" as const,
            summary,
            ...(alternative ? {} : { notebookSaved: notebookMessage === undefined }),
            ...(notebookMessage === undefined ? {} : { notebookMessage }),
          };
        }),
      );
    }).pipe(
      Effect.ensuring(
        gateway.getSession(sessionAddress).pipe(
          Effect.flatMap((current) =>
            current === null || TERMINAL_COMPUTE_SESSION_STATUSES.has(current.status)
              ? Effect.void
              : gateway.stopSession({
                  ...sessionAddress,
                  expectedGeneration: current.generation,
                }),
          ),

          Effect.ignore,
          Effect.andThen(
            Effect.forEach(cells, (cell) => gateway.settledRunRecorded(cell.executionId), {
              discard: true,
            }),
          ),
          Effect.andThen(
            Effect.promise(() =>
              NodeFSP.rm(stagingFolder, { recursive: true, force: true }).catch(() => undefined),
            ),
          ),
        ),
      ),
    );
    return yield* operation;
  });

  const runFresh = Effect.fn("NotebookRuns.runFresh")(function* (
    request: Request,
    project: Project,
    report: ReportNotebookJob,
  ) {
    const attempt: Attempt = {
      sessionId: ComputeSessionId.make(NodeCrypto.randomUUID()),
      executionId: ComputeExecutionId.make(NodeCrypto.randomUUID()),
    };
    const run = {
      projectId: project.projectId,
      scriptPath: request.scriptPath,
      sessionId: attempt.sessionId,
      executionId: attempt.executionId,
    };
    const address = { cwd: project.root, path: request.scriptPath };
    yield* project.admission?.assertCurrent ?? Effect.void;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => beginResultAttempt(layout, run),
        catch: (cause) =>
          new ComputeResultsError({
            message: "The notebook run could not be recorded.",
            cause,
          }),
      }),
      () =>
        Effect.gen(function* () {
          yield* notebooks.reserveFreshRun(address);
          const receipt = yield* notebooks.freshSnapshot(address);
          return yield* execute(request, project, receipt, report, attempt);
        }),
      (_, exit) =>
        Effect.gen(function* () {
          const finishedAt = DateTime.formatIso(yield* DateTime.now);
          const outcome = Exit.isSuccess(exit) ? exit.value : undefined;
          if (outcome !== undefined && outcome._tag !== "failed") {
            yield* Effect.tryPromise({
              try: async () => {
                if (outcome._tag === "completed" && outcome.notebookSaved) {
                  await clearResultFailuresThrough(layout, run, finishedAt);
                }
                await forgetResultAttempt(layout, run);
              },
              catch: (cause) =>
                new ComputeResultsError({
                  message: "The completed notebook attempt could not be cleared.",
                  cause,
                }),
            }).pipe(Effect.ignore({ log: true }));
            return;
          }
          const interrupted =
            attempt.cancelledCell !== undefined ||
            (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
          const history =
            interrupted && attempt.failedCell === undefined && attempt.cancelledCell === undefined
              ? yield* gateway
                  .listAllExecutions({ cwd: project.root, sessionId: run.sessionId })
                  .pipe(Effect.orElseSucceed(() => []))
              : [];
          const execution =
            attempt.failedCell ??
            attempt.cancelledCell ??
            history.find(
              (entry) => entry.result?.status === "cancelled" && entry.result.startedAt !== null,
            );
          const source = execution?.request.source;
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          const message = interrupted
            ? "The notebook run was stopped."
            : execution?.result?.failureReason ||
              outcome?.message ||
              (error instanceof Error ? error.message : "The notebook could not run.");
          yield* Effect.tryPromise({
            try: () =>
              recordFailedResultAttempt(layout, run, {
                status: interrupted ? "cancelled" : "failed",
                finishedAt: execution?.result?.finishedAt ?? finishedAt,
                message,
                hasExecution: execution !== undefined,
                ...(source?._tag === "document" && source.cell !== undefined
                  ? { cellId: source.cell }
                  : {}),
                ...(execution === undefined
                  ? {}
                  : { cellExecutionId: execution.request.executionId }),
                ...(attempt.parameters === undefined ? {} : { parameters: attempt.parameters }),
              }),
            catch: (cause) =>
              new ComputeResultsError({
                message: "The notebook attempt could not be recorded.",
                cause,
              }),
          }).pipe(Effect.ignore({ log: true }));
        }),
    );
  });

  const start = Effect.fn("NotebookRuns.start")(function* (input: Request) {
    const project = yield* projectForRun(input.cwd);
    const scriptPath = yield* notebookPath(project, input.scriptPath);
    const request = { ...input, scriptPath };
    if (!scriptPath.toLowerCase().endsWith(".ipynb")) {
      return yield* new ComputeResultsError({ message: "Choose a saved .ipynb notebook." });
    }
    if (request.sweep !== undefined && request.parameters !== undefined) {
      return yield* new ComputeResultsError({
        message: "Choose one parameter setting or a sweep.",
      });
    }
    const job = Effect.fn("NotebookRuns.job")(
      function* (report: ReportNotebookJob) {
        if (request.sweep === undefined) return yield* runFresh(request, project, report);
        yield* project.admission?.assertCurrent ?? Effect.void;
        const address = { cwd: project.root, path: request.scriptPath };
        yield* notebooks.reserveFreshRun(address);
        const receipt = yield* notebooks.freshSnapshot(address);
        let last: ComputeResultsRerunResult = { _tag: "failed", message: "No settings were run." };
        let saved = 0;
        const failures: NonNullable<NotebookFreshRun["sweepSummary"]>["failures"][number][] = [];
        for (const [index, parameters] of request.sweep.entries()) {
          if (
            !report({
              parameters,
              progress: { phase: "starting", cell: 0, total: 0 },
            })
          )
            break;
          const result = yield* execute({ ...request, parameters }, project, receipt, report).pipe(
            Effect.catch((cause) =>
              Effect.succeed({ _tag: "failed" as const, message: cause.message }),
            ),
          );
          if (result._tag === "published") {
            last = result;
            saved += 1;
          } else {
            failures.push({
              index,
              parameters,
              message: result.message ?? "The notebook did not publish results.",
            });
            if (saved === 0) last = result;
          }
          report({ sweepSummary: { total: request.sweep.length, saved, failures: [...failures] } });
        }
        return last;
      },
      Effect.scoped,
      Effect.mapError((cause) =>
        isComputeResultsError(cause)
          ? cause
          : new ComputeResultsError({ message: cause.message, cause }),
      ),
    );
    const parameters = request.parameters ?? request.sweep?.[0];
    return yield* deps.jobs.start(jobKey(project, request.scriptPath), job, {
      ...(parameters === undefined ? {} : { parameters }),
      progress: { phase: "starting", cell: 0, total: 0 },
    });
  });
  const status = Effect.fn("NotebookRuns.status")(function* (request: NotebookFreshRunStatusInput) {
    const project = yield* projectForRun(request.cwd);
    const scriptPath = yield* notebookPath(project, request.scriptPath);
    return yield* deps.jobs.status(jobKey(project, scriptPath), request.runId);
  });
  const watch = Effect.fn("NotebookRuns.watch")(function* (
    request: NotebookFreshRunSubscribeInput,
  ) {
    return yield* gateway
      .watchProject(request, (project) =>
        Stream.unwrap(
          notebookPath(project, request.scriptPath).pipe(
            Effect.map((path) => deps.jobs.watch(jobKey(project, path))),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ComputeResultsError({ message: "The project could not be opened.", cause }),
        ),
      );
  });
  const stop = Effect.fn("NotebookRuns.stop")(function* (request: NotebookFreshRunStopInput) {
    const project = yield* projectForRun(request.cwd);
    const scriptPath = yield* notebookPath(project, request.scriptPath);
    yield* (
      project.admission?.assertCurrent.pipe(
        Effect.mapError(
          (cause) =>
            new ComputeResultsError({
              message: "The project changed before the notebook run could be stopped.",
              cause,
            }),
        ),
      ) ?? Effect.void
    );
    return yield* deps.jobs.stop(jobKey(project, scriptPath), request.runId);
  });
  const wait = Effect.fn("NotebookRuns.wait")(function* (
    request: NotebookFreshRunStatusInput & { readonly runId: ComputeSessionId },
  ) {
    const project = yield* projectForRun(request.cwd);
    const scriptPath = yield* notebookPath(project, request.scriptPath);
    return yield* deps.jobs.wait(jobKey(project, scriptPath), request.runId);
  });
  const run = Effect.fn("NotebookRuns.run")(function* (request: Request) {
    const { runId, outcome } = yield* start(request);
    return outcome ?? (yield* wait({ ...request, runId }));
  });

  return { start, status, watch, stop, wait, run };
}
