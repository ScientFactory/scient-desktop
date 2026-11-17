// @effect-diagnostics nodeBuiltinImport:off
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ShellStreamItem,
  EventId,
  TurnItemId,
  GitCommandError,
  KeybindingRule,
  ExternalLauncherCommandNotFoundError,
  OrchestrationV2TurnItem,
  TerminalNotRunningError,
  ProjectId,
  PlanId,
  ProviderDriverKind,
  ResolvedKeybindingRule,
  ThreadId,
  WS_METHODS,
  EditorId,
} from "@t3tools/contracts";
import {
  projectedSubagentsToRuntime,
  deriveAgentPanelModel,
} from "../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { applyOrchestrationV2ProjectionEvent } from "../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";
import { projectThreadProjectionForWire } from "./orchestration-v2/WireProjection.ts";
import { historicalSubagentsToRuntime } from "../../../packages/client-runtime/src/state/historicalSubagentRuntime.ts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertTrue } from "@effect/vitest/utils";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { HttpClient } from "effect/http";
import { vi } from "vite-plus/test";
import * as GitManager from "./git/GitManager.ts";
import * as OrchestratorV2 from "./orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchV2 from "./orchestration-v2/ThreadLaunchService.ts";
import {
  threadCreated as transferV2ThreadCreated,
  turnEvents as transferV2TurnEvents,
  THREAD_ID as transferV2ThreadId,
  LONG_TURN_THREAD_ID as TRANSFER_V2_LONG_TURN_THREAD_ID,
  longTurnThreadBatches as transferV2LongTurnThreadBatches,
  shellFleetEvents as transferV2ShellFleetEvents,
  SHELL_IDLE_SUBAGENTS as TRANSFER_V2_SHELL_IDLE_SUBAGENTS,
  SHELL_SETTLED_THREADS as TRANSFER_V2_SHELL_SETTLED_THREADS,
  STALE_TODO_LAST_FINISHED_CHECKPOINT_ID as TRANSFER_V2_STALE_TODO_LAST_FINISHED_CHECKPOINT_ID,
  STALE_TODO_LIVE_RUN_ID as TRANSFER_V2_STALE_TODO_LIVE_RUN_ID,
  STALE_TODO_SUBAGENTS_PER_RUN as TRANSFER_V2_STALE_TODO_SUBAGENTS_PER_RUN,
  STALE_TODO_THREAD_ID as TRANSFER_V2_STALE_TODO_THREAD_ID,
  staleTodoListThreadBatches as transferV2StaleTodoListThreadBatches,
} from "../integration/TransferBudgetV2Fixture.integration.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import {
  measureHttpGet,
  attributeSnapshotTransfer,
  openMeasuredWsClient,
  transferDelta,
} from "../integration/NetworkTransferMeasurement.integration.ts";
import { THREAD_HISTORY_PAGE_POLICY } from "./orchestration-v2/threadHistoryPaging.ts";
import { makeSqlStatementCounter } from "../integration/SqlStatementCounter.integration.ts";
import {
  awaitSubscriptionSynchronized,
  collectQueueUntil,
  expectedMeasuredAssistantText,
  isMeasuredTransferShellUpdate,
  commitMeasuredTransferTurn,
  seedTransferBudgetHistory,
  subscribeShellItems,
  subscribeThreadItems,
  TRANSFER_HISTORY_TURN_COUNT,
  TRANSFER_THREAD_ID,
} from "../integration/TransferBudgetScenario.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  type TransferBudgetRun,
  transferBudgetViolations,
} from "../integration/TransferBudgetReport.integration.ts";
import {
  NodeHttpServerTest,
  NodeHttpServerTestWithWsDeflate,
  TRANSFER_CLIENT_BOUNDED_QUERY,
  TRANSFER_CLIENT_HISTORY_QUERY,
  TRANSFER_CLIENT_SHELL_QUERY,
  type TransferSubscription,
  buildAppUnderTest,
  collectV2ShellCatchup,
  collectV2ThreadCatchup,
  decodeLegacyThreadBoundedSnapshot,
  decodeTransferHistoryPage,
  decodeTransferShellHttpSnapshot,
  decodeTransferShellResumable,
  decodeTransferShellSnapshot,
  decodeTransferThreadSnapshot,
  decodeWorkflowSubagent,
  decodeWorkflowTurnItem,
  defaultModelSelection,
  encodeTestJson,
  encodeWorkflowSubagent,
  getAuthenticatedSessionCookieHeader,
  getHttpServerUrl,
  getPairedClientCredential,
  getWsServerUrl,
  makeNativeArchiveFixture,
  makeNativeLaunchFixture,
  makeWsRpcClient,
  seedV2StreamThread,
  transferClientShellResumeQuery,
  transferSubscriptionStream,
  withFirstWsAckHeld,
  withWsRpcClient,
} from "./server.testkit.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "server router seam: orchestration",
  (it) => {
    it.effect("marks an empty V2 shell catch-up replay as synchronized", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const items = yield* collectV2ShellCatchup(yield* getWsServerUrl("/ws"), 0);
        assert.equal(items.at(-1)?.kind, "synchronized");
        assert.deepEqual(
          items.filter((item) => item.kind !== "snapshot"),
          [{ kind: "synchronized" }],
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "sends V2 thread snapshots and bounded history fallbacks with a completion marker",
      () =>
        Effect.gen(function* () {
          const app = yield* buildAppUnderTest();
          const seeded = yield* seedV2StreamThread(app);
          const wsUrl = yield* getWsServerUrl("/ws");
          for (const acceptBoundedSnapshot of [false, true]) {
            const items = yield* withWsRpcClient(wsUrl, (client) =>
              client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                threadId: transferV2ThreadId,
                acceptBoundedSnapshot,
                requestCompletionMarker: true,
              }).pipe(
                Stream.takeUntil((item) => item.kind === "synchronized"),
                Stream.runCollect,
              ),
            );
            const first = items[0];
            assertTrue(first?.kind === "snapshot");
            assert.equal(first.projection.thread.id, transferV2ThreadId);
            assert.equal(first.snapshotSequence, seeded.sequence);
            assert.deepEqual(first.projection.messages, []);
            assert.equal(first.hasMoreHistory, acceptBoundedSnapshot ? false : undefined);
            assert.deepEqual(items.at(-1), { kind: "synchronized" });
          }
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("replays V2 reasoning items separately from persisted assistant messages", () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        const base = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).find(
          (event) => event.type === "message.updated" && event.payload.role === "assistant",
        );
        if (base?.type !== "message.updated") return yield* Effect.die("Missing assistant fixture");
        const reasoning: OrchestrationV2DomainEvent = {
          id: EventId.make("reasoning-event"),
          type: "turn-item.updated",
          threadId: transferV2ThreadId,
          occurredAt: base.occurredAt,
          payload: {
            id: TurnItemId.make("reasoning-item"),
            threadId: transferV2ThreadId,
            runId: base.payload.runId,
            nodeId: base.payload.nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "reasoning",
            text: "Checking evidence.",
            status: "completed",
            streaming: false,
            title: null,
            startedAt: base.occurredAt,
            updatedAt: base.occurredAt,
            completedAt: base.occurredAt,
          },
        };
        const answer: OrchestrationV2DomainEvent = {
          ...base,
          id: EventId.make("answer-event"),
          payload: { ...base.payload, text: "Here is the answer." },
        };
        yield* app.v2.eventSink.write({ events: [reasoning, answer] });
        const wsUrl = yield* getWsServerUrl("/ws");
        const initial = yield* collectV2ThreadCatchup(wsUrl);
        const snapshot = initial[0];
        if (snapshot?.kind !== "snapshot") return yield* Effect.die("Missing thread snapshot");
        assert.deepEqual(
          snapshot.projection.messages.map((message) => [message.role, message.text]),
          [["assistant", "Here is the answer."]],
        );
        assert.isTrue(
          snapshot.projection.turnItems.some(
            (item) => item.type === "reasoning" && item.text === "Checking evidence.",
          ),
        );
        const replay = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence);
        assert.deepEqual(
          replay.flatMap((item) => (item.kind === "event" ? [item.event.type] : [])),
          ["turn-item.updated", "message.updated"],
        );
        const persisted = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
        assert.equal(persisted.messages[0]?.role, "assistant");
        assert.isTrue(persisted.turnItems.some((item) => item.type === "reasoning"));
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "preserves native workflow phases and inert member authority through SQL, HTTP and websocket replay",
      () =>
        Effect.gen(function* () {
          const app = yield* buildAppUnderTest();
          const seeded = yield* seedV2StreamThread(app);
          const decodeSubagent = decodeWorkflowSubagent;
          const now = DateTime.formatIso(seeded.thread.updatedAt);
          const workflow = decodeSubagent({
            id: "native-workflow",
            threadId: transferV2ThreadId,
            runId: null,
            parentNodeId: "native-root",
            origin: "provider_native",
            createdBy: "agent",
            driver: "claude-code",
            providerInstanceId: "claude-code",
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Review evidence",
            title: "Audit",
            model: "claude/reviewer",
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            presentation: {
              kind: "workflow",
              workflowName: "Audit",
              firstSeenAt: now,
              phases: [{ index: 0, title: "Review" }],
              runHandles: {
                runId: "display-handle",
                scriptPath: "/workspace/review.ts",
                sessionUrl: "https://session.example/review",
              },
            },
          });
          const member = decodeSubagent({
            ...encodeWorkflowSubagent(workflow),
            id: "native-member",
            parentNodeId: workflow.id,
            title: "Reader",
            status: "completed",
            result: "Evidence checked",
            completedAt: now,
            presentation: {
              kind: "workflow_agent",
              workflowId: workflow.id,
              agentIndex: 0,
              phaseIndex: 0,
              attempt: 2,
              role: "researcher",
              effort: "high",
              firstSeenAt: now,
              usage: { totalTokens: 50, inputTokens: 30, toolUses: 2 },
            },
          });
          yield* app.v2.eventSink.write({
            events: [workflow, member].map((payload) => ({
              id: EventId.make(`workflow-${payload.id}`),
              type: "subagent.updated" as const,
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload,
            })),
          });
          // Native coordinators also produce their own timeline item. This cohort anchor
          // retains completed display-only members in bounded snapshots.
          yield* app.v2.eventSink.write({
            events: [
              {
                id: EventId.make("workflow-item"),
                type: "turn-item.updated",
                threadId: transferV2ThreadId,
                occurredAt: seeded.thread.updatedAt,
                payload: decodeWorkflowTurnItem({
                  id: "workflow-item",
                  threadId: transferV2ThreadId,
                  runId: null,
                  nodeId: workflow.id,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: "running",
                  title: "Audit",
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "subagent",
                  subagentId: workflow.id,
                  origin: workflow.origin,
                  driver: workflow.driver,
                  providerInstanceId: workflow.providerInstanceId,
                  childThreadId: null,
                  prompt: workflow.prompt,
                  result: null,
                }),
              },
            ],
          });
          const headers = {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          };
          const response = yield* measureHttpGet({
            url: `${yield* getHttpServerUrl()}/api/orchestration/threads/${transferV2ThreadId}/bounded`,
            headers,
          });
          assert.equal(response.status, 200);
          const http = yield* decodeLegacyThreadBoundedSnapshot(
            Buffer.from(response.decodedBody).toString("utf8"),
          );
          const socket = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"));
          const snapshot = socket[0];
          assertTrue(snapshot?.kind === "snapshot");
          const persisted = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
          assert.deepEqual(http.projection.subagents, persisted.subagents);
          assert.deepEqual(snapshot.projection.subagents, persisted.subagents);
          const model = deriveAgentPanelModel({
            agents: [],
            v2Projection: projectedSubagentsToRuntime(http.projection.subagents),
          });
          assert.equal(model.workflows.length, 1);
          assert.equal(model.workflows[0]?.phases[0]?.members[0]?.attempt, 2);
          assert.equal(model.workflows[0]?.phases[0]?.members[0]?.usage?.toolUses, 2);
          assert.equal(model.liveCount, 0);
          assert.equal(model.workflows[0]?.workflow.runHandles?.runId, "display-handle");
          assert.deepEqual(persisted.runtimeRequests, []);
          assert.isNull(persisted.subagents.find((agent) => agent.id === member.id)?.childThreadId);
          assert.isNull(persisted.subagents.find((agent) => agent.id === member.id)?.nativeTaskRef);
          const replay = yield* collectV2ThreadCatchup(
            yield* getWsServerUrl("/ws"),
            seeded.sequence,
          );
          const replayed = replay.flatMap((item) =>
            item.kind === "event" && item.event.type === "subagent.updated"
              ? [item.event.payload]
              : [],
          );
          assert.deepEqual(replayed, [workflow, member]);
          assert.deepEqual(replay.at(-1), { kind: "synchronized" });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "preserves oversized historical task completion through real HTTP and websocket snapshots and replay",
      () =>
        Effect.gen(function* () {
          const app = yield* buildAppUnderTest();
          const seeded = yield* seedV2StreamThread(app);
          const detail = "Review outcome. " + "😀".repeat(12_000);
          const activity = (
            activityId: string,
            kind: string,
            payload: Record<string, unknown>,
            ordinal: number,
          ): OrchestrationV2TurnItem => ({
            id: TurnItemId.make(`migration:v1:history:activity:${activityId}`),
            threadId: transferV2ThreadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            startedAt: seeded.thread.updatedAt,
            completedAt: seeded.thread.updatedAt,
            updatedAt: seeded.thread.updatedAt,
            type: "dynamic_tool",
            title: kind,
            toolName: kind,
            input: {
              activityId,
              turnId: null,
              tone: "info",
              kind,
              summary: kind,
              sequence: ordinal,
              payload,
            },
          });
          const copied = activity(
            "copied",
            "task.completed",
            {
              taskId: "copied-reviewer",
              agentKind: "agent",
              status: "completed",
              summary: detail,
              typedUsage: { toolUses: 2 },
            },
            3,
          );
          const items = [
            activity(
              "start",
              "task.started",
              { taskId: "reviewer", agentKind: "agent", title: "Review" },
              0,
            ),
            activity(
              "completion",
              "task.completed",
              {
                taskId: "reviewer",
                agentKind: "agent",
                status: "completed",
                summary: detail,
                typedUsage: { totalTokens: 123, toolUses: 4 },
              },
              1,
            ),
            activity(
              "completion-only",
              "task.completed",
              {
                taskId: "completion-only",
                agentKind: "agent",
                status: "failed",
                detail,
                typedUsage: { totalTokens: 99, toolUses: 3 },
              },
              2,
            ),
            {
              ...copied,
              id: TurnItemId.make("fork:historical:copied"),
              inheritedFrom: {
                threadId: ThreadId.make("historical-origin"),
                itemId: copied.id,
                runId: null,
                status: copied.status,
              },
            },
          ];
          yield* app.v2.eventSink.write({
            events: items.map((payload) => ({
              id: EventId.make(`historical-wire:${payload.id}`),
              type: "turn-item.updated" as const,
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload,
            })),
          });
          const beforeTransport = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
          assert.deepEqual(
            beforeTransport.turnItems,
            items.map((item, index) => ({ ...item, ordinal: index + 1 })),
          );
          const headers = {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          };
          const response = yield* measureHttpGet({
            url: `${yield* getHttpServerUrl()}/api/orchestration/threads/${transferV2ThreadId}/bounded`,
            headers,
          });
          assert.equal(response.status, 200);
          const http = yield* decodeLegacyThreadBoundedSnapshot(
            Buffer.from(response.decodedBody).toString("utf8"),
          );
          const wsUrl = yield* getWsServerUrl("/ws");
          const snapshots = yield* collectV2ThreadCatchup(wsUrl);
          const snapshot = snapshots[0];
          assertTrue(snapshot?.kind === "snapshot");
          const replay = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence);
          const replayItems = replay.flatMap((item) =>
            item.kind === "event" && item.event.type === "turn-item.updated"
              ? [item.event.payload]
              : [],
          );
          assert.equal(replayItems.length, items.length);
          for (const wireItems of [
            http.projection.turnItems,
            snapshot.projection.turnItems,
            replayItems,
          ]) {
            const agents = historicalSubagentsToRuntime(wireItems);
            const model = deriveAgentPanelModel({ agents });
            assert.equal(agents.length, 3);
            assert.equal(model.liveCount, 0);
            const reviewer = agents.find(
              (agent) => agent.id === `historical:${transferV2ThreadId}:reviewer`,
            );
            assert.ok(reviewer);
            assert.equal(reviewer.status, "completed");
            assert.deepEqual(reviewer.usage, { totalTokens: 123, toolUses: 4 });
            assert.match(reviewer.result ?? "", /^Review outcome\./);
            assert.isTrue(reviewer.historical);
            const failed = agents.find(
              (agent) => agent.id === `historical:${transferV2ThreadId}:completion-only`,
            );
            assert.equal(failed?.status, "failed");
            assert.deepEqual(failed?.usage, { totalTokens: 99, toolUses: 3 });
            assert.match(failed?.error ?? "", /^Review outcome\./);
            const inherited = agents.find(
              (agent) => agent.id === "historical:historical-origin:copied-reviewer",
            );
            assert.equal(inherited?.status, "completed");
            assert.deepEqual(inherited?.usage, { toolUses: 2 });
            assert.match(inherited?.result ?? "", /^Review outcome\./);
            assert.isTrue(
              wireItems.every(
                (item) =>
                  item.runId === null && item.nodeId === null && item.nativeItemRef === null,
              ),
            );
          }
          const persisted = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
          assert.deepEqual(persisted.turnItems, beforeTransport.turnItems);
          assert.deepEqual(persisted.runtimeRequests, []);
          assert.deepEqual(replay.at(-1), { kind: "synchronized" });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("pages the complete V2 transcript after a bounded HTTP cold open", () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        yield* seedV2StreamThread(app);
        const turns = THREAD_HISTORY_PAGE_POLICY.maxUserTurns * 3;
        for (let index = 0; index < turns; index++) {
          yield* app.v2.eventSink.write({
            events: transferV2TurnEvents(ProviderDriverKind.make("codex"), index, false),
          });
        }
        const baseUrl = yield* getHttpServerUrl();
        const headers = {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        };
        const response = yield* measureHttpGet({
          url: `${baseUrl}/api/orchestration/threads/${transferV2ThreadId}/bounded`,
          headers,
        });
        assert.equal(response.status, 200);
        const snapshot = yield* decodeTransferThreadSnapshot(
          Buffer.from(response.decodedBody).toString("utf8"),
        );
        assert.equal(
          snapshot.projection.messages.length,
          THREAD_HISTORY_PAGE_POLICY.maxUserTurns * 2,
        );
        assert.isTrue(snapshot.hasMoreHistory);
        assert.isNotNull(snapshot.historyCursor);
        let cursor: string | null = snapshot.historyCursor;
        const items = [...snapshot.projection.visibleTurnItems];
        const seen = new Set<string>();
        while (cursor !== null) {
          assert.isFalse(seen.has(cursor), "history cursor must advance");
          seen.add(cursor);
          const older: Effect.Success<ReturnType<typeof measureHttpGet>> = yield* measureHttpGet({
            url: `${baseUrl}/api/orchestration/threads/${transferV2ThreadId}/history?cursor=${encodeURIComponent(cursor)}`,
            headers,
          });
          assert.equal(older.status, 200);
          const page: Effect.Success<ReturnType<typeof decodeTransferHistoryPage>> =
            yield* decodeTransferHistoryPage(Buffer.from(older.decodedBody).toString("utf8"));
          assert.isAbove(page.items.length, 0);
          assert.equal(page.snapshotSequence, snapshot.snapshotSequence);
          assert.equal(page.hasMoreHistory, page.nextCursor !== null);
          items.unshift(...page.items);
          cursor = page.nextCursor;
        }
        const persisted = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
        assert.deepEqual(
          items.map((row) => row.sourceItemId),
          persisted.visibleTurnItems.map((row) => row.sourceItemId),
        );
        assert.equal(new Set(items.map((row) => row.sourceItemId)).size, items.length);
        for (const type of ["user_message", "assistant_message", "dynamic_tool"] as const) {
          assert.equal(items.filter((row) => row.item.type === type).length, turns);
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(
      (["thread", "shell"] as const).map((subscription) => ({
        caseTitle: `keeps V2 ${subscription} changes committed during snapshot capture`,
        subscription,
      })),
    )("$caseTitle", ({ subscription }) =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        const app = yield* buildAppUnderTest({
          transformThreadManagementV2: (threads) => ({
            ...threads,
            getThreadSnapshot: (threadId) =>
              threads.getThreadSnapshot(threadId).pipe(
                Effect.tap(() => Deferred.succeed(captureEntered, undefined)),
                Effect.tap(() => Deferred.await(releaseCapture)),
              ),
            readShellSnapshot: (options) =>
              threads.readShellSnapshot(options).pipe(
                // The inner decode runs after the shell read transaction commits.
                // Hold emission here so the competing writer can commit independently.
                Effect.map((decode) =>
                  decode.pipe(
                    Effect.tap(() => Deferred.succeed(captureEntered, undefined)),
                    Effect.tap(() => Deferred.await(releaseCapture)),
                  ),
                ),
              ),
          }),
        });
        const seeded = yield* seedV2StreamThread(app);
        const received = yield* Queue.unbounded<
          OrchestrationV2ThreadStreamItem | OrchestrationV2ShellStreamItem
        >();
        const wsUrl = yield* getWsServerUrl("/ws");
        const reader = yield* withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            if (subscription === "thread") {
              return yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                threadId: transferV2ThreadId,
                requestCompletionMarker: true,
              }).pipe(Stream.runForEach((item) => Queue.offer(received, item)));
            }
            return yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
              requestCompletionMarker: true,
            }).pipe(Stream.runForEach((item) => Queue.offer(received, item)));
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(captureEntered);
        const writer = yield* app.v2.eventSink
          .write({
            events: [
              {
                id: EventId.make("snapshot-race-update"),
                type: "thread.metadata-updated",
                threadId: transferV2ThreadId,
                occurredAt: seeded.thread.updatedAt,
                payload: { ...seeded.thread, title: "Committed during capture" },
              },
            ],
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.succeed(releaseCapture, undefined);
        const stored = yield* Fiber.join(writer);
        const prefix = yield* collectQueueUntil(
          received,
          (item) => item.kind === "synchronized",
          "snapshot capture completion",
        );
        if (subscription === "shell") yield* TestClock.adjust(Duration.millis(100));
        const changes = yield* collectQueueUntil(
          received,
          (item) =>
            subscription === "thread"
              ? item.kind === "event" && item.sequence === stored[0]!.sequence
              : item.kind === "thread.updated" && item.thread.title === "Committed during capture",
          `a committed ${subscription} change after snapshot capture`,
        );
        const items = [...prefix, ...changes];
        assert.equal(items[0]?.kind, "snapshot");
        assert.equal(items[1]?.kind, "synchronized");
        assert.equal(items.at(-1)?.kind, subscription === "thread" ? "event" : "thread.updated");
        yield* Fiber.interrupt(reader);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "detaches an overflowing V2 producer while a live RPC ACK is held and resumes authoritatively",
      () =>
        Effect.gen(function* () {
          const attached = yield* Deferred.make<void>();
          const detached = yield* Deferred.make<void>();
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const app = yield* buildAppUnderTest({
            transformThreadManagementV2: (threads) => ({
              ...threads,
              streamStoredEventsFrom: (input) =>
                Stream.unwrap(
                  Deferred.succeed(attached, undefined).pipe(
                    Effect.as(
                      threads
                        .streamStoredEventsFrom(input)
                        .pipe(Stream.ensuring(Deferred.succeed(detached, undefined))),
                    ),
                  ),
                ),
            }),
          });
          const seeded = yield* seedV2StreamThread(app);
          const received = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          const wsUrl = yield* getWsServerUrl("/ws");
          const reader = yield* makeWsRpcClient.pipe(
            Effect.flatMap((client) =>
              client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                threadId: transferV2ThreadId,
                afterSequence: seeded.sequence,
              }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
            ),
            Effect.provide(withFirstWsAckHeld(wsUrl, held, release)),
            Effect.result,
            Effect.forkScoped,
          );
          yield* Deferred.await(attached);
          const first = yield* app.v2.eventSink.write({
            events: [
              {
                id: EventId.make("held-ack-first"),
                type: "thread.metadata-updated",
                threadId: transferV2ThreadId,
                occurredAt: seeded.thread.updatedAt,
                payload: { ...seeded.thread, title: "First delivered" },
              },
            ],
          });
          yield* Deferred.await(held);
          yield* app.v2.eventSink.write({
            events: Array.from({ length: 1_100 }, (_, index) => ({
              id: EventId.make(`held-ack-overflow-${index}`),
              type: "thread.metadata-updated" as const,
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, title: `Committed ${index}` },
            })),
          });
          // This finalizer is upstream of RPC delivery: it must run before ACK release.
          yield* Deferred.await(detached);
          assert.isFalse(yield* Deferred.isDone(release));
          assert.equal(
            (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).thread.title,
            "Committed 1099",
          );
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(reader);
          assertTrue(result._tag === "Failure");
          assert.equal(result.failure._tag, "OrchestrationV2GetThreadProjectionError");
          const recovered = yield* collectV2ThreadCatchup(wsUrl, first[0]!.sequence);
          const snapshot = recovered[0];
          assertTrue(snapshot?.kind === "snapshot");
          assert.equal(snapshot.projection.thread.title, "Committed 1099");
          assert.deepEqual(recovered.at(-1), { kind: "synchronized" });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "detaches an overflowing V2 shell producer before held ACK release and recovers removed entries",
      () =>
        Effect.gen(function* () {
          const attached = yield* Deferred.make<void>();
          const detached = yield* Deferred.make<void>();
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let observeLive = false;
          const app = yield* buildAppUnderTest({
            transformApplicationEventStore: (events) => ({
              ...events,
              streamProjectedApplicationEvents: (input) =>
                !observeLive
                  ? events.streamProjectedApplicationEvents(input)
                  : Stream.unwrap(
                      Deferred.succeed(attached, undefined).pipe(
                        Effect.as(
                          events
                            .streamProjectedApplicationEvents(input)
                            .pipe(Stream.ensuring(Deferred.succeed(detached, undefined))),
                        ),
                      ),
                    ),
            }),
          });
          const fs = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "scient-shell-overflow-",
          });
          const projectId = ProjectId.make("shell-overflow-removed-project");
          yield* app.v2.projects.create({
            commandId: CommandId.make("shell-overflow-create-project"),
            projectId,
            title: "Removed project",
            workspaceRoot,
          });
          const seeded = yield* seedV2StreamThread(app);
          const archivedId = ThreadId.make("shell-overflow-archived-thread");
          const archived = yield* seedV2StreamThread(app, archivedId);
          const wsUrl = yield* getWsServerUrl("/ws");
          const initial = yield* collectV2ShellCatchup(wsUrl);
          const initialSnapshot = initial[0];
          assertTrue(initialSnapshot?.kind === "snapshot");
          assert.isTrue(
            initialSnapshot.snapshot.projects.some((project) => project.id === projectId),
          );
          assert.isTrue(
            initialSnapshot.snapshot.threads.some((thread) => thread.id === archivedId),
          );
          const cursor = initialSnapshot.snapshot.snapshotSequence;
          observeLive = true;
          const reader = yield* makeWsRpcClient.pipe(
            Effect.flatMap((client) =>
              client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({ afterSequence: cursor }).pipe(
                Stream.runDrain,
              ),
            ),
            Effect.provide(withFirstWsAckHeld(wsUrl, held, release, attached)),
            Effect.result,
            Effect.forkScoped,
          );
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          yield* Deferred.await(attached);
          yield* app.v2.eventSink.write({
            events: [
              {
                id: EventId.make("shell-held-first-live-update"),
                type: "thread.metadata-updated",
                threadId: transferV2ThreadId,
                occurredAt: seeded.thread.updatedAt,
                payload: { ...seeded.thread, title: "First live shell update" },
              },
            ],
          });
          yield* TestClock.adjust(Duration.millis(100));
          yield* Deferred.await(held);
          yield* app.v2.eventSink.write({
            events: Array.from({ length: 1_100 }, (_, index) => {
              const threadId = ThreadId.make(`shell-held-overflow-${index}`);
              return {
                id: EventId.make(`shell-held-overflow-${index}`),
                type: "thread.created" as const,
                threadId,
                occurredAt: seeded.thread.updatedAt,
                payload: {
                  ...seeded.thread,
                  id: threadId,
                  title: `Shell committed ${index}`,
                  lineage: { ...seeded.thread.lineage, rootThreadId: threadId },
                },
              };
            }),
          });
          yield* Deferred.await(detached);
          assert.isFalse(yield* Deferred.isDone(release));
          yield* app.v2.eventSink.write({
            events: [
              {
                id: EventId.make("shell-overflow-delete-thread"),
                type: "thread.deleted",
                threadId: transferV2ThreadId,
                occurredAt: seeded.thread.updatedAt,
                payload: { ...seeded.thread, deletedAt: seeded.thread.updatedAt },
              },
              {
                id: EventId.make("shell-overflow-archive-thread"),
                type: "thread.archived",
                threadId: archivedId,
                occurredAt: archived.thread.updatedAt,
                payload: { ...archived.thread, archivedAt: archived.thread.updatedAt },
              },
            ],
          });
          yield* app.v2.projects.delete({
            commandId: CommandId.make("shell-overflow-delete-project"),
            projectId,
          });
          assertTrue(Option.isNone(yield* app.v2.projects.getShell(projectId)));
          assertTrue(
            (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).thread.deletedAt !==
              null,
          );
          assertTrue(
            (yield* app.v2.threads.getThreadProjection(archivedId)).thread.archivedAt !== null,
          );
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(reader);
          assertTrue(result._tag === "Failure");
          assert.equal(result.failure._tag, "OrchestrationV2GetShellSnapshotError");
          const recovered = yield* collectV2ShellCatchup(wsUrl, cursor);
          const snapshot = recovered[0];
          assertTrue(snapshot?.kind === "snapshot");
          assert.isFalse(snapshot.snapshot.projects.some((project) => project.id === projectId));
          assert.isFalse(
            snapshot.snapshot.threads.some(
              (thread) => thread.id === transferV2ThreadId || thread.id === archivedId,
            ),
          );
          assert.deepEqual(recovered.at(-1), { kind: "synchronized" });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "coalesces live V2 tool updates without crossing interleaved message or terminal boundaries",
      () =>
        Effect.gen(function* () {
          const app = yield* buildAppUnderTest();
          yield* seedV2StreamThread(app);
          const fixture = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false);
          const run = fixture.find((event) => event.type === "run.created");
          assertTrue(run?.type === "run.created");
          const userMessage = fixture.find(
            (event) => event.type === "message.updated" && event.payload.role === "user",
          );
          const userItem = fixture.find(
            (event) => event.type === "turn-item.updated" && event.payload.type === "user_message",
          );
          assertTrue(userMessage?.type === "message.updated");
          assertTrue(
            userItem?.type === "turn-item.updated" && userItem.payload.type === "user_message",
          );
          const seededRun = yield* app.v2.eventSink.write({ events: [run, userMessage, userItem] });
          const received = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          const wsUrl = yield* getWsServerUrl("/ws");
          const reader = yield* withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: transferV2ThreadId,
              requestCompletionMarker: true,
            }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
          ).pipe(Effect.forkScoped);
          const initial = yield* collectQueueUntil(
            received,
            (item) => item.kind === "synchronized",
            "initial live tool subscription",
          );
          const snapshot = initial.find((item) => item.kind === "snapshot");
          assertTrue(snapshot?.kind === "snapshot");
          assert.equal(snapshot.projection.runs[0]?.id, run.payload.id);
          const tool = fixture.find(
            (event) =>
              event.type === "turn-item.updated" && event.payload.type === "command_execution",
          );
          const message = fixture.find(
            (event) => event.type === "message.updated" && event.payload.role === "assistant",
          );
          assertTrue(
            tool?.type === "turn-item.updated" && tool.payload.type === "command_execution",
          );
          assertTrue(message?.type === "message.updated");
          const toolPayload = tool.payload;
          const update = (index: number): OrchestrationV2DomainEvent => ({
            ...tool,
            id: EventId.make(`live-tool-${index}`),
            payload: {
              ...toolPayload,
              status: "running",
              completedAt: null,
              title: `Progress ${index}`,
              output: "",
            },
          });
          const completed: OrchestrationV2DomainEvent = {
            ...tool,
            id: EventId.make("live-tool-terminal"),
            payload: { ...toolPayload, status: "completed", title: "Done" },
          };
          const stored = yield* app.v2.eventSink.write({
            events: [
              ...Array.from({ length: 50 }, (_, index) => update(index)),
              {
                ...message,
                id: EventId.make("interleaved-answer"),
                payload: { ...message.payload, text: "Evidence checkpoint" },
              },
              ...Array.from({ length: 50 }, (_, index) => update(index + 50)),
              completed,
            ],
          });
          const items = yield* collectQueueUntil(
            received,
            (item) => item.kind === "event" && item.sequence === stored.at(-1)!.sequence,
            "terminal live tool update",
          );
          const events = items.flatMap((item) => (item.kind === "event" ? [item] : []));
          const updates = events.filter((item) => item.event.type === "turn-item.updated");
          assert.isBelow(updates.length, 101);
          const boundary = events.findIndex(
            (item) => item.event.id === EventId.make("interleaved-answer"),
          );
          assert.isAbove(boundary, 0);
          const before = events[boundary - 1]?.event;
          assertTrue(before?.type === "turn-item.updated");
          assert.equal(before.payload.title, "Progress 49");
          assert.equal(events.at(-1)?.event.id, completed.id);
          const sequences = events.map((event) => event.sequence);
          assert.deepEqual(
            sequences,
            sequences.toSorted((a, b) => a - b),
          );
          const projection = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
          const finalTool = projection.turnItems.find((item) => item.id === tool.payload.id);
          assert.equal(finalTool?.status, "completed");
          assert.equal(finalTool?.title, "Done");
          assert.equal(
            projection.messages.find((entry) => entry.id === message.payload.id)?.text,
            "Evidence checkpoint",
          );
          const clientProjection = events.reduce<OrchestrationV2ThreadProjection | null>(
            (current, item) => applyOrchestrationV2ProjectionEvent(current, item.event),
            snapshot.projection,
          );
          assertTrue(clientProjection !== null);
          const expected = projectThreadProjectionForWire(projection);
          assert.deepEqual(clientProjection.messages, expected.messages);
          assert.deepEqual(clientProjection.turnItems, expected.turnItems);
          assert.deepEqual(clientProjection.visibleTurnItems, expected.visibleTurnItems);
          assert.deepEqual(clientProjection.runs, expected.runs);
          assert.deepEqual(
            clientProjection.visibleTurnItems.map((row) => row.sourceItemId),
            [userItem.payload.id, tool.payload.id],
          );
          assert.equal(clientProjection.visibleTurnItems.at(-1)?.item.status, "completed");
          assert.equal(clientProjection.turnItems.length, 2);
          yield* Fiber.interrupt(reader);
          const replay = yield* collectV2ThreadCatchup(wsUrl, seededRun.at(-1)!.sequence);
          // Catch-up replay coalesces the same way, keeping the last update on each side of a boundary.
          assert.deepEqual(
            replay.flatMap((item) => (item.kind === "event" ? [item.event.id] : [])),
            [
              EventId.make("live-tool-49"),
              EventId.make("interleaved-answer"),
              EventId.make("live-tool-99"),
              completed.id,
            ],
          );
          assert.deepEqual(replay.at(-1), { kind: "synchronized" });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "keeps concurrent V2 commits beyond a captured replay high-water mark after synchronization",
      () =>
        Effect.gen(function* () {
          const replayEntered = yield* Deferred.make<void>();
          const releaseReplay = yield* Deferred.make<void>();
          const app = yield* buildAppUnderTest({
            transformApplicationEventStore: (events) => ({
              ...events,
              readAgentEvents: (input) =>
                Stream.unwrap(
                  Deferred.succeed(replayEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseReplay)),
                    Effect.as(events.readAgentEvents(input)),
                  ),
                ),
            }),
          });
          const seeded = yield* seedV2StreamThread(app);
          const previous = yield* app.v2.eventSink.write({
            events: [
              {
                id: EventId.make("high-water-before"),
                type: "thread.metadata-updated",
                threadId: transferV2ThreadId,
                occurredAt: seeded.thread.updatedAt,
                payload: { ...seeded.thread, title: "Before high water" },
              },
            ],
          });
          const received = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          const reader = yield* withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
            client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: transferV2ThreadId,
              afterSequence: seeded.sequence,
              requestCompletionMarker: true,
            }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(replayEntered);
          const concurrent = yield* app.v2.eventSink.write({
            events: [
              {
                id: EventId.make("high-water-concurrent"),
                type: "thread.metadata-updated",
                threadId: transferV2ThreadId,
                occurredAt: seeded.thread.updatedAt,
                payload: { ...seeded.thread, title: "After high water" },
              },
            ],
          });
          yield* Deferred.succeed(releaseReplay, undefined);
          const items = yield* collectQueueUntil(
            received,
            (item) => item.kind === "event" && item.sequence === concurrent[0]!.sequence,
            "commit after captured replay head",
          );
          assert.deepEqual(
            items.map((item) => (item.kind === "event" ? item.sequence : item.kind)),
            [previous[0]!.sequence, "synchronized", concurrent[0]!.sequence],
          );
          yield* Fiber.interrupt(reader);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "coalesces a busy V2 shell independently of quiet threads and retries transient projection reads",
      () =>
        Effect.gen(function* () {
          const failedRead = yield* Deferred.make<void>();
          const shellReads = yield* Ref.make<ThreadId[]>([]);
          const busyId = ThreadId.make("shell-fairness-busy");
          let failBusyRead = true;
          const app = yield* buildAppUnderTest({
            transformThreadManagementV2: (threads) => ({
              ...threads,
              getThreadShell: (threadId) =>
                Ref.update(shellReads, (reads) => [...reads, threadId]).pipe(
                  Effect.andThen(
                    Effect.suspend(() => {
                      if (threadId !== busyId || !failBusyRead)
                        return threads.getThreadShell(threadId);
                      failBusyRead = false;
                      return Deferred.succeed(failedRead, undefined).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new OrchestratorV2.OrchestratorProjectionError({
                              threadId,
                              cause: new Error("synthetic transient shell read failure"),
                            }),
                          ),
                        ),
                      );
                    }),
                  ),
                ),
            }),
          });
          const quiet = yield* seedV2StreamThread(app);
          const busy = yield* seedV2StreamThread(app, busyId);
          const received = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
          const reader = yield* withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
            client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
              requestCompletionMarker: true,
            }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
          ).pipe(Effect.forkScoped);
          yield* collectQueueUntil(
            received,
            (item) => item.kind === "synchronized",
            "initial fairness shell snapshot",
          );
          const stored = yield* app.v2.eventSink.write({
            events: [
              ...Array.from({ length: 450 }, (_, index) => ({
                id: EventId.make(`shell-busy-${index}`),
                type: "thread.metadata-updated" as const,
                threadId: busyId,
                occurredAt: busy.thread.updatedAt,
                payload: { ...busy.thread, title: `Busy ${index}` },
              })),
              {
                id: EventId.make("shell-quiet-update"),
                type: "thread.metadata-updated" as const,
                threadId: transferV2ThreadId,
                occurredAt: quiet.thread.updatedAt,
                payload: { ...quiet.thread, title: "Quiet changed" },
              },
            ],
          });
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Deferred.await(failedRead);
          yield* TestClock.adjust(Duration.seconds(5));
          const seen = new Set<string>();
          const items = yield* collectQueueUntil(
            received,
            (item) => {
              if (item.kind === "thread.updated") seen.add(item.thread.title);
              return seen.has("Busy 449") && seen.has("Quiet changed");
            },
            "both committed shell projections after transient recovery",
          );
          assert.isBelow((yield* Ref.get(shellReads)).length, 10);
          assert.isTrue(
            items.some(
              (item) =>
                item.kind === "thread.updated" &&
                item.thread.id === transferV2ThreadId &&
                item.sequence === stored.at(-1)!.sequence,
            ),
          );
          assert.equal(
            (yield* app.v2.threads.getThreadProjection(busyId)).thread.title,
            "Busy 449",
          );
          yield* Fiber.interrupt(reader);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("projects large V2 tool output while retaining the complete persisted result", () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        const base = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).find(
          (event) =>
            event.type === "turn-item.updated" && event.payload.type === "command_execution",
        );
        assertTrue(base?.type === "turn-item.updated" && base.payload.type === "command_execution");
        const output = "Build complete\n" + "x".repeat(9 * 1024 * 1024);
        yield* app.v2.eventSink.write({
          events: [
            {
              ...base,
              payload: { ...base.payload, output, title: "Build complete" },
            },
          ],
        });
        const items = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
        // Raw payload budget requires an authoritative snapshot, not an oversized replay.
        const first = items[0];
        assertTrue(first?.kind === "snapshot");
        const tool = first.projection.turnItems.find((item) => item.id === base.payload.id);
        assertTrue(tool?.type === "command_execution");
        assert.equal(tool.title, "Build complete");
        assert.equal(tool.output, undefined);
        const persisted = (yield* app.v2.threads.getThreadProjection(transferV2ThreadId))
          .turnItems[0];
        assertTrue(persisted?.type === "command_execution");
        assert.equal(persisted.output, output);
        const shell = yield* collectV2ShellCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
        assert.equal(shell.at(-1)?.kind, "synchronized");
        assert.isFalse(encodeTestJson(shell).includes(output));
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(
      (["thread", "shell"] as const).map((subscription) => ({
        caseTitle: `replaces an ahead-of-head V2 ${subscription} cursor with an authoritative snapshot`,
        subscription,
      })),
    )("$caseTitle", ({ subscription }) =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        const wsUrl = yield* getWsServerUrl("/ws");
        if (subscription === "thread") {
          const items = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence + 100);
          const snapshot = items[0];
          assertTrue(snapshot?.kind === "snapshot");
          assert.equal(snapshot.snapshotSequence, seeded.sequence);
          assert.equal(snapshot.projection.thread.id, transferV2ThreadId);
        } else {
          const items = yield* collectV2ShellCatchup(wsUrl, seeded.sequence + 100);
          const snapshot = items[0];
          assertTrue(snapshot?.kind === "snapshot");
          assert.equal(snapshot.snapshot.snapshotSequence, seeded.sequence);
          assert.equal(snapshot.snapshot.threads[0]?.id, transferV2ThreadId);
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("replays a small V2 thread range across a large application gap", () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        const unrelated = ThreadId.make("unrelated-busy-thread");
        const other = yield* seedV2StreamThread(app, unrelated);
        yield* app.v2.eventSink.write({
          events: Array.from({ length: 1_001 }, (_, index) => ({
            id: EventId.make(`unrelated-${index}`),
            type: "thread.metadata-updated" as const,
            threadId: unrelated,
            occurredAt: other.thread.updatedAt,
            payload: { ...other.thread, title: `Unrelated ${index}` },
          })),
        });
        const stored = yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("small-thread-replay"),
              type: "thread.metadata-updated",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, title: "Small thread replay" },
            },
          ],
        });
        const items = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
        assert.deepEqual(
          items.map((item) => (item.kind === "event" ? item.sequence : item.kind)),
          [stored[0]!.sequence, "synchronized"],
        );
        const update = items[0];
        assertTrue(update?.kind === "event" && update.event.type === "thread.metadata-updated");
        assert.equal(update.event.payload.title, "Small thread replay");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(
      (["thread", "shell"] as const).map((subscription) => ({
        caseTitle: `replaces an over-limit V2 ${subscription} replay with a complete snapshot`,
        subscription,
      })),
    )("$caseTitle", ({ subscription }) =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        const stored = yield* app.v2.eventSink.write({
          events: Array.from({ length: 1_001 }, (_, index) => ({
            id: EventId.make(`over-limit-${index}`),
            type: "thread.metadata-updated" as const,
            threadId: transferV2ThreadId,
            occurredAt: seeded.thread.updatedAt,
            payload: { ...seeded.thread, title: `Updated ${index}` },
          })),
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        if (subscription === "thread") {
          const items = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence);
          const snapshot = items[0];
          assertTrue(snapshot?.kind === "snapshot");
          assert.equal(snapshot.snapshotSequence, stored.at(-1)!.sequence);
          assert.equal(snapshot.projection.thread.title, "Updated 1000");
          assert.deepEqual(items.at(-1), { kind: "synchronized" });
        } else {
          const items = yield* collectV2ShellCatchup(wsUrl, seeded.sequence);
          const snapshot = items[0];
          assertTrue(snapshot?.kind === "snapshot");
          assert.equal(snapshot.snapshot.snapshotSequence, stored.at(-1)!.sequence);
          assert.equal(snapshot.snapshot.threads[0]?.title, "Updated 1000");
          assert.deepEqual(items.at(-1), { kind: "synchronized" });
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("resets cached V2 history when a deleted thread ID is created again", () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("delete-before-recreation"),
              type: "thread.deleted",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, deletedAt: seeded.thread.updatedAt },
            },
          ],
        });
        const recreated = transferV2ThreadCreated(ProviderDriverKind.make("codex"));
        assertTrue(recreated.type === "thread.created");
        yield* app.v2.eventSink.write({
          events: [
            {
              ...recreated,
              id: EventId.make("recreated-thread"),
              payload: { ...recreated.payload, title: "Recreated thread" },
            },
          ],
        });
        const items = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
        const snapshot = items[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.equal(snapshot.projection.thread.title, "Recreated thread");
        assert.deepEqual(snapshot.projection.messages, []);
        assert.deepEqual(items.at(-1), { kind: "synchronized" });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(
      [false, true].map((oversized) => ({
        caseTitle: `synchronizes a deleted V2 thread through authoritative ${oversized ? "snapshot" : "event"} replay`,
        oversized,
      })),
    )("$caseTitle", ({ oversized }) =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        if (oversized) {
          yield* app.v2.eventSink.write({
            events: Array.from({ length: 1_001 }, (_, index) => ({
              id: EventId.make(`deleted-over-limit-${index}`),
              type: "thread.metadata-updated" as const,
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, title: `Updated ${index}` },
            })),
          });
        }
        const deleted = yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("deleted-thread"),
              type: "thread.deleted",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, deletedAt: seeded.thread.updatedAt },
            },
          ],
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence).pipe(Effect.result);
        assertTrue(result._tag === "Success");
        if (oversized) {
          assert.deepEqual(
            result.success.map((item) => item.kind),
            ["snapshot", "synchronized"],
          );
          const snapshot = result.success[0];
          assertTrue(snapshot?.kind === "snapshot");
          assert.equal(snapshot.projection.thread.id, transferV2ThreadId);
          assertTrue(snapshot.projection.thread.deletedAt !== null);
          assert.equal(
            DateTime.formatIso(snapshot.projection.thread.deletedAt),
            DateTime.formatIso(seeded.thread.updatedAt),
          );
        } else {
          assertTrue(result._tag === "Success");
          assert.deepEqual(
            result.success.map((item) => item.kind),
            ["event", "synchronized"],
          );
        }
        const shell = yield* collectV2ShellCatchup(wsUrl, seeded.sequence);
        if (oversized) {
          const snapshot = shell[0];
          assertTrue(snapshot?.kind === "snapshot");
          assert.isFalse(
            snapshot.snapshot.threads.some((thread) => thread.id === transferV2ThreadId),
          );
          assert.deepEqual(shell.at(-1), { kind: "synchronized" });
        } else {
          assert.isTrue(
            shell.some(
              (item) =>
                item.kind === "thread.removed" &&
                item.threadId === transferV2ThreadId &&
                item.sequence === deleted[0]!.sequence &&
                item.location === "active",
            ),
          );
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(
      (
        [
          { name: "ready", sessionState: "ready", unloadFailure: undefined },
          { name: "no-session", sessionState: "absent", unloadFailure: undefined },
          { name: "stopped", sessionState: "stopped", unloadFailure: undefined },
          { name: "unload-failure", sessionState: "ready", unloadFailure: "failure" },
          { name: "unload-defect", sessionState: "ready", unloadFailure: "defect" },
        ] as const
      ).map((scenario) => ({
        caseTitle: `archives native threads and closes terminals (${scenario.name})`,
        scenario,
      })),
    )("$caseTitle", ({ scenario }) =>
      Effect.gen(function* () {
        const fixture = yield* makeNativeArchiveFixture(
          scenario.name,
          scenario.sessionState,
          scenario.unloadFailure,
        );
        const commandId = CommandId.make(`native-archive-${scenario.name}`);
        const before = yield* fixture.app.v2.eventSink.latestSequence();
        const receipt = yield* fixture.dispatch("thread.archive", commandId);
        assert.isAbove(receipt.sequence, before);
        assert.deepEqual(fixture.effects, []);
        const archived = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
        assert.isNotNull(archived.thread.archivedAt);
        const expectedTypes =
          scenario.sessionState === "ready"
            ? ["provider-session.detach", "terminal.cleanup"]
            : ["terminal.cleanup"];
        const pending = yield* fixture.app.v2.outbox.listByCommandId(commandId);
        assert.sameMembers(
          pending.map((row) => row.request.type),
          expectedTypes,
        );
        assert.isTrue(pending.every((row) => row.status === "pending"));
        if (scenario.sessionState === "ready") {
          assert.isUndefined(
            archived.providerSessions.find((row) => row.id === fixture.providerSessionId),
          );
          const detach = pending.find((row) => row.request.type === "provider-session.detach");
          assertTrue(detach?.request.type === "provider-session.detach");
          assert.equal(detach.request.providerSessionId, fixture.providerSessionId);
          assert.isTrue(detach.request.revokeMcpCredential);
        }
        assert.equal(yield* fixture.app.v2.worker.drain(), expectedTypes.length);
        assert.deepEqual(
          fixture.effects,
          scenario.sessionState === "ready"
            ? [`provider.unload:${fixture.threadId}`, `terminal.close:${fixture.threadId}`]
            : [`terminal.close:${fixture.threadId}`],
        );
        const completed = yield* fixture.app.v2.outbox.listByCommandId(commandId);
        assert.isTrue(completed.every((row) => row.status === "succeeded"));
        const repeated = yield* fixture.dispatch("thread.archive", commandId);
        assert.equal(repeated.sequence, receipt.sequence);
        assert.equal(yield* fixture.app.v2.worker.drain(), 0);
        assert.deepEqual(yield* fixture.app.v2.outbox.listByCommandId(commandId), completed);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("archives the recorded native session before active shell removal", () =>
      Effect.gen(function* () {
        const fixture = yield* makeNativeArchiveFixture("precheck");
        const commandId = CommandId.make("native-archive-precheck");
        assert.isNotNull(yield* fixture.app.v2.threads.getThreadShell(fixture.threadId));
        yield* fixture.dispatch("thread.archive", commandId);
        const active = yield* fixture.app.v2.threads.getShellSnapshot();
        assert.isFalse(active.threads.some((thread) => thread.id === fixture.threadId));
        const pending = yield* fixture.app.v2.outbox.listByCommandId(commandId);
        assert.isTrue(
          pending.some(
            (row) =>
              row.request.type === "provider-session.detach" &&
              row.request.providerSessionId === fixture.providerSessionId,
          ),
        );
        yield* fixture.app.v2.worker.drain();
        assert.deepEqual(fixture.effects, [
          `provider.unload:${fixture.threadId}`,
          `terminal.close:${fixture.threadId}`,
        ]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "settles native idle sessions with durable detach and leaves terminal cleanup to the reactor",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeNativeArchiveFixture("settle");
          const commandId = CommandId.make("native-settle");
          yield* fixture.dispatch("thread.settle", commandId);
          const projection = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
          assert.equal(projection.thread.settledOverride, "settled");
          assert.isNotNull(projection.thread.settledAt);
          assert.isNull(projection.thread.archivedAt);
          assert.deepEqual(fixture.effects, []);
          const pending = yield* fixture.app.v2.outbox.listByCommandId(commandId);
          assert.deepEqual(
            pending.map((row) => row.request.type),
            ["provider-session.detach"],
          );
          assert.equal(yield* fixture.app.v2.worker.drain(), 1);
          assert.deepEqual(fixture.effects, [`provider.unload:${fixture.threadId}`]);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("preserves the blocked-settlement boundary and native history", () =>
      Effect.gen(function* () {
        const fixture = yield* makeNativeArchiveFixture(
          "settle-blocked",
          "ready",
          undefined,
          transferV2ThreadId,
        );
        const events = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false);
        yield* fixture.app.v2.eventSink.write({ events });
        const projection = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
        const activeRun = projection.runs[0];
        assertTrue(activeRun !== undefined);
        yield* fixture.app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("native-blocked-settle-run"),
              type: "run.updated",
              threadId: fixture.threadId,
              occurredAt: yield* DateTime.now,
              payload: { ...activeRun, status: "running", completedAt: null },
            },
          ],
        });
        const before = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
        const sequence = yield* fixture.app.v2.eventSink.latestSequence();
        const commandId = CommandId.make("native-settle-blocked");
        const error = yield* fixture.dispatch("thread.settle", commandId).pipe(Effect.flip);
        assert.equal(error._tag, "OrchestrationV2DispatchCommandError");
        assert.equal(yield* fixture.app.v2.eventSink.latestSequence(), sequence);
        assert.deepEqual(
          yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId),
          before,
        );
        assert.deepEqual(yield* fixture.app.v2.outbox.listByCommandId(commandId), []);
        assert.deepEqual(fixture.effects, []);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("forwards opening-turn plan provenance through launch RPC", () =>
      Effect.gen(function* () {
        const received: Array<ThreadLaunchV2.ThreadLaunchInput> = [];
        const sourcePlanRef = {
          threadId: ThreadId.make("source-plan-thread"),
          planId: PlanId.make("source-plan"),
        };
        const fixture = yield* makeNativeLaunchFixture("source-plan-wire", {
          transformThreadLaunchV2: (launch) => ({
            ...launch,
            launch: (input) =>
              Effect.sync(() => {
                received.push(input);
              }).pipe(
                // Stop at the service boundary; real plan adoption is covered by
                // the connected cross-target extraction fixture.
                Effect.andThen(
                  Effect.fail(
                    new ThreadLaunchV2.ThreadLaunchError({
                      operation: "dispatch-message",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      cause: "Synthetic launch boundary",
                    }),
                  ),
                ),
              ),
          }),
        });
        const failure = yield* fixture
          .launch({
            ...fixture.input,
            initialMessage: {
              ...fixture.input.initialMessage,
              sourcePlanRef,
              selectedScientSkillNames: ["pdf-authoring"],
            },
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "OrchestrationV2ThreadLaunchError");
        assert.lengthOf(received, 1);
        assert.deepEqual(received[0]?.initialMessage, {
          ...fixture.input.initialMessage,
          sourcePlanRef,
          selectedScientSkillNames: ["pdf-authoring"],
        });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("bootstraps a native first-send worktree before releasing its durable run", () =>
      Effect.gen(function* () {
        const operations: string[] = [];
        const fetchedCommit = "0123456789abcdef0123456789abcdef01234567";
        const runForThread = vi.fn<
          ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
        >((input) =>
          Effect.sync(() => {
            operations.push("setup");
            assert.isDefined(input.observeCompletion);
            return { status: "no-script" as const };
          }),
        );
        const createWorktree = vi.fn<GitManager.GitManager["Service"]["createWorktree"]>((input) =>
          Effect.sync(() => {
            operations.push("checkout");
            assert.equal(input.refName, fetchedCommit);
            return { worktree: { path: input.cwd, refName: input.newRefName! } };
          }),
        );
        const fixture = yield* makeNativeLaunchFixture("remote-first", {
          layers: {
            gitVcsDriver: {
              resolveWorktreeBaseRemote: (input) =>
                Effect.sync(() => {
                  assert.equal(input.refName, "main");
                  operations.push("resolve-base-remote");
                  return { remoteName: "origin", branchName: "main" };
                }),
              fetchWorktreeBaseCommit: (input) =>
                Effect.sync(() => {
                  assert.equal(input.refName, "main");
                  operations.push("fetch-base-commit");
                  return { commitSha: fetchedCommit, remoteRefName: "origin/main" };
                }),
            },
            gitManager: { createWorktree },
            projectSetupScriptRunner: { runForThread },
          },
        });
        const launched = yield* fixture.launch({
          ...fixture.input,
          workspaceStrategy: { ...fixture.input.workspaceStrategy, startFromOrigin: true },
        });
        assert.equal(launched.threadId, fixture.threadId);
        assert.isTrue(launched.projection.runs.some((run) => run.status === "preparing"));
        const ready = yield* fixture.awaitRun("starting");
        assert.deepEqual(operations, [
          "resolve-base-remote",
          "fetch-base-commit",
          "checkout",
          "setup",
        ]);
        assert.equal(ready.thread.branch, "feature/manual");
        assert.equal(ready.thread.worktreePath, fixture.root);
        assert.deepEqual(
          ready.messages.map((message) => message.id),
          [fixture.input.initialMessage.messageId],
        );
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: fixture.root,
          refName: fetchedCommit,
          newRefName: "feature/manual",
          baseRefName: "refs/remotes/origin/main",
          path: null,
        });
        assert.equal(runForThread.mock.calls[0]?.[0].worktreePath, fixture.root);
        const done = yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "done");
        assert.isTrue(
          done.stages.every((stage) => stage.status === "done" || stage.status === "skipped"),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each([
      { caseName: "the origin remote is missing", hasOrigin: false },
      { caseName: "the base branch exists only locally", hasOrigin: true },
    ])("native launch uses the local base when $caseName", ({ hasOrigin }) =>
      Effect.gen(function* () {
        const resolveWorktreeBaseRemote = vi.fn<
          GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"]
        >(() => Effect.succeed(hasOrigin ? { remoteName: "origin", branchName: "main" } : null));
        const fetchWorktreeBaseCommit = vi.fn<
          GitVcsDriver.GitVcsDriver["Service"]["fetchWorktreeBaseCommit"]
        >(() => Effect.succeed(null));
        const fixture = yield* makeNativeLaunchFixture(`local-${hasOrigin}`, {
          layers: {
            gitVcsDriver: {
              resolveWorktreeBaseRemote,
              fetchWorktreeBaseCommit,
            },
          },
        });
        yield* fixture.launch({
          ...fixture.input,
          workspaceStrategy: { ...fixture.input.workspaceStrategy, startFromOrigin: true },
        });
        yield* fixture.awaitRun("starting");
        assert.deepEqual(resolveWorktreeBaseRemote.mock.calls, [
          [{ cwd: fixture.root, refName: "main" }],
        ]);
        assert.deepEqual(
          fetchWorktreeBaseCommit.mock.calls,
          hasOrigin
            ? [
                [
                  {
                    cwd: fixture.root,
                    refName: "main",
                    remote: { remoteName: "origin", branchName: "main" },
                  },
                ],
              ]
            : [],
        );
        assert.deepEqual(fixture.createWorktree.mock.calls[0]?.[0], {
          cwd: fixture.root,
          refName: "main",
          newRefName: "feature/manual",
          baseRefName: "main",
          path: null,
        });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // A non-Git project is refused at launch, before any send (ThreadLaunchService tests).
    it.effect.each(["base-without-commit", "fetch-failure", "checkout-defect"] as const)(
      "native required worktree preserves a failed first send for %s",
      (failure) =>
        Effect.gen(function* () {
          const createWorktree = vi.fn<GitManager.GitManager["Service"]["createWorktree"]>(() =>
            failure === "checkout-defect"
              ? Effect.die(new Error("checkout exploded"))
              : Effect.fail(
                  new GitCommandError({
                    operation: "create-worktree",
                    command: "git worktree add",
                    cwd: "/synthetic",
                    detail: "base has no commit",
                  }),
                ),
          );
          const runForThread = vi.fn<
            ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
          >(() => Effect.die("Failed checkout must not run setup"));
          const fixture = yield* makeNativeLaunchFixture(failure, {
            layers: {
              gitVcsDriver: {
                resolveWorktreeBaseRemote: () =>
                  Effect.succeed(
                    failure === "fetch-failure"
                      ? { remoteName: "origin", branchName: "main" }
                      : null,
                  ),
                fetchWorktreeBaseCommit: () =>
                  Effect.fail(
                    new GitCommandError({
                      operation: "fetch",
                      command: "git fetch",
                      cwd: "/synthetic",
                      detail: "fetch failed",
                    }),
                  ),
              },
              gitManager: { createWorktree },
              projectSetupScriptRunner: { runForThread },
            },
          });
          const launched = yield* fixture.launch({
            ...fixture.input,
            workspaceStrategy: {
              ...fixture.input.workspaceStrategy,
              startFromOrigin: failure === "fetch-failure",
            },
          });
          const failed = yield* fixture.awaitRun("failed");
          assert.equal(launched.threadId, fixture.threadId);
          assert.deepEqual(
            failed.messages.map((message) => message.id),
            [fixture.input.initialMessage.messageId],
          );
          assert.equal(failed.runs.length, 1);
          assert.equal(failed.runs[0]?.status, "failed");
          assert.isNull(failed.thread.deletedAt);
          assert.isTrue(failed.runs.every((run) => run.status === "failed"));
          assert.isNull(failed.thread.worktreePath);
          assert.equal(runForThread.mock.calls.length, 0);
          assert.equal(createWorktree.mock.calls.length, failure === "fetch-failure" ? 0 : 1);
          const snapshot = yield* fixture.snapshotWhere((current) => current.phase === "failed");
          assert.isString(snapshot.error);
          if (failure === "fetch-failure") {
            assert.include(snapshot.error!, "fetch failed");
          }
          // Retrying an accepted command reuses its durable message/run, not a second launch.
          const retried = yield* fixture.launch();
          assert.equal(retried.threadId, fixture.threadId);
          assert.equal(
            (yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId)).messages.length,
            1,
          );
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("native launch rejects a missing project before creating a thread", () =>
      Effect.gen(function* () {
        const fixture = yield* makeNativeLaunchFixture("missing-project");
        const result = yield* fixture
          .launch({ ...fixture.input, projectId: ProjectId.make("absent-launch-project") })
          .pipe(Effect.result);
        assertTrue(result._tag === "Failure");
        assert.equal(result.failure._tag, "OrchestrationV2ThreadLaunchError");
        assert.isNull(yield* fixture.app.v2.threads.getThreadShell(fixture.threadId));
        assert.equal(fixture.createWorktree.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(["start-failure", "nonzero-exit"] as const)(
      "native synchronous setup %s retains failed run without provider release",
      (failure) =>
        Effect.gen(function* () {
          const fixture = yield* makeNativeLaunchFixture(`setup-${failure}`, {
            layers: {
              projectSetupScriptRunner: {
                runForThread: (input) =>
                  failure === "start-failure"
                    ? Effect.fail(
                        new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
                          threadId: input.threadId,
                          projectId: input.projectId,
                          projectCwd: input.projectCwd,
                          worktreePath: input.worktreePath,
                          operation: "openTerminal",
                          cause: new Error("setup launch failed"),
                        }),
                      )
                    : Effect.succeed({
                        status: "started",
                        scriptId: "setup",
                        scriptName: "Setup",
                        scriptCommand: "npm install",
                        terminalId: "setup-terminal",
                        cwd: input.worktreePath,
                        async: false,
                        completion: Effect.succeed({ exitCode: 1, durationMs: 1 }),
                      }),
              },
            },
          });
          yield* fixture.launch();
          const failed = yield* fixture.awaitRun("failed");
          assert.equal(failed.runs[0]?.status, "failed");
          assert.equal(failed.messages.length, 1);
          assert.isTrue(failed.runs.every((run) => run.status === "failed"));
          assert.equal(failed.thread.worktreePath, fixture.worktreePath);
          const events = yield* fixture.app.v2.events
            .readAgentEvents({ threadId: fixture.threadId })
            .pipe(Stream.runCollect);
          assert.isFalse(
            events.some(
              (stored) =>
                stored.event.type === "run.updated" && stored.event.payload.status === "starting",
            ),
          );
          const snapshot = yield* fixture.snapshotWhere((current) => current.phase === "failed");
          assert.isTrue(
            snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "pending"),
          );
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("native successful setup does not hide a durable run release failure", () =>
      Effect.gen(function* () {
        const fixture = yield* makeNativeLaunchFixture("release-persistence-failure", {
          layers: {
            projectSetupScriptRunner: {
              runForThread: (input) =>
                Effect.succeed({
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "npm install",
                  terminalId: "setup-terminal",
                  cwd: input.worktreePath,
                  async: false,
                  completion: Effect.succeed({ exitCode: 0, durationMs: 1 }),
                }),
            },
          },
        });
        // Fail the actual event-log insert for release, after setup succeeds.
        // Failed-run persistence still works, so the test proves transaction and
        // error attribution using the same SQL store as the production services.
        yield* fixture.app.v2.sql`
        CREATE TRIGGER reject_native_launch_release
        BEFORE INSERT ON orchestration_events
        WHEN NEW.event_type = 'run.updated' AND json_extract(NEW.payload_json, '$.status') = 'starting'
        BEGIN SELECT RAISE(FAIL, 'controlled native release persistence failure'); END
      `;
        yield* fixture.launch();
        const failed = yield* fixture.awaitRun("failed");
        assert.equal(failed.messages.length, 1);
        assert.equal(failed.runs[0]?.status, "failed");
        assert.equal(failed.thread.worktreePath, fixture.worktreePath);
        const setup = yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "failed");
        assert.equal(setup.stages.find((stage) => stage.id === "setup-script")?.status, "done");
        assert.isFalse(
          setup.stages.some((stage) => stage.id === "agent" && stage.status === "done"),
        );
        const events = yield* fixture.app.v2.events
          .readAgentEvents({ threadId: fixture.threadId })
          .pipe(Stream.runCollect);
        assert.isFalse(
          events.some(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "starting",
          ),
        );
        assert.deepEqual(
          yield* fixture.app.v2.outbox.listByCommandId(
            CommandId.make(`${fixture.input.commandId}:release`),
          ),
          [],
        );
        yield* fixture.app.v2.sql`DROP TRIGGER reject_native_launch_release`;
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each([
      { name: "async-success", async: true, exitCode: 0, cancel: false },
      { name: "async-failure", async: true, exitCode: 1, cancel: false },
      { name: "sync-disconnect", async: false, exitCode: 0, cancel: false },
      { name: "sync-cancel", async: false, exitCode: 0, cancel: true },
    ])("native setup lifecycle: $name", ({ name, async, exitCode, cancel }) =>
      Effect.gen(function* () {
        const scriptExit = yield* Deferred.make<void>();
        const setupEntered = yield* Deferred.make<void>();
        const cleanup: string[] = [];
        const fixture = yield* makeNativeLaunchFixture(name, {
          layers: {
            terminalManager: {
              close: (input) =>
                Effect.sync(() => {
                  cleanup.push(`terminal:${input.terminalId}`);
                }),
            },
            gitVcsDriver: {
              removeWorktree: (input) =>
                Effect.sync(() => {
                  cleanup.push(`worktree:${input.path}`);
                }),
            },
            projectSetupScriptRunner: {
              runForThread: (input) =>
                Deferred.succeed(setupEntered, undefined).pipe(
                  Effect.as({
                    status: "started" as const,
                    scriptId: "setup",
                    scriptName: "Setup",
                    scriptCommand: "npm install",
                    terminalId: "setup-terminal",
                    cwd: input.worktreePath,
                    async,
                    completion: Deferred.await(scriptExit).pipe(
                      Effect.as({ exitCode, durationMs: 1 }),
                    ),
                  }),
                ),
            },
          },
        });
        const accepted = yield* fixture.launch();
        assert.equal(accepted.threadId, fixture.threadId);
        yield* Deferred.await(setupEntered);
        const running = yield* fixture.snapshotWhere(
          (snapshot) =>
            snapshot.phase === "running" &&
            snapshot.stages.some(
              (stage) => stage.id === "setup-script" && stage.status === "running",
            ),
        );
        assert.equal(running.worktreePath, fixture.worktreePath);
        if (async) {
          yield* fixture.awaitRun("starting");
          const released = yield* fixture.snapshotWhere((snapshot) =>
            snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done"),
          );
          assert.equal(released.phase, "running");
        } else {
          const pending = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
          assert.equal(pending.runs[0]?.status, "preparing");
          assert.isTrue(
            running.stages.some((stage) => stage.id === "agent" && stage.status === "pending"),
          );
        }
        if (cancel) {
          const cancelled = yield* Effect.scoped(
            withWsRpcClient(fixture.wsUrl, (client) =>
              client[WS_METHODS.worktreeSetupCancel]({ threadId: fixture.threadId }),
            ),
          );
          assert.isTrue(cancelled.cancelled);
          const failed = yield* fixture.awaitRun("failed");
          const outcome = yield* fixture.snapshotWhere(
            (snapshot) => snapshot.phase === "cancelled",
          );
          assert.equal(outcome.phase, "cancelled");
          assert.equal(failed.messages.length, 1);
          assert.isNull(failed.thread.worktreePath);
          assert.isNull(failed.thread.deletedAt);
          assert.deepEqual(cleanup, [
            "terminal:setup-terminal",
            `worktree:${fixture.worktreePath}`,
          ]);
          return;
        }
        // The launch socket has already closed while setup owns its server scope.
        yield* Deferred.succeed(scriptExit, undefined);
        yield* fixture.awaitRun("starting");
        const done = yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "done");
        assert.equal(
          done.stages.find((stage) => stage.id === "setup-script")?.status,
          exitCode === 0 ? "done" : "failed",
        );
        assert.deepEqual(cleanup, []);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects native identity reuse and isolates a replacement from the old launch", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const scriptExit = yield* Deferred.make<void>();
        const setupCancelled = yield* Deferred.make<void>();
        const fixture = yield* makeNativeLaunchFixture("recreated-during-setup", {
          layers: {
            projectSetupScriptRunner: {
              runForThread: (input) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.as({
                    status: "started" as const,
                    scriptId: "setup",
                    scriptName: "Setup",
                    scriptCommand: "npm install",
                    terminalId: "setup-terminal",
                    cwd: input.worktreePath,
                    async: false,
                    completion: Deferred.await(scriptExit).pipe(
                      Effect.as({ exitCode: 0, durationMs: 1 }),
                      Effect.onInterrupt(() => Deferred.succeed(setupCancelled, undefined)),
                    ),
                  }),
                ),
            },
          },
        });
        yield* fixture.launch();
        yield* Deferred.await(entered);
        yield* fixture.snapshotWhere((snapshot) => snapshot.setupScript !== null);
        const replacementId = ThreadId.make("fresh-native-replacement");
        const create = {
          type: "thread.create" as const,
          commandId: CommandId.make("create-fresh-replacement"),
          threadId: replacementId,
          projectId: fixture.projectId,
          title: "Replacement conversation",
          modelSelection: defaultModelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          createdBy: "user" as const,
          creationSource: "web" as const,
        };
        const active = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
        yield* Effect.scoped(
          withWsRpcClient(fixture.wsUrl, (client) =>
            Effect.gen(function* () {
              const activeReuse = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                ...create,
                commandId: CommandId.make("reuse-active-identity"),
                threadId: fixture.threadId,
              }).pipe(Effect.flip);
              assert.equal(activeReuse._tag, "OrchestrationV2DispatchCommandError");
              assert.equal(
                activeReuse.message,
                "This conversation already exists. Start a new conversation instead.",
              );
              assert.deepEqual(
                yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId),
                active,
              );
              yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "thread.delete",
                commandId: CommandId.make("delete-preparing-incarnation"),
                threadId: fixture.threadId,
              });
              // Observe the actual cancellation while completion is still blocked.
              yield* Deferred.await(setupCancelled);
              const deleted = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
              const deletedSequence = yield* fixture.app.v2.eventSink.latestSequence();
              assert.isNotNull(deleted.thread.deletedAt);
              const deletedReuse = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                ...create,
                commandId: CommandId.make("reuse-deleted-identity"),
                threadId: fixture.threadId,
              }).pipe(Effect.flip);
              assert.equal(deletedReuse._tag, "OrchestrationV2DispatchCommandError");
              assert.equal(deletedReuse.message, activeReuse.message);
              assert.deepEqual(
                yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId),
                deleted,
              );
              assert.equal(yield* fixture.app.v2.eventSink.latestSequence(), deletedSequence);
              const created = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](create);
              const repeated = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](create);
              assert.equal(repeated.sequence, created.sequence);
              assert.equal(yield* fixture.app.v2.eventSink.latestSequence(), created.sequence);
            }),
          ),
        );
        const tombstone = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
        const replacement = yield* fixture.app.v2.threads.getThreadProjection(replacementId);
        assert.equal(replacement.thread.title, "Replacement conversation");
        assert.isNull(replacement.thread.deletedAt);
        assert.deepEqual(replacement.messages, []);
        assert.deepEqual(replacement.runs, []);
        const sequence = yield* fixture.app.v2.eventSink.latestSequence();
        yield* Deferred.succeed(scriptExit, undefined);
        // Deletion cancels the preparing run and its blocked setup before release.
        // Late completion must not revive that execution or touch the replacement.
        yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "cancelled");
        assert.deepEqual(
          yield* fixture.app.v2.threads.getThreadProjection(replacementId),
          replacement,
        );
        assert.deepEqual(
          yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId),
          tombstone,
        );
        assert.equal(yield* fixture.app.v2.eventSink.latestSequence(), sequence);
        assert.deepEqual(
          yield* fixture.app.v2.outbox.listByCommandId(
            CommandId.make(`${fixture.input.commandId}:release`),
          ),
          [],
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "native cancellation cleanup failure retains owned workspace and accepted history",
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const scriptExit = yield* Deferred.make<void>();
          const fixture = yield* makeNativeLaunchFixture("cleanup-failed", {
            layers: {
              gitVcsDriver: {
                removeWorktree: () =>
                  Effect.fail(
                    new GitCommandError({
                      operation: "remove",
                      command: "git worktree remove",
                      cwd: "/synthetic",
                      detail: "cleanup failed",
                    }),
                  ),
              },
              terminalManager: { close: () => Effect.void },
              projectSetupScriptRunner: {
                runForThread: (input) =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.as({
                      status: "started" as const,
                      scriptId: "setup",
                      scriptName: "Setup",
                      scriptCommand: "npm install",
                      terminalId: "setup-terminal",
                      cwd: input.worktreePath,
                      async: false,
                      completion: Deferred.await(scriptExit).pipe(
                        Effect.as({ exitCode: 0, durationMs: 1 }),
                      ),
                    }),
                  ),
              },
            },
          });
          yield* fixture.launch();
          yield* Deferred.await(entered);
          yield* fixture.snapshotWhere((snapshot) => snapshot.setupScript !== null);
          yield* Effect.scoped(
            withWsRpcClient(fixture.wsUrl, (client) =>
              client[WS_METHODS.worktreeSetupCancel]({ threadId: fixture.threadId }),
            ),
          );
          const failed = yield* fixture.awaitRun("failed");
          assert.isNull(failed.thread.deletedAt);
          assert.equal(failed.thread.worktreePath, fixture.worktreePath);
          assert.equal(failed.thread.branch, "feature/manual");
          assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(fixture.worktreePath));
          const cancelled = yield* fixture.snapshotWhere(
            (snapshot) => snapshot.phase === "cancelled" && snapshot.error !== null,
          );
          assert.include(cancelled.error ?? "", "cleanup failed");
          assert.equal(failed.messages.length, 1);
          assert.equal(failed.runs[0]?.status, "failed");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: 27e6cc27fe perf(server): cache and stream static web assets (#9669)

    it.effect("binds static metadata and bytes to one file across atomic replacement", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-static-replace-",
        });
        const beforeOpenPath = path.join(staticDir, "before-open.txt");
        const afterOpenPath = path.join(staticDir, "after-open.txt");
        const afterOpenSnapshotPath = path.join(staticDir, "after-open-snapshot.txt");
        const windowsHost = HostProcess.Platform.defaultValue() === "win32";
        const original = "original bytes";
        const replacement = "replacement bytes with a different size";
        for (const filePath of [beforeOpenPath, afterOpenPath]) {
          yield* fileSystem.writeFileString(filePath, original);
          yield* fileSystem.writeFileString(`${filePath}.next`, replacement);
        }
        if (windowsHost) {
          // Windows cannot replace an open destination, so model the race with its original handle.
          yield* fileSystem.writeFileString(afterOpenSnapshotPath, original);
        }
        const replaced = new Set<string>();
        const replaceOnce = Effect.fnUntraced(function* (filePath: string) {
          if (replaced.has(filePath)) return;
          replaced.add(filePath);
          yield* fileSystem.rename(`${filePath}.next`, filePath);
        });
        const replacingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          stat: (filePath) =>
            fileSystem
              .stat(filePath)
              .pipe(
                Effect.tap(() =>
                  filePath === beforeOpenPath ? replaceOnce(filePath) : Effect.void,
                ),
              ),
          open: (filePath, options) =>
            fileSystem
              .open(
                filePath === afterOpenPath && windowsHost ? afterOpenSnapshotPath : filePath,
                options,
              )
              .pipe(
                Effect.tap(() =>
                  filePath === afterOpenPath ? replaceOnce(filePath) : Effect.void,
                ),
              ),
        });
        yield* buildAppUnderTest({ config: { staticDir } }).pipe(
          Effect.provideService(FileSystem.FileSystem, replacingFileSystem),
        );

        for (const [name, expected] of [
          ["before-open.txt", replacement],
          ["after-open.txt", original],
        ] as const) {
          const response = yield* HttpClient.get(`/${name}`, {
            headers: { "accept-encoding": "identity" },
          });
          assert.equal(response.status, 200);
          assert.equal(response.headers["content-length"], String(expected.length));
          assert.isTrue(response.headers.etag?.startsWith(`W/"${expected.length.toString(16)}-`));
          assert.equal(yield* response.text, expected);
          assert.isTrue(replaced.has(path.join(staticDir, name)));
          assert.equal(yield* fileSystem.readFileString(path.join(staticDir, name)), replacement);
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: 27e6cc27fe perf(server): cache and stream static web assets (#9669)

    it.effect("closes static file handles after GET, HEAD, 304, and request cancellation", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-close-" });
        const filePath = path.join(staticDir, "app.txt");
        const body = "file content\n".repeat(1024);
        yield* fileSystem.writeFileString(filePath, body);
        const closed = yield* Queue.unbounded<FileSystem.File>();
        const blocked = yield* Deferred.make<void>();
        const active = new Set<FileSystem.File>();
        let blockAfterOpen = false;
        let bodyReads = 0;
        const trackedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (candidate, options) =>
            Effect.gen(function* () {
              if (candidate !== filePath) return yield* fileSystem.open(candidate, options);
              let opened: FileSystem.File | undefined;
              // Registered first, so this signal runs after the real descriptor-close finalizer.
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (opened === undefined) return;
                  active.delete(opened);
                  yield* Queue.offer(closed, opened);
                }),
              );
              const file = yield* fileSystem.open(candidate, options);
              opened = file;
              active.add(file);
              if (blockAfterOpen) {
                yield* Deferred.succeed(blocked, undefined);
                return yield* Effect.never;
              }
              return new Proxy(file, {
                get(target, key) {
                  if (key === "readAlloc") {
                    return (size: number) => {
                      bodyReads += 1;
                      return target.readAlloc(size);
                    };
                  }
                  return Reflect.get(target, key, target);
                },
              });
            }),
        });
        yield* buildAppUnderTest({ config: { staticDir } }).pipe(
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );

        const get = yield* HttpClient.get("/app.txt");
        assert.equal(yield* get.text, body);
        yield* Queue.take(closed);
        assert.equal(active.size, 0);
        assert.isAbove(bodyReads, 0);
        const readsAfterGet = bodyReads;

        const head = yield* HttpClient.head("/app.txt", { headers: { "accept-encoding": "gzip" } });
        assert.equal(head.status, 200);
        assert.equal(head.headers["content-encoding"], "gzip");
        assert.equal(yield* head.text, "");
        yield* Queue.take(closed);
        assert.equal(active.size, 0);
        assert.equal(bodyReads, readsAfterGet);

        const unchanged = yield* HttpClient.get("/app.txt", {
          headers: { "if-none-match": get.headers.etag! },
        });
        assert.equal(unchanged.status, 304);
        yield* Queue.take(closed);
        assert.equal(active.size, 0);
        assert.equal(bodyReads, readsAfterGet);

        blockAfterOpen = true;
        const cancelled = yield* HttpClient.get("/app.txt").pipe(Effect.forkChild);
        yield* Deferred.await(blocked);
        assert.equal(active.size, 1);
        yield* Fiber.interrupt(cancelled);
        yield* Queue.take(closed);
        assert.equal(active.size, 0);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: d8aa2f85df chore: effect rpc and layer based startup (#929)

    it.effect("routes websocket rpc server.upsertKeybinding", () =>
      Effect.gen(function* () {
        const rule: KeybindingRule = {
          command: "terminal.toggle",
          key: "ctrl+k",
        };
        const resolved: ResolvedKeybindingRule = {
          command: "terminal.toggle",
          shortcut: {
            key: "k",
            metaKey: false,
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            modKey: true,
          },
        };

        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              upsertKeybindingRule: () => Effect.succeed({ keybindings: [resolved], issues: [] }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
        );

        assert.deepEqual(response.issues, []);
        assert.deepEqual(response.keybindings, [resolved]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: 0e38870647 Add keybindings settings editor (#2533)

    it.effect("routes websocket rpc server.removeKeybinding", () =>
      Effect.gen(function* () {
        const rule: KeybindingRule = {
          command: "terminal.toggle",
          key: "ctrl+k",
        };
        const resolved: ResolvedKeybindingRule = {
          command: "terminal.toggle",
          shortcut: {
            key: "j",
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            modKey: true,
          },
        };

        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              removeKeybindingRule: () => Effect.succeed({ keybindings: [resolved], issues: [] }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverRemoveKeybinding](rule)),
        );

        assert.deepEqual(response.issues, []);
        assert.deepEqual(response.keybindings, [resolved]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: d8aa2f85df chore: effect rpc and layer based startup (#929)

    it.effect("routes websocket rpc projects.searchEntries", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
        yield* fs.writeFileString(
          path.join(workspaceDir, "needle-file.ts"),
          "export const needle = 1;",
        );

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsSearchEntries]({
              cwd: workspaceDir,
              query: "needle",
              limit: 10,
            }),
          ),
        );

        assert.isAtLeast(response.entries.length, 1);
        assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
        assert.equal(response.truncated, false);
      }).pipe(Effect.provide(NodeHttpServerTest), TestClock.withLive),
    );

    // regression: d8aa2f85df chore: effect rpc and layer based startup (#929)

    it.effect("routes websocket rpc shell.openInEditor", () =>
      Effect.gen(function* () {
        let openedInput: { cwd: string; editor: EditorId } | null = null;
        yield* buildAppUnderTest({
          layers: {
            externalLauncher: {
              launchEditor: (input) =>
                Effect.sync(() => {
                  openedInput = input;
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.shellOpenInEditor]({
              cwd: "/tmp/project",
              editor: "cursor",
            }),
          ),
        );

        assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: d8aa2f85df chore: effect rpc and layer based startup (#929)

    it.effect("routes websocket rpc shell.openInEditor errors", () =>
      Effect.gen(function* () {
        const externalLauncherError = new ExternalLauncherCommandNotFoundError({
          editor: "cursor",
          command: "cursor",
        });
        yield* buildAppUnderTest({
          layers: {
            externalLauncher: {
              launchEditor: () => Effect.fail(externalLauncherError),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.shellOpenInEditor]({
              cwd: "/tmp/project",
              editor: "cursor",
            }),
          ).pipe(Effect.result),
        );

        assertFailure(result, externalLauncherError);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: d8aa2f85df chore: effect rpc and layer based startup (#929)

    it.effect("routes websocket rpc git methods", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: {
            cwd: "/tmp/repo",
          },
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              createWorktree: () =>
                Effect.succeed({
                  worktree: { path: "/tmp/wt", refName: "feature/demo" },
                }),
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.succeed({
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              status: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              runStackedAction: (input, options) =>
                Effect.gen(function* () {
                  const result = {
                    action: "commit" as const,
                    branch: { status: "skipped_not_requested" as const },
                    commit: {
                      status: "created" as const,
                      commitSha: "abc123",
                      subject: "feat: demo",
                    },
                    push: { status: "skipped_not_requested" as const },
                    pr: { status: "skipped_not_requested" as const },
                    toast: {
                      title: "Committed abc123",
                      description: "feat: demo",
                      cta: {
                        kind: "run_action" as const,
                        label: "Push",
                        action: {
                          kind: "push" as const,
                        },
                      },
                    },
                  };

                  yield* (
                    options?.progressReporter?.publish({
                      actionId: options.actionId ?? input.actionId,
                      cwd: input.cwd,
                      action: input.action,
                      kind: "phase_started",
                      phase: "commit",
                      label: "Committing...",
                    }) ?? Effect.void
                  );

                  yield* (
                    options?.progressReporter?.publish({
                      actionId: options.actionId ?? input.actionId,
                      cwd: input.cwd,
                      action: input.action,
                      kind: "action_finished",
                      result,
                    }) ?? Effect.void
                  );

                  return result;
                }),
              resolvePullRequest: () =>
                Effect.succeed({
                  pullRequest: {
                    number: 1,
                    title: "Demo PR",
                    url: "https://example.com/pr/1",
                    baseBranch: "main",
                    headBranch: "feature/demo",
                    state: "open",
                  },
                }),
              preparePullRequestThread: () =>
                Effect.succeed({
                  pullRequest: {
                    number: 1,
                    title: "Demo PR",
                    url: "https://example.com/pr/1",
                    baseBranch: "main",
                    headBranch: "feature/demo",
                    state: "open",
                  },
                  branch: "feature/demo",
                  worktreePath: null,
                  isOnPullRequestHead: true,
                }),
            },
            gitVcsDriver: {
              pullCurrentBranch: () =>
                Effect.succeed({
                  status: "pulled",
                  refName: "main",
                  upstreamRef: "origin/main",
                }),
              listRefs: () =>
                Effect.succeed({
                  refs: [
                    {
                      name: "main",
                      current: true,
                      isDefault: true,
                      worktreePath: null,
                    },
                  ],
                  isRepo: true,
                  hasPrimaryRemote: true,
                  nextCursor: null,
                  totalCount: 1,
                }),
              removeWorktree: () => Effect.void,
              createRef: (input) => Effect.succeed({ refName: input.refName }),
              switchRef: (input) => Effect.succeed({ refName: input.refName }),
            },
            vcsStatusBroadcaster: {
              refreshStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              refreshAfterCheckout: () => Effect.void,
            },
            reviewService: {
              getDiffPreview: (input) =>
                Effect.succeed({
                  cwd: input.cwd,
                  generatedAt: DateTime.nowUnsafe(),
                  sources: [
                    {
                      id: "working-tree",
                      kind: "working-tree",
                      title: "Dirty worktree",
                      baseRef: "HEAD",
                      headRef: null,
                      diff: "dirty-diff",
                      diffHash: "hash-dirty",
                      truncated: false,
                    },
                    {
                      id: "branch-range",
                      kind: "branch-range",
                      title: "Against main",
                      baseRef: "main",
                      headRef: "feature/demo",
                      diff: "base-diff",
                      diffHash: "hash-base",
                      truncated: false,
                    },
                  ],
                }),
              getDiffFileContents: () =>
                Effect.succeed({
                  oldContents: "before\n",
                  newContents: "after\n",
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");

        const pull = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
        );
        assert.equal(pull.status, "pulled");

        const refreshedStatus = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.vcsRefreshStatus]({ cwd: "/tmp/repo" }),
          ),
        );
        assert.equal(refreshedStatus.isRepo, true);

        const stackedEvents = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(
              Stream.runCollect,
              Effect.map((events) => Array.from(events)),
            ),
          ),
        );
        const lastStackedEvent = stackedEvents.at(-1);
        assert.equal(lastStackedEvent?.kind, "action_finished");
        if (lastStackedEvent?.kind === "action_finished") {
          assert.equal(lastStackedEvent.result.action, "commit");
        }

        const resolvedPr = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitResolvePullRequest]({
              cwd: "/tmp/repo",
              reference: "1",
            }),
          ),
        );
        assert.equal(resolvedPr.pullRequest.number, 1);

        const prepared = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitPreparePullRequestThread]({
              cwd: "/tmp/repo",
              reference: "1",
              mode: "local",
            }),
          ),
        );
        assert.equal(prepared.branch, "feature/demo");

        const refs = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsListRefs]({ cwd: "/tmp/repo" })),
        );
        assert.equal(refs.refs[0]?.name, "main");

        const worktree = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.vcsCreateWorktree]({
              cwd: "/tmp/repo",
              refName: "main",
              path: null,
            }),
          ),
        );
        assert.equal(worktree.worktree.refName, "feature/demo");

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.vcsRemoveWorktree]({
              cwd: "/tmp/repo",
              path: "/tmp/wt",
            }),
          ),
        );

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.vcsCreateRef]({
              cwd: "/tmp/repo",
              refName: "feature/new",
            }),
          ),
        );

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.vcsSwitchRef]({
              cwd: "/tmp/repo",
              refName: "main",
            }),
          ),
        );

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.vcsInit]({
              cwd: "/tmp/repo",
            }),
          ),
        );

        const diffPreview = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.reviewGetDiffPreview]({ cwd: "/tmp/repo" }),
          ),
        );
        assert.equal(diffPreview.sources[0]?.diff, "dirty-diff");

        const diffFileContents = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.reviewGetDiffFileContents]({
              cwd: "/tmp/repo",
              sourceKind: "working-tree",
              changeType: "change",
              baseRef: "HEAD",
              headRef: null,
              oldPath: "README.md",
              newPath: "README.md",
            }),
          ),
        );
        assert.equal(diffFileContents.oldContents, "before\n");
        assert.equal(diffFileContents.newContents, "after\n");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: d8aa2f85df chore: effect rpc and layer based startup (#929)

    it.effect("routes websocket rpc terminal methods", () =>
      Effect.gen(function* () {
        const snapshot = {
          threadId: "thread-1",
          terminalId: "default",
          cwd: "/tmp/project",
          worktreePath: null,
          status: "running" as const,
          pid: 1234,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Primary",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };

        yield* buildAppUnderTest({
          layers: {
            terminalManager: {
              open: () => Effect.succeed(snapshot),
              write: () => Effect.void,
              resize: () => Effect.void,
              clear: () => Effect.void,
              close: () => Effect.void,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");

        const opened = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.terminalOpen]({
              threadId: "thread-1",
              terminalId: "default",
              cwd: "/tmp/project",
            }),
          ),
        );
        assert.equal(opened.terminalId, "default");

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.terminalWrite]({
              threadId: "thread-1",
              terminalId: "default",
              data: "echo hi\n",
            }),
          ),
        );

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.terminalResize]({
              threadId: "thread-1",
              terminalId: "default",
              cols: 120,
              rows: 40,
            }),
          ),
        );

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.terminalClear]({
              threadId: "thread-1",
              terminalId: "default",
            }),
          ),
        );

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.terminalClose]({
              threadId: "thread-1",
              terminalId: "default",
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // regression: d8aa2f85df chore: effect rpc and layer based startup (#929)

    it.effect("routes websocket rpc terminal.write errors", () =>
      Effect.gen(function* () {
        const terminalError = new TerminalNotRunningError({
          threadId: "thread-1",
          terminalId: "default",
        });
        yield* buildAppUnderTest({
          layers: {
            terminalManager: {
              write: () => Effect.fail(terminalError),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.terminalWrite]({
              threadId: "thread-1",
              terminalId: "default",
              data: "echo fail\n",
            }),
          ).pipe(Effect.result),
        );

        assertFailure(result, terminalError);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );
  },
);

it.live("reports thread HTTP and WebSocket transfer budgets", () =>
  Effect.gen(function* () {
    const providers = [
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("claudeAgent"),
    ] as const;

    const runs = yield* Effect.forEach(
      providers,
      (provider) => {
        // Runtime writes and HTTP/WS subscription reads share one traced database.
        const sqlCounter = makeSqlStatementCounter();
        return Effect.scoped(
          Effect.gen(function* () {
            const app = yield* buildAppUnderTest();
            yield* seedTransferBudgetHistory(app.v2.eventSink, provider);

            const baseUrl = yield* getHttpServerUrl();
            const cookie = yield* getAuthenticatedSessionCookieHeader(
              yield* getPairedClientCredential,
            );
            const wsUrl =
              baseUrl.replace(/^http:/, "ws:") +
              `/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`;

            return yield* Effect.scoped(
              Effect.gen(function* () {
                const threadSnapshot = yield* measureHttpGet({
                  url: `${baseUrl}/api/orchestration/threads/${TRANSFER_THREAD_ID}/bounded?compactTurnItems=1&dedupeBodies=1&compactIds=1`,
                  headers: {
                    cookie,
                    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                  },
                });
                yield* Effect.logInfo(
                  "Synthetic bounded transfer attribution",
                  provider,
                  encodeTestJson(attributeSnapshotTransfer(threadSnapshot)),
                );
                assert.equal(threadSnapshot.status, 200);
                assert.equal(threadSnapshot.contentEncoding, "gzip");
                const decodedThread = yield* decodeTransferThreadSnapshot(
                  Buffer.from(threadSnapshot.decodedBody).toString("utf8"),
                );
                assert.equal(
                  decodedThread.projection.messages.length,
                  THREAD_HISTORY_PAGE_POLICY.maxUserTurns * 2,
                );
                assert.equal(
                  decodedThread.hasMoreHistory,
                  TRANSFER_HISTORY_TURN_COUNT > THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
                );
                let historyCursor = decodedThread.historyCursor;
                const historyItems = [...decodedThread.projection.visibleTurnItems];
                const seenCursors = new Set<string>();
                // Startup matches the shared bounded HTTP loader. Older pages are
                // explicitly requested and must reconstruct the complete persisted history.
                while (historyCursor !== null) {
                  assert.isFalse(seenCursors.has(historyCursor), "history cursor must advance");
                  seenCursors.add(historyCursor);
                  const response = yield* measureHttpGet({
                    url: `${baseUrl}/api/orchestration/threads/${TRANSFER_THREAD_ID}/history?cursor=${encodeURIComponent(historyCursor)}`,
                    headers: {
                      cookie,
                      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                    },
                  });
                  assert.equal(response.status, 200);
                  const page = yield* decodeTransferHistoryPage(
                    Buffer.from(response.decodedBody).toString("utf8"),
                  );
                  assert.equal(page.snapshotSequence, decodedThread.snapshotSequence);
                  assert.isAbove(page.items.length, 0);
                  historyItems.unshift(...page.items);
                  assert.equal(page.hasMoreHistory, page.nextCursor !== null);
                  historyCursor = page.nextCursor;
                }
                assert.equal(
                  historyItems.filter((row) => row.item.type === "user_message").length,
                  TRANSFER_HISTORY_TURN_COUNT,
                );
                assert.equal(
                  historyItems.filter((row) => row.item.type === "assistant_message").length,
                  TRANSFER_HISTORY_TURN_COUNT,
                );
                assert.equal(
                  historyItems.filter((row) => row.item.type === "dynamic_tool").length,
                  TRANSFER_HISTORY_TURN_COUNT,
                );
                assert.equal(
                  new Set(historyItems.map((row) => row.sourceItemId)).size,
                  historyItems.length,
                );
                const persistedHistory =
                  yield* app.v2.threads.getThreadProjection(TRANSFER_THREAD_ID);
                assert.deepEqual(
                  historyItems.map((row) => row.sourceItemId),
                  persistedHistory.visibleTurnItems.map((row) => row.sourceItemId),
                );
                const shellSnapshot = yield* measureHttpGet({
                  url: `${baseUrl}/api/orchestration/shell`,
                  headers: {
                    cookie,
                    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                  },
                });
                assert.equal(shellSnapshot.status, 200);
                const decodedShell = yield* decodeTransferShellSnapshot(
                  Buffer.from(shellSnapshot.decodedBody).toString("utf8"),
                );
                assert.equal(decodedShell.threads.length, 1);

                // Three sockets, the way real installs look: the capped
                // thread-only client, a shell-only socket that isolates the
                // sidebar cost, and a second device holding both.
                const threadClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                const shellClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                const secondClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                assert.include(threadClient.recorder.negotiatedExtensions(), "permessage-deflate");

                const threadItems = yield* subscribeThreadItems(
                  threadClient,
                  decodedThread.snapshotSequence,
                );
                const shellItems = yield* subscribeShellItems(
                  shellClient,
                  decodedShell.snapshotSequence,
                );
                const secondThreadItems = yield* subscribeThreadItems(
                  secondClient,
                  decodedThread.snapshotSequence,
                );
                const secondShellItems = yield* subscribeShellItems(
                  secondClient,
                  decodedShell.snapshotSequence,
                );
                assert.equal(
                  yield* awaitSubscriptionSynchronized(
                    threadItems,
                    `${provider} thread subscription to synchronize`,
                  ),
                  "replay",
                );
                assert.equal(
                  yield* awaitSubscriptionSynchronized(
                    shellItems,
                    `${provider} shell subscription to synchronize`,
                  ),
                  "replay",
                );
                assert.equal(
                  yield* awaitSubscriptionSynchronized(
                    secondThreadItems,
                    `${provider} second client thread subscription to synchronize`,
                  ),
                  "replay",
                );
                assert.equal(
                  yield* awaitSubscriptionSynchronized(
                    secondShellItems,
                    `${provider} second client shell subscription to synchronize`,
                  ),
                  "replay",
                );

                const turnStartTotals = threadClient.recorder.totals();
                const shellTurnStartTotals = shellClient.recorder.totals();
                const secondTurnStartTotals = secondClient.recorder.totals();
                const turnStartSqlStatements = sqlCounter.count();
                const committed = yield* commitMeasuredTransferTurn(app.v2.eventSink, provider);
                const finalThreadSequence = committed.at(-1)!.sequence;
                assert.isAbove(finalThreadSequence, decodedThread.snapshotSequence);

                const reachedFinalThreadEvent = (item: OrchestrationV2ThreadStreamItem) =>
                  item.kind === "event" && item.sequence === finalThreadSequence;
                // Shell projection can read the final state at an earlier cursor;
                // skipUnchangedThreadShells then suppresses its later duplicate.
                const reachedFinalShellEvent = (item: OrchestrationV2ShellStreamItem) =>
                  isMeasuredTransferShellUpdate(item, provider, decodedShell.snapshotSequence);
                yield* collectQueueUntil(
                  threadItems,
                  reachedFinalThreadEvent,
                  `${provider} thread stream to reach sequence ${finalThreadSequence}`,
                );
                yield* collectQueueUntil(
                  secondThreadItems,
                  reachedFinalThreadEvent,
                  `${provider} second client thread stream to reach sequence ${finalThreadSequence}`,
                );
                const shellUpdates = yield* collectQueueUntil(
                  shellItems,
                  reachedFinalShellEvent,
                  `${provider} shell stream to show the completed measured turn`,
                );
                const secondShellUpdates = yield* collectQueueUntil(
                  secondShellItems,
                  reachedFinalShellEvent,
                  `${provider} second client shell stream to show the completed measured turn`,
                );
                const measuredTurnWebSocket = transferDelta(
                  turnStartTotals,
                  threadClient.recorder.totals(),
                );
                const measuredTurnShellWebSocket = transferDelta(
                  shellTurnStartTotals,
                  shellClient.recorder.totals(),
                );
                const measuredTurnSecondClientWebSocket = transferDelta(
                  secondTurnStartTotals,
                  secondClient.recorder.totals(),
                );
                const measuredTurnSqlStatements = sqlCounter.count() - turnStartSqlStatements;

                // Read the oracle outside both measured SQL intervals. Both sockets
                // must carry the complete canonical shell, not just a completion flag.
                const expectedShell = yield* app.v2.threads.getThreadShell(TRANSFER_THREAD_ID);
                assert.isNotNull(expectedShell);
                for (const update of [shellUpdates.at(-1), secondShellUpdates.at(-1)]) {
                  assertTrue(
                    update !== undefined &&
                      isMeasuredTransferShellUpdate(
                        update,
                        provider,
                        decodedShell.snapshotSequence,
                      ),
                  );
                  assert.deepEqual(update.thread, expectedShell);
                }

                // The second device drops and comes back with the cursors it
                // held before the turn, one subscription at a time so the
                // catch-up bytes stay separable.
                yield* secondClient.close;
                const reconnectSqlStart = sqlCounter.count();
                const reconnected = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                const reconnectStartTotals = reconnected.recorder.totals();
                const reconnectThreadItems = yield* subscribeThreadItems(
                  reconnected,
                  decodedThread.snapshotSequence,
                );
                const reconnectThreadMode = yield* awaitSubscriptionSynchronized(
                  reconnectThreadItems,
                  `${provider} reconnected thread subscription to synchronize`,
                );
                const reconnectThreadTotals = reconnected.recorder.totals();
                const reconnectShellItems = yield* subscribeShellItems(
                  reconnected,
                  decodedShell.snapshotSequence,
                );
                const reconnectShellMode = yield* awaitSubscriptionSynchronized(
                  reconnectShellItems,
                  `${provider} reconnected shell subscription to synchronize`,
                );
                const reconnectShellTotals = reconnected.recorder.totals();
                const reconnectSqlStatements = sqlCounter.count() - reconnectSqlStart;

                const finalThreadSnapshot =
                  yield* app.v2.threads.getThreadProjection(TRANSFER_THREAD_ID);
                const expectedAssistantText = expectedMeasuredAssistantText(provider);
                const measuredAssistant = finalThreadSnapshot.messages.find(
                  (message) =>
                    message.role === "assistant" && message.text === expectedAssistantText,
                );
                assert.isDefined(measuredAssistant);
                assert.equal(
                  finalThreadSnapshot.messages.length,
                  (TRANSFER_HISTORY_TURN_COUNT + 1) * 2,
                );
                assert.equal(measuredAssistant?.streaming, false);
                assert.equal(finalThreadSnapshot.runs.length, TRANSFER_HISTORY_TURN_COUNT + 1);
                assert.isTrue(finalThreadSnapshot.runs.every((run) => run.status === "completed"));
                assert.equal(
                  finalThreadSnapshot.turnItems.filter((item) => item.type === "dynamic_tool")
                    .length,
                  TRANSFER_HISTORY_TURN_COUNT + 1,
                );

                const getTransferPath = (path: string) =>
                  measureHttpGet({
                    url: `${baseUrl}${path}`,
                    headers: {
                      cookie,
                      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                    },
                  }).pipe(Effect.tap((http) => Effect.sync(() => assert.equal(http.status, 200))));
                const longTurnPath = `/api/orchestration/threads/${TRANSFER_V2_LONG_TURN_THREAD_ID}`;
                const readLongTurnColdOpen = (query: string) =>
                  Effect.gen(function* () {
                    const http = yield* getTransferPath(`${longTurnPath}/bounded?${query}`);
                    const snapshot = yield* decodeTransferThreadSnapshot(
                      Buffer.from(http.decodedBody).toString("utf8"),
                    );
                    const rows = snapshot.projection.visibleTurnItems;
                    const workAnchor = rows.find((row) => row.item.deferredWork !== undefined);
                    return {
                      http,
                      rows: rows.length,
                      cursor: snapshot.historyCursor,
                      workAnchor,
                    };
                  });
                const readLongTurnHistoryPage = (historyCursor: string, query: string) =>
                  Effect.gen(function* () {
                    const http = yield* getTransferPath(
                      `${longTurnPath}/history?cursor=${encodeURIComponent(historyCursor)}&${query}`,
                    );
                    const page = yield* decodeTransferHistoryPage(
                      Buffer.from(http.decodedBody).toString("utf8"),
                    );
                    assert.isTrue(page.hasMoreHistory);
                    return { http, rows: page.items.length };
                  });
                const readFleetShell = (query: string) =>
                  Effect.gen(function* () {
                    const http = yield* getTransferPath(`/api/orchestration/shell?${query}`);
                    const { threads, snapshotSequence, projectIdentities } =
                      yield* decodeTransferShellHttpSnapshot(
                        Buffer.from(http.decodedBody).toString("utf8"),
                      );
                    return { http, rows: threads.length, snapshotSequence, projectIdentities };
                  });
                // A new socket, read until the subscription caught up or the server ended it.
                const openTransferSubscription = (subscription: TransferSubscription) =>
                  Effect.gen(function* () {
                    const socket = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                    const items = yield* transferSubscriptionStream(socket, subscription).pipe(
                      Stream.takeUntil((item) => item.kind === "synchronized"),
                      Stream.runCollect,
                      Scope.provide(socket.scope),
                      Effect.orDie,
                    );
                    const totals = socket.recorder.totals();
                    yield* socket.close;
                    return { kinds: items.map((item) => item.kind), items, totals };
                  });

                // A phone that comes back after one ordinary turn replays it, without tool bodies.
                const shortTurn = yield* app.v2.eventSink.write({
                  events: transferV2TurnEvents(provider, TRANSFER_HISTORY_TURN_COUNT + 1, false),
                });
                const shortTurnResume = yield* openTransferSubscription({
                  thread: TRANSFER_THREAD_ID,
                  afterSequence: finalThreadSequence,
                });
                assert.notInclude(shortTurnResume.kinds, "snapshot");
                // The byte cap below also passes when the resume skips the turn.
                assert.isTrue(
                  shortTurnResume.items.some(
                    (item) => "sequence" in item && item.sequence === shortTurn.at(-1)!.sequence,
                  ),
                );

                // A long agent turn that is still running cannot defer its work, so it loads in
                // row-budget windows (553203c57b).
                const [finishLongTurn, ...longTurnHistory] =
                  transferV2LongTurnThreadBatches(provider).toReversed();
                for (const events of longTurnHistory.toReversed())
                  yield* app.v2.eventSink.write({ events });
                const longTurnRunningColdOpenLegacy =
                  yield* readLongTurnColdOpen("compactTurnItems=1");
                const longTurnRunningColdOpen = yield* readLongTurnColdOpen(
                  TRANSFER_CLIENT_BOUNDED_QUERY,
                );
                const longTurnCursor = longTurnRunningColdOpen.cursor;
                if (longTurnCursor === null)
                  return yield* Effect.die("Expected older long-turn history");
                const longTurnRunningHistoryPageLegacy = yield* readLongTurnHistoryPage(
                  longTurnCursor,
                  "",
                );
                const longTurnRunningHistoryPage = yield* readLongTurnHistoryPage(
                  longTurnCursor,
                  TRANSFER_CLIENT_HISTORY_QUERY,
                );

                // Once it finishes, its work stays on the server until a group is expanded.
                yield* app.v2.eventSink.write({ events: finishLongTurn! });
                const longTurnColdOpen = yield* readLongTurnColdOpen(TRANSFER_CLIENT_BOUNDED_QUERY);
                const { workAnchor } = longTurnColdOpen;
                if (workAnchor?.item.deferredWork === undefined)
                  return yield* Effect.die("Expected the finished long turn to defer its work");
                const longTurnWorkPage = yield* readLongTurnHistoryPage(
                  workAnchor.item.deferredWork.cursor,
                  `view=work&throughEntryId=${encodeURIComponent(workAnchor.sourceItemId)}&compactIds=1`,
                );
                // Mobile opens a thread over the socket alone.
                const socketOpen = yield* openTransferSubscription({
                  thread: TRANSFER_V2_LONG_TURN_THREAD_ID,
                });
                const socketSnapshot = socketOpen.items.find(
                  (item) => item.kind === "snapshot" && "projection" in item,
                );
                if (socketSnapshot?.kind !== "snapshot" || !("projection" in socketSnapshot))
                  return yield* Effect.die("Expected a bounded socket snapshot");
                const longTurnSocketColdOpen = {
                  ...socketOpen,
                  rows: socketSnapshot.projection.visibleTurnItems.length,
                };
                // The row cap below also passes when the socket ignores the deferral and sends a window.
                assert.equal(longTurnSocketColdOpen.rows, longTurnColdOpen.rows);
                const idleThreadResume = yield* openTransferSubscription({
                  thread: TRANSFER_V2_LONG_TURN_THREAD_ID,
                  afterSequence: socketSnapshot.snapshotSequence,
                });
                assert.deepEqual(idleThreadResume.kinds, ["synchronized"]);

                // The transfer thread plus the long-turn thread.
                const earlierThreads = decodedShell.threads.length + 1;
                // Unlike integration/transferBudgetV2, the fleet has no project record. This app
                // resolves identities for real, the fleet's folder is no repository, and a resume
                // resends a root without an identity. That test covers the identity resend.
                yield* app.v2.eventSink.write({ events: transferV2ShellFleetEvents(provider) });
                const fleetShellLegacy = yield* readFleetShell("");
                const fleetShell = yield* readFleetShell(TRANSFER_CLIENT_SHELL_QUERY);
                assert.equal(
                  fleetShellLegacy.rows,
                  earlierThreads +
                    TRANSFER_V2_SHELL_SETTLED_THREADS +
                    TRANSFER_V2_SHELL_IDLE_SUBAGENTS,
                );
                const { projectIdentities } = fleetShell;
                if (projectIdentities === undefined)
                  return yield* Effect.die(
                    "Expected the shell snapshot to name its project identities",
                  );
                // A cold connect subscribes from the snapshot it just loaded and names its
                // identities. Without them the resume sends the project again, in a marked snapshot.
                const fleetShellSubscribe = yield* openTransferSubscription({
                  shell: true,
                  afterSequence: fleetShell.snapshotSequence,
                  knownProjectIdentities: projectIdentities,
                });
                assert.notInclude(fleetShellSubscribe.kinds, "snapshot");
                // A client that holds those rows asks the route whether they still resume.
                const fleetShellResumeHttp = yield* getTransferPath(
                  `/api/orchestration/shell?${transferClientShellResumeQuery(fleetShell.snapshotSequence)}`,
                );
                yield* decodeTransferShellResumable(
                  Buffer.from(fleetShellResumeHttp.decodedBody).toString("utf8"),
                );
                const fleetShellResume = { http: fleetShellResumeHttp, rows: 0 };
                // A cursor too old to replay gets the snapshot in the same answer.
                const staleShellReload = yield* readFleetShell(
                  transferClientShellResumeQuery(decodedShell.snapshotSequence),
                );
                assert.equal(staleShellReload.rows, fleetShell.rows);
                // When that request fails, the socket tells the client to reload, with no snapshot.
                const staleShellResume = yield* openTransferSubscription({
                  shell: true,
                  afterSequence: decodedShell.snapshotSequence,
                  httpSnapshotFallback: true,
                });
                assert.deepEqual(staleShellResume.kinds, ["snapshot-required"]);

                for (const events of transferV2StaleTodoListThreadBatches(provider)) {
                  yield* app.v2.eventSink.write({ events });
                }
                const staleTodoHttp = yield* getTransferPath(
                  `/api/orchestration/threads/${TRANSFER_V2_STALE_TODO_THREAD_ID}/bounded?${TRANSFER_CLIENT_BOUNDED_QUERY}`,
                );
                const staleTodo = (yield* decodeTransferThreadSnapshot(
                  Buffer.from(staleTodoHttp.decodedBody).toString("utf8"),
                )).projection;
                // Clients show the diff of the last finished turn from this record.
                assert.include(
                  staleTodo.checkpoints.map((checkpoint) => checkpoint.id),
                  TRANSFER_V2_STALE_TODO_LAST_FINISHED_CHECKPOINT_ID,
                );
                // The caps below also pass when the running turn loses its own tasks.
                assert.lengthOf(
                  staleTodo.subagents.filter(
                    (subagent) => subagent.runId === TRANSFER_V2_STALE_TODO_LIVE_RUN_ID,
                  ),
                  TRANSFER_V2_STALE_TODO_SUBAGENTS_PER_RUN,
                );
                // The byte cap below also passes when the window loses the handoff.
                assert.lengthOf(staleTodo.contextHandoffs, 1);
                const staleTodoColdOpen = {
                  http: staleTodoHttp,
                  rows: staleTodo.visibleTurnItems.length,
                  records: {
                    nodes: staleTodo.nodes.length,
                    subagents: staleTodo.subagents.length,
                    plans: staleTodo.plans.length,
                    providerTurns: staleTodo.providerTurns.length,
                    checkpoints: staleTodo.checkpoints.length,
                  },
                };

                return {
                  provider,
                  startupTransport: "bounded-compact-http-with-live-cursor",
                  threadSnapshot,
                  measuredTurnWebSocket,
                  shellSnapshot,
                  measuredTurnShellWebSocket,
                  measuredTurnSecondClientWebSocket,
                  reconnectThread: {
                    mode: reconnectThreadMode,
                    ...transferDelta(reconnectStartTotals, reconnectThreadTotals),
                  },
                  reconnectShell: {
                    mode: reconnectShellMode,
                    ...transferDelta(reconnectThreadTotals, reconnectShellTotals),
                  },
                  measuredTurnSqlStatements,
                  reconnectSqlStatements,
                  shortTurnResume,
                  longTurnRunningColdOpenLegacy,
                  longTurnRunningColdOpen,
                  longTurnRunningHistoryPageLegacy,
                  longTurnRunningHistoryPage,
                  longTurnColdOpen,
                  longTurnWorkPage,
                  longTurnSocketColdOpen,
                  idleThreadResume,
                  fleetShellLegacy,
                  fleetShell,
                  fleetShellSubscribe,
                  fleetShellResume,
                  staleShellReload,
                  staleShellResume,
                  staleTodoColdOpen,
                } satisfies TransferBudgetRun;
              }),
            );
          }),
        ).pipe(
          Effect.provideService(Tracer.Tracer, sqlCounter.tracer),
          Effect.provide(NodeHttpServerTestWithWsDeflate),
        );
      },
      { concurrency: 1 },
    );

    const report = formatTransferBudgetReport(runs);
    yield* Effect.logInfo(`\n${report}`);
    const reportPath = yield* Config.String("T3CODE_BOUNDED_TRANSFER_BUDGET_REPORT_PATH").pipe(
      Config.option,
    );
    if (Option.isSome(reportPath)) {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(reportPath.value, report);
    }
    const resultPath = yield* Config.String("T3CODE_BOUNDED_TRANSFER_BUDGET_RESULT_PATH").pipe(
      Config.option,
    );
    if (Option.isSome(resultPath)) {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(resultPath.value, formatTransferBudgetResult(runs));
    }
    assert.deepEqual(transferBudgetViolations(runs), []);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))),
);
