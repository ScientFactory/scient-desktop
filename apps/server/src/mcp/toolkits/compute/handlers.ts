// @effect-diagnostics nodeBuiltinImport:off -- execution ids are random UUIDs, and agents name files by host paths.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  AnalysisRunId,
  AnalysisSourceRevision,
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeSessionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  ComputeResultParameterValues,
  ComputeToolkitId,
  computeRunRoutesForPath,
  isSqliteScript,
  type AnalysisOperationError,
  type AnalysisRunSnapshot,
  type ComputeExecutionRecord,
  type ComputeManagedRuntimeStatus,
  type ComputeSessionRecord,
  type ComputeRunHistoryInput,
  type ComputeSubmitProjectExecutionInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  agentComputeLanguageId,
  agentScope,
  computeFailed,
  isLive,
  ownedSession,
  toolError,
  type AgentScope,
} from "./agentComputeScope.ts";
import { inventorySummary } from "./inventorySummary.ts";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";
import {
  materializeScientDataView,
  previewScientDataView,
  profileScientData,
} from "./dataHandlers.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { computeTranscript } from "./computeTranscript.ts";
import { fileSessionLanguage, matchSavedScript } from "./savedScriptMatch.ts";
import { exportScientResults, verifyScientResults } from "./handoffHandlers.ts";
import {
  editScientNotebook,
  readScientNotebook,
  runScientNotebook,
  stopScientNotebook,
} from "./notebookHandlers.ts";
import {
  checkScientResults,
  compareScientResults,
  listScientResults,
  runScientResults,
  scientResultMarkdown,
} from "./resultHandlers.ts";
import {
  ScientComputeToolkit,
  type AgentFileParameters,
  type ComputeToolImage,
  type ComputeToolRun,
  type ComputeToolSession,
} from "./tools.ts";

const DEFAULT_RUN_WAIT_SECONDS = 120;
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);
const MAXIMUM_IMAGES = 6;
const MAXIMUM_IMAGE_BYTES = 4 * 1024 * 1024;
const RECENT_RUNS = 5;

function ownerLabel(session: ComputeSessionRecord, threadId: string): string {
  const owner = session.owner;
  if (owner?._tag === "file") return `file ${owner.path}`;
  if (owner?._tag === "agent") {
    return owner.threadId === threadId ? "agent (this chat)" : "agent (another chat)";
  }
  return "user";
}

function sessionSummary(session: ComputeSessionRecord, threadId: string): ComputeToolSession {
  return {
    session: session.sessionId,
    language: session.languageId,
    owner: ownerLabel(session, threadId),
    status: session.status,
    busy: session.activeExecutionId !== null || session.pendingCount > 0,
  };
}

function sourceLabel(execution: ComputeExecutionRecord, threadId: string): string {
  const { actor, source } = execution.request;
  const who =
    actor === undefined ? "user" : actor.threadId === threadId ? "agent (this chat)" : "agent";
  if (source._tag === "console") return `${who}: code`;
  const lines =
    source.range === null ? "" : ` lines ${source.range.startLine + 1}–${source.range.endLine + 1}`;
  const unsaved = source.bufferState === "dirty" ? " (unsaved)" : "";
  return `${who}: ${source.origin}${lines} of ${source.path}${unsaved}`;
}

/** Runtime operations need a live session; reading history works on stopped ones too. */
const requireSession = Effect.fn("ScientComputeToolkit.requireSession")(function* (
  scope: AgentScope,
  sessionId: string,
  need: "live" | "existing" = "live",
) {
  const session = yield* scope.gateway
    .getSession({ cwd: scope.cwd, sessionId: ComputeSessionId.make(sessionId) })
    .pipe(Effect.mapError(computeFailed));
  if (session === null || (need === "live" && !isLive(session))) {
    return yield* toolError(
      "session-not-found",
      need === "live"
        ? `There is no live session '${sessionId}'. Call scient_compute_sessions to list them.`
        : `There is no session '${sessionId}' in this project.`,
    );
  }
  return session;
});

/** The agent's own session for this chat and language, started on first use. */
const agentSession = Effect.fn("ScientComputeToolkit.agentSession")(function* (
  scope: AgentScope,
  requestedLanguage: string | undefined,
) {
  return yield* ownedSession(scope, requestedLanguage, {
    _tag: "agent",
    threadId: scope.threadId,
  });
}, Effect.mapError(computeFailed));

