// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import {
  customModelImageInput,
  type ProviderInstanceId,
  type CustomModel,
  type CustomModelProtocol,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { OmpRpcProtocolError, type OmpRpcError } from "effect-omp-rpc/errors";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { customModelProviderId, type ResolvedModelConnection } from "../../customModels.ts";
import { assessModelConnections } from "../../customModelReadiness.ts";
import {
  customModelRuntimeChange,
  effectiveCustomModelReasoning,
} from "../../customModelCapabilities.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import {
  makeOmpRpcProcess,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "./OmpRpcProcess.ts";

export const OMP_CUSTOM_MODELS_EXTENSION = `
const url = process.env.SCIENT_OMP_MODELS_URL;
const token = process.env.SCIENT_OMP_MODELS_TOKEN;
const secrets = new Map();
for (const name of Object.keys(process.env)) {
  if (!name.startsWith("SCIENT_OMP_MODEL_KEY_")) continue;
  const value = process.env[name];
  if (value !== undefined) secrets.set(name, value);
  delete process.env[name];
}
delete process.env.SCIENT_OMP_MODELS_URL;
delete process.env.SCIENT_OMP_MODELS_TOKEN;

export default async function (pi) {
  if (!url || !token) throw new Error("Scient custom-model bootstrap is missing.");
  const registered = new Map();
  let refreshPromise;
  const refresh = () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const response = await fetch(url, {
        headers: { authorization: "Bearer " + token },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Could not load Scient custom models.");
      const connections = await response.json();
      if (!Array.isArray(connections)) throw new Error("Scient custom models were malformed.");
      const present = new Set(connections.map(connection => connection.id));
      for (const id of registered.keys()) {
        if (!present.has(id)) {
          pi.unregisterProvider(id);
          registered.delete(id);
        }
      }
      for (const connection of connections) {
        const signature = JSON.stringify(connection);
        if (registered.get(connection.id) === signature) continue;
        if (registered.has(connection.id)) pi.unregisterProvider(connection.id);
        let apiKey = connection.apiKey;
        if (connection.apiKey !== "scient-keyless") {
          const literal = secrets.get(connection.apiKey);
          if (literal === undefined) throw new Error("A Scient custom-model credential is unavailable.");
          if (literal.startsWith("!")) {
            // OMP interprets a leading ! as a shell-backed config value. Keep
            // only this pathological key environment-backed so it is never
            // executed as a command.
            process.env[connection.apiKey] = literal;
          } else {
            apiKey = literal;
          }
        }
        pi.registerProvider(connection.id, {
          name: connection.name,
          baseUrl: connection.baseUrl,
          api: connection.api,
          apiKey,
          models: connection.models,
        });
        registered.set(connection.id, signature);
      }
    })().finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  };
  pi.registerCommand("scient-models-refresh", {
    description: "Refresh Scient custom models",
    handler: async () => { await refresh(); },
  });
  pi.on("session_start", async () => { await refresh(); });
  const timer = setInterval(() => {
    refresh().catch(() => undefined);
  }, 5000);
  timer.unref?.();
  pi.on("session_shutdown", () => clearInterval(timer));
  await refresh();
}
`;

type OmpProcessFactory = (
  options: OmpRpcProcessOptions,
) => Effect.Effect<
  OmpRpcProcess,
  OmpRpcError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
>;

const OMP_MODEL_KEY_PREFIX = "SCIENT_OMP_MODEL_KEY_";
// OMP's provider-model schema accepts positive effort names only. Its
// `reasoning: false` bit represents the off state.
const OMP_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type OmpReasoningLevel = (typeof OMP_REASONING_LEVELS)[number];

const isReasoningLevel = (value: string): value is OmpReasoningLevel =>
  OMP_REASONING_LEVELS.includes(value as OmpReasoningLevel);

const safeEnvironmentName = (value: string): string =>
  `${OMP_MODEL_KEY_PREFIX}${NodeCrypto.createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 32)}`;

