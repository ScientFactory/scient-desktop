import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadSectionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";

const settingsLayer = ServerSettingsModule.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfig.layerTest(process.cwd(), { prefix: "scient-thread-sections-settings-test-" }),
    ),
  ),
);

const alpha = { id: ThreadSectionId.make("alpha"), name: "Alpha", order: 0 };
const beta = { id: ThreadSectionId.make("beta"), name: "Beta", order: 0 };

it.layer(NodeServices.layer)("server settings thread-section precondition", (it) => {
  it.effect("applies a section edit only to the catalog it was based on", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const empty = { threadSections: [], threadSectionsGeneralIndex: 0 };

      // First client: based on the empty catalog, applies.
      const first = yield* service.updateSettings({
        threadSections: [alpha],
        threadSectionsGeneralIndex: 0,
        threadSectionsExpected: empty,
      });
      assert.deepStrictEqual(
        first.threadSections.map((section) => section.id),
        [alpha.id],
      );

      // Second client, also based on the empty catalog: its section keys are
      // dropped and the returned settings show what the server holds.
      const second = yield* service.updateSettings({
        threadSections: [beta],
        threadSectionsGeneralIndex: 0,
        threadSectionsExpected: empty,
      });
      assert.deepStrictEqual(
        second.threadSections.map((section) => section.id),
        [alpha.id],
      );
      assert.deepStrictEqual(
        (yield* service.getSettings).threadSections.map((section) => section.id),
        [alpha.id],
      );
    }).pipe(Effect.provide(settingsLayer)),
  );
});
