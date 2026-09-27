import { type ModelSelection, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { resolveForkModelWindow, forkModelWindowKey } from "./modelContextWindow.ts";

it.layer(
  Layer.mergeAll(SqlitePersistenceMemory, ServerSettingsService.layerTest(), NodeServices.layer),
)("fork model capacity", (it) => {
  it.effect(
    "retains reported capacity across restart and isolates other models and instances",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* (yield* ServerSettingsService).getSettings;
        const selected = { instanceId: ProviderInstanceId.make("codex"), model: "large-model" };
        const json = yield* forkModelWindowKey(selected, settings);
        yield* sql`INSERT OR REPLACE INTO scient_model_context_windows VALUES (${selected.instanceId}, ${json}, 258400)`;
        const resolve = (modelSelection: ModelSelection) =>
          resolveForkModelWindow({
            sql,
            settings,
            registry: undefined,
            threadId: ThreadId.make("new-fork"),
            modelSelection,
          });
        assert.strictEqual(yield* resolve(selected), 258400);
        assert.isUndefined(
          yield* resolveForkModelWindow({
            sql,
            registry: undefined,
            threadId: ThreadId.make("new-fork"),
            modelSelection: selected,
            settings: {
              ...settings,
              providers: {
                ...settings.providers,
                codex: { ...settings.providers.codex, homePath: "/different/runtime" },
              },
            },
          }),
        );
        assert.isUndefined(yield* resolve({ ...selected, model: "smaller-model" }));
        assert.isUndefined(
          yield* resolve({ ...selected, instanceId: ProviderInstanceId.make("other-codex") }),
        );
      }),
  );
});