const isFinished = (execution: ComputeExecutionRecord) =>
  execution.result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status);

/** Waits on the session stream; `null` means the run is still going when the wait ends. */
const awaitFinished = (
  scope: AgentScope,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  waitSeconds: number,
  fresh = false,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* scope.gateway.subscribeSessions({ cwd: scope.cwd });
      return yield* events.pipe(
        Stream.filter(
          (event) =>
            (event._tag === "execution-updated" &&
              event.sessionId === sessionId &&
              event.execution.request.executionId === executionId &&
              isFinished(event.execution)) ||
            (fresh &&
              event._tag === "session-updated" &&
              event.session.sessionId === sessionId &&
              TERMINAL_COMPUTE_SESSION_STATUSES.has(event.session.status)),
        ),
        Stream.runHead,
        Effect.timeoutOption(Duration.seconds(waitSeconds)),
        Effect.map(Option.flatten),
        Effect.map(
          Option.flatMap((event) =>
            event._tag === "execution-updated" ? Option.some(event.execution) : Option.none(),
          ),
        ),
      );
    }),
  ).pipe(Effect.mapError(computeFailed));

const latestExecution = Effect.fn("ScientComputeToolkit.latestExecution")(function* (
  scope: AgentScope,
  session: ComputeSessionRecord,
  executionId: string | undefined,
) {
  const executions = yield* scope.gateway
    .listExecutions({ cwd: scope.cwd, sessionId: session.sessionId, limit: 200 })
    .pipe(Effect.mapError(computeFailed));
  const execution =
    executionId === undefined
      ? executions.at(-1)
      : executions.find((entry) => entry.request.executionId === executionId);
  if (execution === undefined) {
    return yield* toolError(
      "session-not-found",
      executionId === undefined
        ? "This session has no runs yet."
        : `There is no run '${executionId}' in this session.`,
    );
  }
  return execution;
});

/** Reads a run back as text plus figure images the model can look at. */
const describeRun = Effect.fn("ScientComputeToolkit.describeRun")(function* (
  scope: AgentScope,
  session: ComputeSessionRecord,
  execution: ComputeExecutionRecord,
  includeImages: boolean,
) {
  const executionId = execution.request.executionId;
  const { outputs } = yield* scope.gateway
    .listOutputs({ cwd: scope.cwd, sessionId: session.sessionId, executionId })
    .pipe(Effect.mapError(computeFailed));
  const transcript = computeTranscript(outputs);
  const images: ComputeToolImage[] = [];
  if (includeImages) {
    for (const figure of transcript.figures.slice(0, MAXIMUM_IMAGES)) {
      const output = yield* scope.gateway
        .readOutput(
          {
            projectId: session.projectId,
            sessionId: session.sessionId,
            executionId,
            contentHash: figure.contentHash,
          },
          figure.kind,
        )
        .pipe(Effect.orElseSucceed(() => null));
      if (output === null || output.bytes.byteLength > MAXIMUM_IMAGE_BYTES) continue;
      images.push({
        mediaType: figure.mediaType as ComputeToolImage["mediaType"],
        data: Buffer.from(output.bytes).toString("base64"),
      });
    }
  }
  const result = execution.result;
  const run: ComputeToolRun = {
    run: executionId,
    status: result?.status ?? "queued",
    source: sourceLabel(execution, scope.threadId),
    submittedAt: execution.request.submittedAt,
    finishedAt: result?.finishedAt ?? null,
    output:
      transcript.text.length > 0
        ? transcript.text
        : result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(result.status)
          ? "(no output)"
          : "(still running)",
    figures: transcript.figures.length,
    ...(execution.request.parameters === undefined
      ? {}
      : { parameters: execution.request.parameters }),
    ...(execution.request.inputs === undefined ? {} : { inputs: execution.request.inputs }),
  };
  return {
    session: sessionSummary(session, scope.threadId),
    run,
    ...(result?.writtenFiles === undefined ? {} : { wrote: result.writtenFiles }),
    ...(images.length > 0 ? { images } : {}),
  };
});

const refreshed = (scope: AgentScope, session: ComputeSessionRecord) =>
  scope.gateway.getSession({ cwd: scope.cwd, sessionId: session.sessionId }).pipe(
    Effect.map((current) => current ?? session),
    Effect.orElseSucceed(() => session),
  );

