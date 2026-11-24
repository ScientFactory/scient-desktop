import {
  type CustomModel,
  customModelAttachmentKey,
  customModelImageInput,
  type CustomModelConnection,
  type CustomModelsSettings,
  type ModelConnectionReadiness,
  OrchestratorMcpFailure,
  PROVIDER_DISPLAY_NAMES,
  type SecretRef,
  type ServerProvider,
  supportsModelConnections,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Redacted from "effect/Redacted";

import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import { ProviderInstanceRegistry } from "../../../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { customModelMethods } from "../../../scientServerSettings.ts";
import { testCustomModel } from "../../providerLifecycle/CustomModelRpcHandlers.ts";
import { CustomModelsToolkit } from "./tools.ts";

// An agent reloads its models after a save; a status older than the saved model is not its answer.
const READINESS_WAIT = Duration.seconds(20);
const READINESS_POLL = Duration.millis(500);

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const agentName = (provider: ServerProvider) =>
  provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.instanceId;

const formatTokens = (value: number | undefined) =>
  value === undefined ? "unknown" : value.toLocaleString("en-US");

function modelLimits(model: CustomModel): string {
  if (model.configurationMode === "automatic") {
    const metadata = model.reasoningMetadata;
    return `automatic: ${formatTokens(metadata?.contextWindow)} read, ${formatTokens(metadata?.maxOutputTokens)} per reply`;
  }
  return `manual: ${formatTokens(model.contextWindow)} read, ${formatTokens(model.maxOutputTokens)} per reply`;
}

/** The same assessment Settings shows for one agent. */
function readiness(
  provider: ServerProvider | undefined,
  connection: CustomModelConnection,
  model: CustomModel,
): { readonly status: string; readonly settled: boolean } {
  if (provider === undefined) return { status: "not set up in Scient", settled: true };
  if (!provider.enabled) return { status: "disabled", settled: true };
  if (!provider.installed && !provider.probePending)
    return { status: "not installed", settled: true };
  if (provider.probePending) return { status: "checking", settled: false };
  if (provider.status === "error" || provider.auth.status === "unauthenticated")
    return { status: "the agent needs attention in Settings", settled: true };
  const assessment: ModelConnectionReadiness | undefined = provider.modelConnections?.find(
    (entry) =>
      entry.connectionId === connection.id &&
      entry.modelId === model.id &&
      entry.configurationKey === customModelAttachmentKey(connection, model),
  );
  if (assessment === undefined) return { status: "checking", settled: false };
  if (assessment.state === "available")
    return {
      status:
        assessment.contextWindow === undefined
          ? "ready"
          : `ready (${formatTokens(assessment.contextWindow)} read, ${formatTokens(assessment.maxOutputTokens)} per reply)`,
      settled: true,
    };
  return {
    status:
      assessment.reason === "credential"
        ? "needs setup: the key is missing or not accepted"
        : "needs setup: this agent has no limits for the model; save it with contextWindow and maxOutputTokens",
    settled: true,
  };
}

/** A model's saved configuration, including which agents use it. */
const savedConfiguration = (connection: CustomModelConnection, model: CustomModel) =>
  JSON.stringify([customModelAttachmentKey(connection, model), [...model.instanceIds].sort()]);

function listCustomModels(
  customModels: CustomModelsSettings,
  providers: ReadonlyArray<ServerProvider>,
) {
  return {
    agents: providers
      .filter((provider) => supportsModelConnections(provider.driver))
      .map((provider) => ({
        agent: provider.instanceId,
        name: agentName(provider),
        enabled: provider.enabled,
      })),
    connections: customModels.connections.map((connection) => ({
      connectionId: connection.id,
      name: connection.name,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      key:
        connection.credentialId === null
          ? "none"
          : connection.apiKeySuffix
            ? `saved, ends in ${connection.apiKeySuffix}`
            : "saved",
      models: connection.models.map((model) => ({
        model: model.modelId,
        name: model.name,
        limits: modelLimits(model),
        agents: model.instanceIds.map((agent) => ({
          agent,
          status: readiness(
            providers.find((provider) => provider.instanceId === agent),
            connection,
            model,
          ).status,
        })),
      })),
    })),
  };
}

export const layer = McpToolAccess.toLayer(
  CustomModelsToolkit,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const customModelSettings = customModelMethods(serverSettings);
    const providerRegistry = yield* ProviderRegistry;
    const providerInstances = yield* ProviderInstanceRegistry;
    const config = yield* ServerConfig;
    const secretRequests = yield* SecretRequests;
    const projections = yield* ProjectionStoreV2;
    const random = yield* SecureRandom.SecureRandom;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    const readSettings = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.customModels),
      Effect.mapError(() => invalid("Could not read custom models.")),
    );
    const currentList = Effect.gen(function* () {
      return listCustomModels(yield* readSettings, yield* providerRegistry.getProviders);
    });

    /**
     * Waits until every connected agent has answered for the saved configuration, or the wait
     * runs out. A later change in Settings ends the wait: its answer is not this save's.
     */
    const settledStatuses = Effect.fn("CustomModelsAgent.settledStatuses")(function* (
      connectionId: string,
      modelId: string,
      committedKey: string,
    ) {
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(READINESS_WAIT);
      while (true) {
        const customModels = yield* readSettings;
        const connection = customModels.connections.find((entry) => entry.id === connectionId);
        const model = connection?.models.find((entry) => entry.id === modelId);
        if (connection === undefined || model === undefined)
          return { superseded: "It was removed in Settings since.", statuses: [] };
        if (savedConfiguration(connection, model) !== committedKey)
          return {
            superseded: "It was changed in Settings since; list it for its current status.",
            statuses: [],
          };
        const providers = yield* providerRegistry.getProviders;
        const statuses = model.instanceIds.map((agent) => ({
          agent,
          ...readiness(
            providers.find((provider) => provider.instanceId === agent),
            connection,
            model,
          ),
        }));
        if (
          statuses.every((entry) => entry.settled) ||
          (yield* Clock.currentTimeMillis) >= deadline
        )
          return { superseded: undefined, statuses };
        yield* Effect.sleep(READINESS_POLL);
      }
    });

    const consumeKey = Effect.fn("CustomModelsAgent.consumeKey")(function* (secretRef: SecretRef) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.thread === undefined)
        return yield* invalid("A key from request_secret needs a thread to call from.");
      const shell = yield* projections
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.mapError(() => invalid("Could not read this thread.")));
      if (shell === null) return yield* invalid("Could not read this thread.");
      const value = yield* secretRequests
        .consume({ ref: secretRef, projectId: shell.projectId })
        .pipe(
          Effect.mapError(() =>
            invalid(
              "That secretRef was already used or has expired. Ask with request_secret again.",
            ),
          ),
        );
      const key = value.trim();
      if (key.length === 0)
        return yield* invalid("The key was empty. Ask with request_secret again.");
      return Redacted.make(key);
    });

    return {
      scient_custom_models: McpToolAccess.reads(() => currentList),
      scient_custom_models_manage: McpToolAccess.writesEnvironment((params, check) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          // A change commits under the caller's thread lock, after the access check passes again:
          // its modes cannot change while Scient asks the endpoint for limits.
          const guarded = <A, E, R>(change: Effect.Effect<A, E, R>) => {
            const checked = check.pipe(Effect.andThen(change));
            return scope.thread === undefined
              ? checked
              : executor.withLock(scope.thread.threadId, checked);
          };
          const modelId = params.model?.trim();
          const current = yield* readSettings;
          const existing =
            params.connectionId === undefined
              ? undefined
              : current.connections.find((entry) => entry.id === params.connectionId);
          if (params.connectionId !== undefined && existing === undefined)
            return yield* invalid("No connection has that connectionId. List them first.");
          const lines: string[] = [];

          if (params.action === "remove") {
            if (existing === undefined) return yield* invalid("remove needs a connectionId.");
            if (params.wholeConnection === true) {
              yield* guarded(
                customModelSettings
                  .removeCustomModel({ revision: current.revision, connectionId: existing.id })
                  .pipe(Effect.mapError((error) => invalid(error.message))),
              );
              lines.push(`Removed ${existing.name}, its models and its key.`);
              return { lines };
            }
            if (modelId === undefined)
              return yield* invalid("Name the `model` to remove, or pass wholeConnection.");
            const remaining = existing.models.filter((entry) => entry.modelId !== modelId);
            if (remaining.length === existing.models.length)
              return yield* invalid(`${existing.name} has no model ${modelId}.`);
            yield* guarded(
              customModelSettings
                .saveCustomModel({
                  revision: current.revision,
                  connection: {
                    id: existing.id,
                    name: existing.name,
                    protocol: existing.protocol,
                    baseUrl: existing.baseUrl,
                    models: remaining,
                  },
                })
                .pipe(Effect.mapError((error) => invalid(error.message))),
            );
            lines.push(
              remaining.length === 0
                ? `Removed ${modelId} from ${existing.name}. The connection and its key stay for another model.`
                : `Removed ${modelId} from ${existing.name}.`,
            );
            return { lines };
          }

          if (params.action === "test") {
            const model = existing?.models.find((entry) => entry.modelId === modelId);
            if (existing === undefined || model === undefined)
              return yield* invalid("test needs a connectionId and one of its `model` IDs.");
            const providers = yield* providerRegistry.getProviders;
            for (const agent of model.instanceIds) {
              const provider = providers.find((entry) => entry.instanceId === agent);
              if (provider === undefined || !provider.enabled) {
                lines.push(`${provider ? agentName(provider) : agent}: skipped, the agent is off.`);
                continue;
              }
              const outcome = yield* testCustomModel(
                { serverSettings, providerInstances, config },
                {
                  connectionId: existing.id,
                  modelId: model.id,
                  instanceId: agent,
                  revision: current.revision,
                },
              ).pipe(Effect.result);
              lines.push(
                outcome._tag === "Success"
                  ? `${agentName(provider)}: answered.`
                  : `${agentName(provider)}: ${outcome.failure.message}`,
              );
            }
            if (lines.length === 0) lines.push("No agent uses this model.");
            return { lines };
          }

          // save
          if (modelId === undefined || modelId.length === 0)
            return yield* invalid("save needs the `model` ID.");
          if (existing === undefined && params.connection === undefined)
            return yield* invalid("save needs a connectionId, or a new `connection`.");
          if ((params.contextWindow === undefined) !== (params.maxOutputTokens === undefined))
            return yield* invalid("Give contextWindow and maxOutputTokens together, or neither.");
          const base = existing ?? {
            id: yield* random.uuidV4(),
            ...params.connection!,
            models: [],
          };
          const previous = base.models.find((entry) => entry.modelId === modelId);
          const providers = yield* providerRegistry.getProviders;
          const instanceIds =
            params.agents ??
            previous?.instanceIds ??
            providers
              .filter(
                (provider) =>
                  provider.enabled && supportsModelConnections(provider.driver, base.protocol),
              )
              .map((provider) => provider.instanceId);
          const limits: Partial<CustomModel> =
            params.contextWindow !== undefined && params.maxOutputTokens !== undefined
              ? {
                  configurationMode: "manual",
                  contextWindow: params.contextWindow,
                  maxOutputTokens: params.maxOutputTokens,
                }
              : previous === undefined
                ? { configurationMode: "automatic" }
                : {};
          // Image input stays as it was unless asked; a new model detects it, as in Settings.
          const imageSettings: Partial<CustomModel> =
            params.images !== undefined
              ? { images: params.images, imageInput: params.images ? "enabled" : "disabled" }
              : previous === undefined
                ? { images: false, imageInput: "automatic" }
                : // Written out, since its fallback depends on the mode these limits may change.
                  { imageInput: customModelImageInput(previous) };
          const model: CustomModel = {
            reasoning: false,
            images: false,
            ...previous,
            ...limits,
            ...imageSettings,
            id: previous?.id ?? (yield* random.uuidV4()),
            modelId,
            name: params.name?.trim() || previous?.name || modelId,
            instanceIds,
          };
          const committed = yield* guarded(
            Effect.gen(function* () {
              // Read only after the caller is checked again, so a refused change leaves the ref.
              const apiKey =
                params.secretRef === undefined ? undefined : yield* consumeKey(params.secretRef);
              return yield* customModelSettings
                .saveCustomModel({
                  revision: current.revision,
                  connection: {
                    id: base.id,
                    name: base.name,
                    protocol: base.protocol,
                    baseUrl: base.baseUrl,
                    models: [...base.models.filter((entry) => entry.modelId !== modelId), model],
                  },
                  ...(apiKey === undefined ? {} : { apiKey }),
                  refreshModelId: model.id,
                })
                .pipe(Effect.mapError((error) => invalid(error.message)));
            }),
          );
          lines.push(`Saved ${model.name} on ${base.name}.`);
          const savedConnection = committed.connections.find((entry) => entry.id === base.id);
          const savedModel = savedConnection?.models.find((entry) => entry.id === model.id);
          if (savedConnection === undefined || savedModel === undefined)
            return { lines, connectionId: base.id };
          const outcome = yield* settledStatuses(
            base.id,
            model.id,
            savedConfiguration(savedConnection, savedModel),
          );
          if (outcome.superseded !== undefined) lines.push(outcome.superseded);
          for (const entry of outcome.statuses) {
            const provider = providers.find((candidate) => candidate.instanceId === entry.agent);
            lines.push(`${provider ? agentName(provider) : entry.agent}: ${entry.status}.`);
          }
          return { lines, connectionId: base.id };
        }),
      ),
    };
  }),
);
