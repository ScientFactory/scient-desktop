/** Destination capacity, scoped to the selected provider instance and model. */
import {
  ModelSelection,
  ServerSettings,
  type ProviderSessionId,
  type ProviderThreadId,
} from "@t3tools/contracts";
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

/** Private captured launch ownership, passed by trusted execution code, never a native frame. */
export interface NativeModelCapacityOwner {
  readonly modelSelection: ModelSelection;
  readonly launchFingerprint: string;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
  readonly nativeThreadId: string;
}

export const nativeModelWindowKey = (selection: ModelSelection, launchFingerprint: string) =>
  encodeModelWindowKey({ selection, configurationHash: launchFingerprint });

export const recordNativeModelContextWindow = Effect.fn("recordNativeModelContextWindow")(
  function* (
    sql: SqlClient.SqlClient,
    owner: Pick<NativeModelCapacityOwner, "modelSelection" | "launchFingerprint">,
    maxTokens: number,
  ) {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return;
    const key = yield* nativeModelWindowKey(owner.modelSelection, owner.launchFingerprint);
    yield* sql`INSERT INTO scient_model_context_windows (provider_instance_id, model_selection_json, max_tokens)
    VALUES (${owner.modelSelection.instanceId}, ${key}, ${maxTokens})
    ON CONFLICT(provider_instance_id, model_selection_json) DO UPDATE SET max_tokens = excluded.max_tokens
    WHERE scient_model_context_windows.max_tokens != excluded.max_tokens`;
  },
);

/** Cache native reports by the complete selected model and runtime configuration. */
export const resolveNativeModelContextWindow = Effect.fn("resolveNativeModelContextWindow")(
  function* (input: {
    readonly modelSelection: ModelSelection;
    readonly settings: ServerSettings;
    readonly reported: number | undefined;
    readonly launchFingerprint?: string;
    readonly sql: SqlClient.SqlClient;
  }) {
    const discovered = input.reported;
    const selection = yield* input.launchFingerprint === undefined
      ? forkModelWindowKey(input.modelSelection, input.settings)
      : nativeModelWindowKey(input.modelSelection, input.launchFingerprint);
    const valid = (value: number | undefined): value is number =>
      value !== undefined && Number.isFinite(value) && value > 0;
    const cached = (yield* input.sql<{
      readonly max_tokens: number;
    }>`SELECT max_tokens FROM scient_model_context_windows
    WHERE provider_instance_id = ${input.modelSelection.instanceId} AND model_selection_json = ${selection}`)[0]
      ?.max_tokens;
    // Exact launch reports become durable only in the owned canonical usage transaction.
    if (input.launchFingerprint === undefined && valid(discovered) && discovered !== cached)
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
