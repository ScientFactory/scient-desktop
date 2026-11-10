import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { emptyCloudSyncState, layerInMemory } from "./CloudSyncState.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("A refused turn never opens a provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const moved = ThreadId.make("thread:continued-elsewhere");
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "cloud-lease-guard" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provide(
    layerInMemory({
      ...emptyCloudSyncState,
      moved: {
        [moved]: { movedTo: EnvironmentId.make("env-b"), movedAt: "2026-11-10T10:00:00.000Z" },
      },
    }),
  ),
);

it.layer(layerTest)("Cloud lease guard", (it) => {
  it.effect("refuses a new turn on a thread another computer continued, recording nothing", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId: moved,
        projectId: ProjectId.make("project:cloud"),
        title: "Spectra",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const refused = yield* Effect.flip(
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("turn"),
          threadId: moved,
          messageId: MessageId.make("message:turn"),
          text: "Keep going",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        }),
      );
      assert.strictEqual(refused._tag, "OrchestratorDispatchError");
      assert.match(String((refused as { cause?: unknown }).cause), /continued on another computer/);
      assert.strictEqual(yield* projections.getMessageCount(moved), 0);

      // Renaming is not a turn; the thread stays manageable.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId: moved,
        title: "Spectra (continued)",
      });
    }),
  );
});