const submitAgentExecution = Effect.fn("ScientComputeToolkit.submitAgentExecution")(function* (
  scope: AgentScope,
  session: ComputeSessionRecord,
  input: Pick<ComputeSubmitProjectExecutionInput, "code" | "source"> & {
    readonly waitSeconds?: number | undefined;
  },
) {
  const executionId = ComputeExecutionId.make(NodeCrypto.randomUUID());
  const submitted = yield* Effect.scoped(
    Effect.gen(function* () {
      // Subscribe before submitting so a fast run cannot finish unobserved.
      const finished = yield* awaitFinished(
        scope,
        session.sessionId,
        executionId,
        input.waitSeconds ?? DEFAULT_RUN_WAIT_SECONDS,
      ).pipe(Effect.forkScoped);
      const execution = yield* scope.gateway
        .submitExecution({
          cwd: scope.cwd,
          sessionId: session.sessionId,
          executionId,
          expectedGeneration: session.generation,
          code: input.code,
          source: input.source,
          actor: { _tag: "agent", threadId: scope.threadId },
        })
        .pipe(Effect.mapError(computeFailed));
      if (isFinished(execution)) return execution;
      const done = yield* Fiber.join(finished);
      return Option.getOrElse(done, () => execution);
    }),
  );
  return isFinished(submitted) ? submitted : yield* latestExecution(scope, session, executionId);
});

export const runScientCompute = Effect.fn("ScientComputeToolkit.run")(function* (input: {
  readonly code: string;
  readonly language?: string | undefined;
  readonly session?: string | undefined;
  readonly waitSeconds?: number | undefined;
  readonly includeImages?: boolean | undefined;
}) {
  const scope = yield* agentScope();
  const requestedSession =
    input.session === undefined ? undefined : yield* requireSession(scope, input.session);
  const language =
    requestedSession?.languageId ??
    (input.language === undefined ? undefined : agentComputeLanguageId(input.language));
  const file = yield* matchSavedScript(scope, input.code, language);
  const session =
    requestedSession ?? (yield* agentSession(scope, file?.language ?? input.language));
  const execution = yield* submitAgentExecution(scope, session, {
    code: input.code,
    source: file?.source ?? { _tag: "console" },
    waitSeconds: input.waitSeconds,
  });
  return yield* describeRun(
    scope,
    yield* refreshed(scope, session),
    execution,
    input.includeImages ?? true,
  );
});

const MAXIMUM_FILE_RUN_OUTPUT = 64 * 1024;

const isFinishedRun = (run: AnalysisRunSnapshot) => TERMINAL_RUN_STATUSES.has(run.receipt.status);

const describeFileRun = (run: AnalysisRunSnapshot) => {
  const output = run.receipt.output.map((chunk) => chunk.text).join("");
  return {
    runtime: `${run.runtime.label}${run.runtime.version ? ` ${run.runtime.version}` : ""}`,
    run: {
      run: run.receipt.runId,
      status: run.receipt.status,
      source: `agent: ${run.source.relativePath}`,
      submittedAt: run.receipt.startedAt,
      finishedAt: run.receipt.finishedAt ?? null,
      output: [run.receipt.failureMessage, output.slice(-MAXIMUM_FILE_RUN_OUTPUT)]
        .filter((part) => part !== null && part !== undefined && part.length > 0)
        .join("\n"),
      figures: run.artifacts.length,
      ...(run.parameters === undefined ? {} : { parameters: run.parameters }),
      ...(run.inputs === undefined ? {} : { inputs: run.inputs }),
    },
    wrote: [...(run.writtenFiles ?? []), ...run.artifacts.map((artifact) => artifact.label)],
  };
};

/**
 * Agents often hold a file's full path. Only a plain path under the project is shortened: folding
 * a `..` here could pass through a symlink and land on a different file. Any other absolute path
 * stays as it is, and reading it is refused.
 */
export function projectRelativePath(root: string, path: string, separator = NodePath.sep): string {
  const prefix = `${root}${separator}`;
  const inside = path.startsWith(prefix) ? path.slice(prefix.length).split(separator) : null;
  return inside === null || inside.includes("..") ? path : inside.join("/");
}

const normalizeFileParameters = Schema.decodeUnknownEffect(ComputeResultParameterValues);

