import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterEventStreamError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2RuntimePolicy,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import { layer as threadCommandExecutorLayer } from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as RuntimeRequest from "./RuntimeRequestService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ResourceCleanup from "./ResourceCleanupService.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";
import * as ServerSettings from "../serverSettings.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

it("keeps inherited background routing failure retryable without committing running state", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath: "/tmp/missing-provider-turn-start-worktree",
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "mandatory-input-service-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        ServerSettings.layerTest(),
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, { exists: () => Effect.succeed(false) } as never),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId, willRetry: true })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/provider-turn-start-project",
      refName: "feature/restore",
      path: "/tmp/missing-provider-turn-start-worktree",
    });
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  /** Opens the session, then fails loading its provider thread. */
  readonly ensureThreadFailure?: unknown;
  /**
   * Resumes a thread that has a native ref: resume fails, the fresh-thread
   * fallback succeeds, then reading history for its handoff fails.
   */
  readonly historyReadFailureAfterFallback?: unknown;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  /** Startup succeeds, then every deciding recovery read fails. */
  readonly failReadsAfterRunning?: boolean;
  readonly recoveryPreparationFailure?: unknown;
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-native-account-command"),
      title: "Native account command",
      providerInstanceId: newInstanceId,
      modelSelection: run.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      activeProviderThreadId: providerThreadId,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  if ("historyReadFailureAfterFallback" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const events: Array<OrchestrationV2DomainEvent> = [];
  let recoveryReadsFailed = false;
  const runtimePolicy = {
    runtimeMode: "approval-required",
    interactionMode: "default",
    cwd: "/tmp/native-account-command",
  } satisfies ProviderAdapterV2RuntimePolicy;
  const nativeStartTurn = vi.fn(() =>
    Effect.die("A failed deciding read must not offer a native turn."),
  );
  const closeSubscription = vi.fn(() => Effect.void);
  const subscribeEvents = vi.fn(() =>
    Effect.succeed({ events: Stream.never, close: closeSubscription() }),
  );
  const normalSession: ProviderAdapterV2SessionRuntime = {
    instanceId: newInstanceId,
    driver: providerThread.driver,
    providerSessionId,
    providerSession: {
      id: providerSessionId,
      driver: providerThread.driver,
      providerInstanceId: newInstanceId,
      status: "ready",
      cwd: runtimePolicy.cwd,
      model: run.modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    events: Stream.never,
    subscribeEvents: Effect.suspend(subscribeEvents),
    ensureThread: () => Effect.succeed(providerThread),
    resumeThread: () => Effect.die("Unused resumeThread"),
    startTurn: nativeStartTurn,
    steerTurn: () => Effect.die("Unused steerTurn"),
    interruptTurn: () => Effect.die("Unused interruptTurn"),
    respondToRuntimeRequest: () => Effect.die("Unused respondToRuntimeRequest"),
    readThreadSnapshot: () => Effect.die("Unused readThreadSnapshot"),
    rollbackThread: () => Effect.die("Unused rollbackThread"),
    forkThread: () => Effect.die("Unused forkThread"),
  };
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const resumeFallbackSession = {
    driver: providerThread.driver,
    resumeThread: () =>
      Effect.fail(
        new ProviderAdapterEventStreamError({
          driver: providerThread.driver,
          providerSessionId,
          cause: "native thread is gone",
        }),
      ),
    ensureThread: () => Effect.succeed(providerThread),
  };
  const open = vi.fn(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "historyReadFailureAfterFallback" in input
        ? Effect.succeed(resumeFallbackSession as never)
        : "ensureThreadFailure" in input
          ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
          : "openFailure" in input
            ? Effect.sync(() => {
                if (input.interruptRunBeforeOpenFailure === true) interruptRun();
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderSessionManager.ProviderSessionOpenError({
                      instanceId: newInstanceId,
                      providerSessionId,
                      cause: input.openFailure,
                    }),
                  ),
                ),
              )
            : input.failReadsAfterRunning === true
              ? Effect.succeed(normalSession)
              : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn(
    (_input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) =>
      input.failReadsAfterRunning === true
        ? Effect.void
        : Effect.die("A local command must not start a native turn."),
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn(
    ({
      events: incoming,
      activeAttemptId,
      expectedStatus,
    }: Parameters<EventSink.EventSinkV2Shape["writeIfRunCurrent"]>[0]) =>
      "writeFailure" in input
        ? Effect.fail(
            new EventSink.EventSinkWriteError({
              eventCount: incoming.length,
              cause: input.writeFailure,
            }),
          )
        : Effect.sync(() => {
            const current = projection.runs.find((candidate) => candidate.id === runId);
            const committed =
              current !== undefined &&
              current.activeAttemptId === activeAttemptId &&
              current.status === expectedStatus;
            if (committed) {
              for (const event of incoming) {
                expect(isDomainEvent(event)).toBe(true);
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              if (
                input.failReadsAfterRunning === true &&
                projection.runs.at(-1)?.status === "running"
              ) {
                recoveryReadsFailed = true;
              }
            }
            return { committed, storedEvents: [] };
          }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "mandatory-input-service-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        ServerSettings.layerTest(),
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: () => Effect.die("history read must fail first"),
        }),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () =>
            Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getRuntimeRecoveryProjection: () =>
            "recoveryPreparationFailure" in input || recoveryReadsFailed
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause:
                      input.recoveryPreparationFailure ??
                      "database unavailable after running commit",
                  }),
                )
              : Effect.succeed({
                  ...projection,
                  hasConversation: projection.messages.some(
                    (m) =>
                      m.role === "user" &&
                      (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
                  ),
                }),
          hasUnpairedRunInterruptRequest: () => Effect.succeed(false),
          getTurnStartHistory: () =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: input.historyReadFailureAfterFallback,
              }),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed(runtimePolicy),
        }),
      ),
    ),
  );
  return {
    layer,
    threadId,
    runId,
    open,
    writeIfRunCurrent,
    startRootRun,
    nativeStartTurn,
    subscribeEvents,
    closeSubscription,
    executionLayer: RunExecutionService.layer.pipe(
      Layer.provide(threadCommandExecutorLayer),
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    ),
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a session-open failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("fails a starting run when its last start attempt cannot load the thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("Pi RPC read failed: pi process exited with code 1."),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: {
          class: "provider_error",
          message: "Pi RPC read failed: pi process exited with code 1.",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a thread-load failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a thread-load failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "keeps a store failure after the provider loaded the thread typed and retryable",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });

      const error = yield* harness.startWithRetry.pipe(Effect.flip);

      // The typed store failure stays retryable until the worker's final attempt.
      expect(error._tag).toBe("ProviderTurnStartError");
      expect((error.cause as { _tag?: string } | undefined)?._tag).toBe("ProjectionStoreReadError");
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");
      expect(harness.events).toEqual([]);
    }),
);

