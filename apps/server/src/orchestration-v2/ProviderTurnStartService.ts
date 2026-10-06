import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
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
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// SCIENT-FORK:START — portable history and the frozen conversation-fork start.
import {
  makeTurnStartHistory,
  startFrozenConversationFork,
} from "./scient-fork/PortableTurnStart.ts";
// SCIENT-FORK:END
// SCIENT-FORK:START — a Stop before native acceptance declines and captures the start.
import {
  pendingStartCancellation,
  startUnlessStopRequested,
} from "./scient-fork/PendingStartOwner.ts";
// SCIENT-FORK:END

import { ServerConfig } from "../config.ts";
import { validateProviderCurrentInput } from "./AttachmentPrompt.ts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/Services/ProviderAuthService.ts";
// SCIENT-FORK:START — explicit Scient skill selection for this turn.
import { prepareScientV2SkillScope } from "../scient/skills/ScientV2SkillTurn.ts";
import { ScientSkillSessionPlanner } from "../scient/skills/ScientSkillSession.ts";
// SCIENT-FORK:END
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import {
  handoffBudget,
  hasScientContextHistory,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "./ContextHandoffBudget.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2HistoricalContext,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
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
  },
) {}

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);

export interface ProviderTurnStartServiceV2Shape {
  /**
   * Starts the run's provider turn. When `willRetry` is true, a session open
   * failure is returned so the caller can retry. Otherwise the run is settled
   * as failed.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
    readonly expectedAttemptId?: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | ServerSettingsService
  | ServerConfig
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const handoffPolicy = yield* makeScientContextHandoffPolicy();
    const modelWindowSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const forceBytePolicy = (yield* ContextHandoffPolicyOverride) === "byte";
    const eventSink = yield* EventSink.EventSinkV2;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const skillPlanner = yield* ScientSkillSessionPlanner;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;

    // These callbacks outlive startup while a run drains background work. Build
    // them outside start's scope so they cannot retain its full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      // Guards and background routing need live execution state, not a fresh
      // allocation of every completed message and tool output in the thread.
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === input.runId);
            return run?.activeAttemptId === input.attemptId && run.status === expectedStatus;
          }),
          Effect.catchCause(() => Effect.succeed(false)),
        );
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
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
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
      session: ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          // Only startup needs the handoff history. The event worker keeps this
          // session alive afterward, including when background work remains.
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
      readonly expectedAttemptId?: RunAttemptId;
    }) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        // The effect is idempotent once the run has advanced or terminalized.
        return;
      }
      if (
        input.expectedAttemptId !== undefined &&
        run.activeAttemptId !== input.expectedAttemptId
      ) {
        // A delayed effect for an older attempt has no authority over Retry.
        return;
      }
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.status === "ready" &&
          (handoff.targetRunId === run.id ||
            (handoff.toProviderThreadId === run.providerThreadId &&
              projection.runs.some(
                (source) =>
                  source.id === handoff.targetRunId &&
                  (source.status === "failed" ||
                    source.status === "interrupted" ||
                    (source.status === "completed" &&
                      handoff.delivery === undefined &&
                      projection.messages.some(
                        (message) =>
                          message.id === source.userMessageId &&
                          message.attachments.length === 0 &&
                          message.text.trim().toLowerCase() === "/compact",
                      ))),
              ))),
      );
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
      const source = message.notification?.source;
      const providerWork = source?.kind === "provider_work" ? source : undefined;
      // Settles a run that never reached the provider: one signal turn item plus
      // terminal run, attempt and root node, written only while the run is still
      // the current starting attempt.
      const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
        function* (input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          /** Omitted when the run never started, so `startedAt` stays as projected. */
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >;
          /** Emitted after the run events when the provider thread should go idle. */
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
        }) {
          const { now, status } = input;
          const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
          const item: OrchestrationV2TurnItem = {
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerThreadId: input.itemProviderThreadId,
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
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                threadId: projection.thread.id,
                runId,
                nodeId: rootNode.id,
                providerInstanceId: input.providerInstanceId,
                occurredAt: now,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          yield* eventSink.writeIfRunCurrent({
            threadId: projection.thread.id,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: "starting",
            events,
          });
        },
      );
      if (
        providerWork === undefined &&
        message.attachments.length === 0 &&
        message.text.trimStart().startsWith("/")
      ) {
        const isEmptyCompaction =
          message.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparing a run may already point the thread at a newly selected
        // provider. Account commands still belong to its last native session.
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
                  text: message.text,
                  records: message.context?.records ?? [],
                }),
                hasAttachments: false,
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
                    input: message.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const { worktreePath, branch } = projection.thread;
      if (worktreePath !== null && branch !== null) {
        const exists = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => true));
        if (!exists) {
          const project = yield* projects.getById(projection.thread.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          if (project !== undefined) {
            yield* Effect.logWarning("provider turn start recreating missing worktree", {
              threadId: projection.thread.id,
              worktreePath,
              branch,
            });
            yield* gitWorkflow.pruneWorktrees({ cwd: project.workspaceRoot }).pipe(
              Effect.andThen(
                gitWorkflow.createWorktree({
                  cwd: project.workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("provider turn start failed to recreate worktree", {
                      threadId: projection.thread.id,
                      worktreePath,
                      cause: Cause.pretty(cause),
                    }),
              ),
            );
          }
        }
      }
      // The last start attempt fails the run with the provider's own reason
      // instead of leaving it `starting` after the effect gives up. A run that
      // already left `starting` is not overwritten, and a failed write returns
      // its error to the effect worker.
      const settleStartFailure = (failed: {
        readonly signal: string;
        readonly title: string;
        readonly error: Error;
      }) =>
        Effect.gen(function* () {
          const nestedCause = "cause" in failed.error ? failed.error.cause : undefined;
          yield* settleRunBeforeStart({
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
                message:
                  nestedCause instanceof Error
                    ? nestedCause.message
                    : typeof nestedCause === "string"
                      ? nestedCause
                      : failed.error.message,
                class: "provider_error",
              }),
            },
          });
        });
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
      const recovery = yield* Effect.result(
        projectionStore.getRuntimeRecoveryProjection(projection.thread.id),
      );
      if (recovery._tag === "Failure") {
        if (input.willRetry === true) return yield* recovery.failure;
        yield* settleStartFailure({
          signal: "provider-recovery-preparation-failure",
          title: "Provider recovery state could not be prepared",
          error: recovery.failure,
        });
        return;
      }
      const inheritedBackgroundTurnItems = selectInheritedBackgroundItems(recovery.success);
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus, shouldStartProviderTurn } = runControls;

      const resolvedRuntimePolicy =
        providerWork?.runtimePolicy ??
        run.steeringRuntimePolicy ??
        (yield* runtimePolicy.resolve({
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
        }));
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
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
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              ...(existingSessionProjection === undefined
                ? {}
                : { resumeFromSession: existingSessionProjection }),
              ...(providerThread.nativeThreadRef?.nativeId == null
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
        settleStartFailure,
      });
      // SCIENT-FORK:END
      if (sessionResult._tag === "Failure") {
        // A disposed buffered generation cannot be recreated by retrying session startup.
        if (
          input.willRetry === true &&
          !(providerWork !== undefined && sessionResult.failure._tag === "ProviderTurnStartError")
        )
          return yield* sessionResult.failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      // Native load failures settle the final start attempt separately from
      // portable-history preparation. Other binding failures keep typed errors.
      const loadFromProvider = (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>,
      ) =>
        Effect.gen(function* () {
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
      const loadedProviderThread = yield* Effect.gen(function* () {
        // Adoption consumes the existing generation; it cannot reload or replace its native owner.
        if (providerWork !== undefined) return providerThread;
        if (nativeForkTransfer !== undefined) {
          // SCIENT-FORK:START — a frozen fork starts natively or from its portable prefix.
          if (projection.thread.conversationFork != null) {
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
          const sourceProjection = yield* projectionStore.getThreadRecords(
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
          const sourceProviderTurn = sourceProjection.providerTurns.find(
            (candidate) =>
              candidate.id === sourceAttempt?.providerTurnId ||
              candidate.runAttemptId === sourceAttempt?.id,
          );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          return yield* loadFromProvider(
            session.forkThread({
              sourceProviderThread,
              sourceProviderTurns: sourceProjection.providerTurns,
              targetThreadId: projection.thread.id,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              ...(sourceProviderTurn === undefined
                ? {}
                : { providerTurnId: sourceProviderTurn.id }),
            }),
          );
        }
        if (providerThread.nativeThreadRef === null) {
          // Hand the run's provider thread to the adapter so it adopts this
          // row's identity when attaching native state. An adapter that mints
          // its own row instead leaves two live rows per app thread, and
          // `activeProviderThreadId` then flaps between them on every update.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
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
        const removedDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            projection.runs.some(
              (source) => source.id === handoff.targetRunId && source.status === "rolled_back",
            ),
        );
        const resumed = yield* Effect.result(
          uncertainDelivery || removedDelivery
            ? Effect.fail(
                new ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: removedDelivery
                    ? "Carrying history run was rolled back"
                    : "Uncertain native history injection",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
        );
        if (resumed._tag === "Success") {
          return resumed.success;
        }

        yield* Effect.logWarning("Provider resume failed; attempting a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: removedDelivery
            ? "history_delivery_rolled_back"
            : uncertainDelivery
              ? "uncertain_history_delivery"
              : "resume_failed",
          errorTag: resumed.failure._tag,
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // The native ref is dropped so the adapter binds a fresh native
            // session instead of retrying the resume that just failed, while
            // still adopting this row's identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
          }),
        );
        if (replacement === undefined) return undefined;
        const transferId = yield* idAllocator.allocate.contextTransfer({
          sourceThreadId: projection.thread.id,
          targetThreadId: projection.thread.id,
          type: "provider_resume_fallback",
        });
        const createdAt = yield* DateTime.now;
        const history = yield* prepareHistoryBeforeStart();
        if (history === undefined) return undefined;
        const handoff = yield* contextHandoffService.prepareProviderHandoff({
          threadId: projection.thread.id,
          targetRunId: run.id,
          transferId,
          ...(hasScientContextHistory(projection) ? { purpose: "session_recovery" as const } : {}),
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: run.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
          strategy: "full_thread_summary",
          runs: projection.runs,
          items: history.filter(
            (item) =>
              item.runId === null ||
              projection.runs.some(
                (source) => source.id === item.runId && source.ordinal < run.ordinal,
              ),
          ),
          createdAt,
        });
        effectiveHandoffs = [handoff, ...effectiveHandoffs];
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
        return replacement;
      });
      // The last attempt already failed the run.
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      // Only started runs reached the provider-thread update below. Queued runs and
      // failures during session setup cannot establish a new telemetry selection.
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
        loadedProviderThread.nativeThreadRef?.nativeId === providerThread.nativeThreadRef?.nativeId;
      const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
      const previousUsage = measuredContext
        ? { ...threadUsage, ...measuredContext.usage }
        : threadUsage;
      const reuseTelemetry =
        sameSelection ||
        (previousSelection !== undefined &&
          session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
      const reportedModelWindow = session.getModelContextWindow?.(
        run.modelSelection,
        resolvedRuntimePolicy.cwd,
      );
      const knownModelWindow = Option.isSome(modelWindowSql)
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
      // Persist before delivery. Keep this native transcript's measured
      // occupancy. A different model drops compaction telemetry and uses the
      // new window when that window is known.
      const handoffUsage = contextUsageForHandoff({
        sameNativeThread,
        sameSelection,
        reuseTelemetry,
        previousUsage,
        knownModelWindow,
      });
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds: providerThread.handoffIds,
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
        startedAt: now,
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
      // Explicit refusal records settlement without delivery; old or uncertain
      // receipts may have delivered and must not duplicate native history.
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
      const missedRuns = projection.runs.filter(
        (source) =>
          source.ordinal < run.ordinal &&
          source.providerThreadId === providerThread.id &&
          (source.status === "failed" || source.status === "interrupted") &&
          !deliveredAttemptIds.has(source.activeAttemptId),
      );
      const missedRunIds = new Set(missedRuns.map((source) => source.id));
      // Missing native receipts require portable history before this attempt
      // becomes running. A failed read must not strand a run without a native turn.
      const missedItems = yield* Effect.gen(function* () {
        if (missedRunIds.size === 0) return [];
        const history = yield* prepareHistoryBeforeStart([...missedRunIds]);
        if (history === undefined) return undefined;
        return history.filter(
          (item) =>
            item.runId !== null && missedRunIds.has(item.runId) && historicalMessage(item) !== null,
        );
      });
      if (missedItems === undefined) return;
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      const routableSubagents = projection.subagents.filter((subagent) =>
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
        text: projectComposerContextForProvider({
          text: message.text,
          records: message.context?.records ?? [],
        }),
        selectedScientSkillNames: message.selectedScientSkillNames ?? [],
      }).pipe(Effect.provideService(ScientSkillSessionPlanner, skillPlanner));
      const userText = preparedSkills.text;
      // SCIENT-FORK:END
      // Delivered once: this run's provider turn marks the work as told. A
      // restart continuation is prompted by its own text or resumes natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
      );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: new Set(
          projection.messages
            .filter(
              (candidate) =>
                candidate.attachments.length === 0 &&
                candidate.text.trim().toLowerCase() === "/compact",
            )
            .map((candidate) => candidate.id),
        ),
        run,
        runAttemptIds: projection.attempts
          .filter((candidate) => candidate.runId === run.id)
          .map((candidate) => candidate.id),
      });
      const restartNote =
        restartCancelledWork.length === 0
          ? ""
          : restartCancelledBackgroundWorkNote(restartCancelledWork);
      // SCIENT-FORK:START — Scient provenance spends the Scient handoff budget.
      const usesScientBudget = usesScientHandoffBudget({
        forceBytePolicy,
        projection,
        handoffs: effectiveHandoffs,
        providerInstanceId: run.providerInstanceId,
      });
      // SCIENT-FORK:END
      const settledHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.toProviderThreadId === providerThread.id &&
          handoff.delivery?.nativeThreadId === runningProviderThread.nativeThreadRef?.nativeId &&
          handoff.delivery?.status !== "pending" &&
          !projection.runs.some(
            (source) => source.id === handoff.targetRunId && source.status === "rolled_back",
          ),
      );
      const deliveredItemIds = new Set(
        settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
      );
      const coveredItemIds = new Set([
        ...deliveredItemIds,
        ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
      ]);
      const acceptedAttempts = projection.attempts.filter(
        (source) =>
          source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
      );
      const nativeInputRunIds = new Set(
        acceptedAttempts
          .filter(
            (source) =>
              source.nativeThreadId !== undefined &&
              source.nativeThreadId === runningProviderThread.nativeThreadRef?.nativeId,
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
      // Use saved text and actual native attachments when telemetry is absent.
      // Legacy attempts lack native identity; exclude their explicitly recovered
      // history, whose attachments were not replayed into the replacement thread.
      const nativeContextEstimate = (bytesPerToken: number) =>
        Effect.gen(function* () {
          return sameNativeThread
            ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
                if (
                  item.runId === run.id ||
                  projection.runs.some(
                    (source) => source.id === item.runId && source.status === "rolled_back",
                  ) ||
                  (item.runId !== null &&
                    missedRunIds.has(item.runId) &&
                    !deliveredItemIds.has(item.id)) ||
                  (item.providerThreadId !== providerThread.id && !deliveredItemIds.has(item.id))
                )
                  return sum;
                const historical = historicalMessage(item);
                const nativeAttachments =
                  item.type === "user_message" &&
                  item.providerThreadId === providerThread.id &&
                  item.runId !== null &&
                  (nativeInputRunIds.has(item.runId) ||
                    (legacyInputRunIds.has(item.runId) &&
                      !coveredItemIds.has(item.id) &&
                      !legacyRecoveredRunIds.has(item.runId)))
                    ? attachmentTokenAllowance(item.attachments)
                    : 0;
                return (
                  sum +
                  (historical === null
                    ? 0
                    : Math.ceil(Buffer.byteLength(historical.text) / bytesPerToken)) +
                  nativeAttachments
                );
              }, 0)
            : 0;
        });
      const modelContextWindow =
        knownModelWindow ??
        (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
      // Replacing a native thread clears its usage, not the selected model's capacity.
      const budgetProviderThread = {
        ...runningProviderThread,
        contextUsage: handoffUsage,
      };
      const uncoveredMissedItems = missedItems.filter((item) => !coveredItemIds.has(item.id));
      const startWithHandoffs = (
        turnInput: Parameters<typeof session.startTurn>[0],
        compact = false,
      ) =>
        Effect.gen(function* () {
          const usesRuntimeInstruction = session.driver === "codex" && !compact;
          let runtimeInstruction = usesRuntimeInstruction
            ? preparedSkills.runtimeInstruction
            : undefined;
          const validateCurrent = (text: string) =>
            Effect.fromResult(
              validateProviderCurrentInput({
                text,
                attachments: message.attachments,
                attachmentsDir: serverConfig.attachmentsDir,
                ...(runtimeInstruction === undefined ? {} : { runtimeInstruction }),
              }),
            );
          let preparedUserText = usesRuntimeInstruction ? preparedSkills.baseText : userText;
          let currentInput = compact
            ? userText
            : yield* validateCurrent(preparedUserText).pipe(
                Effect.catchTag("ProviderCurrentInputError", (cause) => {
                  const fallback = preparedSkills.textWithoutCatalogMarker;
                  if (fallback === undefined) return Effect.fail(cause);
                  preparedUserText = usesRuntimeInstruction ? preparedSkills.baseText : fallback;
                  runtimeInstruction = usesRuntimeInstruction
                    ? preparedSkills.runtimeInstructionWithoutCatalogMarker
                    : undefined;
                  return validateCurrent(preparedUserText);
                }),
              );
          // A failed turn/start can leave the requested turn absent from
          // native history even when its preceding handoff was injected.
          const retryHandoff =
            uncoveredMissedItems.length === 0
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    ...(usesScientBudget ? { purpose: "session_recovery" as const } : {}),
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: uncoveredMissedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          const prepareDelivery = () =>
            deliverContextHandoffs({
              handoffs: [...effectiveHandoffs, ...retryHandoff],
              deferInline: compact,
              providerThread: runningProviderThread,
              budget: Effect.gen(function* () {
                const policy = yield* usesScientBudget
                  ? handoffPolicy
                  : genericContextHandoffPolicy;
                return handoffBudget({
                  ...policy,
                  modelContextWindow,
                  // The restart note and user text spend the same serialized allowance.
                  userText: restartNote === "" ? currentInput : `${restartNote}\n\n${currentInput}`,
                  attachments: message.attachments,
                  providerThread: budgetProviderThread,
                  nativeContextEstimate:
                    budgetProviderThread.contextUsage?.usedTokens === undefined
                      ? yield* nativeContextEstimate(policy.bytesPerToken)
                      : 0,
                });
              }),
              alreadyDeliveredItemIds: deliveredItemIds,
              // SCIENT-FORK:START — fork workspace and import provenance.
              ...scientHandoffDeliveryProvenance(projection.thread),
              // SCIENT-FORK:END
              ...(session.injectHistory === undefined
                ? {}
                : {
                    inject: (history: ProviderAdapterV2HistoricalContext) =>
                      session.injectHistory!({
                        providerThread: runningProviderThread,
                        ...history,
                      }),
                  }),
              persist: (handoff) =>
                Effect.gen(function* () {
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
                }),
            });
          const delivery = yield* prepareDelivery().pipe(
            Effect.catchTag("ContextHandoffBudgetError", (cause) =>
              Effect.gen(function* () {
                const fallback = preparedSkills.textWithoutCatalogMarker;
                if (fallback === undefined) return yield* cause;
                preparedUserText = usesRuntimeInstruction ? preparedSkills.baseText : fallback;
                runtimeInstruction = usesRuntimeInstruction
                  ? preparedSkills.runtimeInstructionWithoutCatalogMarker
                  : undefined;
                currentInput = compact ? fallback : yield* validateCurrent(preparedUserText);
                return yield* prepareDelivery();
              }),
            ),
          );
          if (!(yield* shouldStartProviderTurn()))
            return yield* new ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: projection.thread.id,
              providerThreadId: providerThread.id,
              runId: run.id,
              cause: "The current native offer was declined after input preparation.",
            });
          yield* preparedSkills.publish;
          const start = compact ? session.compactThread! : session.startTurn;
          const context = [delivery.context, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          // A note continuation has no turn to resume; its text is the prompt.
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* start({
            ...(noteContinuation ? promptedInput : turnInput),
            message: {
              ...turnInput.message,
              ...(runtimeInstruction === undefined ? {} : { runtimeInstruction }),
              text:
                context === ""
                  ? preparedUserText
                  : `${context}\n\nUser message:\n${preparedUserText}`,
            },
          });
          // The provider already accepted the turn. A stale pending marker
          // can force a fresh thread later, but must not stop live ingestion.
          yield* delivery.delivered.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to record accepted context handoff delivery", {
                runId: run.id,
                deliveryStatus: "pending",
              }),
            ),
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProviderAdapterTurnStartError"
              ? cause
              : new ProviderAdapterTurnStartError({
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
      const deliverySession =
        providerWork !== undefined ? session : makeDeliverySession(session, startWithHandoffs);
      yield* runExecution.startRootRun({
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
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
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
        message: {
          messageId: message.id,
          text: userText,
          attachments: message.attachments,
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
      start: (input) =>
        start(input).pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
    });
  }),
);
