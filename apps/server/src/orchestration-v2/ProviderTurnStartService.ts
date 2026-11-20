import { isContextHistoryItem } from "./scient-fork/ContextHistoryCandidates.ts";
import * as SqlClient from "effect/sql/SqlClient";
import {
  nativeModelCapacityOwnerFor,
  resolveNativeModelContextWindow,
} from "./scient-fork/NativeModelContextWindow.ts";
import {
  ContextHandoffPolicyOverride,
  genericContextHandoffPolicy,
  makeScientContextHandoffPolicy,
  scientHandoffDeliveryProvenance,
  usesScientHandoffBudget,
} from "./ScientContextHandoffPolicy.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import {
  CommandId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  latestProviderTurnForAttempt,
  withMessageSenderNote,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  isCompactionCommandMessage,
  parseGoalCommand,
  type ProviderSessionId,
  RunId,
  RunAttemptId,
  NodeId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// SCIENT-FORK:START — portable history and the frozen conversation-fork start.
import {
  makeTurnStartHistory,
  startFrozenConversationFork,
} from "./scient-fork/PortableTurnStart.ts";
import { providerTurnsOutsideRolledBackRuns } from "./scient-fork/ConversationForkNativeSource.ts";
// SCIENT-FORK:END
// SCIENT-FORK:START — a pending start keeps its session out of idle release.
import { reserveSessionForStartup } from "./scient-provider/StartupSessionHold.ts";
// SCIENT-FORK:END
// SCIENT-FORK:START provider-enabled-at-open
import { isProviderInstanceDisabledOpen } from "./scient-provider/ProviderInstanceEnabled.ts";
// SCIENT-FORK:END provider-enabled-at-open
// SCIENT-FORK:START — a Stop before native acceptance declines and captures the start.
import {
  pendingStartPreparation,
  pendingStartCancellation,
  startUnlessStopRequested,
} from "./scient-fork/PendingStartOwner.ts";
// SCIENT-FORK:END

import { validateProviderCurrentInput } from "./ScientCurrentInput.ts";

import * as ServerConfig from "../config.ts";
import {
  CLAUDE_PROVIDER,
  CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL,
} from "./Adapters/ClaudeAdapterV2.ts";
import { withTurnStartReservation, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import { prepareScientV2SkillScope } from "../scient/skills/ScientV2SkillTurn.ts";
import { ScientSkillSessionPlanner } from "../scient/skills/ScientSkillSession.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ServerSettings from "../serverSettings.ts";
import { makeRestoreMissingWorktree } from "../workspace/restoreMissingWorktree.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { hasScientContextHistory } from "./ScientHistoricalContext.ts";
import { canForkBusySourceNatively, isActiveRun } from "./CommandPolicy.ts";
import { contextBoundaryOrdinal, isScheduledFreshRun } from "./contextBoundary.ts";
import {
  handoffBudget,
  contextUsageForHandoff,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs, withInlineContext } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import { unsentManualContinuationSource } from "@t3tools/shared/orchestrationV2ManualContinuation";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ContextHandoffBackgroundWorkError,
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
    attemptId: Schema.optional(RunAttemptId),
    rootNodeId: Schema.optional(NodeId),
  },
) {}

/** Runs that ended without completing: their provider turn may still project as running. */
const NON_COMPLETING_TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

export function abandonedProviderTurns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
  run: Pick<OrchestrationV2Run, "ordinal">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
) {
  const attemptsByRun = Map.groupBy(projection.attempts, (attempt) => attempt.runId);
  const abandonedRuns = new Map<string | null, OrchestrationV2Run>();
  for (const previous of projection.runs) {
    if (
      previous.ordinal >= run.ordinal ||
      previous.providerThreadId !== providerThreadId ||
      !NON_COMPLETING_TERMINAL_RUN_STATUSES.has(previous.status)
    ) {
      continue;
    }
    if (previous.activeAttemptId !== null) {
      abandonedRuns.set(previous.activeAttemptId, previous);
    }
    for (const attempt of attemptsByRun.get(previous.id) ?? []) {
      abandonedRuns.set(attempt.id, previous);
    }
  }
  return projection.providerTurns.flatMap((turn) => {
    const previous = abandonedRuns.get(turn.runAttemptId);
    return turn.providerThreadId === providerThreadId &&
      turn.status === "running" &&
      previous !== undefined
      ? [{ turn, run: previous }]
      : [];
  });
}

export const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);

/**
 * Claude refuses these before it reads the prompt: replacing a process running background work,
 * launch arguments whose appended system prompt or settings cannot be read, or MCP registration
 * that never answers while the query opens. A query that ends before the turn attaches (such as a
 * rejected resume point) never received the prompt either.
 */
const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeMcpRegistrationTimeoutError",
] as const;

const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (isProviderAdapterProtocolError(error) &&
    error.driver === CLAUDE_PROVIDER &&
    error.detail === CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

/**
 * Whether a non-truncating provider's native session lost the conversation kept before `run`.
 * Rollback resets it: the newest accepted turn was rolled back (works without legacy-missing
 * native ids) or ran under another native id (rollback of runs the provider never accepted).
 */
const nativeSessionMissesKeptTurns = (
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "attempts" | "providerTurns" | "contextHandoffs"
  >,
  providerThread: OrchestrationV2ProviderThread,
  run: OrchestrationV2Run,
): boolean => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === undefined) return false;
  const acceptedAttemptIds = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const accepted = projection.attempts.filter((attempt) => acceptedAttemptIds.has(attempt.id));
  const runsById = new Map(projection.runs.map((source) => [source.id, source]));
  const ordinalOf = (attempt: OrchestrationV2RunAttempt) =>
    runsById.get(attempt.runId)?.ordinal ?? 0;
  const newest = accepted
    .filter((attempt) => attempt.providerThreadId === providerThread.id)
    .toSorted((a, b) => ordinalOf(a) - ordinalOf(b) || a.attemptOrdinal - b.attemptOrdinal)
    .at(-1);
  if (newest === undefined) return false;
  // Inherited fork history is kept even when every local run was rolled back.
  const keepsHistory =
    (projection.thread.forkedFrom?.type === "run" && projection.thread.lineage.sideChat !== true) ||
    accepted.some((attempt) => {
      const source = runsById.get(attempt.runId);
      return (
        source !== undefined && source.ordinal < run.ordinal && source.status !== "rolled_back"
      );
    });
  return (
    keepsHistory &&
    (runsById.get(newest.runId)?.status === "rolled_back" ||
      (newest.nativeThreadId !== undefined && newest.nativeThreadId !== nativeId)) &&
    !projection.contextHandoffs.some(
      (handoff) =>
        handoff.toProviderThreadId === providerThread.id &&
        handoff.delivery?.nativeThreadId === nativeId &&
        handoff.delivery.status !== "pending",
    )
  );
};

/** Missing execution records cannot be repaired by retrying a start. */
export class ProviderTurnStartRunStateMissingError extends Schema.TaggedError<ProviderTurnStartRunStateMissingError>()(
  "ProviderTurnStartRunStateMissingError",
  {
    runId: RunId,
  },
) {}

export const isProviderTurnStartRunStateMissingError = Schema.is(
  ProviderTurnStartRunStateMissingError,
);

const RESUME_PROMPT = "Continue where you left off.";

// SCIENT-FORK: product name.
const START_GAVE_UP_MESSAGE =
  "Scient could not start this turn. Send the message again; if it keeps failing, check the server logs.";

