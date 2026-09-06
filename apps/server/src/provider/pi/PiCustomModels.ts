// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { customModelImageInput } from "@t3tools/contracts";
import type {
  CustomModel,
  CustomModelConnection,
  CustomModelProtocol,
  ModelReasoningMetadata,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { customModelProviderId } from "../../customModels.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { assessModelConnections } from "../../customModelReadiness.ts";
import {
  customModelRuntimeChange,
  effectiveCustomModelReasoning,
} from "../../customModelCapabilities.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import {
  makePiRpcClient,
  PiRpcProtocolError,
  PiRpcConfigurationError,
  type PiRpcClient,
  type PiRpcSpawnOptions,
} from "./PiRpcClient.ts";
import type { PiRpcModel } from "./PiRpcSchema.ts";

/** Explicit maps prevent Pi from inventing its standard Off–High ladder. */
export function piCustomModelReasoning(
  model: CustomModel,
  protocol: CustomModelProtocol,
  baseUrl?: string,
) {
  const metadata = effectiveCustomModelReasoning(model, protocol);
  const override = model.reasoningOverride;
  const known = metadata?.status === "known" && metadata.supported === true;
  const levels = known ? metadata.levels : [];
  return {
    // Unknown means omit reasoning controls on the wire, not 'reasoning off'.
    reasoning: known,
    thinkingLevelMap: Object.fromEntries(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
        level,
        levels.includes(level as (typeof levels)[number])
          ? level === "off"
            ? "none"
            : level
          : null,
      ]),
    ),
    // Pi's compatibility heuristics suppress this parameter for some hosts
    // (including xAI). An explicit effort capability must survive serialization.
    ...(known && protocol === "openai-completions"
      ? {
          compat: {
            supportsReasoningEffort: true,
            thinkingFormat:
              baseUrl?.replace(/\/$/, "") === "https://openrouter.ai/api/v1"
                ? "openrouter"
                : "openai",
          },
        }
      : {}),
    ...(known && protocol === "anthropic-messages" && (override || metadata?.mode === "adaptive")
      ? { compat: { forceAdaptiveThinking: true } }
      : {}),
  };
}

