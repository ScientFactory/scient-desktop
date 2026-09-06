import * as NodeCrypto from "node:crypto";
import { customModelImageInput } from "@t3tools/contracts";
import { preferredReasoningLevel } from "@t3tools/shared/model";
import type {
  CustomModel,
  CustomModelConnection,
  CustomModelProtocol,
  ProviderInstanceId,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { AcpProcessExitedError, AcpRequestError } from "effect-acp/errors";
import type { SessionConfigOption } from "effect-acp/schema";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { assessModelConnections } from "../../customModelReadiness.ts";
import {
  customModelDiscoverySnapshot,
  customModelRuntimeChange,
  effectiveCustomModelReasoning,
} from "../../customModelCapabilities.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { makeDroidAcpRuntime, type DroidAcpRuntimeFactory } from "../acp/DroidAcpSupport.ts";

const DROID_PROVIDER_BY_PROTOCOL = {
  "openai-completions": "generic-chat-completion-api",
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
} as const satisfies Record<CustomModelProtocol, string>;

/** Only configuration visible to this instance participates in invalidation. No secrets. */
export function droidCustomModelsSnapshot(
  connections: ReadonlyArray<CustomModelConnection>,
  instanceId: ProviderInstanceId,
) {
  return customModelDiscoverySnapshot(connections, instanceId).map(
    ({ name: _connectionName, models, ...connection }) => ({
      ...connection,
      // Labels and next-turn preferences do not change an in-flight API request.
      models: models.map(({ name: _name, defaultReasoningLevel: _preference, ...model }) => model),
    }),
  );
}

/** Stable, collision-resistant id used by both Droid's model picker and Scient selection. */
export function droidCustomModelId(connectionId: string, customModelId: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(connectionId)
    .update("\0")
    .update(customModelId)
    .digest("hex")
    .slice(0, 12);
  return `custom:scient-${customModelId.slice(0, 40)}-${digest}`;
}

/** Prefer exact evidence; absent optional values deliberately delegate to Droid's native defaults. */
function droidModelLimits(model: CustomModel) {
  if (model.configurationMode !== "automatic") return model;
  const metadata = model.reasoningMetadata;
  const contextWindow = metadata?.contextWindow;
  const maxOutputTokens = metadata?.maxOutputTokens;
  if (
    contextWindow === undefined ||
    maxOutputTokens === undefined ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 ||
    maxOutputTokens > contextWindow
  )
    return {};
  return { contextWindow, maxOutputTokens };
}

function droidModelImages(model: CustomModel): boolean {
  const choice = customModelImageInput(model);
  return choice === "automatic" ? model.reasoningMetadata?.images === true : choice === "enabled";
}

/** Droid ACP advertises a generic ladder for BYOK completions even when the request accepts more.
 * Correct only exact Scient-managed effort APIs; native and unknown models retain their live controls.
 * Verified against Droid 0.213.0 with a local wire-capture fixture, including Max.
 */
export function resolveDroidCustomReasoningOptions(
  configOptions: ReadonlyArray<SessionConfigOption>,
  connections: ReadonlyArray<ResolvedModelConnection>,
): ReadonlyArray<SessionConfigOption> {
  const selected = configOptions.find(
    (option) => option.id === "model" || option.category === "model",
  );
  if (selected?.type !== "select") return configOptions;
  for (const connection of connections) {
    if (connection.protocol !== "openai-completions") continue;
    const model = connection.models.find(
      (entry) => droidCustomModelId(connection.id, entry.id) === selected.currentValue,
    );
    const metadata = model && effectiveCustomModelReasoning(model, connection.protocol);
    if (!model) continue;
    if (metadata?.status !== "known" || !metadata.supported || metadata.mode !== "effort") continue;
    return configOptions.map((option) => {
      if (
        option.type !== "select" ||
        (option.id !== "reasoning_effort" && option.category !== "thought_level")
      )
        return option;
      const advertised = new Set(
        option.options.flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
        ),
      );
      const configured = preferredReasoningLevel(metadata.levels, metadata.defaultLevel);
      return {
        ...option,
        options: metadata.levels
          // Droid serializes its advertised ladder plus the configured custom effort.
          // Other extra levels may be acknowledged but silently mapped to that configured value.
          .filter((level) => level !== "off" && (advertised.has(level) || level === configured))
          .map((value) => ({
            value,
            name: value === "xhigh" ? "Extra-high" : value.charAt(0).toUpperCase() + value.slice(1),
          })),
      };
    });
  }
  return configOptions;
}

