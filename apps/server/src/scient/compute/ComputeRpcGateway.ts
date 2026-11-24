// @effect-diagnostics nodeBuiltinImport:off -- environment inspection needs a stable host cwd.
import * as NodeOS from "node:os";

import { inspectScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import {
  computeNotebookBatchActivity,
  computeNotebookCellNotRun,
  ComputeExecutionId,
  ComputeProjectId,
  ComputeOperationError,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeLanguageId,
  type ComputeExecutionRecord,
  type ComputeSourceRange,
  type ComputeStartSessionInput,
} from "@scientfactory/compute";
import {
  ComputeGatewayError,
  type ComputeAddPythonLibraryInput,
  type ComputeInspectRuntimesInput,
  type ComputeListProjectExecutionsInput,
  type ComputeListProjectOutputsInput,
  type ComputeManagedRuntimeInput,
  type ComputeManagedRuntimeStatusInput,
  type ComputeProjectExecutionCommandInput,
  type ComputeProjectInput,
  type ComputeProjectSessionCommandInput,
  type ComputeStopProjectSessionInput,
  type ComputeProjectSessionInput,
  type ComputeStartProjectSessionInput,
  type ComputeSubmitProjectCellsInput,
  type ComputeSubmitProjectExecutionInput,
  type ComputeTableInput,
  type ComputeRuntimeInventoryInput,
  type ComputeRunHistoryInput,
  type ComputeRunHistoryResult,
  type AnalysisRunSummary,
  type ComputeVerifyRuntimeInput,
  resolveScientificComputingLanguageSettings,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import { COMPUTE_LANGUAGE_CATALOG, type ServerSettingsError } from "@t3tools/contracts";
import { analysisRunHistoryCursor } from "../analysis/AnalysisRunIndex.ts";
import type { AnalysisService } from "../analysis/AnalysisService.ts";
import type { LocalAnalysisStoreError } from "../analysis/LocalAnalysisStore.ts";
import type { ComputeSessionService } from "./ComputeSessionService.ts";
import type { ComputeHistoryExecutionRef } from "./LocalComputeStore.ts";
import type { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import {
  ComputeWorkspaceAdmission,
  type ComputeWorkspaceReceipt,
} from "./ComputeWorkspaceAdmission.ts";
import { notebookPathAllowed } from "../notebook/NotebookStore.ts";

interface BoundComputeProject {
  readonly projectId: ComputeProjectId;
  readonly root: string;
  readonly admission: ComputeWorkspaceReceipt | null;
}

type ComputeGatewayService = Pick<
  ComputeSessionService["Service"],
  | "activeWork"
  | "runtimeDescriptors"
  | "runtimeInventory"
  | "inspectRuntimes"
  | "verifyRuntime"
  | "managedRuntimeStatus"
  | "manageRuntime"
  | "cancelManagedRuntime"
  | "addPythonLibrary"
  | "startSession"
  | "listSessions"
  | "getSession"
  | "listExecutions"
  | "historyExecutionRefs"
  | "historyExecutions"
  | "listOutputs"
  | "submitExecution"
  | "submitExecutions"
  | "cancelExecution"
  | "interruptSession"
  | "restartSession"
  | "stopSession"
  | "inspectVariables"
  | "readTable"
  | "subscribeSessions"
  | "settledRuns"
  | "settledRunRecorded"
>;
type ComputeGatewaySettings = {
  readonly getSettings: Effect.Effect<
    ServerSettingsValue,
    ServerSettingsError | LocalAnalysisStoreError
  >;
  readonly hostKey?: Effect.Effect<string | null>;
  /** This machine's choice for one project, which wins over its host default. */
  readonly projectExecutable?: (
    languageId: string,
    projectId: string,
  ) => Effect.Effect<string | null, ServerSettingsError>;
};
type ComputeGatewayWorkspace = Pick<WorkspaceFileSystem.WorkspaceFileSystem["Service"], "readFile">;

type GatewayOperation = ComputeGatewayError["operation"];
type GatewayReason = ComputeGatewayError["reason"];

function gatewayError(
  operation: GatewayOperation,
  reason: GatewayReason,
  message: string,
  cause?: unknown,
): ComputeGatewayError {
  return new ComputeGatewayError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function makeComputeRpcGateway(input: {
  readonly compute: ComputeGatewayService;
  readonly serverSettings: ComputeGatewaySettings;
  readonly workspaceFileSystem: ComputeGatewayWorkspace;
  readonly workspaceResolver?: WorkspaceBindingResolver["Service"];
}) {
  const inWorkspace =
    <I extends { readonly cwd: string | null }, A, E, R>(
      operation: GatewayOperation,
      action: (request: I) => Effect.Effect<A, E, R>,
    ) =>
    (request: I) =>
      Effect.gen(function* () {
        if (request.cwd === null) return yield* action(request);
        if (!input.workspaceResolver)
          return yield* gatewayError(
            operation,
            "operation-failed",
            "Workspace authority is unavailable.",
          );
        const resolver = input.workspaceResolver;
        const resolved = yield* resolver
          .resolveWorkspaceRoot(request.cwd)
          .pipe(
            Effect.mapError((cause) =>
              gatewayError(
                operation,
                "operation-failed",
                "The project workspace could not be verified.",
                cause,
              ),
            ),
          );
        const scope = {
          bindingId: resolved.binding.bindingId,
          authorityGeneration: resolved.binding.authorityGeneration,
          workspaceRoot: resolved.binding.canonicalRoot,
          scopeRevision: resolved.scopeRevision,
        };
        const assertCurrent = resolver.assertCurrentWorkspaceScope(scope).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new ComputeOperationError({
                operation: "resolve",
                reason: "workspace-changed",
                message:
                  "The project workspace changed. Reopen Compute from the current workspace.",
                cause,
              }),
          ),
        );
        yield* assertCurrent;
        return yield* action(request).pipe(
          Effect.provideService(ComputeWorkspaceAdmission, { scope, assertCurrent }),
        );
      });
  const readSettings = (operation: GatewayOperation) =>
    input.serverSettings.getSettings.pipe(
      Effect.mapError((cause) =>
        gatewayError(
          operation,
          "settings-failed",
          "Unable to read scientific computing settings.",
          cause,
        ),
      ),
    );

  const projectFor = Effect.fn("ComputeRpcGateway.projectFor")(function* (
    operation: GatewayOperation,
    cwd: string,
  ) {
    const admission = yield* ComputeWorkspaceAdmission;
    const project = yield* Effect.tryPromise({
      try: async () => {
        const inspection = await inspectScientProject(admission?.scope.workspaceRoot ?? cwd);
        if (inspection.state !== "initialized") {
          // Any registered folder can run code; history then belongs to its workspace binding.
          return admission === null || admission === undefined
            ? null
            : {
                root: admission.scope.workspaceRoot,
                projectId: ComputeProjectId.make(admission.scope.bindingId),
              };
        }
        if (admission && inspection.root !== admission.scope.workspaceRoot) return null;
        const identity = await readScientProjectIdentity(inspection.root);
        return { root: inspection.root, projectId: ComputeProjectId.make(identity.projectId) };
      },
      catch: (cause) =>
        gatewayError(
          operation,
          "operation-failed",
          "Unable to inspect the Scient project identity.",
          cause,
        ),
    });
    if (project !== null) return project;
    return yield* gatewayError(
      operation,
      "project-not-initialized",
      "Initialize this folder as a Scient project before starting a compute session.",
    );
  });

  const boundProject = Effect.fn("ComputeRpcGateway.boundProject")(function* (
    operation: GatewayOperation,
    request: { readonly cwd: string },
  ): Effect.fn.Return<BoundComputeProject, ComputeGatewayError> {
    const project = yield* projectFor(operation, request.cwd);
    return { ...project, admission: yield* ComputeWorkspaceAdmission };
  });

  const requireLanguage = Effect.fn("ComputeRpcGateway.requireLanguage")(function* (
    operation: GatewayOperation,
    languageId: ComputeLanguageId,
  ) {
    const descriptor = input.compute.runtimeDescriptors.find(
      (candidate) => candidate.languageId === languageId,
    );
    if (descriptor === undefined) {
      return yield* gatewayError(
        operation,
        "language-unavailable",
        `This Scient build does not provide the '${languageId}' compute adapter.`,
      );
    }
    const settings = yield* readSettings(operation);
    const preference = resolveScientificComputingLanguageSettings(
      settings.scientificComputing,
      languageId,
    );
    return { descriptor, preference };
  });

  const projectExecutables = Effect.fn("ComputeRpcGateway.projectExecutables")(function* (
    operation: GatewayOperation,
    projectId: string | null,
    languageIds: ReadonlyArray<string>,
  ) {
    const lookup = input.serverSettings.projectExecutable;
    if (lookup === undefined || projectId === null) return {};
    const entries = yield* Effect.forEach(languageIds, (languageId) =>
      lookup(languageId, projectId).pipe(
        Effect.map((executable) => [languageId, executable] as const),
        Effect.mapError((cause) =>
          gatewayError(
            operation,
            "settings-failed",
            "Unable to read the project's runtime.",
            cause,
          ),
        ),
      ),
    );
    return Object.fromEntries(entries.filter(([, executable]) => executable !== null)) as Record<
      string,
      string
    >;
  });

  const runtimeInventory = Effect.fn("ComputeRpcGateway.runtimeInventory")(function* (
    request: ComputeRuntimeInventoryInput = {},
  ) {
    const settings = yield* readSettings("inspect");
    const hostKey =
      input.serverSettings.hostKey === undefined ? null : yield* input.serverSettings.hostKey;
    const languageIds = new Set([
      ...input.compute.runtimeDescriptors.map((descriptor) => descriptor.languageId),
      ...COMPUTE_LANGUAGE_CATALOG.flatMap((group) =>
        group.languages.map((language) => language.languageId as ComputeLanguageId),
      ),
    ]);
    const preferences = Object.fromEntries(
      [...languageIds].map((languageId) => [
        languageId,
        resolveScientificComputingLanguageSettings(settings.scientificComputing, languageId),
      ]),
    );
    const { languages, incomplete } = yield* input.compute.runtimeInventory({
      configuredExecutables: Object.fromEntries(
        Object.entries(preferences).map(([id, preference]) => [id, preference.executable || null]),
      ),
      ...(request.refresh === undefined ? {} : { refresh: request.refresh }),
    });
    return {
      languages: languages.map((language) => ({
        ...language,
        enabled: true,
        configuredExecutable: preferences[language.descriptor.languageId]?.executable || null,
      })),
      ...(incomplete ? { incomplete } : {}),
      ...(hostKey === null ? {} : { hostKey }),
    };
  });

  const inspectRuntimes = Effect.fn("ComputeRpcGateway.inspectRuntimes")(function* (
    request: ComputeInspectRuntimesInput,
  ) {
    const settings = yield* readSettings("inspect");
    const project = request.cwd === null ? null : yield* projectFor("inspect", request.cwd);
    const preferences = Object.fromEntries(
      input.compute.runtimeDescriptors.map((descriptor) => [
        descriptor.languageId,
        resolveScientificComputingLanguageSettings(
          settings.scientificComputing,
          descriptor.languageId,
        ),
      ]),
    );
    const projectChoices = yield* projectExecutables(
      "inspect",
      project?.projectId ?? null,
      Object.keys(preferences),
    );
    for (const [languageId, executable] of Object.entries(projectChoices))
      preferences[languageId] = { ...preferences[languageId]!, executable };
    const inspected = yield* input.compute.inspectRuntimes({
      projectRoot: project?.root ?? null,
      workingDirectory: project?.root ?? NodeOS.tmpdir(),
      configuredExecutables: Object.fromEntries(
        Object.entries(preferences).map(([languageId, preference]) => [
          languageId,
          preference.executable.length === 0 ? null : preference.executable,
        ]),
      ),
      chosenForProject: new Set(Object.keys(projectChoices)),
      refresh: request.refresh,
      ...(request.languageIds === undefined ? {} : { languageIds: new Set(request.languageIds) }),
    });
    return {
      contractVersion: 1 as const,
      scope: project === null ? ("environment" as const) : ("project" as const),
      languages: inspected.map((language) => ({
        ...language,
        enabled: true,
        managedRuntime: language.managedRuntime ?? null,
        configuredExecutable: preferences[language.descriptor.languageId]?.executable || null,
      })),
    };
  });

  const verifyRuntime = Effect.fn("ComputeRpcGateway.verifyRuntime")(function* (
    request: ComputeVerifyRuntimeInput,
  ) {
    yield* requireLanguage("verify", request.languageId);
    const project = request.cwd === null ? null : yield* projectFor("verify", request.cwd);
    const executable = request.executable.trim();
    if (executable.length === 0) {
      return yield* gatewayError(
        "verify",
        "runtime-not-found",
        "Choose a detected runtime or enter an executable path to verify.",
      );
    }
    return yield* input.compute.verifyRuntime({
      languageId: request.languageId,
      executable,
      workingDirectory: project?.root ?? NodeOS.tmpdir(),
      refresh: true,
    });
  });

  const managedRuntimeStatus = Effect.fn("ComputeRpcGateway.managedRuntimeStatus")(function* (
    request: ComputeManagedRuntimeStatusInput,
  ) {
    return yield* input.compute.managedRuntimeStatus(request.languageId);
  });

  const manageRuntime = Effect.fn("ComputeRpcGateway.manageRuntime")(function* (
    request: ComputeManagedRuntimeInput,
  ) {
    return yield* input.compute.manageRuntime(request.languageId, request.action, {
      ...(request.toolkitIds === undefined ? {} : { toolkitIds: request.toolkitIds }),
      ...(request.toolkitChange === undefined ? {} : { toolkitChange: request.toolkitChange }),
      ...(request.selectionAfterInstall === undefined
        ? {}
        : { selectionAfterInstall: request.selectionAfterInstall }),
    });
  });

  const cancelManagedRuntime = Effect.fn("ComputeRpcGateway.cancelManagedRuntime")(function* (
    request: ComputeManagedRuntimeStatusInput,
  ) {
    return yield* input.compute.cancelManagedRuntime(request.languageId);
  });

  const addPythonLibrary = Effect.fn("ComputeRpcGateway.addPythonLibrary")(function* (
    request: ComputeAddPythonLibraryInput,
  ) {
    const project = yield* projectFor("manage", request.cwd);
    return yield* input.compute.addPythonLibrary({
      projectId: project.projectId,
      sessionId: request.sessionId,
      distribution: request.distribution,
    });
  });

  const startSession = Effect.fn("ComputeRpcGateway.startSession")(function* (
    request: ComputeStartProjectSessionInput &
      Pick<ComputeStartSessionInput, "notebookRun"> & { readonly publishResults?: false },
  ) {
    const project = yield* projectFor("start", request.cwd);
    const { descriptor, preference: hostPreference } = yield* requireLanguage(
      "start",
      request.languageId,
    );
    const projectChoice = (yield* projectExecutables("start", project.projectId, [
      request.languageId,
    ]))[request.languageId];
    const preference =
      projectChoice === undefined
        ? hostPreference
        : { ...hostPreference, executable: projectChoice };
    const savedFile =
      request.runOnce === undefined ? null : yield* validateSource(project.root, request.runOnce);
    // Only the whole saved file run from scratch is a recipe someone can rerun.
    const wholeSavedFile =
      savedFile !== null &&
      request.runOnce?.source._tag === "document" &&
      request.runOnce.source.origin === "file" &&
      request.runOnce.code === savedFile;
    if (
      !wholeSavedFile &&
      (request.runOnce?.inputs !== undefined || request.runOnce?.parameters !== undefined)
    ) {
      return yield* gatewayError(
        "start",
        "source-invalid",
        "Save the whole script before running it with parameters or declared inputs.",
      );
    }
    return yield* input.compute.startSession({
      projectId: project.projectId,
      sessionId: request.sessionId,
      languageId: request.languageId,
      label: descriptor.displayName,
      ...(request.owner === undefined ? {} : { owner: request.owner }),
      workingDirectory: project.root,
      configuredExecutable: preference.executable.length === 0 ? null : preference.executable,
      ...(projectChoice === undefined ? {} : { chosenForProject: true }),
      ...(request.executable === null ? {} : { requestedExecutable: request.executable }),
      ...(request.notebookRun === undefined ? {} : { notebookRun: request.notebookRun }),
      ...(request.runOnce === undefined
        ? {}
        : {
            runOnce: {
              ...request.runOnce,
              ...(wholeSavedFile && request.publishResults !== false
                ? { publishResults: true }
                : {}),
            },
          }),
    });
  });

  const listSessions = Effect.fn("ComputeRpcGateway.listSessions")(function* (
    request: ComputeProjectInput,
  ) {
    const project = yield* projectFor("list", request.cwd);
    const sessions = yield* input.compute.listSessions({ projectId: project.projectId });
    const recent = new Set(sessions.slice(-100).map((session) => session.sessionId));
    // History is bounded; live owners must never disappear behind newer history.
    return sessions
      .filter(
        (session) =>
          !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status) || recent.has(session.sessionId),
      )
      .toReversed();
  });

  const getSession = Effect.fn("ComputeRpcGateway.getSession")(function* (
    request: ComputeProjectSessionInput,
  ) {
    const project = yield* projectFor("get", request.cwd);
    return yield* input.compute.getSession({
      projectId: project.projectId,
      sessionId: request.sessionId,
    });
  });

  const listAllExecutions = Effect.fn("ComputeRpcGateway.listAllExecutions")(function* (
    request: ComputeProjectSessionInput,
  ) {
    const project = yield* projectFor("list", request.cwd);
    return yield* input.compute.listExecutions({
      projectId: project.projectId,
      sessionId: request.sessionId,
    });
  });

  const listExecutions = Effect.fn("ComputeRpcGateway.listExecutions")(function* (
    request: ComputeListProjectExecutionsInput,
  ) {
    const executions = yield* listAllExecutions(request);
    return executions.slice(-request.limit);
  });

  const runHistory = Effect.fn("ComputeRpcGateway.runHistory")(function* (
    request: ComputeRunHistoryInput,
    listFileRuns?: AnalysisService["Service"]["listRuns"],
  ) {
    const project = yield* projectFor("list", request.cwd);
    const sessions = yield* input.compute.listSessions({
      projectId: project.projectId,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    });
    const historyPosition = (execution: ComputeHistoryExecutionRef) => {
      const { source, submittedAt, executionId } = execution;
      const cellIndex =
        request.notebookBatchId !== undefined && source._tag === "document"
          ? source.notebookBatch?.index
          : undefined;
      return { submittedAt, executionId, ...(cellIndex === undefined ? {} : { cellIndex }) };
    };
    interface HistoryPosition {
      readonly submittedAt: string;
      readonly executionId: string;
      readonly cellIndex?: number;
    }
    const compare = (left: HistoryPosition, right: HistoryPosition) =>
      (left.cellIndex !== undefined && right.cellIndex !== undefined
        ? left.cellIndex - right.cellIndex
        : 0) ||
      right.submittedAt.localeCompare(left.submittedAt) ||
      (right.executionId > left.executionId ? 1 : right.executionId < left.executionId ? -1 : 0);
    const filter = request.filter?.trim().toLowerCase();
    const before = request.before;
    const groupBatches =
      request.notebookBatchId === undefined &&
      request.executionId === undefined &&
      request.path === undefined;
    const bySession = yield* Effect.forEach(
      sessions.filter(
        (session) => request.sessionId === undefined || request.sessionId === session.sessionId,
      ),
      Effect.fnUntraced(function* (session) {
        const target = { projectId: project.projectId, sessionId: session.sessionId };
        const direct =
          request.executionId === undefined
            ? null
            : (yield* input.compute.historyExecutions({
                ...target,
                executionIds: [request.executionId],
              }))[0];
        const refs =
          direct === null
            ? yield* input.compute.historyExecutionRefs(target)
            : direct === undefined
              ? []
              : [direct.request];
        type Candidate = {
          readonly session: typeof session;
          readonly ref: ComputeHistoryExecutionRef;
          readonly batch?: ReadonlyArray<ComputeHistoryExecutionRef>;
          readonly direct?: ComputeExecutionRecord;
        };
        const rows: Candidate[] = [];
        const groups = new Map<string, ComputeHistoryExecutionRef[]>();
        for (const ref of refs) {
          const { source } = ref;
          const path = source._tag === "document" ? source.path : undefined;
          const batch = source._tag === "document" ? source.notebookBatch : undefined;
          if (
            (request.notebookBatchId !== undefined && batch?.id !== request.notebookBatchId) ||
            (request.path !== undefined && path !== request.path) ||
            (filter && path?.toLowerCase().includes(filter) !== true)
          )
            continue;
          if (batch !== undefined && groupBatches) {
            const group = groups.get(batch.id);
            if (group === undefined) groups.set(batch.id, [ref]);
            else group.push(ref);
          } else {
            rows.push({ session, ref, ...(direct ? { direct } : {}) });
          }
        }
        for (const [batchId, cells] of groups) {
          const ref =
            cells.find((cell) => cell.executionId === batchId) ??
            cells.reduce((oldest, cell) =>
              compare(historyPosition(cell), historyPosition(oldest)) > 0 ? cell : oldest,
            );
          rows.push({ session, ref, batch: cells });
        }
        let previousCell =
          request.notebookBatchId === undefined || before === undefined
            ? undefined
            : refs.find(({ executionId }) => executionId === before.executionId);
        if (
          previousCell === undefined &&
          direct &&
          request.notebookBatchId !== undefined &&
          before !== undefined
        ) {
          const previous = (yield* input.compute.historyExecutions({
            ...target,
            executionIds: [ComputeExecutionId.make(before.executionId)],
          }))[0];
          previousCell = previous?.request;
        }
        const boundary = previousCell === undefined ? before : historyPosition(previousCell);
        return rows
          .filter(
            ({ ref }) => boundary === undefined || compare(historyPosition(ref), boundary) > 0,
          )
          .toSorted((left, right) => compare(historyPosition(left.ref), historyPosition(right.ref)))
          .slice(0, request.limit + 1);
      }),
      { concurrency: 4 },
    );
    const fileRuns: AnalysisRunSummary[] = [];
    if (
      listFileRuns !== undefined &&
      request.path === undefined &&
      request.sessionId === undefined &&
      request.executionId === undefined &&
      request.notebookBatchId === undefined
    ) {
      let cursor =
        before === undefined
          ? undefined
          : analysisRunHistoryCursor(before.submittedAt, before.executionId);
      do {
        const page = yield* listFileRuns({
          cwd: project.root,
          limit: Math.min(request.limit + 1, 100),
          ...(cursor === undefined ? {} : { cursor }),
        }).pipe(
          Effect.mapError((cause) =>
            gatewayError("list", "operation-failed", cause.message, cause),
          ),
        );
        fileRuns.push(
          ...page.runs.filter(
            (run) => !filter || run.source.relativePath.toLowerCase().includes(filter),
          ),
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined && fileRuns.length <= request.limit);
    }
    const matches = [
      ...bySession.flat().map((row) => ({
        ...historyPosition(row.ref),
        row,
        kind: "session" as const,
      })),
      ...fileRuns.map((row) => ({
        submittedAt: row.receipt.startedAt,
        executionId: row.receipt.runId,
        row,
        kind: "file" as const,
      })),
    ].toSorted(compare);
    const page = matches.slice(0, request.limit);
    const last = page.at(-1);
    const runs = yield* Effect.forEach(
      page.flatMap((entry) => (entry.kind === "session" ? [entry.row] : [])),
      Effect.fnUntraced(function* ({ session, ref, batch, direct }) {
        const source = ref.source;
        const group =
          batch !== undefined && source._tag === "document" ? source.notebookBatch : undefined;
        const settled =
          group !== undefined && session.lastNotebookBatch?.id === group.id
            ? session.lastNotebookBatch
            : undefined;
        const executionIds =
          group !== undefined && settled === undefined
            ? batch!.map(({ executionId }) => executionId)
            : [ref.executionId];
        const cells =
          direct === undefined
            ? yield* input.compute.historyExecutions({
                projectId: project.projectId,
                sessionId: session.sessionId,
                executionIds,
              })
            : [direct];
        const execution = cells.find(({ request }) => request.executionId === ref.executionId);
        if (execution === undefined) return null;
        if (settled !== undefined) return { session, execution, notebookBatch: settled };
        if (group === undefined) return { session, execution };

        const { id, mode, count } = group;
        const { currentCell, active } = computeNotebookBatchActivity(cells, id);
        const statuses = new Set(cells.map((cell) => cell.result?.status ?? "queued"));
        const failedCell = cells.reduce<number | undefined>((first, cell) => {
          const source = cell.request.source;
          const index = source._tag === "document" ? source.notebookBatch?.index : undefined;
          return cell.result?.status === "failed" && index !== undefined
            ? Math.min(first ?? Infinity, index + 1)
            : first;
        }, undefined);
        const notRun = cells.filter(computeNotebookCellNotRun).length;
        const cellStatus =
          (
            [
              "interrupting",
              "running",
              "submitting",
              "queued",
              "failed",
              "lost",
              "cancelled",
              "succeeded",
            ] as const
          ).find((candidate) => statuses.has(candidate)) ?? "queued";
        const status =
          mode === "all" &&
          currentCell > 0 &&
          (cellStatus === "queued" || cellStatus === "submitting" || cellStatus === "running")
            ? "running"
            : cellStatus;
        return {
          session,
          execution,
          notebookBatch: {
            id,
            mode,
            count,
            status,
            ...(currentCell > 0 && (status === "running" || status === "interrupting")
              ? { currentCell }
              : {}),
            ...(failedCell === undefined ? {} : { failedCell }),
            ...(notRun === 0 ? {} : { notRun }),
            ...(active === undefined ? {} : { active }),
          },
        };
      }),
      { concurrency: 4 },
    );
    return {
      runs: runs.filter((row) => row !== null),
      fileRuns: page.flatMap((entry) => (entry.kind === "file" ? [entry.row] : [])),
      next:
        matches.length > page.length && last !== undefined
          ? { submittedAt: last.submittedAt, executionId: last.executionId }
          : null,
    } satisfies ComputeRunHistoryResult;
  });

  const listOutputs = Effect.fn("ComputeRpcGateway.listOutputs")(function* (
    request: ComputeListProjectOutputsInput,
  ) {
    const project = yield* projectFor("outputs", request.cwd);
    return yield* input.compute.listOutputs({
      projectId: project.projectId,
      sessionId: request.sessionId,
      executionId: request.executionId,
    });
  });

  const validateSource = Effect.fn("ComputeRpcGateway.validateSource")(function* (
    projectRoot: string,
    request: Pick<ComputeSubmitProjectExecutionInput, "source" | "code">,
  ) {
    const source = request.source;
    if (source._tag === "document") {
      const file = yield* input.workspaceFileSystem
        .readFile({ cwd: projectRoot, relativePath: source.path })
        .pipe(
          Effect.mapError((cause) =>
            gatewayError(
              "submit",
              "source-invalid",
              `Unable to resolve compute source '${source.path}' inside this project.`,
              cause,
            ),
          ),
        );
      if (source.bufferState === "saved") {
        if (source.revision === null || file.revision !== source.revision) {
          return yield* gatewayError(
            "submit",
            "source-invalid",
            "The saved source changed before execution. Submit the current buffer as dirty or try again after it is saved.",
          );
        }
        if (file.truncated) {
          return yield* gatewayError(
            "submit",
            "source-invalid",
            "The saved source is too large to validate for execution.",
          );
        }
        const submittedSource = extractComputeSourceRange(file.contents, source.range);
        if (submittedSource === null || submittedSource !== request.code) {
          return yield* gatewayError(
            "submit",
            "source-invalid",
            "The submitted code does not match the claimed saved source range.",
          );
        }
        return file.contents;
      }
    }
    return null;
  });

  const submitExecution = Effect.fn("ComputeRpcGateway.submitExecution")(function* (
    request: ComputeSubmitProjectExecutionInput,
  ) {
    const project = yield* projectFor("submit", request.cwd);
    const session = yield* input.compute.getSession({
      projectId: project.projectId,
      sessionId: request.sessionId,
    });
    if (session !== null) yield* requireLanguage("submit", session.languageId);
    yield* validateSource(project.root, request);
    return yield* input.compute.submitExecution({
      ...request,
      projectId: project.projectId,
    });
  });

  const submitCells = Effect.fn("ComputeRpcGateway.submitCells")(function* (
    request: ComputeSubmitProjectCellsInput & {
      readonly notebookRun?: ComputeSubmitProjectCellsInput["cells"][number]["executionId"];
    },
  ) {
    if (!notebookPathAllowed(request.path))
      return yield* gatewayError(
        "submit",
        "source-invalid",
        "This notebook is outside the project.",
      );
    const project = yield* projectFor("submit", request.cwd);
    const session = yield* input.compute.getSession({
      projectId: project.projectId,
      sessionId: request.sessionId,
    });
    if (session !== null) yield* requireLanguage("submit", session.languageId);
    const first = request.cells[0];
    const batch =
      first !== undefined &&
      (request.runAll || request.notebookRun !== undefined || request.cells.length > 1)
        ? {
            id: first.executionId,
            mode:
              request.runAll || request.notebookRun !== undefined
                ? ("all" as const)
                : ("selection" as const),
            count: request.cells.length,
          }
        : undefined;
    return yield* input.compute.submitExecutions({
      projectId: project.projectId,
      sessionId: request.sessionId,
      ...(request.notebookRun === undefined ? {} : { notebookRun: request.notebookRun }),
      submissions: request.cells.map((cell, index) => ({
        projectId: project.projectId,
        sessionId: request.sessionId,
        executionId: cell.executionId,
        expectedGeneration: request.expectedGeneration,
        code: cell.code,
        ...(request.actor === undefined ? {} : { actor: request.actor }),
        source: {
          _tag: "document" as const,
          origin: "cell" as const,
          path: request.path,
          bufferState: "saved" as const,
          revision: null,
          range: null,
          cell: cell.cellId,
          ...(batch === undefined ? {} : { notebookBatch: { ...batch, index } }),
        },
      })),
    });
  });

  const cancelExecution = Effect.fn("ComputeRpcGateway.cancelExecution")(function* (
    request: ComputeProjectExecutionCommandInput,
  ) {
    const project = yield* projectFor("cancel", request.cwd);
    return yield* input.compute.cancelExecution({ ...request, projectId: project.projectId });
  });

  const sessionCommand = (
    operation: "interrupt" | "restart" | "stop",
    command: ComputeGatewayService["interruptSession"],
  ) =>
    Effect.fn(`ComputeRpcGateway.${operation}`)(function* (
      request: ComputeProjectSessionCommandInput,
    ) {
      const project = yield* projectFor(operation, request.cwd);
      return yield* command({ ...request, projectId: project.projectId });
    });

  const subscribeSessions = Effect.fn("ComputeRpcGateway.subscribeSessions")(function* (
    request: ComputeProjectInput,
  ) {
    const project = yield* projectFor("subscribe", request.cwd);
    return yield* input.compute.subscribeSessions({ projectId: project.projectId });
  });

  const inspectVariables = Effect.fn("ComputeRpcGateway.inspectVariables")(function* (
    request: ComputeProjectSessionCommandInput,
  ) {
    const project = yield* projectFor("variables", request.cwd);
    return yield* input.compute.inspectVariables({ ...request, projectId: project.projectId });
  });

  const readTable = Effect.fn("ComputeRpcGateway.readTable")(function* (
    request: ComputeTableInput & { readonly profile?: boolean },
  ) {
    const project = yield* projectFor("table", request.cwd);
    return yield* input.compute.readTable({ ...request, projectId: project.projectId });
  });

  return {
    runtimeInventory,
    activeWork: input.compute.activeWork,
    settledRuns: input.compute.settledRuns,
    settledRunRecorded: input.compute.settledRunRecorded,
    inspectRuntimes: inWorkspace("inspect", inspectRuntimes),
    verifyRuntime: inWorkspace("verify", verifyRuntime),
    managedRuntimeStatus,
    manageRuntime,
    cancelManagedRuntime,
    addPythonLibrary: inWorkspace("manage", addPythonLibrary),
    startSession: inWorkspace("start", startSession),
    listSessions: inWorkspace("list", listSessions),
    getSession: inWorkspace("get", getSession),
    listExecutions: inWorkspace("list", listExecutions),
    listAllExecutions: inWorkspace("list", listAllExecutions),
    runHistory: (
      request: ComputeRunHistoryInput,
      listFileRuns?: AnalysisService["Service"]["listRuns"],
    ) =>
      inWorkspace("list", (request: ComputeRunHistoryInput) => runHistory(request, listFileRuns))(
        request,
      ),
    listOutputs: inWorkspace("outputs", listOutputs),
    submitExecution: inWorkspace("submit", submitExecution),
    submitCells: inWorkspace("submit", submitCells),
    cancelExecution: inWorkspace("cancel", cancelExecution),
    interruptSession: inWorkspace(
      "interrupt",
      sessionCommand("interrupt", input.compute.interruptSession),
    ),
    restartSession: inWorkspace("restart", sessionCommand("restart", input.compute.restartSession)),
    stopSession: inWorkspace(
      "stop",
      Effect.fn("ComputeRpcGateway.stop")(function* (request: ComputeStopProjectSessionInput) {
        const project = yield* projectFor("stop", request.cwd);
        return yield* input.compute.stopSession({ ...request, projectId: project.projectId });
      }),
    ),
    /** The project a folder's runs and linked results belong to. */
    project: inWorkspace("get", (request: { readonly cwd: string }) =>
      projectFor("get", request.cwd),
    ),
    projectWithAdmission: inWorkspace("get", (request: { readonly cwd: string }) =>
      boundProject("get", request),
    ),
    watchProject: <A, E>(
      request: ComputeProjectInput,
      watch: (project: BoundComputeProject) => Stream.Stream<A, E>,
    ) =>
      inWorkspace(
        "subscribe",
        Effect.fn("ComputeRpcGateway.watchProject")(function* (request: ComputeProjectInput) {
          const project = yield* boundProject("subscribe", request);
          const { admission } = project;
          const updates = watch(project);
          return admission === null
            ? updates
            : updates.pipe(
                Stream.takeWhileEffect(() =>
                  admission.assertCurrent.pipe(
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  ),
                ),
              );
        }),
      )(request),
    inspectVariables: inWorkspace("variables", inspectVariables),
    readTable: inWorkspace("table", readTable),
    subscribeSessions: inWorkspace("subscribe", subscribeSessions),
  };
}

/** Exact UTF-16 editor range extraction; line indices are zero-based and end-exclusive by column. */
export function extractComputeSourceRange(
  contents: string,
  range: ComputeSourceRange | null,
): string | null {
  if (range === null) return contents;
  const lineStarts = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === "\n") lineStarts.push(index + 1);
  }
  const lineEnd = (line: number): number | null => {
    const start = lineStarts[line];
    if (start === undefined) return null;
    const newline = contents.indexOf("\n", start);
    const rawEnd = newline === -1 ? contents.length : newline;
    return rawEnd > start && contents[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
  };
  const start = lineStarts[range.startLine];
  const end = lineStarts[range.endLine];
  const startLineEnd = lineEnd(range.startLine);
  const endLineEnd = lineEnd(range.endLine);
  if (start === undefined || end === undefined || startLineEnd === null || endLineEnd === null) {
    return null;
  }
  if (
    range.startColumn > startLineEnd - start ||
    range.endColumn > endLineEnd - end ||
    range.endLine < range.startLine ||
    (range.endLine === range.startLine && range.endColumn < range.startColumn)
  ) {
    return null;
  }
  return contents.slice(start + range.startColumn, end + range.endColumn);
}

export type ComputeRpcGateway = ReturnType<typeof makeComputeRpcGateway>;
