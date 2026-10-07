import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  EventId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const checkpointLayer = CheckpointService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      Layer.mock(CheckpointStore.CheckpointStore)({
        isGitRepository: () =>
          Effect.die("A corrupt workspace binding must fail before Git access"),
      }),
    ),
  ),
);

it.live.each(["sql", "replay"] as const)(
  "rejects corrupt new workspace roots while preserving mutable historical and standalone scopes (%s)",
  (storage) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:workspace-binding:with-colons");
      const instanceId = ProviderInstanceId.make("fixture");
      yield* projections.apply({
        id: EventId.make("event:workspace-binding:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("project:workspace-binding"),
          title: "Workspace roots",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "fixture" },
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
          createdBy: "user",
          creationSource: "web",
        },
      });
      const input = {
        threadId,
        runId: RunId.make("run:first"),
        rootNodeId: NodeId.make("node:first"),
        providerThreadId: ProviderThreadId.make("provider-thread:first"),
        cwd: "/captured/A",
        createdAt: now,
      };
      const first = yield* checkpoints.prepareRootRunScope(input);
      const anotherA = yield* checkpoints.prepareRootRunScope({
        ...input,
        runId: RunId.make("run:another"),
        rootNodeId: NodeId.make("node:another"),
      });
      const atB = yield* checkpoints.prepareRootRunScope({ ...input, cwd: "/captured/B" });
      const backA = yield* checkpoints.prepareRootRunScope(input);
      const legacyId = yield* ids.allocate.checkpointScope({ threadId, name: "root" });
      assert.equal(first.id, anotherA.id);
      assert.equal(first.id, backA.id);
      assert.notEqual(first.id, atB.id);
      assert.notEqual(first.id, legacyId);
      assert.isTrue(CheckpointService.isWorkspaceBoundRootScopeId(first.id));
      assert.equal(
        (yield* Effect.result(checkpoints.prepareRootRunScope({ ...input, cwd: "relative" })))._tag,
        "Failure",
      );
      let sequence = 0;
      const event = (payload: typeof first): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:workspace-binding:${++sequence}`),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload,
      });
      yield* projections.apply(event(first));
      yield* projections.apply(event(anotherA));
      const before = yield* projections.getThreadProjection(threadId);
      for (const corrupt of [
        { ...first, cwd: "/captured/B" },
        { ...first, cwd: "/captured/../A" },
        { ...first, kind: "manual" as const },
        { ...first, id: CheckpointScopeId.make(`${first.id}-corrupt`) },
      ]) {
        assert.equal((yield* Effect.result(projections.apply(event(corrupt))))._tag, "Failure");
        assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
        assert.equal((yield* Effect.result(checkpoints.ensureScope(corrupt)))._tag, "Failure");
        assert.equal(
          (yield* Effect.result(
            checkpoints.captureBaseline({ scope: corrupt, ordinalWithinScope: 0 }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.result(
            checkpoints.materializeBaselineCheckpoint({ scope: corrupt, ordinalWithinScope: 0 }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.result(
            checkpoints.capture({
              scope: corrupt,
              runId: input.runId,
              nodeId: input.rootNodeId,
              ordinalWithinScope: 1,
              appRunOrdinal: 1,
              capturedAt: now,
            }),
          ))._tag,
          "Failure",
        );
      }
      // A newly encountered identifier must also agree with its own workspace digest.
      assert.equal(
        (yield* Effect.result(projections.apply(event({ ...atB, cwd: "/captured/C" }))))._tag,
        "Failure",
      );
      assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
      yield* projections.apply(event(atB));
      // Old accepted generic-root events were mutable. Rebuilding their history must remain legal.
      const legacy = { ...first, id: legacyId };
      yield* projections.apply(event(legacy));
      yield* projections.apply(event({ ...legacy, cwd: "/historical/B" }));
      const standalone = {
        ...first,
        id: CheckpointScopeId.make("scope:standalone-task"),
        kind: "manual" as const,
        parentScopeId: first.id,
        advancesAppRunCount: false,
      };
      yield* projections.apply(event(standalone));
      const final = yield* projections.getThreadProjection(threadId);
      assert.equal(
        final.checkpointScopes.find((scope) => scope.id === legacyId)?.cwd,
        "/historical/B",
      );
      assert.deepEqual(
        final.checkpointScopes.find((scope) => scope.id === standalone.id),
        standalone,
      );
      assert.deepEqual(
        final.checkpointScopes.find((scope) => scope.id === first.id),
        anotherA,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          checkpointLayer,
          IdAllocator.layer,
          storage === "sql"
            ? ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory))
            : ProjectionStore.layerMemory,
        ),
      ),
    ),
);
