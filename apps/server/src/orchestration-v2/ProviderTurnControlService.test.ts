import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  MessageId,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeNativeSessionAdapterV2 } from "./Adapters/NativeSessionAdapterV2.ts";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

function layerProjectionStore(
  getProviderControlContext: ProjectionStore.ProjectionStoreV2["Service"]["getProviderControlContext"],
) {
  return Layer.succeed(
    ProjectionStore.ProjectionStoreV2,
    ProjectionStore.ProjectionStoreV2.of({
      apply: () => Effect.void,
      getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
      getLimitRecoveryWakeAt: () => Effect.die("unused getLimitRecoveryWakeAt"),
      getOpenRemoteDelegatedTasks: Effect.die("unused getOpenRemoteDelegatedTasks"),
      getAgentAwarenessSnapshot: () => Effect.die("unused awareness snapshot"),
      getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
      listActiveSubagentThreadIds: () => Effect.die("unused listActiveSubagentThreadIds"),
      countThreads: () => Effect.die("unused countThreads"),
      listActiveShellIndex: () => Effect.die("unused listActiveShellIndex"),
      listActiveThreads: () => Effect.die("unused listActiveThreads"),
      listOlderSettledThreads: () => Effect.die("unused listOlderSettledThreads"),
      readShellSnapshot: () => Effect.die("unused readShellSnapshot"),
      getThreadShell: () => Effect.die("unused getThreadShell"),
      getForkSourceRunIds: () => Effect.die("unused getForkSourceRunIds"),
      getThreadTitles: () => Effect.die("unused getThreadTitles"),
      getThreadLinkMetadata: () => Effect.die("unused getThreadLinkMetadata"),
      findGuestShareThreadId: () => Effect.die("unused findGuestShareThreadId"),
      getThread: () => Effect.die("unused getThread"),
      findThread: () => Effect.die("unused findThread"),
      getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
      getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
      getThreadWorktreePaths: () => Effect.die("unused getThreadWorktreePaths"),
      getThreadProjection: () => Effect.die("control effects must not load transcript"),
      getTurnStartContext: () => Effect.die("unused"),
      getForkHistoryItems: () => Effect.succeed([]),
      getContextHistoryCandidates: () => Effect.die("unused context history read"),
      getContextHandoffSummaryPage: () => Effect.die("unused summary reader"),
      resolveContextHistory: () => Effect.die("unused context source resolver"),
      getProjectThreadTitles: () => Effect.succeed([]),
      getConversationFork: () => Effect.succeed(null),
      getReleasableFiles: () => Effect.succeed([]),
      getTurnStartHistory: () => Effect.die("unused"),
      getNativeHistoryEstimates: () => Effect.die("unused native estimate"),
      getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
      getPlan: () => Effect.die("unused"),
      hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
      getRollbackAttachmentOwners: () => Effect.die("unused prune query"),
      hasRunInterruptRequest: () => Effect.die("unused stop read"),
      getRunProviderRecords: () => Effect.die("unused run provider read"),
      getRunCardRecords: () => Effect.die("unused run card read"),
      getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
      searchThread: () => Effect.die("unused"),
      searchThreadStream: () => Stream.empty,
      getThreadHistoryPage: () => Effect.die("unused"),
      getTimelinePage: () => Effect.die("Unused timeline read"),
      getMessageCount: () => Effect.die("unused message count"),
      getTranscriptByteFloor: () => Effect.die("unused transcript byte floor"),
      hasPendingDelegatedCompletion: () => Effect.die("unused hasPendingDelegatedCompletion"),
      getSubagentCount: () => Effect.die("unused subagent count"),
      getRunCount: () => Effect.die("unused run count"),
      listAppOwnedChildThreadIds: () => Effect.die("unused listAppOwnedChildThreadIds"),
      getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
      getTurnItem: () => Effect.die("unused turn item read"),
      getMessagesById: () => Effect.die("unused getMessagesById"),
      getThreadRecords: () => Effect.die("unused record read"),
      getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
      getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
      getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
      getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
      getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
      getProviderControlContext,
      getCheckpointContext: () => Effect.die("not used"),
      getCheckpointRollbackContext: () => Effect.die("unused rollback context"),
      getCheckpointCaptureContext: () => Effect.die("not used"),
      getRunMessage: () => Effect.die("not used"),
      getDelegatedChildControls: () => Effect.die("not used"),
      getRun: () => Effect.die("not used"),
      isNodeStored: () => Effect.die("not used"),
      canStartQueuedRun: () => Effect.die("not used"),
      getHeldQueuedRuns: () => Effect.die("not used"),
      getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
      getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
      getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
      getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
      getPullRequestSnapshot: () => Effect.die("unused getPullRequestSnapshot"),
    }),
  );
}