function parameterJsonText(value: Schema.Json): string {
  // Existing callers can still send a value already encoded as JSON text.
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      // Plain strings are also accepted.
    }
  }
  return JSON.stringify(value);
}

export const runScientComputeFile = Effect.fn("ScientComputeToolkit.runFile")(function* (input: {
  readonly path: string;
  readonly parameters?: AgentFileParameters | undefined;
  readonly inputs?: ReadonlyArray<string> | undefined;
  readonly session?: string | undefined;
  readonly includeImages?: boolean | undefined;
  readonly run?: string | undefined;
  readonly waitSeconds?: number | undefined;
}) {
  const scope = yield* agentScope();
  const { gateway } = scope;
  const parameters =
    input.parameters === undefined
      ? undefined
      : yield* normalizeFileParameters(
          Object.fromEntries(
            Object.entries(input.parameters).map(([name, value]) => [
              name,
              parameterJsonText(value),
            ]),
          ),
        ).pipe(
          Effect.mapError(() => toolError("compute-failed", "The run parameters are too large.")),
        );
  const setup = {
    ...(parameters === undefined ? {} : { parameters }),
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
  };
  const hasSetup = parameters !== undefined || input.inputs !== undefined;
  if (hasSetup && (input.session !== undefined || input.run !== undefined)) {
    return yield* toolError(
      "compute-failed",
      "Omit session and run when starting a file with parameters or declared inputs.",
    );
  }
  const requestedPath = projectRelativePath(scope.cwd, input.path);
  if (NodePath.isAbsolute(requestedPath)) {
    return yield* toolError("compute-failed", "Choose a file inside this project.");
  }
  if (input.run !== undefined && input.session !== undefined) {
    return yield* toolError("compute-failed", "Read a session run with scient_compute_output.");
  }
  const waited = (
    relativePath: string,
    runId: AnalysisRunId,
    start: Effect.Effect<AnalysisRunSnapshot, AnalysisOperationError>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before starting so a fast run cannot finish unobserved.
        const events = yield* gateway.subscribeFileRuns({
          cwd: scope.cwd,
          relativePath,
        });
        const started = yield* start;
        if (isFinishedRun(started)) return started;
        yield* events.pipe(
          Stream.filter(
            (event) =>
              event._tag !== "run-output" &&
              event.run.receipt.runId === runId &&
              TERMINAL_RUN_STATUSES.has(event.run.receipt.status),
          ),
          Stream.runHead,
          Effect.timeoutOption(Duration.seconds(input.waitSeconds ?? DEFAULT_RUN_WAIT_SECONDS)),
        );
        return yield* gateway.getFileRun({ cwd: scope.cwd, runId });
      }),
    );
  if (input.run !== undefined) {
    const runId = AnalysisRunId.make(input.run);
    const run = yield* waited(
      requestedPath,
      runId,
      gateway.getFileRun({ cwd: scope.cwd, runId }),
    ).pipe(Effect.mapError(computeFailed));
    return describeFileRun(run);
  }
  const file = yield* gateway
    .readFile({ cwd: scope.cwd, relativePath: requestedPath })
    .pipe(Effect.mapError(() => toolError("compute-failed", `Cannot read '${input.path}'.`)));
  if (file.outsideWorkspace || file.exists === false) {
    return yield* toolError("compute-failed", "Choose a saved file inside this project.");
  }
  const relativePath = file.relativePath;
  const language = fileSessionLanguage(relativePath);
  const requestedSession =
    input.session === undefined ? undefined : yield* requireSession(scope, input.session);
  if (requestedSession !== undefined && requestedSession.languageId !== language) {
    return yield* toolError("compute-failed", "Choose a session that matches the file language.");
  }
  const sqlite = language === "sql" && isSqliteScript(file.contents);
  const matlab = language === "matlab";
  const routes = computeRunRoutesForPath(relativePath).filter(
    (route) => route.languageId !== "sqlite" || sqlite,
  );
  const candidates =
    routes.length > 0 &&
    requestedSession === undefined &&
    (language === undefined || sqlite || matlab)
      ? (yield* gateway
          .inspectFileRuntimes({ cwd: scope.cwd })
          .pipe(Effect.mapError(computeFailed))).runtimes
      : [];
  const runtime = routes.flatMap((route) =>
    candidates.filter(
      (candidate) => candidate.kind === route.languageId && candidate.availability === "available",
    ),
  )[0];
  const preferAlternative =
    sqlite ||
    (matlab &&
      !candidates.some(
        (candidate) => candidate.kind === "matlab" && candidate.availability === "available",
      ));
  const useSession =
    language !== undefined &&
    (requestedSession !== undefined || runtime === undefined || !preferAlternative);
  if (useSession) {
    if (file.truncated || file.contents.length > 1024 * 1024 || file.contents.trim().length === 0) {
      return yield* toolError("compute-failed", "Choose a nonempty saved script up to 1 MiB.");
    }
    const source = {
      _tag: "document",
      origin: "file",
      path: relativePath,
      revision: file.revision,
      bufferState: "saved",
      range: null,
    } as const;
    if (hasSetup) {
      const sessionId = ComputeSessionId.make(NodeCrypto.randomUUID());
      const executionId = ComputeExecutionId.make(NodeCrypto.randomUUID());
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const finished = yield* awaitFinished(
            scope,
            sessionId,
            executionId,
            input.waitSeconds ?? DEFAULT_RUN_WAIT_SECONDS,
            true,
          ).pipe(Effect.forkScoped);
          const session = yield* gateway
            .startSession({
              cwd: scope.cwd,
              sessionId,
              languageId: ComputeLanguageId.make(language),
              executable: null,
              owner: { _tag: "agent", threadId: scope.threadId },
              publishResults: false,
              runOnce: {
                executionId,
                code: file.contents,
                source,
                actor: { _tag: "agent", threadId: scope.threadId },
                ...setup,
              },
            })
            .pipe(Effect.mapError(computeFailed));
          const done = yield* Fiber.join(finished);
          const current = yield* refreshed(scope, session);
          const execution = Option.isSome(done)
            ? done.value
            : yield* gateway.listExecutions({ cwd: scope.cwd, sessionId, limit: 1 }).pipe(
                Effect.map((records) => records[0]),
                Effect.mapError(computeFailed),
              );
          const runtime = current.runtime?.displayName ?? current.label;
          if (execution !== undefined) {
            return {
              ...(yield* describeRun(scope, current, execution, input.includeImages ?? true)),
              runtime,
              wrote: execution.result?.writtenFiles ?? [],
            };
          }
          if (TERMINAL_COMPUTE_SESSION_STATUSES.has(current.status)) {
            return yield* toolError(
              "compute-failed",
              current.lostReason ?? "The runtime stopped before the script ran.",
            );
          }
          return {
            runtime,
            session: sessionSummary(current, scope.threadId),
            run: {
              run: executionId,
              status: "queued",
              source: `agent: ${relativePath}`,
              submittedAt: current.createdAt,
              finishedAt: null,
              output: "(runtime is starting)",
              figures: 0,
              ...setup,
            },
            wrote: [],
          };
        }),
      );
    }
    const session = requestedSession ?? (yield* agentSession(scope, language));
    const execution = yield* submitAgentExecution(scope, session, {
      code: file.contents,
      source,
      waitSeconds: input.waitSeconds,
    });
    const current = yield* refreshed(scope, session);
    return {
      ...(yield* describeRun(scope, current, execution, input.includeImages ?? true)),
      runtime: current.runtime?.displayName ?? current.label,
      wrote: execution.result?.writtenFiles ?? [],
    };
  }
  if (runtime === undefined) {
    return yield* toolError("compute-failed", `Nothing on this computer runs '${relativePath}'.`);
  }
  const runId = AnalysisRunId.make(NodeCrypto.randomUUID());
  const run = yield* waited(
    relativePath,
    runId,
    gateway.startFileRun({
      runId,
      cwd: scope.cwd,
      relativePath,
      sourceRevision: AnalysisSourceRevision.make(file.revision),
      runtimeId: runtime.id,
      agentThreadId: scope.threadId,
      ...setup,
    }),
  ).pipe(Effect.mapError(computeFailed));
  return describeFileRun(run);
});