effectIt.effect(
  "terminalizes the final portable-resume history failure without provider dispatch",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });
      yield* harness.start;
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
      expect(harness.projection().attempts[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(harness.projection().nodes[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(harness.projection().turnItems).toMatchObject([
        { type: "error", title: "Provider history could not be prepared", status: "failed" },
      ]);
    }),
);

effectIt.effect("does not overwrite a run interrupted while its thread loads", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.projection().turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect("persists a failed sign-out without starting a provider turn", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/logout",
      logoutFailure: "Could not stop all sessions for this provider. Try again.",
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider sign-out failed",
        failure: {
          class: "permission_error",
          message: "Could not stop all sessions for this provider. Try again.",
        },
      },
    ]);
  }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

effectIt.effect("a stale outbox start cannot execute the newer retry attempt", () =>
  Effect.gen(function* () {
    const h = makeLocalCommandHarness({
      text: "Retained queued retry",
      openFailure: new Error("Controlled native open failure"),
    });
    const executorLayer = EffectWorker.layerExecutor.pipe(
      Layer.provide(
        Layer.mergeAll(
          h.layer,
          Layer.mock(ResourceCleanup.ResourceCleanupService)({}),
          Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
          Layer.mock(RunFinalization.RunFinalizationService)({}),
          Layer.mock(RuntimeRequest.RuntimeRequestServiceV2)({}),
          Layer.mock(ThreadTitleRegeneration.ThreadTitleRegenerationService)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ConversationForkService)({}),
          ServerConfig.layerTest(process.cwd(), { prefix: "mandatory-input-service-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const stale: EffectOutbox.OrchestrationEffectV2 = {
      id: "effect:queued:stale-attempt",
      commandId: CommandId.make("command:queued:stale-attempt"),
      threadId: h.threadId,
      request: {
        type: "provider-turn.start",
        runId: h.runId,
        expectedAttemptId: RunAttemptId.make("failed-predecessor-attempt"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "fixture-worker",
      leaseExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute(stale, { willRetry: false });
      expect(h.open).not.toHaveBeenCalled();
      expect(h.tryHandlePromptCommand).not.toHaveBeenCalled();
      expect(h.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(h.startRootRun).not.toHaveBeenCalled();
      expect(h.projection().runs.at(-1)).toMatchObject({
        status: "starting",
        activeAttemptId: h.attemptId,
      });
      // The matching new attempt still follows the real startup path and owns
      // its own failure receipt; the fence does not block legitimate Retry.
      yield* executor.execute(
        {
          ...stale,
          id: "effect:queued:current-attempt",
          request: { type: "provider-turn.start", runId: h.runId, expectedAttemptId: h.attemptId },
        },
        { willRetry: false },
      );
      expect(h.open).toHaveBeenCalledOnce();
      expect(h.writeIfRunCurrent).toHaveBeenCalled();
      expect(h.projection().runs.at(-1)).toMatchObject({
        status: "failed",
        activeAttemptId: h.attemptId,
      });
    }).pipe(Effect.provide(executorLayer));
  }),
);

effectIt.effect(
  "does not commit running state when final inherited background routing cannot be read",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        recoveryPreparationFailure: "simulated inherited-background projection failure",
      });

      // A final failure is settled by the native startup owner. Retryable failures
      // retain their starting state, as the worktree-repair test above proves.
      yield* harness.start;
      expect(harness.projection().runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
      expect(harness.projection().attempts[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(
        harness.events.some(
          (event) => event.type === "run.updated" && event.payload.status === "running",
        ),
      ).toBe(false);
      expect(harness.writeIfRunCurrent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          activeAttemptId: harness.attemptId,
          expectedStatus: "starting",
        }),
      );
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
    }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) throw new Error("The admitted run must reach native execution.");
    // "false" would skip the provider turn or the terminal write and leave the
    // run active. A read failure must reach the caller instead.
    if (
      controls.shouldStartProviderTurn === undefined ||
      controls.shouldFinalizeRun === undefined
    ) {
      throw new Error("The native execution owner must receive both deciding guards.");
    }
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");

    // Run the actual execution owner with the captured startup input. Its
    // preparation failure settles via the attempt/status guarded write, so
    // the same failed recovery read cannot strand the admitted run.
    yield* Effect.gen(function* () {
      const execution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* execution.startRootRun(controls);
    }).pipe(Effect.provide(harness.executionLayer));
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().attempts[0]?.status).toBe("failed");
    expect(harness.projection().nodes[0]?.status).toBe("failed");
    expect(harness.writeIfRunCurrent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "running",
      }),
    );
    expect(harness.nativeStartTurn).not.toHaveBeenCalled();
    // Preparation never opened a stream lease; there is nothing to close.
    expect(harness.subscribeEvents).not.toHaveBeenCalled();
    expect(harness.closeSubscription).not.toHaveBeenCalled();
  }),
);