export function buildDroidCustomModelsSettings(
  connections: ReadonlyArray<ResolvedModelConnection>,
): {
  readonly settings: { readonly customModels: ReadonlyArray<Record<string, unknown>> };
  readonly environment: NodeJS.ProcessEnv;
} {
  let index = 0;
  const environment: NodeJS.ProcessEnv = {};
  return {
    environment,
    settings: {
      customModels: connections.flatMap((connection) => {
        if (connection.credentialError !== undefined) return [];
        // Droid interpolates apiKey strings once. A scoped reference preserves keys
        // containing literal ${...}, without editing the parent process environment.
        const keyVariable = `SCIENT_DROID_KEY_${NodeCrypto.randomBytes(16).toString("hex")}`;
        return connection.models.flatMap((model) => {
          const limits = droidModelLimits(model);
          const reasoning = effectiveCustomModelReasoning(model, connection.protocol);
          if (connection.apiKey) environment[keyVariable] = Redacted.value(connection.apiKey);
          return [
            {
              id: droidCustomModelId(connection.id, model.id),
              index: index++,
              model: model.modelId,
              displayName: model.name,
              baseUrl: connection.baseUrl,
              provider: DROID_PROVIDER_BY_PROTOCOL[connection.protocol],
              maxContextLimit: limits.contextWindow,
              maxOutputTokens: limits.maxOutputTokens,
              noImageSupport: !droidModelImages(model),
              ...(reasoning?.status === "known" && reasoning.supported
                ? {
                    reasoningEffort: preferredReasoningLevel(
                      reasoning.levels,
                      reasoning.defaultLevel,
                    ),
                  }
                : {}),
              ...(reasoning?.supported !== null && reasoning?.supported !== undefined
                ? { enableThinking: reasoning.supported }
                : model.configurationMode === "automatic"
                  ? {}
                  : { enableThinking: model.reasoning }),
              ...(connection.apiKey ? { apiKey: "${" + keyVariable + "}" } : {}),
            },
          ];
        });
      }),
    },
  };
}

/**
 * Adds Scient-managed models to every disposable Droid process. Credentials
 * are supplied through that child's environment; its private overlay contains only references.
 */