export const readScientComputeOutput = Effect.fn("ScientComputeToolkit.output")(function* (input: {
  readonly session: string;
  readonly run?: string | undefined;
  readonly waitSeconds?: number | undefined;
  readonly includeImages?: boolean | undefined;
}) {
  const scope = yield* agentScope();
  const session = yield* requireSession(scope, input.session, "existing");
  const wait = input.waitSeconds ?? 0;
  const waitForStartup =
    input.run !== undefined &&
    session.lifetime === "fresh" &&
    session.status === "starting" &&
    wait > 0;
  if (waitForStartup) {
    yield* awaitFinished(scope, session.sessionId, ComputeExecutionId.make(input.run), wait, true);
  }
  let execution = yield* latestExecution(scope, session, input.run);
  if (!waitForStartup && !isFinished(execution) && wait > 0) {
    yield* awaitFinished(scope, session.sessionId, execution.request.executionId, wait);
    execution = yield* latestExecution(scope, session, execution.request.executionId);
  }
  return yield* describeRun(
    scope,
    yield* refreshed(scope, session),
    execution,
    input.includeImages ?? true,
  );
});

export const listScientComputeSessions = Effect.fn("ScientComputeToolkit.sessions")(function* (
  input: {
    readonly history?:
      | Pick<ComputeRunHistoryInput, "filter" | "before" | "notebookBatchId">
      | undefined;
  } = {},
) {
  const scope = yield* agentScope();
  if (input.history !== undefined) {
    const { runs, fileRuns, next } = yield* scope.gateway
      .runHistory({ cwd: scope.cwd, limit: 30, ...input.history })
      .pipe(Effect.mapError(computeFailed));
    return {
      sessions: [],
      runs: [
        ...runs.map(({ session, execution, notebookBatch }) => ({
          run: execution.request.executionId,
          session: session.sessionId,
          ...(execution.request.source._tag === "document"
            ? { file: execution.request.source.path }
            : {}),
          language: session.languageId,
          status: notebookBatch?.status ?? execution.result?.status ?? "queued",
          ...(notebookBatch === undefined
            ? {}
            : { notebookBatch: { id: notebookBatch.id, count: notebookBatch.count } }),
          submittedAt: execution.request.submittedAt,
          ...(execution.request.actor === undefined
            ? {}
            : { agentThread: execution.request.actor.threadId }),
        })),
        ...fileRuns.map((run) => ({
          run: run.receipt.runId,
          file: run.source.relativePath,
          language: run.runtime.kind,
          status: run.receipt.status,
          submittedAt: run.receipt.startedAt,
          ...(run.agentThreadId === undefined ? {} : { agentThread: run.agentThreadId }),
        })),
      ].toSorted(
        (left, right) =>
          right.submittedAt.localeCompare(left.submittedAt) ||
          (right.run > left.run ? 1 : right.run < left.run ? -1 : 0),
      ),
      next,
    };
  }
  const sessions = yield* scope.gateway
    .listSessions({ cwd: scope.cwd })
    .pipe(Effect.mapError(computeFailed));
  const live = sessions.filter(isLive);
  return {
    sessions: yield* Effect.forEach(live, (session) =>
      scope.gateway
        .listExecutions({ cwd: scope.cwd, sessionId: session.sessionId, limit: 200 })
        .pipe(
          Effect.orElseSucceed((): ReadonlyArray<ComputeExecutionRecord> => []),
          Effect.map((executions) => ({
            ...sessionSummary(session, scope.threadId),
            recentRuns: executions.slice(-RECENT_RUNS).map((execution) => ({
              run: execution.request.executionId,
              status: execution.result?.status ?? "queued",
              source: sourceLabel(execution, scope.threadId),
              submittedAt: execution.request.submittedAt,
            })),
          })),
        ),
    ),
  };
});

