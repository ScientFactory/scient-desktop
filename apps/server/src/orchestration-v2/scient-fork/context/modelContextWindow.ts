/** Destination capacity, scoped to the selected provider instance and model. */
import { ModelSelection, type ThreadId, ServerSettings } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { customModelProviderId } from "../../../customModels.ts";
import { droidCustomModelId } from "../../../provider/droid/DroidCustomModels.ts";

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

export const resolveForkModelWindow = Effect.fn("resolveForkModelWindow")(function* (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly settings: ServerSettings;
  readonly registry: ProviderAdapterRegistry["Service"] | undefined;
  readonly sql: SqlClient.SqlClient;
}) {
  const discovered =
    input.registry === undefined
      ? undefined
      : yield* input.registry.getByInstance(input.modelSelection.instanceId).pipe(
          Effect.flatMap(
            (adapter) =>
              adapter.getModelContextWindow?.({
                threadId: input.threadId,
                modelSelection: input.modelSelection,
              }) ?? Effect.succeed(undefined),
          ),
          Effect.orElseSucceed(() => undefined),
        );
  const selection = yield* forkModelWindowKey(input.modelSelection, input.settings);
  const valid = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0;
  if (valid(discovered))
    yield* input.sql`INSERT OR REPLACE INTO scient_model_context_windows
    (provider_instance_id, model_selection_json, max_tokens) VALUES (${input.modelSelection.instanceId}, ${selection}, ${discovered})`;
  const cached = (yield* input.sql<{
    readonly max_tokens: number;
  }>`SELECT max_tokens FROM scient_model_context_windows
    WHERE provider_instance_id = ${input.modelSelection.instanceId} AND model_selection_json = ${selection}`)[0]
    ?.max_tokens;
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
  const windows = [discovered ?? cached, ...configured].filter(valid);
  return windows.length === 0 ? undefined : Math.min(...windows);
});