const modelPayload = (model: CustomModel, protocol: CustomModelProtocol) => {
  const metadata = effectiveCustomModelReasoning(model, protocol);
  const automatic = model.configurationMode === "automatic";
  const contextWindow =
    model.contextWindow ?? (automatic ? model.reasoningMetadata?.contextWindow : undefined);
  const maxTokens =
    model.maxOutputTokens ?? (automatic ? model.reasoningMetadata?.maxOutputTokens : undefined);
  if (contextWindow === undefined || maxTokens === undefined) return undefined;
  const reasoning = model.reasoningOverride?.supported ?? metadata?.supported ?? model.reasoning;
  const requestedLevels = metadata?.levels ?? model.reasoningOverride?.levels;
  const levels = reasoning ? (requestedLevels ?? []).filter(isReasoningLevel) : [];
  const hasExplicitLevels = requestedLevels !== undefined;
  const advertisedReasoning = reasoning && (!hasExplicitLevels || levels.length > 0);
  const thinkingMode =
    protocol === "anthropic-messages"
      ? metadata?.mode === "adaptive"
        ? "anthropic-adaptive"
        : "budget"
      : "effort";
  const requestedDefault = model.defaultReasoningLevel ?? metadata?.defaultLevel;
  const defaultLevel =
    requestedDefault && isReasoningLevel(requestedDefault) && levels.includes(requestedDefault)
      ? requestedDefault
      : undefined;
  const imageInput = customModelImageInput(model);
  return {
    id: model.modelId,
    name: model.name,
    api: protocol,
    reasoning: advertisedReasoning,
    ...(levels.length > 0
      ? {
          thinking: {
            mode: thinkingMode,
            efforts: levels,
            ...(defaultLevel ? { defaultLevel } : {}),
          },
        }
      : {}),
    input:
      imageInput === "enabled" ||
      (imageInput === "automatic" && model.reasoningMetadata?.images === true)
        ? ["text", "image"]
        : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
};

interface OmpModelServerPayload {
  readonly id: string;
  readonly name: string;
  readonly api: CustomModelProtocol;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<NonNullable<ReturnType<typeof modelPayload>>>;
}

type PublishableModelConnection = ResolvedModelConnection & {
  readonly credentialError?: never;
  readonly apiKey: Redacted.Redacted<string> | null;
};

const publishableConnections = (
  connections: ReadonlyArray<ResolvedModelConnection>,
): ReadonlyArray<PublishableModelConnection> =>
  connections.flatMap((connection) => {
    if (connection.credentialError !== undefined) return [];
    const models = connection.models.filter((model) => modelPayload(model, connection.protocol));
    return models.length === 0 ? [] : [{ ...connection, models }];
  });

export const buildOmpCustomModelPayload = (
  connections: ReadonlyArray<ResolvedModelConnection>,
): {
  readonly payload: ReadonlyArray<OmpModelServerPayload>;
  readonly environment: Record<string, string>;
} => {
  const payload: Array<OmpModelServerPayload> = [];
  const environment: Record<string, string> = {};
  publishableConnections(connections).forEach((connection) => {
    const models = connection.models.flatMap((model) => {
      const value = modelPayload(model, connection.protocol);
      return value ? [value] : [];
    });
    const key = connection.apiKey === null ? null : Redacted.value(connection.apiKey);
    const apiKey = key === null ? "scient-keyless" : safeEnvironmentName(connection.id);
    if (key !== null) environment[apiKey] = key;
    payload.push({
      id: customModelProviderId(connection.id),
      name: connection.name,
      api: connection.protocol,
      baseUrl: connection.baseUrl,
      apiKey,
      models,
    });
  });
  return { payload, environment };
};

const publishableConnectionIds = (
  connections: ReadonlyArray<ResolvedModelConnection>,
): ReadonlySet<string> =>
  new Set(publishableConnections(connections).map((connection) => connection.id));

/**
 * A newly attached keyed connection cannot be added to an existing process
 * because its key was intentionally not placed in the parent environment.
 * Keep the current turn alive and require the next session process to pick it
 * up, rather than interrupting an in-flight turn.
 */
const pendingCredentialConnectionIds = (
  loaded: ReadonlyArray<ResolvedModelConnection>,
  current: ReadonlyArray<ResolvedModelConnection>,
): ReadonlySet<string> => {
  const loadedIds = publishableConnectionIds(loaded);
  return new Set(
    publishableConnections(current)
      .filter((connection) => connection.apiKey !== null && !loadedIds.has(connection.id))
      .map((connection) => connection.id),
  );
};

/**
 * OMP resolves an environment-backed key when a provider is registered. A
 * credential rotation or endpoint/protocol change therefore needs a fresh
 * process; model metadata changes can be refreshed safely inside the existing
 * process.
 */
const requiresCredentialRestart = (
  loaded: ReadonlyArray<ResolvedModelConnection>,
  current: ReadonlyArray<ResolvedModelConnection>,
): boolean => {
  const currentById = new Map(current.map((connection) => [connection.id, connection]));
  return loaded.some((connection) => {
    const next = currentById.get(connection.id);
    return (
      next === undefined ||
      next.credentialError !== undefined ||
      next.credentialId !== connection.credentialId ||
      next.baseUrl !== connection.baseUrl ||
      next.protocol !== connection.protocol
    );
  });
};

const listen = (server: NodeHttp.Server) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
      }),
    catch: (cause) =>
      new OmpRpcProtocolError({ detail: "Could not prepare OMP custom models.", cause }),
  });

