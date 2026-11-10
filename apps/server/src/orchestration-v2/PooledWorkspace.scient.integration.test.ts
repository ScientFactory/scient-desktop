import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { awaitThreadProjection } from "./testkit/awaitThreadProjection.testkit.ts";
import {
  emptyState,
  makeProviderAdapter,
  makeProviderThread,
  modelSelection,
  runtimePolicy,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

it.effect(
  "completes a second turn in a pooled thread whose workspace differs from the process cwd",
  () =>
    Effect.gen(function* () {
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const state = yield* Ref.make(emptyState);
      const workspace = yield* checkpointWorkspace("pooled-second-turn");
      const openingWorkspace = `${workspace}/opening-thread`;
      yield* (yield* FileSystem.FileSystem).makeDirectory(openingWorkspace);
      const registry = Layer.effect(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        Effect.gen(function* () {
          const delegate = yield* makeProviderAdapter(state);
          return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            get: () =>
              Effect.succeed({
                ...delegate,
                openSession: Effect.fn("PooledFixture.openSession")(function* (input) {
                  const runtime = yield* delegate.openSession(input);
                  return {
                    ...runtime,
                    ensureThread: Effect.fn("PooledFixture.ensureThread")(function* (request) {
                      return makeProviderThread({
                        idAllocator: allocator,
                        threadId: request.threadId,
                        providerSessionId: input.providerSessionId,
                        now: yield* DateTime.now,
                        nativeThreadId: `native-${request.threadId}`,
                      });
                    }),
                    startTurn: Effect.fn("PooledFixture.startTurn")(function* (request) {
                      const events = (yield* Ref.get(state)).eventQueues.get(
                        String(input.providerSessionId),
                      )!;
                      const now = yield* DateTime.now;
                      const providerTurnId = allocator.derive.providerTurn({
                        driver: runtime.driver,
                        nativeTurnId: String(request.runId),
                      });
                      yield* Queue.offer(events, {
                        type: "provider_turn.updated",
                        driver: runtime.driver,
                        providerTurn: {
                          id: providerTurnId,
                          providerThreadId: request.providerThread.id,
                          nodeId: request.rootNodeId,
                          runAttemptId: request.attemptId,
                          nativeTurnRef: {
                            driver: runtime.driver,
                            nativeId: String(request.runId),
                            strength: "strong",
                          },
                          ordinal: request.providerTurnOrdinal,
                          status: "completed",
                          startedAt: now,
                          completedAt: now,
                        },
                      });
                      yield* Queue.offer(events, {
                        type: "turn.terminal",
                        driver: runtime.driver,
                        providerThreadId: request.providerThread.id,
                        providerTurnId,
                        status: "completed",
                        runOrdinal: request.runOrdinal,
                        failure: null,
                        threadDisposition: "reusable",
                      });
                    }),
                  };
                }),
              }),
            list: () => Effect.succeed([delegate.instanceId]),
          });
        }),
      );
      const layer = layerWithRegistry(
        { name: "pooled-second-turn", runtimePolicyOverride: { cwd: workspace } },
        registry,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectId = ProjectId.make("pooled-project");
        const threadId = ThreadId.make("pooled-conversation");
        const openingThreadId = ThreadId.make("opening-conversation");
        const now = yield* DateTime.now;
        const timestamp = DateTime.formatIso(now);
        yield* (yield* EventStore.EventStoreV2).appendProjectEvent({
          eventId: EventId.make("pooled-project-created"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: timestamp,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Pooled project",
            workspaceRoot: workspace,
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        });
        for (const id of [openingThreadId, threadId])
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${id}`),
            threadId: id,
            projectId,
            title: String(id),
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        const sessionId = allocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* manager.open({
          threadId: openingThreadId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, cwd: openingWorkspace },
        });
        for (const ordinal of [1, 2]) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send:${ordinal}`),
            threadId,
            messageId: MessageId.make(`message:${ordinal}`),
            text: `Turn ${ordinal}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const projection = yield* awaitThreadProjection(
            threadId,
            (p) => p.runs.find((run) => run.ordinal === ordinal)?.status === "completed",
          );
          assert.equal(
            projection.providerThreads.find(
              (thread) => thread.id === projection.thread.activeProviderThreadId,
            )?.providerSessionId,
            sessionId,
          );
        }
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer)), Effect.scoped),
);
