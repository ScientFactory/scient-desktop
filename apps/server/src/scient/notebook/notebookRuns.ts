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
  type ComputeResultsRerunResult,
  type NotebookFreshRunInput,
  type NotebookFreshRun,
  type NotebookFreshRunStatusInput,
  type NotebookFreshRunStopInput,
  type NotebookFreshRunSubscribeInput,
} from "@t3tools/contracts";
import { notebookCellRun } from "@t3tools/shared/notebookStaleness";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import { computeResultsStagingFolder } from "../compute/LocalComputeStore.ts";
import {
  prepareResultRun,
  publishScriptRun,
  summarizeRevision,
  type SettledScriptRun,
} from "../results/resultRevisions.ts";
import type { NotebookRunJobs, ReportNotebookJob } from "./NotebookRunJobs.ts";
import type { NotebookStore } from "./NotebookStore.ts";
import type { WorkspacePaths } from "../../workspace/WorkspacePaths.ts";
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
    alternative = false,
  ) {
    const address = { cwd: project.root, path: request.scriptPath };
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
    const { parameterEnvironment } = plan;
    if (Buffer.byteLength(parameterEnvironment) > 30_000) {
      return {
        _tag: "failed" as const,
        message: "The parameters are too large to pass to the runtime.",
      };
    }
    const cells = plan.cells
      .filter((cell) => cell.source.trim() !== "")
      .map((cell) => ({
        cellId: cell.id,
        executionId: ComputeExecutionId.make(NodeCrypto.randomUUID()),
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
    const sessionId = ComputeSessionId.make(NodeCrypto.randomUUID());
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
      const captured = yield* gateway.settledRuns.pipe(
        Stream.filter((run) => run.execution.request.sessionId === sessionId),
        Stream.take(cells.length),
        Stream.mapEffect(({ execution }) => {
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
      const code = plan.cells.map(({ source }) => source).join("\n");
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
                codeSha256: NodeCrypto.createHash("sha256")
                  .update(
                    receipt.cells
                      .filter((cell) => cell.cellType === "code" && !cell.injectedParameters)
                      .map((cell) => cell.source)
                      .join("\n"),
                  )
                  .digest("hex"),
                ...setup,
                parameters: plan.parameters,
                succeeded: true,
                language: session.label,
                code,
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
          });
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
                  codeSha256: NodeCrypto.createHash("sha256").update(code).digest("hex"),
                  executionId,
                  results,
                })
                .pipe(
                  Effect.match({ onSuccess: () => undefined, onFailure: (cause) => cause.message }),
                );
          if (revision._tag === "failed") {
            const status =
              notebookMessage === undefined ? "The notebook was saved." : notebookMessage;
            return { ...revision, message: `${status} ${revision.message}` };
          }
          if (!alternative) report({ publishedResults: revision.revision.outputs.length });
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
        yield* project.admission?.assertCurrent ?? Effect.void;
        const address = { cwd: project.root, path: request.scriptPath };
        yield* notebooks.reserveFreshRun(address);
        const receipt = yield* notebooks.freshSnapshot(address);
        if (request.sweep === undefined) return yield* execute(request, project, receipt, report);
        let last: ComputeResultsRerunResult = { _tag: "failed", message: "No settings were run." };
        let saved = 0;
        const failures: NonNullable<NotebookFreshRun["sweepSummary"]>["failures"][number][] = [];
        for (const [index, parameters] of request.sweep.entries()) {
          report({ parameters, progress: { phase: "starting", cell: 0, total: 0 } });
          const result = yield* execute(
            { ...request, parameters },
            project,
            receipt,
            report,
            true,
          ).pipe(
            Effect.catch((cause) =>
              Effect.succeed({ _tag: "failed" as const, message: cause.message }),
            ),
          );
          if (result._tag === "published") {
            last = result;
            saved += 1;
          } else {
            failures.push({ index, parameters, message: result.message });
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
