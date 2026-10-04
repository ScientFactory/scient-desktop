/** Destination capacity, scoped to the selected provider instance and model. */
import { ModelSelection, ServerSettings } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { customModelProviderId } from "../../customModels.ts";
import { droidCustomModelId } from "../../provider/droid/DroidCustomModels.ts";

const RuntimeConfiguration = Schema.Struct({
  providers: ServerSettings.fields.providers,
  providerInstances: ServerSettings.fields.providerInstances,
});
const encodeRuntimeConfiguration = Schema.encodeEffect(Schema.fromJsonString(RuntimeConfiguration));
const encodeModelWindowKey = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ selection: ModelSelection, configurationHash: Schema.String }),
  ),
);

export const forkModelWindowKey = Effect.fn("forkModelWindowKey")(function* (
  selection: ModelSelection,
  settings: ServerSettings,
) {
  const configuration = yield* encodeRuntimeConfiguration({
    providers: settings.providers,
    providerInstances: settings.providerInstances,
  });
  return yield* encodeModelWindowKey({
    selection,
    configurationHash: NodeCrypto.createHash("sha256").update(configuration).digest("hex"),
  });
});

/** Cache native reports by the complete selected model and runtime configuration. */
export const resolveNativeModelContextWindow = Effect.fn("resolveNativeModelContextWindow")(
  function* (input: {
    readonly modelSelection: ModelSelection;
    readonly settings: ServerSettings;
    readonly reported: number | undefined;
    readonly sql: SqlClient.SqlClient;
  }) {
    const discovered = input.reported;
    const selection = yield* forkModelWindowKey(input.modelSelection, input.settings);
    const valid = (value: number | undefined): value is number =>
      value !== undefined && Number.isFinite(value) && value > 0;
    const cached = (yield* input.sql<{
      readonly max_tokens: number;
    }>`SELECT max_tokens FROM scient_model_context_windows
    WHERE provider_instance_id = ${input.modelSelection.instanceId} AND model_selection_json = ${selection}`)[0]
      ?.max_tokens;
    if (valid(discovered) && discovered !== cached)
      yield* input.sql`INSERT OR REPLACE INTO scient_model_context_windows
    (provider_instance_id, model_selection_json, max_tokens) VALUES (${input.modelSelection.instanceId}, ${selection}, ${discovered})`;
    const configured = input.settings.customModels.connections.flatMap((connection) =>
      connection.models.flatMap((model) => {
        if (
          !model.instanceIds.includes(input.modelSelection.instanceId) ||
          ![
            model.modelId,
            `${customModelProviderId(connection.id)}/${model.modelId}`,
            droidCustomModelId(connection.id, model.id),
          ].includes(input.modelSelection.model)
        )
          return [];
        const capacity =
          model.configurationMode === "automatic"
            ? model.reasoningMetadata?.contextWindow
            : model.contextWindow;
        return valid(capacity) ? [capacity] : [];
      }),
    );
    const windows = [valid(discovered) ? discovered : cached, ...configured].filter(valid);
    return windows.length === 0 ? undefined : Math.min(...windows);
  },
);
