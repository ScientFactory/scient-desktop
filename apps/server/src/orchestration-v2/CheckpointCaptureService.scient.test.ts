import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerProjectionStoreTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
  NodeCrypto.layer,
);

const projectId = ProjectId.make("project:changes-known");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" } as const;

it.layer(layerProjectionStoreTest)("CheckpointCaptureServiceV2 change evidence", (it) => {
  it.effect.each([
    { repositories: "listed", changesKnown: true },
    { repositories: "unreadable", changesKnown: undefined },
  ] as const)(
    "a run's changes stay unknown when its repositories could not be listed ($repositories)",
    ({ repositories, changesKnown }) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:changes-known:${repositories}`);
        const runId = RunId.make(`run:changes-known:${repositories}`);
        const scopeId = CheckpointScopeId.make(`scope:changes-known:${repositories}`);
        const rootNodeId = NodeId.make(`node:changes-known:${repositories}`);
        const providerThreadId = ProviderThreadId.make(
          `provider-thread:changes-known:${repositories}`,
        );
        const event = (name: string) => EventId.make(`event:changes-known:${repositories}:${name}`);
        yield* projectionStore.apply({
          id: event("thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: "Change evidence",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* projectionStore.apply({
          id: event("provider-thread"),
          type: "provider-thread.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projectionStore.apply({
          id: event("scope"),
          type: "checkpoint-scope.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId,
            nodeId: rootNodeId,
            parentScopeId: null,
            providerThreadId,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/project",
            createdAt: now,
          },
        });
        const checkpoint = (ordinal: number): OrchestrationV2Checkpoint => ({
          id: CheckpointId.make(`checkpoint:changes-known:${repositories}:${ordinal}`),
          threadId,
          scopeId,
          runId: ordinal === 0 ? null : runId,
          nodeId: rootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: ordinal,
          appRunOrdinal: ordinal === 0 ? null : ordinal,
          ref: CheckpointRef.make(`checkpoint-ref:changes-known:${repositories}:${ordinal}`),
          status: "ready",
          files: [],
          capturedAt: now,
        });
        yield* projectionStore.apply({
          id: event("baseline"),
          type: "checkpoint.captured",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: checkpoint(0),
        });
        yield* projectionStore.apply({
          id: event("run"),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:changes-known:${repositories}`),
            rootNodeId,
            activeAttemptId: null,
            status: "cancelled",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: event("node"),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "cancelled",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: scopeId,
            startedAt: now,
            completedAt: now,
          },
        });

        const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
        yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
          Effect.flatMap((service) => service.execute({ threadId, runId, scopeId })),
          Effect.provide(
            CheckpointCaptureService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  IdAllocator.layer,
                  Layer.mock(CheckpointService.CheckpointServiceV2)({
                    repositoryScopesIfReadable: () =>
                      Effect.succeed(repositories === "listed" ? [] : null),
                    capture: () => Effect.succeed({ ...checkpoint(1), changesKnown: true }),
                  }),
                  Layer.mock(EventSink.EventSinkV2)({
                    commitCommand: (input) =>
                      Ref.set(committed, input.events).pipe(
                        Effect.as({ committed: true } as never),
                      ),
                  }),
                ),
              ),
            ),
          ),
        );

        const captured = (yield* Ref.get(committed)).flatMap((event) =>
          event.type === "checkpoint.captured" && event.payload.runId === runId
            ? [event.payload]
            : [],
        );
        assert.deepEqual(
          captured.map((payload) => payload.changesKnown),
          [changesKnown],
        );
      }),
  );
});