const startFailureMessage = (error: Error): string => {
  const nestedCause = "cause" in error ? error.cause : undefined;
  return (
    knownProviderFailureMessage(error) ??
    (nestedCause instanceof Error
      ? nestedCause.message
      : typeof nestedCause === "string"
        ? nestedCause
        : error.message)
  );
};

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
    readonly expectedAttemptId?: RunAttemptId;
    // SCIENT-FORK: the refused owner dispatch replaced with a new provider session.
    readonly supersededProviderSessionId?: ProviderSessionId;
  }) => Effect.Effect<void, ProviderTurnStartError>;
  readonly failStartingRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly attemptId: RunAttemptId;
    readonly rootNodeId: NodeId;
  }) => Effect.Effect<void, ProviderTurnStartError | ProviderTurnStartRunStateMissingError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
  | McpProviderSessions.McpProviderSessions
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const handoffPolicy = yield* makeScientContextHandoffPolicy();
    const modelWindowSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const forceBytePolicy = (yield* ContextHandoffPolicyOverride) === "byte";
    const eventSink = yield* EventSink.EventSinkV2;
    const turnAnalytics = yield* ProviderUsageAnalytics.ProviderTurnAnalytics;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const skillPlanner = yield* ScientSkillSessionPlanner;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

    // Build draining callbacks outside startup scope so they cannot retain full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly worktreePath: string | null;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptIn = (statuses: ReadonlyArray<OrchestrationV2Run["status"]>) =>
        projectionStore
          .getRun(input.threadId, input.runId)
          .pipe(
            Effect.map(
              (run) => run?.activeAttemptId === input.attemptId && statuses.includes(run.status),
            ),
          );
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        isCurrentAttemptIn([expectedStatus]);
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        // SCIENT-FORK:START — a Stop requested before the native offer declines it.
        shouldStartProviderTurn: () =>
          startUnlessStopRequested(isCurrentAttemptInStatus("running"), {
            projectionStore,
            idAllocator,
            threadId: input.threadId,
            runId: input.runId,
          }),
        // SCIENT-FORK:END
        shouldFinalizeRun: () => isCurrentAttemptIn(["starting", "running"]),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
        hasWorkspaceMoved: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => current.thread.worktreePath !== input.worktreePath),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
        loadUnsettledWork: (threadId: ThreadId, nodeIds: ReadonlyArray<NodeId>) =>
          projectionStore
            .getThreadRecords(threadId, ["subagents", "nodes", "turnItems"], {
              nodeIds,
              subagentIds: nodeIds,
              turnItemStatuses: ["pending", "running", "waiting"],
            })
            .pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () =>
                  Effect.succeed({ subagents: [], nodes: [], turnItems: [] }),
              }),
            ),
        loadRunInterruptReason: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["run_interrupt_request"],
              turnItemRunIds: [input.runId],
            })
            .pipe(
              Effect.map(({ turnItems }) => {
                const request = turnItems.find((item) => item.type === "run_interrupt_request");
                return request?.type === "run_interrupt_request" ? request.message : undefined;
              }),
              Effect.catchCause(() => Effect.undefined),
            ),
      };
    };

    // SCIENT-FORK:START — a long-lived run must retain only its captured owner, never startup history.
    const makePendingStartCancellation = pendingStartCancellation({
      projectionStore,
      idAllocator,
      providerSessions,
    });
    // SCIENT-FORK:END

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.resumeTurn === undefined
          ? {}
          : {
              resumeTurn: (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
                start(ProviderAdapter.resumeTurnInput(input)),
            }),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
      function* (input: {
        readonly run: OrchestrationV2Run;
        readonly rootNode: OrchestrationV2ExecutionNode;
        readonly attempt: OrchestrationV2RunAttempt;
        readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly signal: string;
        readonly status: "completed" | "failed";
        readonly now: DateTime.Utc;
        readonly startedAt?: DateTime.Utc;
        readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
        readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
        readonly item:
          | Pick<Extract<OrchestrationV2TurnItem, { type: "error" }>, "type" | "title" | "failure">
          | Pick<
              Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
              "type" | "title" | "input" | "output" | "exitCode"
            >;
        readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
      }) {
        const { run, rootNode, attempt, turnItems, now, status } = input;
        const runId = run.id;
        const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
        const item: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
          threadId: run.threadId,
          runId,
          nodeId: rootNode.id,
          providerThreadId: input.itemProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            Math.max(
              0,
              ...turnItems.filter((item) => item.runId === runId).map((item) => item.ordinal),
            ) + 1,
          status,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          ...input.item,
        };
        const eventPayloads = [
          { type: "turn-item.updated", payload: item },
          { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
          {
            type: "run-attempt.updated",
            payload: { ...attempt, status, ...started, completedAt: now },
          },
          {
            type: "node.updated",
            payload: { ...rootNode, status, ...started, completedAt: now },
          },
          ...(input.providerThreadUpdate === undefined
            ? []
            : [
                {
                  type: "provider-thread.updated" as const,
                  payload: input.providerThreadUpdate,
                },
              ]),
        ] as const;
        const events = yield* Effect.forEach(eventPayloads, (event) =>
          Effect.gen(function* () {
            return {
              ...event,
              id: yield* idAllocator.allocate.event({ threadId: run.threadId }),
              threadId: run.threadId,
              runId,
              nodeId: rootNode.id,
              providerInstanceId: input.providerInstanceId,
              occurredAt: now,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events,
        });
        // A steering restart that cannot start still ends a run whose earlier turns counted.
        if (written.committed) {
          yield* turnAnalytics.runSettled({
            runId,
            status,
            completedAt: now,
            childrenRunning: false,
          });
        }
      },
    );

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (
      input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly willRetry?: boolean;
        readonly expectedAttemptId?: RunAttemptId;
        // SCIENT-FORK: the refused owner dispatch replaced with a new provider session.
        readonly supersededProviderSessionId?: ProviderSessionId;
      },
      captureStartingRun: (run: OrchestrationV2Run) => void,
    ) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      // SCIENT-FORK: a fork's workspace choice shapes how its history is delivered.
      const conversationFork = yield* projectionStore.getConversationFork(input.threadId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        return;
      }
      if (
        input.expectedAttemptId !== undefined &&
        run.activeAttemptId !== input.expectedAttemptId
      ) {
        // A delayed effect for an older attempt has no authority over Retry.
        return;
      }
      captureStartingRun(run);
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      // Older versions also stored subagent replies as history handoffs. Their
      // queued completion messages carry the results without a history budget.
      const subagentResultTransfers = new Set(
        projection.contextTransfers
          .filter((transfer) => transfer.type === "subagent_result")
          .map((transfer) => transfer.id),
      );
      const isPendingForRun = (handoff: OrchestrationV2ContextHandoff, anyProviderThread = false) =>
        handoff.status === "ready" &&
        (handoff.targetRunId === run.id ||
          ((anyProviderThread || handoff.toProviderThreadId === run.providerThreadId) &&
            projection.runs.some(
              (source) =>
                source.id === handoff.targetRunId &&
                // A settled delivery retires history of this thread: the session that took it
                // holds it, and a fresh session starts from a full summary of the thread. That
                // summary lacks another thread's history (a fork source, a merge-back).
                (((source.status === "failed" ||
                  source.status === "interrupted" ||
                  source.status === "cancelled") &&
                  !(
                    (handoff.delivery?.status === "injected" ||
                      handoff.delivery?.status === "inline") &&
                    handoff.fromProviderThreadIds.length > 0 &&
                    handoff.fromProviderThreadIds.every((id) =>
                      projection.providerThreads.some((candidate) => candidate.id === id),
                    )
                  )) ||
                  (source.status === "completed" &&
                    handoff.delivery === undefined &&
                    // Compaction and /goal turns defer history to the next turn.
                    projection.messages.some(
                      (message) =>
                        message.id === source.userMessageId &&
                        (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
                    ))),
            )));
      const isSideChatHandoff = (handoff: OrchestrationV2ContextHandoff) =>
        projection.thread.lineage.sideChat === true &&
        ContextHandoffService.isSideChatContextHandoff(handoff);
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          !isSideChatHandoff(handoff) &&
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          isPendingForRun(handoff),
      );
      // Carried forward until a provider turn accepts them, also after a provider switch. A fresh
      // session starts without them, and an unscheduled fresh run retires them. A schedule's fresh
      // run is a side conversation, so the thread's next turn still gets them.
      const carriedSideChatHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          isSideChatHandoff(handoff) &&
          handoff.delivery === undefined &&
          isPendingForRun(handoff, true),
      );
      const sideChatHandoff = run.freshContext === true ? undefined : carriedSideChatHandoffs[0];
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      if (
        carriedSideChatHandoffs.length > 0 &&
        run.freshContext === true &&
        !isScheduledFreshRun(run, projection.turnItems)
      ) {
        const updatedAt = yield* DateTime.now;
        const retired = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(carriedSideChatHandoffs, (handoff) =>
            Effect.map(idAllocator.allocate.event({ threadId: projection.thread.id }), (id) => ({
              id,
              type: "context-handoff.updated" as const,
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, status: "superseded" as const, updatedAt },
            })),
          ),
        });
        if (!retired.committed) return;
      }
      const source = message.notification?.source;
      const providerWork = source?.kind === "provider_work" ? source : undefined;
      const manualResume =
        run.manualContinuationOfRunId !== undefined && attempt.reason !== "steering_restart";
      const resumeSource = manualResume
        ? unsentManualContinuationSource(run, projection)
        : undefined;
      const unsentResumeMessage =
        resumeSource !== undefined
          ? projection.messages.find((source) => source.id === resumeSource.userMessageId)
          : undefined;
      const providerMessage = unsentResumeMessage ?? message;
      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
          readonly message?: string;
        }) {
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: failed.signal,
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: failed.title,
              failure: makeProviderFailure({
                cause: failed.error,
                message: failed.message ?? startFailureMessage(failed.error),
                class: "provider_error",
              }),
            },
          });
        },
      );
      if (
        expandAssistantCitationsForProvider(providerMessage.text).length >
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS
      ) {
        yield* settleRunBeforeStart({
          run,
          rootNode,
          attempt,
          turnItems: projection.turnItems,
          signal: "expanded-input-too-long",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Message is too long",
            failure: makeProviderFailure({
              class: "validation_error",
              message: `Message exceeds ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} characters after expanding quotes. Shorten it and try again.`,
            }),
          },
        });
        return;
      }
      if (
        providerWork === undefined &&
        providerMessage.attachments.length === 0 &&
        providerMessage.text.trimStart().startsWith("/")
      ) {
        const isEmptyCompaction =
          providerMessage.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparation may select a new provider; account commands still target the last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: projectComposerContextForProvider({
                  text: providerMessage.text,
                  records: providerMessage.context?.records ?? [],
                }),
                hasAttachments: false,
                // A scheduled delivery keeps its task author's createdBy.
                sentByPerson:
                  providerMessage.createdBy === "user" &&
                  providerMessage.scheduledTaskId === undefined,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: providerMessage.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status:
                providerThread.status === "error"
                  ? "error"
                  : providerThread.nativeThreadRef === null
                    ? "not_loaded"
                    : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const recreateResult = yield* Effect.result(restoreMissingWorktree(projection.thread));
      if (recreateResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recreateResult.failure;
        yield* settleStartFailure({
          signal: "worktree-recreate-failure",
          title: "Couldn't recreate thread workspace",
          error: recreateResult.failure,
          message: recreateResult.failure.message,
        });
        return;
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const recoveryResult = yield* Effect.result(
        projectionStore.getRuntimeRecoveryProjection(projection.thread.id),
      );
      if (recoveryResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recoveryResult.failure;
        yield* settleStartFailure({
          signal: "runtime-recovery-read-failure",
          title: "Couldn't read thread state",
          error: recoveryResult.failure,
        });
        return;
      }
      const inheritedBackgroundTurnItems = selectInheritedBackgroundItems(recoveryResult.success);
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        worktreePath: projection.thread.worktreePath,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus, shouldStartProviderTurn } = runControls;

      const admittedRuntimePolicy = providerWork?.runtimePolicy ?? run.steeringRuntimePolicy;
      const resolvedPolicy = yield* (
        admittedRuntimePolicy
          ? Effect.succeed(admittedRuntimePolicy)
          : runtimePolicy.resolve({
              thread: {
                ...projection.thread,
                runtimeMode:
                  run.runtimeMode ?? run.legacyQueue?.runtimeMode ?? projection.thread.runtimeMode,
                interactionMode:
                  run.interactionMode ??
                  run.legacyQueue?.interactionMode ??
                  projection.thread.interactionMode,
              },
              modelSelection: run.modelSelection,
            })
      ).pipe(Effect.result);
      if (resolvedPolicy._tag === "Failure") {
        const error = resolvedPolicy.failure;
        if (error._tag !== "RuntimePolicyAboveCeilingError") return yield* error;
        yield* settleStartFailure({
          signal: "runtime-mode-above-ceiling",
          title: "Thread mode is above the policy limit",
          error,
          message: error.message,
        });
        return;
      }
      const resolvedRuntimePolicy = resolvedPolicy.success;
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      // SCIENT-FORK: reserved before the session is opened or reused, until this start ends.
      yield* reserveSessionForStartup(providerSessions, providerSessionId);
      // A run that ended without completing can leave its provider turn projected as
      // running when the agent ignored Stop or an interrupt timed out. Every attempt
      // of such a run owns a possible abandoned turn, including attempts a steering
      // restart superseded, and the session cannot be reused until those turns stop.
      const abandonedTurns = abandonedProviderTurns(projection, run, providerThread.id);
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        // Buffered work already owns this generation; restarting it would destroy its next turn.
        if (providerWork === undefined && Option.isSome(liveSession)) {
          // The run already ended without stopping its provider — a failed start, an
          // ignored Stop, or an interrupt that never confirmed. Recover that exact
          // turn before reusing its native conversation.
          const recovered = yield* Effect.result(
            liveSession.value.interruptTurn({
              providerThread,
              providerTurnId: abandonedTurn.id,
              requestRuntimeRestart: true,
            }),
          );
          if (recovered._tag === "Failure") {
            if (input.willRetry === true) return yield* recovered.failure;
            yield* settleStartFailure({
              signal: "provider-turn-recovery-failure",
              title: "Provider turn recovery failed",
              error: recovered.failure,
            });
            return;
          }
        }
        const completedAt = yield* DateTime.now;
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(abandonedTurns, ({ turn, run: abandonedRun }) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "provider-turn.updated" as const,
                threadId: projection.thread.id,
                runId: abandonedRun.id,
                nodeId: turn.nodeId,
                providerInstanceId: abandonedRun.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...turn, status: "interrupted" as const, completedAt },
              };
            }),
          ),
        });
        if (!repaired.committed) return;
      }
      // Opening a session does not prompt the provider, so the workspace is still unchanged.
      const baseline = yield* runExecution.forkBaseline({
        appThread: projection.thread,
        run,
        checkpointScope,
      });
      const brokenNativeThread = providerThread.status === "error";
      // Opened without the broken native id, a session that was not live starts fresh.
      const opensFreshSession =
        brokenNativeThread &&
        providerThread.nativeThreadRef !== null &&
        !(yield* providerSessions.isLive(providerSessionId));
      const sessionResult = yield* Effect.result(
        providerWork !== undefined
          ? Effect.gen(function* () {
              const owned = yield* providerSessions.get(providerWork.providerSessionId);
              if (
                Option.isNone(owned) ||
                providerWork.providerSessionId !== providerSessionId ||
                providerWork.providerThreadId !== providerThread.id ||
                projection.thread.activeProviderThreadId !== providerThread.id ||
                owned.value.instanceId !== run.providerInstanceId ||
                owned.value.providerSession.cwd !== resolvedRuntimePolicy.cwd ||
                checkpointScope.cwd !== resolvedRuntimePolicy.cwd ||
                existingSessionProjection === undefined ||
                !["ready", "running", "waiting"].includes(existingSessionProjection.status) ||
                !modelSelectionsEqual(providerWork.modelSelection, run.modelSelection) ||
                run.runtimeMode !== resolvedRuntimePolicy.runtimeMode ||
                run.interactionMode !== resolvedRuntimePolicy.interactionMode
              )
                return yield* new ProviderTurnStartError({
                  runId,
                  cause: "Buffered native work no longer owns its captured execution session.",
                });
              return owned.value;
            })
          : providerSessions.open({
              threadId: projection.thread.id,
              providerSessionId,
              // SCIENT-FORK:START provider-enabled-at-open
              requireEnabledInstance: true,
              // SCIENT-FORK:END provider-enabled-at-open
              // SCIENT-FORK:START — the superseded owner can hold this native history.
              ...(input.supersededProviderSessionId === undefined
                ? {}
                : { supersededProviderSessionId: input.supersededProviderSessionId }),
              // SCIENT-FORK:END
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              ...(existingSessionProjection === undefined
                ? {}
                : { resumeFromSession: existingSessionProjection }),
              ...(providerThread.nativeThreadRef?.nativeId == null || brokenNativeThread
                ? {}
                : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
              ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
                ? {}
                : {
                    initialProviderItemIdentityVersion:
                      providerThread.nativeMetadata.itemIdentityVersion,
                  }),
            }),
      );
      // SCIENT-FORK:START — portable history is read before the native offer.
      const prepareHistoryBeforeStart = makeTurnStartHistory({
        projectionStore,
        threadId: input.threadId,
        runs: projection.runs,
        willRetry: input.willRetry,
        referenceOnly: !forceBytePolicy && hasScientContextHistory(projection),
        settleStartFailure,
      });
      const prepareFullHistoryBeforeStart = makeTurnStartHistory({
        projectionStore,
        threadId: input.threadId,
        runs: projection.runs,
        willRetry: input.willRetry,
        settleStartFailure,
      });
      // SCIENT-FORK:END
      // SCIENT-FORK:START provider-enabled-at-open
      if (
        sessionResult._tag === "Failure" &&
        isProviderInstanceDisabledOpen(sessionResult.failure)
      ) {
        yield* settleStartFailure({
          signal: "provider-instance-disabled",
          title: "Provider is turned off",
          error: sessionResult.failure,
        });
        return;
      }
      // SCIENT-FORK:END provider-enabled-at-open
      if (sessionResult._tag === "Failure") {
        const failure = sessionResult.failure;
        const requiresSignIn =
          "cause" in failure &&
          isProviderAdapterOpenSessionError(failure.cause) &&
          failure.cause.requiresSignIn === true;
        // A disposed buffered generation cannot be recreated by retrying session startup.
        const bufferedGenerationLost =
          providerWork !== undefined && failure._tag === "ProviderTurnStartError";
        if (input.willRetry === true && !requiresSignIn && !bufferedGenerationLost)
          return yield* failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) {
        const loaded = yield* Effect.result(load);
        if (loaded._tag === "Success") return loaded.success;
        if (input.willRetry === true) return yield* loaded.failure;
        yield* settleStartFailure({
          signal: "provider-thread-load-failure",
          title: "Provider turn failed to start",
          error: loaded.failure,
        });
        return undefined;
      });
      let effectiveHandoffs = providerWork === undefined ? handoffs : [];
      let completedNativeFork = nativeForkTransfer;
      let resumeFellBack = false;
      const userText = withMessageSenderNote(
        providerMessage,
        projectComposerContextForProvider({
          text: providerMessage.text,
          records: providerMessage.context?.records ?? [],
        }),
      );
      // Native goal commands go verbatim; handoff history waits a turn.
      const goalDriver =
        session.driver === "codex" ||
        session.driver === "claudeAgent" ||
        session.providerSession.capabilities.turns.supportsNativeGoals === true;
      const goalCommand = goalDriver && parseGoalCommand(providerMessage) !== null;
      // The provider turn marks cancellation work delivered; restart continuations use their own text or resume natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: () =>
          new Set(
            projection.messages
              .filter(
                (candidate) =>
                  isCompactionCommandMessage(candidate) ||
                  (goalDriver && parseGoalCommand(candidate) !== null),
              )
              .map((candidate) => candidate.id),
          ),
        run,
        attempts: projection.attempts,
      });
      const restartNote =
        restartCancelledWork.length === 0
          ? ""
          : restartCancelledBackgroundWorkNote(restartCancelledWork);
      // SCIENT-FORK:START — the Scient or generic policy supplies the token cap; the
      // native model window is resolved once from persisted launch evidence.
      const reportedModelWindow = session.getModelContextWindow?.(
        run.modelSelection,
        resolvedRuntimePolicy.cwd,
      );
      const resolvedModelWindow = Option.isSome(modelWindowSql)
        ? yield* resolveNativeModelContextWindow({
            sql: modelWindowSql.value,
            settings: yield* serverSettings.getSettings,
            modelSelection: run.modelSelection,
            reported: reportedModelWindow,
            ...(session.modelContextWindowLaunchFingerprint === undefined
              ? {}
              : {
                  launchFingerprint: session.modelContextWindowLaunchFingerprint,
                }),
          })
        : reportedModelWindow;
      // SCIENT-FORK:END
      const handoffContextForThread = (loadedProviderThread: OrchestrationV2ProviderThread) => {
        const measuredContext = latestNativeContextUsage(projection, providerThread);
        const previousSelection =
          measuredContext?.modelSelection ??
          projection.runs.findLast(
            (source) =>
              source.ordinal < run.ordinal &&
              source.startedAt !== null &&
              source.providerThreadId === providerThread.id,
          )?.modelSelection;
        const sameSelection =
          previousSelection === undefined ||
          modelSelectionsEqual(previousSelection, run.modelSelection);
        const sameNativeThread =
          loadedProviderThread.nativeThreadRef?.nativeId ===
          providerThread.nativeThreadRef?.nativeId;
        const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
        const previousUsage = measuredContext
          ? { ...threadUsage, ...measuredContext.usage }
          : threadUsage;
        const reuseTelemetry =
          sameSelection ||
          (previousSelection !== undefined &&
            session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
        // SCIENT-FORK:START — resolved native model window.
        const knownModelWindow = resolvedModelWindow;
        // SCIENT-FORK:END
        const handoffUsage = contextUsageForHandoff({
          sameNativeThread,
          sameSelection,
          reuseTelemetry,
          previousUsage,
          knownModelWindow,
        });
        const settledHandoffs = projection.contextHandoffs.filter(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status !== "pending" &&
            // SCIENT-FORK:START — a rolled-back carrying run removed its delivered history.
            !projection.runs.some(
              (source) => source.id === handoff.targetRunId && source.status === "rolled_back",
            ),
          // SCIENT-FORK:END
        );
        const deliveredItemIds = new Set(
          settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
        );
        const coveredItemIds = new Set([
          ...deliveredItemIds,
          ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
        ]);
        // SCIENT-FORK:START — explicit refusal records settlement without delivery; old or
        // uncertain receipts may have delivered and must not duplicate native history.
        const deliveredAttemptIds = new Set(
          projection.providerTurns
            .filter(
              (turn) =>
                turn.acceptedAt !== undefined ||
                (turn.nativeAcceptance !== "pending" &&
                  (turn.nativeAcceptance !== undefined || turn.nativeTurnRef !== null)),
            )
            .map((turn) => turn.runAttemptId),
        );
        // SCIENT-FORK:END
        const acceptedAttempts = projection.attempts.filter(
          (source) =>
            source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
        );
        const nativeInputRunIds = new Set(
          acceptedAttempts
            .filter(
              (source) =>
                source.nativeThreadId !== undefined &&
                source.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId,
            )
            .map((source) => source.runId),
        );
        const legacyInputRunIds = new Set(
          acceptedAttempts
            .filter((source) => source.nativeThreadId === undefined)
            .map((source) => source.runId),
        );
        const legacyRecoveredRunIds = new Set(
          projection.runs
            .filter(
              (source) =>
                source.providerThreadId === providerThread.id &&
                settledHandoffs.some(
                  (handoff) =>
                    handoff.strategy === "full_thread_summary" &&
                    handoff.fromProviderThreadIds.includes(providerThread.id) &&
                    source.ordinal >= handoff.coveredRunOrdinals.from &&
                    source.ordinal <= handoff.coveredRunOrdinals.to,
                ),
            )
            .map((source) => source.id),
        );
        // Row identity survives recovery; only accepted native input and delivered history occupy the new session.
        // SCIENT-FORK:START — bounded measurement in the policy's token units.
        const nativeContextEstimate = Effect.fn("ProviderTurnStartService.nativeContextEstimate")(
          function* (bytesPerToken: number) {
            return sameNativeThread
              ? (yield* projectionStore.getNativeHistoryEstimates(input.threadId)).reduce(
                  (sum, item) => {
                    const acceptedNatively =
                      item.providerThreadId === providerThread.id &&
                      item.runId !== null &&
                      (nativeInputRunIds.has(item.runId) ||
                        (legacyInputRunIds.has(item.runId) &&
                          !coveredItemIds.has(item.id) &&
                          !legacyRecoveredRunIds.has(item.runId)));
                    if (
                      item.runId === run.id ||
                      projection.runs.some(
                        (source) => source.id === item.runId && source.status === "rolled_back",
                      ) ||
                      (!acceptedNatively && !deliveredItemIds.has(item.id))
                    )
                      return sum;
                    const nativeAttachments =
                      item.type === "user_message" && acceptedNatively ? item.attachmentTokens : 0;
                    return sum + Math.ceil(item.textBytes / bytesPerToken) + nativeAttachments;
                  },
                  0,
                )
              : 0;
          },
        );
        // SCIENT-FORK:END
        const modelContextWindow =
          knownModelWindow ??
          (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
        const budgetProviderThread = {
          ...loadedProviderThread,
          contextUsage: handoffUsage,
        };
        const missedRuns = projection.runs.filter(
          (source) =>
            source.ordinal < run.ordinal &&
            source.providerThreadId === providerThread.id &&
            (source.status === "failed" || source.status === "interrupted") &&
            !deliveredAttemptIds.has(source.activeAttemptId),
        );
        const missedRunIds = new Set(missedRuns.map((source) => source.id));
        return {
          sameNativeThread,
          handoffUsage,
          deliveredItemIds,
          coveredItemIds,
          acceptedAttempts,
          nativeInputRunIds,
          legacyInputRunIds,
          missedRuns,
          missedRunIds,
          // SCIENT-FORK:START — the delivered handoffs choose the Scient or generic policy,
          // and the skill-prepared current input replaces the composer text at delivery.
          budget: Effect.fn("ProviderTurnStartService.handoffBudget")(function* (
            budgetHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>,
            currentText = userText,
          ) {
            const scientBudget = usesScientHandoffBudget({
              forceBytePolicy,
              projection,
              handoffs: budgetHandoffs,
              providerInstanceId: run.providerInstanceId,
            });
            const policy = yield* scientBudget ? handoffPolicy : genericContextHandoffPolicy;
            return handoffBudget({
              ...policy,
              modelContextWindow,
              // The restart note and user text spend the same serialized allowance.
              userText: restartNote === "" ? currentText : `${restartNote}\n\n${currentText}`,
              attachments: providerMessage.attachments,
              providerThread: budgetProviderThread,
              nativeContextEstimate:
                budgetProviderThread.contextUsage?.usedTokens === undefined
                  ? // Stored history runs about four bytes per token; the
                    // Scient policy measures in its own token unit.
                    yield* nativeContextEstimate(scientBudget ? policy.bytesPerToken : 4)
                  : 0,
            });
          }),
          // SCIENT-FORK:END
        };
      };
      const prepareRetryHandoff = Effect.fn("ProviderTurnStartService.prepareRetryHandoff")(
        function* (context: ReturnType<typeof handoffContextForThread>) {
          const { missedRunIds, coveredItemIds, missedRuns, acceptedAttempts } = context;
          // SCIENT-FORK:START — missing native receipts read portable history before this
          // attempt becomes running; a failed read must not strand a run without a native turn.
          const missedRunHistory =
            missedRunIds.size === 0 ? [] : yield* prepareHistoryBeforeStart([...missedRunIds]);
          if (missedRunHistory === undefined) return undefined;
          const missedHistory = missedRunHistory.filter(
            (item) => item.runId !== null && missedRunIds.has(item.runId),
          );
          const missedItems = missedHistory.filter(
            (item) => !coveredItemIds.has(item.id) && isContextHistoryItem(item),
          );
          // SCIENT-FORK:END
          // The resume fallback summary already covers every earlier run in order. A
          // retry copy after it would rank older missed requests as the newest history.
          const handoffs =
            missedItems.length === 0 || resumeFellBack
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    // SCIENT-FORK:START — Scient provenance spends the Scient handoff budget.
                    ...(usesScientHandoffBudget({
                      forceBytePolicy,
                      projection,
                      handoffs: effectiveHandoffs,
                      providerInstanceId: run.providerInstanceId,
                    })
                      ? { purpose: "session_recovery" as const }
                      : {}),
                    // SCIENT-FORK:END
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          // History delivery (inline or injected) is text only, so missed images ride on prompts
          // until a later run's is accepted. Compaction and /goal starts carry none. A missed run's
          // own accepted attempt predates its unsent steering input, so it does not count.
          const runsById = new Map(projection.runs.map((source) => [source.id, source]));
          const messagesById = new Map(projection.messages.map((message) => [message.id, message]));
          let lastPromptOrdinal = 0;
          for (const attempt of acceptedAttempts) {
            if (missedRunIds.has(attempt.runId)) continue;
            const source = runsById.get(attempt.runId);
            if (source === undefined) continue;
            const message = messagesById.get(source.userMessageId);
            if (
              message !== undefined &&
              (isCompactionCommandMessage(message) ||
                (goalDriver && parseGoalCommand(message) !== null))
            )
              continue;
            lastPromptOrdinal = Math.max(lastPromptOrdinal, source.ordinal);
          }
          const promptRunIds = missedRuns
            .filter((source) => source.ordinal > lastPromptOrdinal)
            .map((source) => source.id);
          // SCIENT-FORK:START — reference-only history carries no images; read those prompts whole.
          const promptHistory = missedHistory.some(
            (item) =>
              "sourceOnly" in item &&
              item.type === "user_message" &&
              item.runId !== null &&
              promptRunIds.includes(item.runId),
          )
            ? yield* prepareFullHistoryBeforeStart(promptRunIds)
            : missedHistory;
          if (promptHistory === undefined) return undefined;
          // SCIENT-FORK:END
          const attachments = promptHistory.flatMap((item) =>
            !("sourceOnly" in item) &&
            item.type === "user_message" &&
            item.runId !== null &&
            promptRunIds.includes(item.runId)
              ? item.attachments
              : [],
          );
          return { handoffs, attachments };
        },
      );
      const prepareRecoveryHandoff = Effect.fn("ProviderTurnStartService.prepareRecoveryHandoff")(
        function* () {
          const transferId = yield* idAllocator.allocate.contextTransfer({
            sourceThreadId: projection.thread.id,
            targetThreadId: projection.thread.id,
            type: "provider_resume_fallback",
          });
          const createdAt = yield* DateTime.now;
          // SCIENT-FORK:START — portable history excludes rolled-back runs.
          const history = yield* prepareHistoryBeforeStart();
          if (history === undefined) return undefined;
          // SCIENT-FORK:END
          // SCIENT-FORK:START — history may be body-less candidates; only a fresh run sets a boundary.
          const boundary = projection.runs.some((source) => source.freshContext === true)
            ? contextBoundaryOrdinal({
                runs: projection.runs,
                turnItems: yield* projectionStore.getTurnStartHistory(projection.thread.id),
              })
            : 0;
          // SCIENT-FORK:END
          const inherited =
            boundary === 0
              ? yield* ContextHandoffService.readInheritedHandoffItems(
                  projectionStore,
                  projection.thread,
                )
              : [];
          // SCIENT-FORK:START — copied frozen rows are also the thread's own runless rows.
          const inheritedIds = new Set<string>(inherited.map((item) => item.id));
          // SCIENT-FORK:END
          const from = Math.max(1, boundary);
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            // SCIENT-FORK:START — Scient history recovers with the session-recovery budget.
            ...(hasScientContextHistory(projection)
              ? { purpose: "session_recovery" as const }
              : {}),
            // SCIENT-FORK:END
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: { from, to: Math.max(from, run.ordinal - 1) },
            strategy: "full_thread_summary",
            runs: projection.runs,
            items: [
              ...inherited,
              ...history.filter((item) =>
                item.runId === null
                  ? boundary === 0 && !inheritedIds.has(item.id)
                  : projection.runs.some(
                      (source) =>
                        source.id === item.runId &&
                        source.ordinal >= boundary &&
                        source.ordinal < run.ordinal &&
                        source.status !== "rolled_back",
                    ),
              ),
            ],
            createdAt,
          });
          return { handoff, transferId, createdAt };
        },
      );
      const recoveryHandoff = yield* Effect.cached(prepareRecoveryHandoff());
      const withRecoveryHandoff = (handoff: OrchestrationV2ContextHandoff) => {
        // Delivery ranks later handoffs as newer history. Pending handoffs from
        // earlier runs predate this summary; handoffs for this run (provider-switch
        // delta, merge-back) are newer and must stay last.
        return [
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId !== run.id),
          handoff,
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId === run.id),
        ];
      };
      let resumedRetryHandoff: Effect.Success<ReturnType<typeof prepareRetryHandoff>> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
      let portableForkFallback: OrchestrationV2ContextHandoff | undefined;
      let recoveryTurnItem: OrchestrationV2TurnItem | undefined;
      const loadedProviderThread = yield* Effect.gen(function* () {
        // Adoption consumes the existing generation; it cannot reload or replace its native owner.
        if (providerWork !== undefined) return providerThread;
        if (nativeForkTransfer !== undefined) {
          // SCIENT-FORK:START — a frozen fork starts natively or from its portable prefix.
          if (projection.thread.historyOrigin === "scient_fork") {
            const frozenStart = yield* startFrozenConversationFork({
              nativeForkTransfer,
              session,
              threadId: projection.thread.id,
              runs: projection.runs,
              run,
              providerThread,
              providerSessionId,
              resolvedRuntimePolicy,
              loadFromProvider,
              prepareHistoryBeforeStart,
              startError: (cause) => new ProviderTurnStartError({ runId, cause }),
              stillStarting: isCurrentAttemptInStatus("starting"),
              nativeForkFailureMessage: (failure) =>
                makeProviderFailure({
                  cause: failure,
                  message: startFailureMessage(failure),
                  class: "provider_error",
                }).message,
              rootNodeId: rootNode.id,
              noticeOrdinal:
                Math.max(
                  0,
                  ...projection.turnItems
                    .filter((item) => item.runId === runId)
                    .map((item) => item.ordinal),
                ) + 1,
              projectionStore,
              contextHandoffService,
              eventSink,
              idAllocator,
            });
            if (frozenStart.portableHandoff !== undefined) {
              effectiveHandoffs = [frozenStart.portableHandoff, ...effectiveHandoffs];
              completedNativeFork = undefined;
            }
            return frozenStart.providerThread;
          }
          // SCIENT-FORK:END
          let sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          // The source may have started a turn after dispatch planned this fork.
          const sourceBusy = sourceProjection.runs.some(
            (candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun(candidate),
          );
          let nativeForkFailure: string | undefined;
          if (
            (sourceRun.status === "completed" || sourceRun.status === "waiting") &&
            (!sourceBusy ||
              canForkBusySourceNatively(
                session.providerSession.capabilities,
                sourceProviderTurn?.nativeTurnRef != null,
              ))
          ) {
            const forked = yield* Effect.result(
              session.forkThread({
                sourceProviderThread,
                // SCIENT-FORK:START — one rule drops rolled-back turns here and in frozen forks.
                sourceProviderTurns: providerTurnsOutsideRolledBackRuns(sourceProjection),
                // SCIENT-FORK:END
                targetThreadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                ...(sourceProviderTurn === undefined
                  ? {}
                  : { providerTurnId: sourceProviderTurn.id }),
              }),
            );
            if (forked._tag === "Success") return forked.success;
            if (input.willRetry === true) return yield* forked.failure;
            if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
            // Retries are spent (e.g. the source's native session is gone): start fresh with portable history.
            yield* Effect.logWarning("Starting a native fork in a fresh native session", {
              driver: session.driver,
              providerThreadId: providerThread.id,
              sourceProviderThreadId: sourceProviderThread.id,
              runId,
              errorTag: forked.failure._tag,
            });
            nativeForkFailure = makeProviderFailure({
              cause: forked.failure,
              message: startFailureMessage(forked.failure),
              class: "provider_error",
            }).message;
            sourceProjection = {
              ...sourceProjection,
              ...(yield* projectionStore.getThreadRecords(nativeForkTransfer.sourceThreadId, [
                "runs",
                "attempts",
              ])),
            };
          }
          const nativeForkFailed = nativeForkFailure !== undefined;
          // SCIENT-FORK:START — a frozen parent's rows are read here too, by reference.
          const sourceItems = yield* ContextHandoffService.readPortableForkItems(
            projectionStore,
            sourceProjection,
            sourceRun,
            !forceBytePolicy,
          );
          // SCIENT-FORK:END
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId: nativeForkTransfer.id,
            // SCIENT-FORK:START — same retained-history policy as a dispatch-time portable fork.
            purpose: "scient_fork",
            // SCIENT-FORK:END
            fromProviderThreadIds: [sourceProviderThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: sourceRun.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: ContextHandoffService.visibleDeltaRunOrdinals(
              sourceProjection,
              sourceItems,
            ),
            strategy: "full_thread_summary",
            items: sourceItems,
            runs: sourceProjection.runs,
            createdAt,
          });
          const loaded = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: nativeForkFailed
                ? { ...providerThread, nativeThreadRef: null, forkedFrom: null }
                : { ...providerThread, forkedFrom: null },
              // The failed fork may have left the adapter's session half-switched.
              ...(nativeForkFailed ? { forceNewNativeThread: true } : {}),
            }),
          );
          if (loaded === undefined) return undefined;
          portableForkFallback = handoff;
          effectiveHandoffs = [handoff, ...effectiveHandoffs];
          // SCIENT-FORK:START — one marker clears the provider link and the consumed transfer.
          completedNativeFork = undefined;
          // SCIENT-FORK:END
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-handoff.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: handoff,
              },
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  status: "resolved_portable",
                  resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                  error: null,
                  updatedAt: createdAt,
                },
              },
              ...(nativeForkFailure === undefined
                ? []
                : [
                    {
                      id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                      type: "turn-item.updated" as const,
                      threadId: projection.thread.id,
                      runId: run.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: createdAt,
                      payload: {
                        id: idAllocator.derive.runSignalTurnItem({
                          runId,
                          signal: "native-fork-fallback",
                        }),
                        threadId: projection.thread.id,
                        runId,
                        nodeId: rootNode.id,
                        providerThreadId: providerThread.id,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal:
                          Math.max(
                            0,
                            ...projection.turnItems
                              .filter((item) => item.runId === runId)
                              .map((item) => item.ordinal),
                          ) + 1,
                        status: "completed" as const,
                        title: "Native fork failed",
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `Could not fork the source conversation natively (${nativeForkFailure}). Started a fresh session with its history.`,
                      },
                    },
                  ]),
            ],
          });
          return loaded;
        }
        if (providerThread.nativeThreadRef === null) {
          // Pass the stored provider row for adoption; adapter-minted duplicates make activeProviderThreadId flap.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
            }),
          );
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending",
        );
        // SCIENT-FORK:START — rolled-back carrying history forces a fresh native session.
        const removedDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            projection.runs.some(
              (source) => source.id === handoff.targetRunId && source.status === "rolled_back",
            ),
        );
        // SCIENT-FORK:END
        // A provider that cannot truncate rolls back into a fresh native session holding none of the kept turns.
        const nativeSessionLacksKeptTurns =
          !session.providerSession.capabilities.checkpointing.providerCanRollbackConversation &&
          nativeSessionMissesKeptTurns(projection, providerThread, run);
        // Dispatch prepares no import handoff for a session import: its history is in the native session.
        const importedNativeSession =
          projection.thread.historyOrigin === "v1_import" &&
          !projection.providerTurns.some((turn) => turn.providerThreadId === providerThread.id) &&
          !projection.contextHandoffs.some(
            (handoff) =>
              handoff.toProviderThreadId === providerThread.id &&
              handoff.strategy === "manual_context",
          );
        const resumed = yield* Effect.result(
          uncertainDelivery || removedDelivery || nativeSessionLacksKeptTurns
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: removedDelivery
                    ? "Carrying history run was rolled back"
                    : uncertainDelivery
                      ? "Uncertain native history injection"
                      : "Native session holds none of the kept conversation",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                importedNativeSession,
              }),
        );
        if (resumed._tag === "Success") {
          const context = handoffContextForThread(resumed.success);
          resumedHandoffContext = context;
          resumedRetryHandoff = yield* prepareRetryHandoff(context);
          // SCIENT-FORK:START — a failed portable-history read has already settled this start.
          if (resumedRetryHandoff === undefined) return undefined;
          // SCIENT-FORK:END
          const fits = yield* deliverContextHandoffs({
            handoffs: [...handoffs, ...resumedRetryHandoff.handoffs],
            providerThread: { ...resumed.success, id: providerThread.id },
            // SCIENT-FORK:START — Scient policy, source resolver, and provenance.
            budget: context.budget(handoffs),
            resolveHistory: projectionStore.resolveContextHistory,
            ...scientHandoffDeliveryProvenance(projection.thread, conversationFork),
            // SCIENT-FORK:END
            deferInline: isCompactionCommandMessage(providerMessage) || goalCommand,
            alreadyDeliveredItemIds: context.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (fits) return resumed.success;
          const freshThread = { ...resumed.success, nativeThreadRef: null };
          const freshContext = handoffContextForThread(freshThread);
          // SCIENT-FORK:START — a failed portable-history read has already settled this start.
          const recovery = yield* recoveryHandoff;
          if (recovery === undefined) return undefined;
          const { handoff } = recovery;
          // SCIENT-FORK:END
          const fitsFresh = yield* deliverContextHandoffs({
            handoffs: withRecoveryHandoff(handoff),
            providerThread: freshThread,
            // SCIENT-FORK:START — Scient policy, source resolver, and provenance.
            budget: freshContext.budget(withRecoveryHandoff(handoff)),
            resolveHistory: projectionStore.resolveContextHistory,
            ...scientHandoffDeliveryProvenance(projection.thread, conversationFork),
            // SCIENT-FORK:END
            alreadyDeliveredItemIds: freshContext.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (!fitsFresh) return resumed.success;
          const hasPendingWork = yield* (
            session.hasPendingBackgroundWorkForThread?.(resumed.success, {
              includeSubagents: true,
            }) ??
              session.hasPendingBackgroundWork ??
              Effect.succeed(false)
          );
          if (hasPendingWork) {
            return yield* loadFromProvider(
              Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: new ContextHandoffBackgroundWorkError(),
                }),
              ),
            );
          }
        }
        resumedHandoffContext = undefined;
        resumedRetryHandoff = undefined;
        if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
        // Another client is still writing to the native thread. A fresh
        // session here would silently split the conversation from it.
        if (
          resumed._tag === "Failure" &&
          resumed.failure._tag === "ProviderAdapterThreadInUseError"
        ) {
          return yield* loadFromProvider(Effect.fail(resumed.failure));
        }

        yield* Effect.logWarning("Recovering provider context in a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          // SCIENT-FORK:START — rolled-back carrying history forces a fresh native session.
          reason: removedDelivery
            ? "history_delivery_rolled_back"
            : uncertainDelivery
              ? "uncertain_history_delivery"
              : nativeSessionLacksKeptTurns
                ? "native_session_lacks_kept_turns"
                : resumed._tag === "Success"
                  ? "handoff_budget_exhausted"
                  : "resume_failed",
          // SCIENT-FORK:END
          errorTag: resumed._tag === "Failure" ? resumed.failure._tag : "ContextHandoffBudgetError",
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // Clear the native ref to force a fresh session while preserving row identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
            // A fresh session that never loaded the broken history needs no replacement.
            ...(opensFreshSession && resumed._tag === "Failure"
              ? {}
              : { forceNewNativeThread: true }),
          }),
        );
        if (replacement === undefined) return undefined;
        if (
          replacement.nativeThreadRef?.nativeId != null &&
          replacement.nativeThreadRef.driver === providerThread.nativeThreadRef?.driver &&
          replacement.nativeThreadRef.nativeId === providerThread.nativeThreadRef.nativeId
        ) {
          // Never retried. Forget the load first, or the next turn would skip resume and start on
          // the reused session without this error or the recovery handoff.
          yield* providerSessions.forgetLoadedProviderThread({
            providerSessionId: session.providerSessionId,
            threadId: projection.thread.id,
            providerThread: replacement,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
          });
          yield* settleStartFailure({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: new ProviderAdapter.ProviderAdapterProtocolError({
              driver: session.driver,
              detail:
                "the provider returned its existing session when asked for a fresh one, so the conversation context could not be moved to a new session",
            }),
          });
          return undefined;
        }
        // SCIENT-FORK:START — a failed portable-history read has already settled this start.
        const recovery = yield* recoveryHandoff;
        if (recovery === undefined) return undefined;
        const { handoff, transferId, createdAt } = recovery;
        // SCIENT-FORK:END
        const previousRun = projection.runs.findLast(
          (candidate) =>
            candidate.providerThreadId === providerThread.id &&
            candidate.ordinal < run.ordinal &&
            candidate.startedAt !== null,
        );
        // Stable per run so a retried start reuses the reserved run-start position.
        const handoffTurnItemId = idAllocator.derive.runSignalTurnItem({
          runId,
          signal: "resume-fallback-handoff",
        });
        const handoffTurnItem: OrchestrationV2TurnItem = {
          id: handoffTurnItemId,
          threadId: projection.thread.id,
          runId,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          // The summary is delivered ahead of this run's own handoffs and message.
          ordinal: yield* turnItemPositions.allocate({
            threadId: projection.thread.id,
            turnItemId: handoffTurnItemId,
            runId,
            runOrdinal: run.ordinal,
            placement: "run_start",
          }),
          status: "completed",
          title: "Recovered context",
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
          type: "handoff",
          contextHandoffId: handoff.id,
          fromProviderThreadIds: handoff.fromProviderThreadIds,
          toProviderThreadId: handoff.toProviderThreadId,
          fromProviderInstanceIds: [providerThread.providerInstanceId],
          toProviderInstanceId: run.providerInstanceId,
          fromModelSelections: previousRun === undefined ? [] : [previousRun.modelSelection],
          toModel: run.modelSelection.model,
          strategy: handoff.strategy,
          summary: handoff.summaryText,
        };
        const replacementWrite = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        if (!replacementWrite.committed) return undefined;
        effectiveHandoffs = withRecoveryHandoff(handoff);
        resumeFellBack = true;
        recoveryTurnItem = handoffTurnItem;
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      const handoffContext = resumedHandoffContext ?? handoffContextForThread(loadedProviderThread);
      const {
        sameNativeThread,
        handoffUsage,
        deliveredItemIds,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
        budget,
      } = handoffContext;
      if (manualResume && unsentResumeMessage === undefined && session.resumeTurn === undefined) {
        yield* settleStartFailure({
          signal: "resume-unsupported",
          title: "Native resume is unavailable",
          error: new ProviderAdapter.ProviderResumeUnsupportedError({
            driver: session.driver,
            providerThreadId: providerThread.id,
          }),
        });
        return;
      }
      const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
      // SCIENT-FORK:START — a failed portable-history read has already settled this start.
      if (retryHandoff === undefined) return;
      // SCIENT-FORK:END
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        // SCIENT-FORK:START — retain binding authority across later project/worktree relocation.
        nativeMetadata: {
          ...loadedProviderThread.nativeMetadata,
          cwd: resolvedRuntimePolicy.cwd ?? session.providerSession.cwd,
        },
        // SCIENT-FORK:END
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds:
          portableForkFallback === undefined
            ? providerThread.handoffIds
            : [...providerThread.handoffIds, portableForkFallback.id],
        forkedFrom:
          completedNativeFork === undefined && nativeForkTransfer !== undefined
            ? null
            : providerThread.forkedFrom,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(completedNativeFork === undefined || runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...completedNativeFork,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        // Shown only once the replacement session commits with the running transition.
        ...(recoveryTurnItem === undefined
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "turn-item.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: recoveryTurnItem,
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        // SCIENT-FORK:START — candidate upstream fix: `run` was read before the provider turn
        // opened; a completion acknowledged since then keeps its cleared delivery.
        keepCurrentDelegatedCompletion: true,
        // SCIENT-FORK:END
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      // Delegated (app_owned) children run their own runs; routing them here ingests their items twice.
      const routableSubagents = projection.subagents.filter(
        (subagent) =>
          subagent.origin === "provider_native" &&
          RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      // SCIENT-FORK:START — V2's analogue of V1's `ProviderService.sendTurn`
      // skill block. `message.dispatch` persisted the composer's explicit
      // selection on this run's user message; apply it to the exact text the
      // provider is about to receive, and narrow the turn's skill scope.
      const preparedSkills = yield* prepareScientV2SkillScope({
        threadId: projection.thread.id,
        driver: session.driver,
        mcpSessionInjection: session.mcpSessionInjection === true,
        projectRoot: resolvedRuntimePolicy.cwd ?? undefined,
        text: userText,
        // A resumed prompt that never reached the provider keeps its own skill selection.
        selectedScientSkillNames: providerMessage.selectedScientSkillNames ?? [],
      }).pipe(
        Effect.provideService(ScientSkillSessionPlanner, skillPlanner),
        Effect.provideService(McpProviderSessions.McpProviderSessions, mcpSessions),
      );
      const skillUserText = preparedSkills.text;
      // SCIENT-FORK:END
      const persistHandoff = Effect.fn("ProviderTurnStartService.persist")(function* (
        handoff: OrchestrationV2ContextHandoff,
      ) {
        const updatedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({
                threadId: projection.thread.id,
              }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, updatedAt },
            },
          ],
        });
      });
      const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
        function* (turnInput: Parameters<typeof session.startTurn>[0], compact = false) {
          const usesRuntimeInstruction = session.driver === "codex" && !compact;
          let runtimeInstruction = usesRuntimeInstruction
            ? preparedSkills.runtimeInstruction
            : undefined;
          const missedAttachments =
            compact || goalCommand
              ? []
              : retryHandoff.attachments.filter(
                  (missed) =>
                    !turnInput.message.attachments.some((current) => current.id === missed.id),
                );
          const validateCurrent = (text: string) =>
            validateProviderCurrentInput({
              text,
              // SCIENT-FORK: recovered attachments are sent with this turn, so its input limit counts them.
              attachments: [...missedAttachments, ...providerMessage.attachments],
              attachmentsDir: serverConfig.attachmentsDir,
              ...(runtimeInstruction === undefined ? {} : { runtimeInstruction }),
            }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
          let preparedUserText = usesRuntimeInstruction ? preparedSkills.baseText : skillUserText;
          let currentInput = compact
            ? skillUserText
            : yield* validateCurrent(preparedUserText).pipe(
                Effect.catchTags({
                  ProviderCurrentInputError: (cause) => {
                    const fallback = preparedSkills.textWithoutCatalogMarker;
                    if (fallback === undefined) return Effect.fail(cause);
                    preparedUserText = usesRuntimeInstruction ? preparedSkills.baseText : fallback;
                    runtimeInstruction = usesRuntimeInstruction
                      ? preparedSkills.runtimeInstructionWithoutCatalogMarker
                      : undefined;
                    return validateCurrent(preparedUserText);
                  },
                }),
              );
          const prepareDelivery = () =>
            deliverContextHandoffs({
              handoffs: [...effectiveHandoffs, ...retryHandoff.handoffs],
              deferInline: compact || goalCommand,
              providerThread: runningProviderThread,
              // SCIENT-FORK:START — the skill-prepared current input spends the allowance.
              budget: budget(effectiveHandoffs, currentInput),
              // SCIENT-FORK:END
              alreadyDeliveredItemIds: deliveredItemIds,
              // SCIENT-FORK:START — the required source resolver never falls back to lost history.
              resolveHistory: projectionStore.resolveContextHistory,
              // SCIENT-FORK:END
              // SCIENT-FORK:START — fork workspace and import provenance.
              ...scientHandoffDeliveryProvenance(projection.thread, conversationFork),
              // SCIENT-FORK:END
              ...(session.injectHistory === undefined
                ? {}
                : {
                    inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                      session.injectHistory!({
                        providerThread: runningProviderThread,
                        ...history,
                      }),
                  }),
              persist: persistHandoff,
            });
          const delivery = yield* prepareDelivery().pipe(
            Effect.catchTags({
              // The enclosing operation owns the span for this inline handler.
              ContextHandoffBudgetError: Effect.fnUntraced(function* (cause) {
                const fallback = preparedSkills.textWithoutCatalogMarker;
                if (fallback === undefined) return yield* cause;
                preparedUserText = usesRuntimeInstruction ? preparedSkills.baseText : fallback;
                runtimeInstruction = usesRuntimeInstruction
                  ? preparedSkills.runtimeInstructionWithoutCatalogMarker
                  : undefined;
                currentInput = compact ? fallback : yield* validateCurrent(preparedUserText);
                return yield* prepareDelivery();
              }),
            }),
          );
          if (!(yield* shouldStartProviderTurn()))
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: projection.thread.id,
              providerThreadId: providerThread.id,
              runId: run.id,
              cause: "The current native offer was declined after input preparation.",
            });
          yield* preparedSkills.publish;
          const start = compact ? session.compactThread! : session.startTurn;
          // Like history, the side chat context waits for a turn that sends a prompt.
          const sideChatContext =
            sideChatHandoff === undefined || compact || goalCommand
              ? ""
              : sideChatHandoff.summaryText;
          const context = [delivery.context, sideChatContext, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          const startInput = noteContinuation ? promptedInput : turnInput;
          const { resume: _resume, ...contextInput } = startInput;
          const { message: resumeMessage, resume: _resumeIntent, ...resumeInput } = startInput;
          // Like pending history, pending images need a prompt; native resume carries none.
          const prompted = context !== "" || missedAttachments.length > 0;
          // A resume that must be prompted still needs a request, or the agent has nothing to do.
          const requestText =
            turnInput.resume && prompted && preparedUserText === ""
              ? RESUME_PROMPT
              : preparedUserText;
          const text = goalCommand ? preparedUserText : withInlineContext(context, requestText);
          const operation =
            turnInput.resume && !prompted && session.resumeTurn !== undefined
              ? session.resumeTurn({ ...resumeInput, messageId: resumeMessage.messageId })
              : start({
                  ...(prompted ? contextInput : startInput),
                  message: {
                    ...turnInput.message,
                    ...(runtimeInstruction === undefined ? {} : { runtimeInstruction }),
                    text,
                    ...(missedAttachments.length === 0
                      ? {}
                      : { attachments: [...missedAttachments, ...turnInput.message.attachments] }),
                  },
                  ...(text === preparedUserText
                    ? {}
                    : { inlineContextLength: text.length - preparedUserText.length }),
                });
          yield* operation.pipe(
            // Clear pending handoff markers for refused prompts so the next turn retains the native session.
            Effect.tapError((error) =>
              refusedBeforePrompt(error)
                ? delivery.unsent.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Failed to restore unsent context handoffs", {
                        runId: run.id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
          // After provider acceptance, failed delivery bookkeeping must not stop live ingestion.
          const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
          yield* Effect.forEach(
            [
              delivery.delivered,
              ...(sideChatContext === "" || sideChatHandoff === undefined || nativeThreadId == null
                ? []
                : [
                    persistHandoff({
                      ...sideChatHandoff,
                      toProviderThreadId: runningProviderThread.id,
                      delivery: { nativeThreadId, status: "inline" as const, itemIds: [] },
                    }),
                  ]),
            ],
            (record) =>
              record.pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("Failed to record accepted context handoff delivery", {
                    runId: run.id,
                    deliveryStatus: "pending",
                  }),
                ),
              ),
            { discard: true },
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterTurnStartError"
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId: run.id,
                cause,
              }),
        ),
      );
      // Native-initiated work has already begun under its captured policy;
      // preserve its adoption path rather than issuing another ordinary prompt.
      if (providerWork !== undefined) yield* preparedSkills.publish;
      // SCIENT-FORK:START — every ordinary prompt delivers through skill preparation.
      const deliverySession =
        providerWork !== undefined ? session : makeDeliverySession(session, startWithHandoffs);
      // SCIENT-FORK:END
      return runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        // SCIENT-FORK:START — a Codex root run captures its launch owner.
        ...nativeModelCapacityOwnerFor({
          session,
          providerThread: runningProviderThread,
          modelSelection: run.modelSelection,
          providerSessionId,
        }),
        // SCIENT-FORK:END
        providerSessionId,
        session: deliverySession,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        baseline,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        resume: manualResume && unsentResumeMessage === undefined,
        nativeThreadHasTurns:
          nativeInputRunIds.size > 0 ||
          (legacyInputRunIds.size > 0 &&
            sameNativeThread &&
            !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        // SCIENT-FORK:START — ordinary prompts prepare locally; adopted native work has already begun.
        ...(providerWork === undefined
          ? {
              prepareBeforeProviderTurn: pendingStartPreparation({
                eventSink,
                threadId: input.threadId,
                runId: run.id,
                rootNodeId: rootNode.id,
                shouldStartProviderTurn: runControls.shouldStartProviderTurn,
              }),
            }
          : {}),
        // SCIENT-FORK:END
        cancelBeforeProviderTurn: makePendingStartCancellation({
          threadId: input.threadId,
          runId: run.id,
          activeAttemptId: attempt.id,
          rootNodeId: rootNode.id,
          checkpointScopeId: checkpointScope.id,
          runOrdinal: run.ordinal,
          providerSessionId,
          providerThread: runningProviderThread,
          session,
          hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        }),
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        loadRunInterruptReason: runControls.loadRunInterruptReason,
        hasWorkspaceMoved: runControls.hasWorkspaceMoved,
        loadUnsettledWork: runControls.loadUnsettledWork,
        message: {
          messageId: message.id,
          // SCIENT-FORK:START — the skill-prepared text is the turn's message.
          text: skillUserText,
          // SCIENT-FORK:END
          attachments: providerMessage.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.notification === undefined ? {} : { notification: message.notification }),
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    return ProviderTurnStartServiceV2.of({
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          let startingRun: OrchestrationV2Run | undefined;
          const captureStartingRun = (run: OrchestrationV2Run) => {
            startingRun = run;
          };
          return yield* Effect.gen(function* () {
            // Storage cleanup removes worktrees under the same lease. Only startup
            // holds it; the provider turn runs after it is released.
            const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
            const cwd =
              thread.worktreePath ??
              (yield* projects
                .getById(thread.projectId, { includeDeleted: true })
                .pipe(Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot)));
            const providerTurn = yield* cwd === undefined
              ? start(input, captureStartingRun)
              : withTurnStartReservation(
                  fileSystem,
                  path,
                  path.resolve(cwd),
                  thread.worktreePath === null
                    ? start(input, captureStartingRun)
                    : withWorkspaceLease(
                        path.resolve(thread.worktreePath),
                        start(input, captureStartingRun),
                      ),
                );
            if (providerTurn !== undefined) {
              // Run execution owns finalization after the running write. A later
              // failure must not settle a replacement attempt committed by steering.
              yield* providerTurn.pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning(
                      "Run execution failed after starting",
                      { runId: input.runId },
                      cause,
                    ),
                ),
              );
            }
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.fail(
                  new ProviderTurnStartError({
                    runId: input.runId,
                    cause: Cause.squash(cause),
                    ...(startingRun?.activeAttemptId == null || startingRun.rootNodeId == null
                      ? {}
                      : {
                          attemptId: startingRun.activeAttemptId,
                          rootNodeId: startingRun.rootNodeId,
                        }),
                  }),
                ),
            ),
          );
        },
        (effect, input) =>
          effect.pipe(
            // SCIENT-FORK:START — release the startup reservation only after the native start ends.
            Effect.scoped,
            // SCIENT-FORK:END
            Effect.mapError((cause) =>
              isProviderTurnStartError(cause)
                ? cause
                : new ProviderTurnStartError({ runId: input.runId, cause }),
            ),
          ),
      ),
      failStartingRun: Effect.fn("ProviderTurnStartService.failStartingRun")(
        function* ({ threadId, runId, attemptId, rootNodeId }) {
          const projection = yield* projectionStore.getTurnStartContext(threadId, runId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          if (
            run === undefined ||
            run.status !== "starting" ||
            run.activeAttemptId !== attemptId ||
            run.rootNodeId !== rootNodeId
          )
            return;
          const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
          const attempt = projection.attempts.find(
            (candidate) => candidate.id === run.activeAttemptId,
          );
          if (rootNode === undefined || attempt === undefined) {
            return yield* new ProviderTurnStartRunStateMissingError({ runId });
          }
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: "provider-turn-start-failure",
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: run.providerThreadId,
            item: {
              type: "error",
              title: "Turn failed to start",
              failure: makeProviderFailure({ message: START_GAVE_UP_MESSAGE }),
            },
          });
        },
        (effect, { runId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartRunStateMissingError(cause)
                ? cause
                : new ProviderTurnStartError({ runId, cause }),
            ),
          ),
      ),
    });
  }),
);
