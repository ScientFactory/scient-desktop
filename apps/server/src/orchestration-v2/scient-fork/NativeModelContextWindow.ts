// @effect-diagnostics nodeBuiltinImport:off -- The pure native-context evidence fingerprint retains its persisted identity.
/** Destination capacity, scoped to the selected provider instance and model. */
import {
  ModelSelection,
  ServerSettings,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type ProviderSessionId,
  type ProviderThreadId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { customModelProviderId } from "../../customModels.ts";
import { droidCustomModelId } from "../../provider/droid/DroidCustomModels.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { decodeRunRow } from "./projectionRowJson.ts";

const RuntimeConfiguration = Schema.Struct({
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

/** The launch owner a Codex root run captures, when its native thread is known. */
export const nativeModelCapacityOwnerFor = (input: {
  readonly session: Pick<
    ProviderAdapterV2SessionRuntime,
    "driver" | "modelContextWindowLaunchFingerprint"
  >;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly modelSelection: ModelSelection;
  readonly providerSessionId: ProviderSessionId;
}): { readonly nativeModelCapacityOwner?: NativeModelCapacityOwner } => {
  const { session, providerThread: runningProviderThread, providerSessionId } = input;
  return session.driver !== "codex" ||
    session.modelContextWindowLaunchFingerprint === undefined ||
    runningProviderThread.nativeThreadRef?.driver !== "codex" ||
    runningProviderThread.nativeThreadRef.nativeId === null
    ? {}
    : {
        nativeModelCapacityOwner: {
          modelSelection: input.modelSelection,
          launchFingerprint: session.modelContextWindowLaunchFingerprint,
          providerSessionId,
          providerThreadId: runningProviderThread.id,
          nativeThreadId: runningProviderThread.nativeThreadRef.nativeId,
        },
      };
};

/** Ingest options that record a live root's reported Codex window for its launch owner. */
export const nativeModelCapacityWrite = (input: {
  readonly owner: NativeModelCapacityOwner | undefined;
  readonly rootTerminalAlreadySeen: boolean;
  readonly event: ProviderAdapterV2Event;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
}) => {
  const deliveredEvent = input.event;
  return input.owner === undefined ||
    input.rootTerminalAlreadySeen ||
    deliveredEvent.type !== "provider_turn.updated" ||
    deliveredEvent.driver !== "codex" ||
    deliveredEvent.providerTurn.nodeId !== input.rootNodeId ||
    deliveredEvent.providerTurn.runAttemptId !== input.attemptId ||
    deliveredEvent.providerTurn.tokenUsage?.maxTokens == null ||
    !Number.isFinite(deliveredEvent.providerTurn.tokenUsage.maxTokens) ||
    deliveredEvent.providerTurn.tokenUsage.maxTokens <= 0
    ? {}
    : {
        nativeModelCapacityOwner: input.owner,
        writeIfRunCurrent: {
          runId: input.runId,
          activeAttemptId: input.attemptId,
          expectedStatus: "running" as const,
        },
      };
};

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

/** The context window an accepted Codex turn reports, read inside the write transaction.
 * Undefined unless the captured launch owner still owns the run; the write must then not commit. */
export const readOwnedNativeModelCapacity = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  },
  capacityOwner: NativeModelCapacityOwner,
) =>
  Effect.gen(function* () {
    const usage = input.events.find((event) => event.type === "provider-turn.updated");
    const turn = usage?.type === "provider-turn.updated" ? usage.payload : undefined;
    if (
      turn?.nativeTurnRef?.driver !== "codex" ||
      turn.nativeTurnRef.nativeId === null ||
      turn.nativeAcceptance !== "accepted" ||
      turn.status !== "running" ||
      turn.tokenUsage?.maxTokens == null ||
      !Number.isFinite(turn.tokenUsage.maxTokens) ||
      turn.tokenUsage.maxTokens <= 0 ||
      turn.runAttemptId !== input.activeAttemptId ||
      turn.providerThreadId !== capacityOwner.providerThreadId ||
      usage?.threadId !== input.threadId ||
      usage.runId !== input.runId ||
      usage.nodeId !== turn.nodeId ||
      usage.providerInstanceId !== capacityOwner.modelSelection.instanceId ||
      usage.driver !== "codex" ||
      !/^codex-launch:v1:[a-f0-9]{64}$/.test(capacityOwner.launchFingerprint)
    )
      return undefined;
    const owners = yield* sql<{ readonly payload_json: string }>`
      SELECT r.payload_json FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = ${input.activeAttemptId}
        AND a.run_id = r.run_id AND a.thread_id = r.thread_id
      JOIN orchestration_v2_projection_nodes n ON n.node_id = ${turn.nodeId}
        AND n.run_id = r.run_id AND n.thread_id = r.thread_id
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = ${capacityOwner.providerThreadId}
        AND p.thread_id = r.thread_id
      JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id = ${capacityOwner.providerSessionId}
        AND s.provider_instance_id = r.provider_instance_id AND s.driver = 'codex'
      JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id = s.provider_session_id
        AND b.thread_id = r.thread_id
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      LEFT JOIN orchestration_v2_projection_provider_turns v ON v.provider_turn_id = ${turn.id}
      WHERE r.run_id = ${input.runId} AND r.thread_id = ${input.threadId}
        AND json_extract(r.payload_json, '$.rootNodeId') = n.node_id
        AND r.provider_thread_id = p.provider_thread_id AND r.provider_instance_id = p.provider_instance_id
        AND r.provider_instance_id = ${capacityOwner.modelSelection.instanceId}
        AND p.provider_session_id = s.provider_session_id AND p.driver = 'codex'
        AND p.last_run_ordinal = r.ordinal
        AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ${capacityOwner.nativeThreadId}
        AND json_extract(p.payload_json, '$.nativeThreadRef.driver') = 'codex'
        AND a.status = 'running'
        AND a.provider_thread_id = p.provider_thread_id AND a.provider_instance_id = p.provider_instance_id
        AND json_extract(a.payload_json, '$.rootNodeId') = n.node_id
        AND (a.provider_turn_id IS NULL OR a.provider_turn_id = ${turn.id})
        AND (json_extract(a.payload_json, '$.nativeThreadId') IS NULL OR json_extract(a.payload_json, '$.nativeThreadId') = ${capacityOwner.nativeThreadId})
        AND n.kind = 'root_turn' AND n.parent_node_id IS NULL AND n.provider_thread_id = p.provider_thread_id
        AND (n.provider_turn_id IS NULL OR n.provider_turn_id = ${turn.id})
        AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND json_extract(t.payload_json, '$.activeProviderThreadId') = p.provider_thread_id
        AND (v.provider_turn_id IS NULL OR (v.thread_id = r.thread_id AND v.provider_thread_id = p.provider_thread_id
          AND v.node_id = n.node_id AND v.run_attempt_id = a.attempt_id AND v.status = 'running'
          AND json_extract(v.payload_json, '$.nativeTurnRef.driver') = 'codex'
          AND json_extract(v.payload_json, '$.nativeTurnRef.nativeId') = ${turn.nativeTurnRef.nativeId}))
      LIMIT 1`;
    if (
      owners[0] === undefined ||
      !modelSelectionsEqual(
        (yield* decodeRunRow(owners[0].payload_json)).modelSelection,
        capacityOwner.modelSelection,
      )
    )
      return undefined;
    return turn.tokenUsage.maxTokens;
  });