const close = (server: NodeHttp.Server) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

/**
 * Creates a process factory that loads a credential-free OMP extension. The
 * extension receives model definitions over an authenticated loopback endpoint.
 * Publishable connection keys are bootstrapped by generated environment names,
 * then moved into the extension's private registration closure; they are never
 * written to the extension file or process arguments.
 */
export const makeOmpCustomModelsClientFactory = Effect.fn("OmpCustomModels.makeClientFactory")(
  function* (
    settings: Pick<ServerSettingsService["Service"], "resolveCustomModels" | "subscribeChanges">,
    instanceId: ProviderInstanceId,
    stateDir: string,
    makeProcess: OmpProcessFactory = makeOmpRpcProcess,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const extensionDirectory = path.join(stateDir, "omp", "extensions");
    const extensionPath = path.join(extensionDirectory, "scient-custom-models.mjs");
    yield* fs.makeDirectory(extensionDirectory, { recursive: true });
    yield* writeFileStringAtomically({
      filePath: extensionPath,
      contents: OMP_CUSTOM_MODELS_EXTENSION,
      mode: 0o600,
    });
    return (options: OmpRpcProcessOptions) =>
      Effect.gen(function* () {
        // Subscribe before the initial read so a settings change cannot be
        // missed between startup resolution and the live bridge.
        const changes = yield* settings.subscribeChanges;
        const initialConnections = yield* settings
          .resolveCustomModels(instanceId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OmpRpcProtocolError({ detail: "Could not resolve OMP custom models.", cause }),
            ),
          );
        let loaded = publishableConnections(initialConnections);
        let resolvedConnections = initialConnections;
        let pendingCredentialIds: ReadonlySet<string> = new Set();
        let retired = false;
        let closed = false;
        let native: OmpRpcProcess | undefined;
        const authority = yield* Semaphore.make(1);
        const token = NodeCrypto.randomBytes(32).toString("hex");
        const expected = Buffer.from(`Bearer ${token}`);
        const resolveCurrent: Effect.Effect<
          ReadonlyArray<ResolvedModelConnection>,
          OmpRpcProtocolError
        > = Effect.suspend(() => settings.resolveCustomModels(instanceId)).pipe(
          Effect.mapError(
            (cause) =>
              new OmpRpcProtocolError({ detail: "Could not resolve OMP custom models.", cause }),
          ),
        );
        const fail = (detail: string): Effect.Effect<never, OmpRpcProtocolError> =>
          Effect.fail(new OmpRpcProtocolError({ detail }));
        const retire: Effect.Effect<void, never, never> = Effect.gen(function* () {
          if (retired) return;
          retired = true;
          if (native) {
            yield* native.shutdown.pipe(Effect.ignore);
            yield* native.close();
          }
        });
        const readAuthority: Effect.Effect<void, OmpRpcProtocolError> = Effect.gen(function* () {
          if (retired || closed) return yield* fail("Oh My Pi model connections are retired.");
          const current = yield* resolveCurrent;
          resolvedConnections = current;
          if (retired || closed) return yield* fail("Oh My Pi model connections are retired.");
          pendingCredentialIds = pendingCredentialConnectionIds(loaded, current);
          const change = customModelRuntimeChange(loaded, current, instanceId);
          if (change === "revoke" || requiresCredentialRestart(loaded, current)) {
            yield* retire;
            return yield* fail(
              "Scient model connections changed. Start a new turn to reconnect to Oh My Pi.",
            );
          }
        });
        const synchronizeAuthority: Effect.Effect<void, OmpRpcError> =
          authority.withPermit(readAuthority);
        const guarded = <A>(effect: Effect.Effect<A, OmpRpcError>): Effect.Effect<A, OmpRpcError> =>
          synchronizeAuthority.pipe(Effect.andThen(effect));
        const effectContext = yield* Effect.context<never>();

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
          void Effect.runPromiseWith(effectContext)(
            authority.withPermit(
              Effect.gen(function* () {
                if (retired || closed)
                  return yield* fail("Oh My Pi model connections are retired.");
                const current = resolvedConnections;
                pendingCredentialIds = pendingCredentialConnectionIds(loaded, current);
                const active = current.filter(
                  (connection) => !pendingCredentialIds.has(connection.id),
                );
                const change = customModelRuntimeChange(loaded, active, instanceId);
                if (change === "revoke" || requiresCredentialRestart(loaded, active)) {
                  yield* retire;
                  return yield* fail(
                    "Scient model connections changed. Start a new turn to reconnect to Oh My Pi.",
                  );
                }
                const next = buildOmpCustomModelPayload(active);
                loaded = publishableConnections(active);
                return next.payload;
              }),
            ),
          ).then(
            (payload) => {
              if (retired || closed) {
                response.writeHead(503).end();
                return;
              }
              response
                .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
                .end(JSON.stringify(payload));
            },
            () => response.writeHead(503).end(),
          );
        });
        server.requestTimeout = 5_000;
        server.headersTimeout = 5_000;
        server.maxConnections = 4;
        yield* Effect.acquireRelease(listen(server), () => close(server));
        const address = server.address();
        if (!address || typeof address === "string") {
          return yield* fail("Could not determine the OMP custom-model endpoint.");
        }
        native = yield* makeProcess({
          ...options,
          env: {
            ...(options.env ?? process.env),
            ...buildOmpCustomModelPayload(initialConnections).environment,
            SCIENT_OMP_MODELS_URL: `http://127.0.0.1:${address.port}/models`,
            SCIENT_OMP_MODELS_TOKEN: token,
          },
          extraArgs: [...(options.extraArgs ?? []), "--extension", extensionPath],
        });
        if (!native) return yield* fail("Oh My Pi has not started.");
        const nativeProcess: OmpRpcProcess = native;
        yield* changes.pipe(
          Stream.runForEach(() =>
            synchronizeAuthority.pipe(
              Effect.catch(() =>
                retired
                  ? Effect.void
                  : Effect.logWarning("Could not verify OMP model connections."),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        const wrapped: OmpRpcProcess = {
          ...nativeProcess,
          assessModelConnections: (models) =>
            assessModelConnections(resolvedConnections, (connection, model) => {
              const available = models.some(
                (candidate) =>
                  candidate.provider === customModelProviderId(connection.id) &&
                  candidate.id === model.modelId,
              );
              if (!available) return undefined;
              return {
                contextWindow: model.contextWindow ?? model.reasoningMetadata?.contextWindow,
                maxOutputTokens: model.maxOutputTokens ?? model.reasoningMetadata?.maxOutputTokens,
                source: model.configurationMode === "automatic" ? "agent" : "manual",
              };
            }),
          ready: nativeProcess.ready,
          events: nativeProcess.events,
          flushEvents: nativeProcess.flushEvents,
          command: (body) => guarded(nativeProcess.command(body)),
          prompt: (input) => guarded(nativeProcess.prompt(input)),
          steer: (message, images) => guarded(nativeProcess.steer(message, images)),
          followUp: (message, images) => guarded(nativeProcess.followUp(message, images)),
          abort: () => nativeProcess.abort(),
          getState: () => guarded(nativeProcess.getState()),
          getModels: () => guarded(nativeProcess.getModels()),
          getCommands: () => guarded(nativeProcess.getCommands()),
          setModel: (provider, modelId) => guarded(nativeProcess.setModel(provider, modelId)),
          setThinkingLevel: (level) => guarded(nativeProcess.setThinkingLevel(level)),
          compact: (instructions) => guarded(nativeProcess.compact(instructions)),
          switchSession: (sessionPath) => guarded(nativeProcess.switchSession(sessionPath)),
          setSubagentSubscription: (level) => guarded(nativeProcess.setSubagentSubscription(level)),
          setHostTools: (tools) => guarded(nativeProcess.setHostTools(tools)),
          setHostUriSchemes: (schemes) => guarded(nativeProcess.setHostUriSchemes(schemes)),
          extensionUiResponse: (response) => guarded(nativeProcess.extensionUiResponse(response)),
          hostToolUpdate: (result) => guarded(nativeProcess.hostToolUpdate(result)),
          hostToolResult: (result) => guarded(nativeProcess.hostToolResult(result)),
          hostUriResult: (result) => guarded(nativeProcess.hostUriResult(result)),
          close: () => {
            closed = true;
            return nativeProcess.close();
          },
          shutdown: Effect.suspend(() => {
            closed = true;
            return nativeProcess.shutdown;
          }),
        };
        return wrapped;
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
  },
);

export type OmpCustomModelsProcessFactory = ReturnType<typeof makeOmpCustomModelsClientFactory>;
