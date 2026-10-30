// @effect-diagnostics nodeBuiltinImport:off -- execution ids are random UUIDs.
import * as NodeCrypto from "node:crypto";

import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeSessionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { computeTranscript } from "./computeTranscript.ts";
import {
  ScientComputeToolError,
  ScientComputeToolkit,
  type ComputeToolImage,
  type ComputeToolRun,
  type ComputeToolSession,
} from "./tools.ts";

const DEFAULT_RUN_WAIT_SECONDS = 120;
const MAXIMUM_IMAGES = 6;
const MAXIMUM_IMAGE_BYTES = 4 * 1024 * 1024;
const RECENT_RUNS = 5;
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { py: "python", jl: "julia" };

type ToolErrorCode = ConstructorParameters<typeof ScientComputeToolError>[0]["code"];
const toolError = (code: ToolErrorCode, message: string) =>
  new ScientComputeToolError({ code, message });
const computeFailed = (error: { readonly message: string }) =>
  toolError("compute-failed", error.message);

/** The thread's project and identity; every compute tool acts in the caller's own project. */
const agentScope = Effect.fn("ScientComputeToolkit.scope")(function* () {
  const invocation = yield* AgentInvocationContext.AgentInvocationContext;
  if (!invocation.capabilities.has("compute")) {
    return yield* toolError(
      "capability-unavailable",
      "This provider session does not grant Scient Compute access.",
    );
  }
  const workspace = yield* consumeAgentWorkspace().pipe(
    Effect.mapError((error) => toolError(error.code, error.message)),
  );
  return {
    cwd: workspace.binding.canonicalRoot,
    threadId: invocation.threadId as string,
    gateway: yield* ComputeMcpGateway,
  };
});
type AgentScope = Effect.Success<ReturnType<typeof agentScope>>;

const isLive = (session: ComputeSessionRecord) =>
  !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status);

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

const requireSession = Effect.fn("ScientComputeToolkit.requireSession")(function* (
  scope: AgentScope,
  sessionId: string,
) {
  const session = yield* scope.gateway
    .getSession({ cwd: scope.cwd, sessionId: ComputeSessionId.make(sessionId) })
    .pipe(Effect.mapError(computeFailed));
  if (session === null || !isLive(session)) {
    return yield* toolError(
      "session-not-found",
      `There is no live session '${sessionId}'. Call scient_compute_sessions to list them.`,
    );
  }
  return session;
});

/** The agent's own session for this chat and language, started on first use. */
const agentSession = Effect.fn("ScientComputeToolkit.agentSession")(function* (
  scope: AgentScope,
  requestedLanguage: string | undefined,
) {
  const normalized = (requestedLanguage ?? "python").trim().toLowerCase();
  const languageId = ComputeLanguageId.make(LANGUAGE_ALIASES[normalized] ?? normalized);
  const sessions = yield* scope.gateway.listSessions({ cwd: scope.cwd });
  const existing = sessions.find(
    (session) =>
      isLive(session) &&
      session.languageId === languageId &&
      session.owner?._tag === "agent" &&
      session.owner.threadId === scope.threadId,
  );
  if (existing !== undefined) return existing;
  return yield* scope.gateway.startSession({
    cwd: scope.cwd,
    sessionId: ComputeSessionId.make(`agent-${NodeCrypto.randomUUID()}`),
    languageId,
    executable: null,
    owner: { _tag: "agent", threadId: scope.threadId },
  });
}, Effect.mapError(computeFailed));

const isFinished = (execution: ComputeExecutionRecord) =>
  execution.result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status);

/** Waits on the session stream; `null` means the run is still going when the wait ends. */
const awaitFinished = (
  scope: AgentScope,
  session: ComputeSessionRecord,
  executionId: ComputeExecutionId,
  waitSeconds: number,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* scope.gateway.subscribeSessions({ cwd: scope.cwd });
      return yield* events.pipe(
        Stream.filter(
          (event) =>
            event._tag === "execution-updated" &&
            event.sessionId === session.sessionId &&
            event.execution.request.executionId === executionId &&
            isFinished(event.execution),
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
  };
  return {
    session: sessionSummary(session, scope.threadId),
    run,
    ...(images.length > 0 ? { images } : {}),
  };
});