export const makeDroidCustomModelsRuntimeFactory = Effect.fn(
  "DroidCustomModels.makeRuntimeFactory",
)(function* (
  settings: Pick<
    ServerSettingsService["Service"],
    "resolveCustomModels" | "getSettings" | "subscribeChanges"
  >,
  instanceId: ProviderInstanceId,
  makeRuntime: DroidAcpRuntimeFactory = makeDroidAcpRuntime,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (input: Parameters<DroidAcpRuntimeFactory>[0]) =>
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
      // Subscribe before resolving credentials, including while process construction is in flight.
      const changes = yield* settings.subscribeChanges;
      const connections = yield* settings.resolveCustomModels(instanceId).pipe(
        Effect.mapError(
          () =>
            new AcpRequestError({
              code: -32603,
              errorMessage: "Could not load Droid custom models.",
            }),
        ),
      );
      let currentConnections: ReadonlyArray<CustomModelConnection> = connections;
      let refreshPending = false;
      let invalidated = false;
      const invalidate = yield* Effect.cached(
        Effect.gen(function* () {
          invalidated = true;
          yield* Scope.close(runtimeScope, Exit.void);
        }),
      );
      const assertCurrent = Effect.gen(function* () {
        const current = yield* settings.getSettings.pipe(
          Effect.mapError(
            () =>
              new AcpRequestError({
                code: -32603,
                errorMessage: "Could not check Droid custom models.",
              }),
          ),
        );
        const change = customModelRuntimeChange(
          connections.filter((connection) => connection.credentialError === undefined),
          current.customModels.connections,
          instanceId,
        );
        if (invalidated || change === "revoke") {
          yield* invalidate;
          return yield* new AcpProcessExitedError({});
        }
        refreshPending = change === "refresh";
        currentConnections = current.customModels.connections;
      });
      yield* changes.pipe(
        // Re-read the latest snapshot: queued events can predate credential resolution.
        Stream.runForEach(() =>
          assertCurrent.pipe(
            Effect.catch(() =>
              invalidated
                ? Effect.void
                : Effect.logWarning("Could not verify Droid model connections."),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      return yield* Effect.gen(function* () {
        const configuration = buildDroidCustomModelsSettings(connections);
        const overlayPath = yield* Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-models-" });
          yield* fs.chmod(directory, 0o700);
          const overlayPath = path.join(directory, "settings.json");
          yield* fs.writeFileString(
            overlayPath,
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify(configuration.settings),
            { mode: 0o600, flag: "wx" },
          );
          return overlayPath;
        }).pipe(
          Effect.mapError(
            () =>
              new AcpRequestError({
                code: -32603,
                errorMessage: "Could not prepare Droid model connections.",
              }),
          ),
        );
        yield* assertCurrent;
        const runtime = yield* makeRuntime({
          ...input,
          resolveConfigOptions: (configOptions) =>
            resolveDroidCustomReasoningOptions(configOptions, connections),
          environment: { ...(input.environment ?? process.env), ...configuration.environment },
          runtimeSettingsPath: overlayPath,
        });
        yield* assertCurrent;
        return {
          ...runtime,
          assessModelConnections: (models: ReadonlyArray<ServerProviderModel>) =>
            assessModelConnections(connections, (connection, model) => {
              const limits = droidModelLimits(model);
              if (
                !models.some((entry) => entry.slug === droidCustomModelId(connection.id, model.id))
              )
                return undefined;
              const source =
                model.configurationMode !== "automatic"
                  ? "manual"
                  : limits.contextWindow === undefined
                    ? "agent"
                    : model.reasoningMetadata?.source;
              return {
                contextWindow: limits.contextWindow,
                maxOutputTokens: limits.maxOutputTokens,
                ...(source && source !== "unknown" ? { source } : {}),
              };
            }),
          // Snapshot lookup only: never resolve metadata while holding runtime locks.
          getDefaultReasoningLevel: (modelId: string) =>
            currentConnections
              .flatMap((connection) =>
                connection.models.filter(
                  (model) => droidCustomModelId(connection.id, model.id) === modelId,
                ),
              )
              .at(0)?.defaultReasoningLevel,
          getReasoningMetadata: (modelId: string) => {
            for (const connection of connections) {
              const model = connection.models.find(
                (entry) => droidCustomModelId(connection.id, entry.id) === modelId,
              );
              if (model) return effectiveCustomModelReasoning(model, connection.protocol) ?? null;
            }
            return undefined;
          },
          getImageSupport: (modelId: string) => {
            for (const connection of connections) {
              const model = connection.models.find(
                (entry) => droidCustomModelId(connection.id, entry.id) === modelId,
              );
              if (model) return droidModelImages(model);
            }
            return undefined;
          },
          isConfigurationCurrent: () => !invalidated && !refreshPending,
          isConfigurationRetired: () => invalidated,
          checkConfiguration: () => assertCurrent,
          start: () => assertCurrent.pipe(Effect.andThen(runtime.start())),
          setModel: (modelId: string) =>
            assertCurrent.pipe(Effect.andThen(runtime.setModel(modelId))),
          prompt: (...args: Parameters<typeof runtime.prompt>) =>
            assertCurrent.pipe(Effect.andThen(runtime.prompt(...args))),
        };
      }).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.onError(() => invalidate),
      );
    });
});