function layerSessions(
  liveSessionId: ProviderSessionId,
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
) {
  return Layer.succeed(
    ProviderSessionManager.ProviderSessionManagerV2,
    ProviderSessionManager.ProviderSessionManagerV2.of({
      withProviderWorkAdmission: () => Effect.die("Unused native generation admission"),
      resolveMcpInvocationPolicy: () =>
        Effect.die("MCP invocation policy is not used in this fixture."),
      shutdown: Effect.void,
      open: () => Effect.die("unused open"),
      get: (providerSessionId) =>
        Effect.succeed(providerSessionId === liveSessionId ? Option.some(runtime) : Option.none()),
      isLive: (providerSessionId) => Effect.succeed(providerSessionId === liveSessionId),
      close: () => Effect.void,
      closeInstance: () => Effect.void,
      release: () => Effect.void,
      detach: () => Effect.void,
      otherWorkingThreads: () => Effect.succeed([]),
      releaseUnlessBusy: () => Effect.succeed(true),
      forgetLoadedProviderThread: () => Effect.void,
      subscribePromptSuggestion: () => Stream.empty,
    }),
  );
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = layerProjectionStore((_threadId, target) =>
        Ref.get(projection).pipe(
          Effect.map((current) => ({
            providerThread: current.providerThreads.find(
              (thread) => thread.id === target.providerThreadId,
            ),
            providerTurn: current.providerTurns.find((turn) => turn.id === target.providerTurnId),
            attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
            message: undefined,
            run: undefined,
          })),
        ),
      );
      const layerSessionManager = layerSessions(oldSessionId, runtime);
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpProviderSessions.layer,
            layerProjection,
            layerSessionManager,
            Layer.mock(EventSink.EventSinkV2)({}),
            McpAppModelContext.layerEmpty,
            ServerConfig.layerTest(process.cwd(), { prefix: "mandatory-input-service-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

it.effect("steers a running turn with its sender and the thread's MCP app model context", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:steer-app-context");
    const sessionId = ProviderSessionId.make("provider-session:steer-app-context");
    const providerTurnId = ProviderTurnId.make("provider-turn:steer-app-context");
    const attemptId = RunAttemptId.make("run-attempt:steer-app-context");
    const providerThread = {
      id: ProviderThreadId.make("provider-thread:steer-app-context"),
      driver,
      providerInstanceId,
      providerSessionId: sessionId,
    } as OrchestrationV2ProviderThread;
    const projection = makeProjection({ now, threadId, providerThread, providerTurnId, attemptId });
    const steered: Array<ProviderAdapter.ProviderAdapterV2SteerInput> = [];
    const runtime = {
      instanceId: providerInstanceId,
      driver,
      providerSessionId: sessionId,
      // SCIENT-FORK: Scient's steer preparation reads the session's project root.
      providerSession: { id: sessionId, cwd: null },
      steerTurn: (input: ProviderAdapter.ProviderAdapterV2SteerInput) =>
        Effect.sync(() => void steered.push(input)),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    const layerControl = ProviderTurnControlService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerProjectionStore(() =>
            Effect.succeed({
              providerThread,
              providerTurn: projection.providerTurns[0],
              attempt: projection.attempts[0],
              message: {
                id: MessageId.make("message:steer-app-context"),
                text: "What did the app report?",
                attachments: [],
                createdBy: "agent",
                creationSource: "mcp",
                senderThreadId: ThreadId.make("thread:steer-sender"),
              } as unknown as NonNullable<
                ProjectionStore.ProjectionProviderControlContext["message"]
              >,
              run: {
                id: RunId.make("run:steer-app-context"),
                status: "running",
                activeAttemptId: attemptId,
              } as OrchestrationV2Run,
            }),
          ),
          layerSessions(sessionId, runtime),
          Layer.mock(EventSink.EventSinkV2)({}),
          McpProviderSessions.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "mandatory-input-service-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
          Layer.mock(McpAppModelContext.McpAppModelContext)({
            forThread: () =>
              Effect.succeed([
                {
                  itemId: "turn-item:call-1",
                  server: "tools",
                  tool: "picker",
                  text: "Pressed: blue",
                },
              ]),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
      yield* control.steer({
        threadId,
        providerSessionId: sessionId,
        providerThreadId: providerThread.id,
        providerTurnId,
        messageId: MessageId.make("message:steer-app-context"),
      });
    }).pipe(Effect.provide(layerControl));

    assert.equal(steered.length, 1);
    assert.equal(
      steered[0]!.message.text,
      '[Scient: the agent in Scient thread "thread:steer-sender" sent this message, not the user.]\n\nWhat did the app report?',
    );
    assert.deepEqual("appContext" in steered[0]! ? steered[0].appContext : undefined, [
      { key: "mcp_app_turn-item_call-1", text: "Pressed: blue" },
    ]);
  }),
);

it.effect.each([
  "old-attempt",
  "replaced-binding",
  "settled-run",
  "terminal-receipt",
  "archived-thread",
  "deleted-thread",
  "wrong-root",
  "replaced-active-thread",
  "wrong-root-binding",
  "receipt-arrives",
] as const)(
  "pending Stop preserves exact native ownership until its accepted turn receipt: %s",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:pending-stop:${kind}`);
        const sessionId = ProviderSessionId.make(`session:pending-stop:${kind}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:pending-stop:${kind}`);
        const attemptId = RunAttemptId.make(`attempt:pending-stop:${kind}`);
        const runId = RunId.make("run:restart-session");
        const rootNodeId = NodeId.make("node:restart-session");
        const interruptCount = yield* Ref.make(0);
        const offers = yield* Ref.make(0);
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const adapter = makeNativeSessionAdapterV2({
          driver,
          instanceId: providerInstanceId,
          capabilities: CodexProviderCapabilitiesV2,
          defaultCwd: "/workspace",
          idAllocator: allocator,
          continuations: { offer: () => Effect.die("No background wake in pending Stop fixture") },
          open: () =>
            Effect.succeed({
              nativeId: "native-thread:pending-stop",
              nativeThreadKnown: true,
              send: () => Ref.update(offers, (count) => count + 1),
              interrupt: Ref.update(interruptCount, (count) => count + 1),
              resume: () => Effect.void,
              respond: () => Effect.die("No runtime request in pending Stop fixture"),
            }),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy: {
            cwd: "/workspace",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: {
            cwd: "/workspace",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          existingProviderThread: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        const base = makeProjection({
          now,
          threadId,
          providerThread,
          providerTurnId: ProviderTurnId.make("placeholder:not-a-native-receipt"),
          attemptId,
        });
        const run: OrchestrationV2ThreadProjection["runs"][number] = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:pending-stop"),
          rootNodeId,
          activeAttemptId: attemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const projection = yield* Ref.make<OrchestrationV2ThreadProjection>({
          ...base,
          runs: [run],
          providerTurns: [],
          attempts: base.attempts.map((attempt) => ({
            ...attempt,
            providerTurnId: null,
            status: "running",
            completedAt: null,
          })),
          nodes: [
            {
              id: rootNodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: true,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          ],
        });
        const turnInput = {
          appThread: base.thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId,
          rootNodeId,
          providerThread,
          modelSelection,
          runtimePolicy: {
            cwd: "/workspace",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          message: {
            messageId: run.userMessageId,
            text: "Native foreground accepted before SQL receipt.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        } satisfies Parameters<typeof runtime.startTurn>[0];
        yield* runtime.startTurn(turnInput);
        assert.equal(yield* Ref.get(offers), 1);
        const nativeReceipt = yield* Stream.runHead(
          runtime.events.pipe(Stream.filter((event) => event.type === "provider_turn.updated")),
        );
        assert.isTrue(Option.isSome(nativeReceipt));
        if (Option.isNone(nativeReceipt) || nativeReceipt.value.type !== "provider_turn.updated")
          return yield* Effect.die("Native adapter did not emit its accepted turn receipt");
        const receipt = nativeReceipt.value.providerTurn;
        // SQL projection deliberately has not ingested the actual adapter receipt yet.
        if (kind === "old-attempt")
          yield* Ref.update(projection, (current) => ({
            ...current,
            runs: [{ ...run, activeAttemptId: RunAttemptId.make("newer-retry-attempt") }],
          }));
        if (kind === "replaced-binding")
          yield* Ref.update(projection, (current) => ({
            ...current,
            providerThreads: [
              {
                ...providerThread,
                providerSessionId: ProviderSessionId.make("replacement-session"),
              },
            ],
          }));
        if (kind === "settled-run")
          yield* Ref.update(projection, (current) => ({
            ...current,
            runs: [
              {
                ...run,
                status: "completed",
                completedAt: now,
              } satisfies OrchestrationV2ThreadProjection["runs"][number],
            ],
          }));
        if (kind === "archived-thread")
          yield* Ref.update(projection, (current) => ({
            ...current,
            thread: { ...current.thread, archivedAt: now },
          }));
        if (kind === "deleted-thread")
          yield* Ref.update(projection, (current) => ({
            ...current,
            thread: { ...current.thread, deletedAt: now },
          }));
        if (kind === "replaced-active-thread")
          yield* Ref.update(projection, (current) => ({
            ...current,
            thread: {
              ...current.thread,
              activeProviderThreadId: ProviderThreadId.make("replacement-active-thread"),
            },
          }));
        if (kind === "wrong-root-binding")
          yield* Ref.update(projection, (current) => ({
            ...current,
            nodes: current.nodes.map((node) => ({
              ...node,
              providerThreadId: ProviderThreadId.make("wrong-root-binding"),
            })),
          }));
        if (kind === "wrong-root")
          yield* Ref.update(projection, (current) => ({
            ...current,
            nodes: current.nodes.map((node) => ({
              ...node,
              rootNodeId: NodeId.make("foreign-root"),
            })),
          }));
        if (kind === "terminal-receipt")
          yield* Ref.update(projection, (current) => ({
            ...current,
            providerTurns: [{ ...receipt, status: "completed" as const, completedAt: now }],
          }));
        const dependencies = Layer.mergeAll(
          McpProviderSessions.layer,
          McpAppModelContext.layerEmpty,
          // The fixture projection never ingests the stop, so Stop's settle wait ends at once.
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(0),
            stream: () => Stream.empty,
          }),
          ServerConfig.layerTest(process.cwd(), { prefix: "mandatory-input-service-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () => Ref.get(projection),
            getProviderControlContext: (_threadId, target) =>
              Ref.get(projection).pipe(
                Effect.map((current) => ({
                  providerThread: current.providerThreads.find(
                    (entry) => entry.id === target.providerThreadId,
                  ),
                  providerTurn: current.providerTurns.find(
                    (entry) => entry.id === target.providerTurnId,
                  ),
                  attempt: current.attempts.find((entry) => entry.id === attemptId),
                  run,
                  message: undefined,
                })),
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: (id) => Effect.succeed(id === sessionId ? Option.some(runtime) : Option.none()),
            close: () => Effect.die("Pending Stop must not close a shared provider session"),
            closeInstance: () => Effect.die("Pending Stop must not close bystander instances"),
          }),
        );
        yield* Effect.gen(function* () {
          const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
          const input = {
            threadId,
            runId,
            expectedAttemptId: attemptId,
            providerSessionId: sessionId,
            providerThreadId,
          };
          if (kind !== "receipt-arrives") {
            assert.isTrue(Option.isNone(yield* control.interruptPendingStart(input)));
            assert.equal(yield* Ref.get(interruptCount), 0);
            return;
          }
          const pending = yield* control.interruptPendingStart(input).pipe(Effect.flip);
          assert.equal(pending.reason, "receipt_pending");
          assert.equal(pending.runId, runId);
          assert.equal(yield* Ref.get(interruptCount), 0);
          yield* Ref.update(projection, (current) => ({
            ...current,
            providerTurns: [receipt],
            attempts: current.attempts.map((attempt) => ({
              ...attempt,
              providerTurnId: receipt.id,
            })),
          }));
          assert.deepEqual(yield* control.interruptPendingStart(input), Option.some(receipt.id));
          assert.equal(yield* Ref.get(interruptCount), 1);
          // The actual generic native adapter cleared its private active turn:
          // the next prompt is accepted without a session teardown or synthetic turn.
          yield* runtime.startTurn({
            ...turnInput,
            runId: RunId.make("run:after-stopped-receipt"),
            attemptId: RunAttemptId.make("attempt:after-stopped-receipt"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
          });
          assert.equal(yield* Ref.get(offers), 2);
        }).pipe(Effect.provide(ProviderTurnControlService.layer.pipe(Layer.provide(dependencies))));
      }),
    ).pipe(Effect.provide(IdAllocator.layer)),
);