const refreshed = (scope: AgentScope, session: ComputeSessionRecord) =>
  scope.gateway.getSession({ cwd: scope.cwd, sessionId: session.sessionId }).pipe(
    Effect.map((current) => current ?? session),
    Effect.orElseSucceed(() => session),
  );

export const runScientCompute = Effect.fn("ScientComputeToolkit.run")(function* (input: {
  readonly code: string;
  readonly language?: string | undefined;
  readonly session?: string | undefined;
  readonly waitSeconds?: number | undefined;
  readonly includeImages?: boolean | undefined;
}) {
  const scope = yield* agentScope();
  const session =
    input.session === undefined
      ? yield* agentSession(scope, input.language)
      : yield* requireSession(scope, input.session);
  const executionId = ComputeExecutionId.make(NodeCrypto.randomUUID());
  const submitted = yield* Effect.scoped(
    Effect.gen(function* () {
      // Subscribe before submitting so a fast run cannot finish unobserved.
      const finished = yield* awaitFinished(
        scope,
        session,
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
          source: { _tag: "console" },
          actor: { _tag: "agent", threadId: scope.threadId },
        })
        .pipe(Effect.mapError(computeFailed));
      if (isFinished(execution)) return execution;
      const done = yield* Fiber.join(finished);
      return Option.getOrElse(done, () => execution);
    }),
  );
  const execution = isFinished(submitted)
    ? submitted
    : yield* latestExecution(scope, session, executionId);
  return yield* describeRun(
    scope,
    yield* refreshed(scope, session),
    execution,
    input.includeImages ?? true,
  );
});

export const readScientComputeOutput = Effect.fn("ScientComputeToolkit.output")(function* (input: {
  readonly session: string;
  readonly run?: string | undefined;
  readonly waitSeconds?: number | undefined;
  readonly includeImages?: boolean | undefined;
}) {
  const scope = yield* agentScope();
  const session = yield* requireSession(scope, input.session);
  let execution = yield* latestExecution(scope, session, input.run);
  if (!isFinished(execution) && (input.waitSeconds ?? 0) > 0) {
    yield* awaitFinished(scope, session, execution.request.executionId, input.waitSeconds ?? 0);
    execution = yield* latestExecution(scope, session, execution.request.executionId);
  }
  return yield* describeRun(
    scope,
    yield* refreshed(scope, session),
    execution,
    input.includeImages ?? true,
  );
});

export const listScientComputeSessions = Effect.fn("ScientComputeToolkit.sessions")(function* () {
  const scope = yield* agentScope();
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

export const listScientComputeInventory = Effect.fn("ScientComputeToolkit.inventory")(function* () {
  const invocation = yield* AgentInvocationContext.AgentInvocationContext;
  if (!invocation.capabilities.has("compute")) {
    return yield* toolError(
      "capability-unavailable",
      "This provider session does not grant Scient Compute access.",
    );
  }
  const gateway = yield* ComputeMcpGateway;
  return yield* gateway
    .runtimeInventory()
    .pipe(
      Effect.mapError(() =>
        toolError("compute-failed", "The Scient Compute runtime inventory could not be read."),
      ),
    );
});

const handlers = {
  scient_compute_run: runScientCompute,
  scient_compute_output: readScientComputeOutput,
  scient_compute_sessions: () => listScientComputeSessions(),
  scient_compute_variables: listScientComputeVariables,
  scient_compute_control: controlScientCompute,
  scient_compute_inventory: () => listScientComputeInventory(),
} satisfies Parameters<typeof ScientComputeToolkit.toLayer>[0];

export const ScientComputeToolkitHandlersLive = ScientComputeToolkit.toLayer(handlers);
