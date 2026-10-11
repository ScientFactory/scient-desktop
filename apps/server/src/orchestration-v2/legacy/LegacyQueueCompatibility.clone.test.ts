import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import { SourceControlRepositoryService } from "../../sourceControl/SourceControlRepositoryService.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { makeLegacyQueueCompatibility } from "./LegacyQueueCompatibility.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(
  (["resume", "send", "steer"] as const).map((action) => ({
    caseTitle: `legacy queue ${action} preserves held work while the actual project clone is active`,
    action,
  })),
)("$caseTitle", ({ action }) => {
  const release = Deferred.makeUnsafe<void>();
  const replay = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: `legacy-queue-clone-${action}` },
    makeLayer([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("The effect worker is paused for durable effect inspection"),
      },
    ]),
    { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
  );
  const cloneLayer = ProjectCloneTracker.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlRepositoryService)({
        prepareClone: (input) =>
          Effect.succeed({
            destinationPath: input.destinationPath,
            remoteUrl: input.remoteUrl ?? "",
            cloneUrl: input.remoteUrl ?? "",
            repository: null,
          }),
        cloneRepository: (input) =>
          Deferred.await(release).pipe(
            Effect.as({
              cwd: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              repository: null,
            }),
          ),
        discardClone: () => Effect.void,
      }),
    ),
  );
  const services = Layer.mergeAll(LegacyV1ThreadImporter.layer, cloneLayer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(replay, CommandReceiptStore.layer).pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
  const layer = ThreadManagement.layerWithLegacyImporter.pipe(Layer.provideMerge(services));
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    const compatibility = yield* makeLegacyQueueCompatibility;
    const projectId = ProjectId.make(`legacy-clone-project:${action}`);
    const threadId = ThreadId.make(`legacy-clone-thread:${action}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`legacy-clone-create:${action}`),
      threadId,
      projectId,
      title: "Clone gate",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: config.cwd,
      createdBy: "user",
      creationSource: "web",
    });
    if (action === "steer") {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("legacy-clone-active"),
        threadId,
        messageId: MessageId.make("legacy-clone-active-message"),
        text: "Established before cloning starts",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
    }
    yield* tracker.start(
      {
        projectId,
        title: "Clone gate",
        remoteUrl: "https://example.invalid/clone-gate.git",
        destinationPath: config.cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { createProject: () => Effect.void, onCloned: () => Effect.void },
    );
    assert.equal((yield* tracker.get(projectId))?.phase, "running");
    if (action === "resume") {
      const admitted = yield* compatibility.execute({
        method: "enqueue",
        payload: {
          threadId,
          queueItemId: "qitem_cloneheld",
          text: "Keep this captured selection",
          attachments: [],
          modelSelection,
          selectedScientSkillNames: ["analysis"],
        },
      });
      assert.equal(admitted.items.length, 1);
      assert.equal(admitted.awaitingCompletion, true);
    } else
      yield* orchestrator.dispatch({
        type: "legacy-queue.import",
        commandId: CommandId.make(`legacy-clone-held:${action}`),
        threadId,
        queueItemId: "qitem_cloneheld",
        messageId: MessageId.make(`legacy-clone-held-message:${action}`),
        text: "Keep this captured selection",
        attachments: [],
        modelSelection,
        selectedScientSkillNames: ["analysis"],
        createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      });
    const before = yield* orchestrator.getThreadProjection(threadId);
    const imported = before.runs.find((run) => run.legacyQueue?.queueItemId === "qitem_cloneheld");
    assert.equal(imported?.status, "queued");
    assert.equal(imported?.queueHeld, true);
    const effectsBefore = yield* sql`SELECT effect_id, effect_type, payload_json
        FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count
            FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start'`)[0]
        ?.count,
      action === "steer" ? 1 : 0,
    );
    const request = {
      method: "control" as const,
      payload: { threadId, action, queueItemId: "qitem_cloneheld" },
    };
    const failure = yield* compatibility.execute(request).pipe(Effect.flip);
    assert.deepInclude(failure, {
      _tag: "OrchestratorCommandRejectedError",
      commandType: action === "steer" ? "queued-message.promote-to-steer" : "queue.resume",
    });
    assert.deepInclude("cause" in failure ? failure.cause : null, {
      message: "The repository is still being cloned.",
    });
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
    assert.deepEqual(
      yield* sql`SELECT effect_id, effect_type, payload_json
          FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
      effectsBefore,
    );
    const held = yield* compatibility.execute({ method: "list", payload: { threadId } });
    assert.equal(held.items.length, 1);
    assert.deepEqual(held.items[0]?.selectedScientSkillNames, ["analysis"]);
    yield* Deferred.succeed(release, undefined);
    yield* tracker.stream.pipe(
      Stream.filter((clones) =>
        clones.some((clone) => clone.projectId === projectId && clone.phase === "done"),
      ),
      Stream.take(1),
      Stream.runDrain,
    );
    if (action !== "steer") {
      yield* compatibility.execute(request);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs[0]?.status, "starting");
      assert.equal(after.runs[0]?.queueHeld, false);
      assert.deepEqual(after.messages[0]?.selectedScientSkillNames, ["analysis"]);
      assert.equal(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count
          FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start'`)[0]?.count,
        1,
      );
    }
  }).pipe(Effect.provide(layer));
});