const REFRESH_COMMAND = "scient-models-refresh";
/** Endpoint and protocol are part of identity; a familiar model name is not sufficient. */
export function piNativeProviderId(baseUrl: string, protocol: CustomModelProtocol) {
  const url = baseUrl.replace(/\/+$/, "");
  if (url === "https://api.openai.com/v1" && protocol === "openai-responses") return "openai";
  if (url === "https://api.anthropic.com" && protocol === "anthropic-messages") return "anthropic";
  if (url === "https://openrouter.ai/api/v1" && protocol === "openai-completions")
    return "openrouter";
  if (url === "https://api.x.ai/v1" && protocol === "openai-responses") return "xai";
  return undefined;
}
// The generated extension contains no credentials. Only its owning Pi process
// receives the scoped bootstrap capability; it is removed from child environments.
export const PI_CUSTOM_MODELS_EXTENSION = `
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
export default async function(pi) {
  const url = process.env.SCIENT_PI_MODELS_URL;
  const token = process.env.SCIENT_PI_MODELS_TOKEN;
  delete process.env.SCIENT_PI_MODELS_URL;
  delete process.env.SCIENT_PI_MODELS_TOKEN;
  const registered = new Map();
  const builtins = new Map(builtinProviders().map(provider => [provider.id, provider]));
  let registry;
  function register(connection) {
    const config = connection.config;
    if (!connection.nativeProviderId && !config.models.some(model => model.automatic)) {
      pi.registerProvider(connection.id, config);
      return;
    }
    const native = () => registry?.getProvider(connection.nativeProviderId) ?? builtins.get(connection.nativeProviderId);
    const definitions = new Map(config.models.map(model => [model.id, model]));
    const nativeModel = model => native()?.getModels().find(entry => entry.id === model.id && entry.api === config.api);
    const getModels = () => config.models.flatMap(definition => {
      const { automatic, reasoningOverride, imageInput, ...manual } = definition;
      const source = nativeModel(definition);
      const inherited = automatic && source;
      // Unknown automatic models have no invented fallback capacity.
      if (automatic && !inherited && !(manual.contextWindow > 0 && manual.maxTokens > 0)) return [];
      return [{ ...(inherited || manual),
        input: imageInput === "automatic" && source ? source.input : manual.input,
        // Manual capacity does not opt out of native reasoning capabilities.
        ...(source && !reasoningOverride ? { reasoning: source.reasoning,
          thinkingLevelMap: source.thinkingLevelMap, compat: source.compat } : {}),
        ...(inherited && reasoningOverride ? { reasoning: manual.reasoning,
          thinkingLevelMap: manual.thinkingLevelMap, compat: { ...inherited.compat, ...manual.compat } } : {}),
        id: definition.id, name: definition.name, provider: connection.id,
        api: config.api, baseUrl: config.baseUrl }];
    });
    // Native history conversion and compatibility checks use the transport identity.
    // Selection stays connection-scoped; assistant messages retain the native identity.
    const usesNativeTransport = model => definitions.get(model.id)?.automatic &&
      native()?.getModels().some(entry => entry.api === model.api);
    const route = model => usesNativeTransport(model) ? { ...model, provider: native().id } : model;
    const dispatch = (method, model, context, options) => {
      const provider = usesNativeTransport(model) ? native() : getApiProvider(model.api);
      return provider[method](route(model), context, options);
    };
    pi.registerProvider({
      id: connection.id, name: config.name, baseUrl: config.baseUrl,
      // A literal bound to this connection; never substitute a native profile credential.
      auth: { apiKey: { name: "Scient connection",
        login: async () => { throw new Error("Manage this key in Scient."); },
        check: async () => ({ type: "api_key", source: "Scient connection" }),
        resolve: async () => ({ auth: { apiKey: connection.literalKey }, source: "Scient connection" }) } },
      getModels,
      // The native registry owns refresh/cache identity. We only read its current catalog.
      stream: (model, context, options) => dispatch("stream", model, context, options),
      streamSimple: (model, context, options) => dispatch("streamSimple", model, context, options),
      ...(native()?.filterModels ? { filterModels: (models) => native().filterModels(
        models.map(route), { type: "api_key", key: connection.literalKey }
      ).map(model => ({ ...model, provider: connection.id })) } : {}),
      ...(native()?.fetchDeferred ? { fetchDeferred: (model, handle, options) => native().fetchDeferred(route(model), handle, options) } : {}),
      ...(native()?.cancelDeferred ? { cancelDeferred: (model, handle, options) => native().cancelDeferred(route(model), handle, options) } : {}),
    });
  }
  async function refresh() {
    const response = await fetch(url, {
      headers: { authorization: "Bearer " + token },
      redirect: "error", signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error("Could not load Scient custom models.");
    const connections = await response.json();
    const present = new Set(connections.map(connection => connection.id));
    for (const id of registered.keys()) {
      if (!present.has(id)) {
        pi.unregisterProvider(id);
        registered.delete(id);
      }
    }
    for (const connection of connections) {
      const signature = JSON.stringify(connection);
      const source = registry?.getProvider(connection.nativeProviderId) ?? builtins.get(connection.nativeProviderId);
      const previous = registered.get(connection.id);
      // Rebind changed native implementations too, including newly added/removed hooks.
      if (previous?.signature === signature && previous.source === source) continue;
      if (registered.has(connection.id)) pi.unregisterProvider(connection.id);
      register(connection);
      registered.set(connection.id, { signature, source });
    }
  }
  await refresh();
  pi.on("session_start", async (_event, ctx) => { registry = ctx.modelRegistry; await refresh(); });
  pi.registerCommand("${REFRESH_COMMAND}", { description: "Refresh Scient models",
    handler: async (_args, ctx) => { registry = ctx.modelRegistry; await refresh(); } });
}
`;

