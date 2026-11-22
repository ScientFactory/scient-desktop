import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

// regression: task_cancel holds the child's lock while it stops the child's own
// delegated tasks, and Stop on one of those took that same lock as its parent's.
it.effect("task_cancel stops a task that delegated its own task", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("task-cancel-local-descendant");
    const turns: Array<{
      readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
      readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
    }> = [];
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const providerTurn = (
            turn: ProviderAdapter.ProviderAdapterV2TurnInput,
            status: "running" | "interrupted",
          ) => ({
            id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
            providerThreadId: turn.providerThread.id,
            nodeId: turn.rootNodeId,
            runAttemptId: turn.attemptId,
            nativeTurnRef: null,
            ordinal: turn.providerTurnOrdinal,
            status,
            startedAt: now,
            completedAt: status === "running" ? null : now,
          });
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities: ClaudeProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.sync(() => turns.push({ turn, events })).pipe(
                Effect.andThen(
                  Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: providerTurn(turn, "running"),
                  }),
                ),
              ),
            steerTurn: () => Effect.die("unused"),
            // Like a provider, an interrupted turn ends.
            interruptTurn: ({ providerTurnId }) =>
              Effect.forEach(
                turns.filter((entry) => providerTurn(entry.turn, "running").id === providerTurnId),
                ({ turn, events: turnEvents }) =>
                  Queue.offerAll(turnEvents, [
                    {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: providerTurn(turn, "interrupted"),
                    },
                    {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status: "interrupted",
                      failure: null,
                      threadDisposition: "reusable",
                    },
                  ]),
                { discard: true },
              ),
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
    const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
      { name: "task-cancel-local-descendant" },
      layerAdapters,
      { runEffectWorker: false },
    );
    const layerOrchestration = Layer.merge(
      layerOrchestrator,
      ThreadManagementService.layer.pipe(
        Layer.provide(layerOrchestrator),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
    );
    const layerTest = OrchestratorMcpService.layer.pipe(
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provideMerge(layerOrchestration),
      Layer.provide(
        Layer.mergeAll(
          layerAdapters,
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          ServerSettings.layerTest(),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const eventSink = yield* EventSink.EventSinkV2;
      const parentThreadId = ThreadId.make("thread:task-cancel-descendant-parent");
      const turnRunning = () =>
        eventSink.latestSequence().pipe(
          Effect.flatMap((afterSequence) =>
            eventSink.stream({ afterSequence }).pipe(
              Stream.map((stored) => stored.event),
              Stream.filter(
                (event: OrchestrationV2DomainEvent) =>
                  event.type === "provider-turn.updated" && event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            ),
          ),
        );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-parent"),
        threadId: parentThreadId,
        projectId: ProjectId.make("project:task-cancel-descendant"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const parentRunning = yield* turnRunning();
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-parent"),
        threadId: parentThreadId,
        messageId: MessageId.make("message:start-parent"),
        text: "Delegate a build",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(parentRunning);

      // The parent delegates a task, and that task delegates one of its own.
      const delegate = (
        id: string,
        parentThread: ThreadId,
        parentRun: { readonly id: RunId; readonly rootNodeId: NodeId },
      ) =>
        Effect.gen(function* () {
          const running = yield* turnRunning();
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make(`delegate-${id}`),
            parentThreadId: parentThread,
            parentRunId: parentRun.id,
            parentNodeId: parentRun.rootNodeId,
            task: `Work on ${id}`,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          return (yield* orchestrator.getThreadProjection(parentThread)).subagents[0]!;
        });
      const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
      const task = yield* delegate("child", parentThreadId, {
        id: parentRun.id,
        rootNodeId: parentRun.rootNodeId!,
      });
      const child = turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
      const descendant = yield* delegate("descendant", task.childThreadId!, {
        id: child.turn.runId,
        rootNodeId: child.turn.rootNodeId,
      });

      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:task-cancel-descendant"),
        requestNamespace: "provider-session:task-cancel-descendant",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:task-cancel-descendant",
          providerInstanceId: instanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const cancelled = yield* service.cancelTask(scope, {
        taskId: task.id,
        clientRequestId: "cancel-task",
      });
      yield* worker.drain();
      assert.equal(cancelled.status, "cancel_requested");
      const descendantRuns = (yield* orchestrator.getThreadProjection(descendant.childThreadId!))
        .runs;
      assert.deepEqual(
        descendantRuns.map((run) => run.status),
        ["interrupted"],
      );
    }).pipe(Effect.provide(layerTest));
  }),
);