const listScientComputeVariables = Effect.fn("ScientComputeToolkit.variables")(function* (input: {
  readonly session: string;
}) {
  const scope = yield* agentScope();
  const session = yield* requireSession(scope, input.session);
  const snapshot = yield* scope.gateway
    .inspectVariables({
      cwd: scope.cwd,
      sessionId: session.sessionId,
      expectedGeneration: session.generation,
    })
    .pipe(Effect.mapError(computeFailed));
  return {
    session: sessionSummary(session, scope.threadId),
    variables: snapshot.variables.map((variable) => ({
      name: variable.name,
      type: variable.typeName,
      shape: variable.shape,
      preview: variable.preview,
    })),
    truncated: snapshot.truncated,
  };
});

const controlScientCompute = Effect.fn("ScientComputeToolkit.control")(function* (input: {
  readonly session: string;
  readonly action: "interrupt" | "restart" | "stop";
}) {
  const scope = yield* agentScope();
  const session = yield* requireSession(scope, input.session);
  const command = {
    cwd: scope.cwd,
    sessionId: session.sessionId,
    expectedGeneration: session.generation,
  };
  const updated = yield* (
    input.action === "interrupt"
      ? scope.gateway.interruptSession(command)
      : input.action === "restart"
        ? scope.gateway.restartSession(command)
        : scope.gateway.stopSession(command)
  ).pipe(Effect.mapError(computeFailed));
  return { session: sessionSummary(updated, scope.threadId) };
});