/** One integration path for discovery, chat, and background generation. */
export const makePiCustomModelsClientFactory = Effect.fn("PiCustomModels.make")(function* (
  settings: Pick<
    ServerSettingsService["Service"],
    "resolveCustomModels" | "getSettings" | "subscribeChanges"
  >,
  instanceId: ProviderInstanceId,
  stateDir: string,
  makeClient: typeof makePiRpcClient = makePiRpcClient,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, "pi", "extensions");
  yield* fs.makeDirectory(directory, { recursive: true });
  const extensionPath = path.join(directory, "scient-custom-models.mjs");
  yield* writeFileStringAtomically({
    filePath: extensionPath,
    contents: PI_CUSTOM_MODELS_EXTENSION,
    mode: 0o600,
  });
  return (options: PiRpcSpawnOptions) =>
    Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      let loaded: ReadonlyArray<CustomModelConnection> = [];
      let resolvedConnections: ReadonlyArray<ResolvedModelConnection> = [];
      let retired = false;
      let nativeClient: PiRpcClient | undefined;
      let closed = false;
      const retire = Effect.gen(function* () {
        retired = true;
        if (nativeClient && !closed) {
          closed = true;
          yield* nativeClient.close();
        }
      });
      const checkAuthority = Effect.gen(function* () {
        const current = yield* settings.getSettings.pipe(
          Effect.mapError(
            () => new PiRpcConfigurationError({ detail: "Could not check Pi model connections." }),
          ),
        );
        if (
          retired ||
          customModelRuntimeChange(loaded, current.customModels.connections, instanceId) ===
            "revoke"
        ) {
          yield* retire;
          return yield* new PiRpcProtocolError({
            detail: "Model connections changed. Start a new turn to reconnect.",
          });
        }
      });
      yield* changes.pipe(
        Stream.runForEach(() =>
          checkAuthority.pipe(
            Effect.catch(() =>
              retired ? Effect.void : Effect.logWarning("Could not verify Pi model connections."),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const context = yield* Effect.context<never>();
      const token = NodeCrypto.randomBytes(32).toString("hex");
      const expected = Buffer.from("Bearer " + token);
      let unavailableConnections = new Map<string, string>();
      let reasoningMetadata = new Map<string, ModelReasoningMetadata>();
      let reasoningPreferences = new Map<string, CustomModel["defaultReasoningLevel"]>();
      let automaticModels = new Set<string>();
      const modelKey = (provider: string, id: string) => JSON.stringify([provider, id]);
      const annotate = (model: PiRpcModel): PiRpcModel => {
        const metadata = reasoningMetadata.get(modelKey(model.provider, model.id));
        const defaultReasoningLevel = reasoningPreferences.get(modelKey(model.provider, model.id));
        return {
          ...model,
          ...(metadata ? { reasoningMetadata: metadata } : {}),
          ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
        };
      };
      const server = NodeHttp.createServer((request, response) => {
        const supplied = Buffer.from(request.headers.authorization ?? "");
        if (
          request.method !== "GET" ||
          request.url !== "/models" ||
          supplied.length !== expected.length ||
          !NodeCrypto.timingSafeEqual(supplied, expected)
        ) {
          response.writeHead(403).end();
          return;
        }
        void Effect.runPromiseWith(context)(
          Effect.gen(function* () {
            yield* checkAuthority;
            const connections = yield* settings.resolveCustomModels(instanceId);
            if (customModelRuntimeChange(loaded, connections, instanceId) === "revoke") {
              yield* retire;
            }
            if (retired)
              return yield* new PiRpcProtocolError({
                detail: "Pi model connections were retired.",
              });
            resolvedConnections = connections;
            loaded = connections.filter((connection) => connection.credentialError === undefined);
            yield* checkAuthority;
            return connections;
          }),
        ).then(
          (connections) => {
            reasoningPreferences = new Map(
              connections.flatMap((connection) =>
                connection.models.map(
                  (model) =>
                    [
                      modelKey(customModelProviderId(connection.id), model.modelId),
                      model.defaultReasoningLevel ??
                        (model.reasoningOverride?.defaultLevel === "off"
                          ? undefined
                          : model.reasoningOverride?.defaultLevel),
                    ] as const,
                ),
              ),
            );
            automaticModels = new Set(
              connections.flatMap((connection) =>
                connection.models
                  .filter((model) => model.configurationMode === "automatic")
                  .map((model) => modelKey(customModelProviderId(connection.id), model.modelId)),
              ),
            );
            reasoningMetadata = new Map(
              connections.flatMap((connection) =>
                connection.models.flatMap((model) =>
                  model.reasoningMetadata &&
                  !model.reasoningOverride &&
                  !piNativeProviderId(connection.baseUrl, connection.protocol)
                    ? [
                        [
                          modelKey(customModelProviderId(connection.id), model.modelId),
                          model.reasoningMetadata,
                        ] as const,
                      ]
                    : [],
                ),
              ),
            );
            unavailableConnections = new Map(
              connections.flatMap((connection) =>
                connection.credentialError !== undefined
                  ? [[customModelProviderId(connection.id), connection.credentialError]]
                  : [],
              ),
            );
            const result = connections.flatMap((connection) => {
              if (connection.credentialError !== undefined) return [];
              const key = connection.apiKey ? Redacted.value(connection.apiKey) : "scient-keyless";
              // Pi's config API supports shell/env expressions. User keys are literals.
              const escaped = key.replaceAll("$", () => "$$");
              const literalKey = escaped.startsWith("!") ? "$" + escaped : escaped;
              return [
                {
                  id: customModelProviderId(connection.id),
                  nativeProviderId: piNativeProviderId(connection.baseUrl, connection.protocol),
                  literalKey: key,
                  config: {
                    name: connection.name,
                    api: connection.protocol,
                    baseUrl: connection.baseUrl,
                    apiKey: literalKey,
                    models: connection.models.map((model) => ({
                      automatic: model.configurationMode === "automatic",
                      imageInput: customModelImageInput(model),
                      reasoningOverride: Boolean(model.reasoningOverride),
                      id: model.modelId,
                      name: model.name,
                      ...piCustomModelReasoning(model, connection.protocol, connection.baseUrl),
                      input: (
                        customModelImageInput(model) === "automatic"
                          ? model.reasoningMetadata?.images
                          : customModelImageInput(model) === "enabled"
                      )
                        ? ["text", "image"]
                        : ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow:
                        model.configurationMode === "automatic"
                          ? model.reasoningMetadata?.contextWindow
                          : model.contextWindow,
                      maxTokens:
                        model.configurationMode === "automatic"
                          ? model.reasoningMetadata?.maxOutputTokens
                          : model.maxOutputTokens,
                    })),
                  },
                },
              ];
            });
            response
              .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify(result));
          },
          () => response.writeHead(503).end(),
        );
      });
      server.requestTimeout = 5000;
      server.headersTimeout = 5000;
      server.maxConnections = 4;
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
              });
            }),
          catch: () => new PiRpcProtocolError({ detail: "Could not prepare custom models." }),
        }),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        return yield* new PiRpcProtocolError({ detail: "Could not prepare custom models." });
      const client = yield* makeClient({
        ...options,
        args: [...(options.args ?? []), "--extension", extensionPath],
        env: {
          ...(options.env ?? process.env),
          SCIENT_PI_MODELS_URL: `http://127.0.0.1:${address.port}/models`,
          SCIENT_PI_MODELS_TOKEN: token,
        },
      });
      nativeClient = client;
      yield* checkAuthority;
      const commands = yield* client.getCommands();
      if (!commands.commands.some((command) => command.name === REFRESH_COMMAND))
        return yield* new PiRpcProtocolError({
          detail: "Pi could not load the Scient model integration.",
        });
      return {
        ...client,
        assessModelConnections: (models: ReadonlyArray<PiRpcModel>) =>
          assessModelConnections(resolvedConnections, (connection, model) => {
            const native = models.find(
              (entry) =>
                entry.provider === customModelProviderId(connection.id) &&
                entry.id === model.modelId,
            );
            return native
              ? {
                  contextWindow: native.contextWindow,
                  maxOutputTokens: native.maxTokens,
                  source: model.configurationMode === "automatic" ? "agent" : "manual",
                }
              : undefined;
          }),
        prompt: (...args: Parameters<typeof client.prompt>) =>
          checkAuthority.pipe(Effect.andThen(client.prompt(...args))),
        setModel: (provider: string, modelId: string) =>
          client.prompt("/" + REFRESH_COMMAND).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const detail = unavailableConnections.get(provider);
                return detail === undefined
                  ? client.setModel(provider, modelId).pipe(
                      Effect.map(annotate),
                      Effect.mapError((cause) =>
                        cause._tag === "PiRpcCommandError" &&
                        cause.command === "set_model" &&
                        automaticModels.has(modelKey(provider, modelId))
                          ? new PiRpcProtocolError({
                              detail:
                                "Automatic settings are unavailable for this model. Check the model ID, update Pi, or configure the model manually.",
                              cause,
                            })
                          : cause,
                      ),
                    )
                  : Effect.fail(new PiRpcProtocolError({ detail }));
              }),
            ),
          ),
        getAvailableModels: () =>
          client.prompt("/" + REFRESH_COMMAND).pipe(
            Effect.andThen(client.getAvailableModels()),
            Effect.map((inventory) => ({ ...inventory, models: inventory.models.map(annotate) })),
          ),
        getState: () =>
          client.getState().pipe(
            Effect.map((state) => ({
              ...state,
              ...(state.model ? { model: annotate(state.model) } : {}),
            })),
          ),
        getThinkingLevels: () =>
          Effect.gen(function* () {
            const state = yield* client.getState();
            const metadata =
              state.model && reasoningMetadata.get(modelKey(state.model.provider, state.model.id));
            const reported = yield* client.getThinkingLevels();
            return metadata
              ? {
                  ...reported,
                  levels: reported.levels.filter((level) => metadata.levels.includes(level)),
                }
              : reported;
          }),
        getCommands: () =>
          client.getCommands().pipe(
            Effect.map((commands) => ({
              ...commands,
              commands: commands.commands.filter((command) => command.name !== REFRESH_COMMAND),
            })),
          ),
      };
    });
});