const PYTHON = ComputeLanguageId.make("python");
const SETUP_POLL_SECONDS = 2;

const setupSummary = (status: ComputeManagedRuntimeStatus) => ({
  installed: status.installed,
  busy: status.operation !== null,
  runtime: status.runtimeVersion,
  toolkits: [...(status.toolkitIds ?? [])],
  failure: status.failureMessage,
});

const setupScientCompute = Effect.fn("ScientComputeToolkit.setup")(function* (input: {
  readonly toolkits?: ReadonlyArray<string> | undefined;
  readonly waitSeconds?: number | undefined;
}) {
  const scope = yield* agentScope();
  const requested = (input.toolkits ?? []).map((id) => ComputeToolkitId.make(id));
  let status = yield* scope.gateway.managedRuntimeStatus({ languageId: PYTHON });
  if (status.operation === null && !status.installed) {
    status = yield* scope.gateway.manageRuntime({
      languageId: PYTHON,
      action: "install",
      toolkitIds: requested,
    });
  } else if (status.operation === null) {
    for (const toolkitId of requested) {
      if (status.toolkitIds?.includes(toolkitId)) continue;
      status = yield* scope.gateway.manageRuntime({
        languageId: PYTHON,
        action: "update",
        toolkitChange: { toolkitId, action: "install" },
      });
    }
  }
  const polls = Math.ceil((input.waitSeconds ?? DEFAULT_RUN_WAIT_SECONDS) / SETUP_POLL_SECONDS);
  for (let poll = 0; status.operation !== null && poll < polls; poll += 1) {
    yield* Effect.sleep(Duration.seconds(SETUP_POLL_SECONDS));
    status = yield* scope.gateway.managedRuntimeStatus({ languageId: PYTHON });
  }
  return setupSummary(status);
}, Effect.mapError(computeFailed));

export const listScientComputeInventory = Effect.fn("ScientComputeToolkit.inventory")(
  function* () {
    const gateway = yield* ComputeMcpGateway;
    const cwd = yield* consumeAgentWorkspace().pipe(
      Effect.map((workspace) => workspace.binding.canonicalRoot),
      Effect.orElseSucceed(() => null),
    );
    const inventory = yield* gateway.runtimeInventory();
    const inspection = yield* gateway.inspectRuntimes({ cwd, refresh: false });
    return inventorySummary(inventory, inspection);
  },
  Effect.mapError(() =>
    toolError("compute-failed", "The Scient Compute runtime inventory could not be read."),
  ),
);

const handlers = {
  scient_notebook_read: readScientNotebook,
  scient_notebook_edit: editScientNotebook,
  scient_notebook_run: runScientNotebook,
  scient_notebook_stop: stopScientNotebook,
  scient_compute_run: runScientCompute,
  scient_compute_run_file: runScientComputeFile,
  scient_compute_output: readScientComputeOutput,
  scient_compute_sessions: listScientComputeSessions,
  scient_compute_variables: listScientComputeVariables,
  scient_compute_control: controlScientCompute,
  scient_compute_setup: setupScientCompute,
  scient_compute_inventory: () => listScientComputeInventory(),
  scient_results_run: runScientResults,
  scient_data_profile: profileScientData,
  scient_data_preview_view: previewScientDataView,
  scient_data_materialize_view: materializeScientDataView,
  scient_results_list: listScientResults,
  scient_results_compare: compareScientResults,
  scient_results_markdown: scientResultMarkdown,
  scient_results_check: checkScientResults,
  scient_results_export: exportScientResults,
  scient_results_verify: verifyScientResults,
} satisfies Parameters<typeof ScientComputeToolkit.toLayer>[0];

export const ScientComputeToolkitHandlersLive = ScientComputeToolkit.toLayer(handlers);
