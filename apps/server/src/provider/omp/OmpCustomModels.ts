// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import {
  customModelImageInput,
  type ProviderInstanceId,
  type CustomModel,
  type CustomModelProtocol,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import { OmpRpcProtocolError, type OmpRpcError } from "effect-omp-rpc/errors";

import { customModelProviderId, type ResolvedModelConnection } from "../../customModels.ts";
import { assessModelConnections } from "../../customModelReadiness.ts";
import {
  customModelRuntimeChange,
  effectiveCustomModelReasoning,
} from "../../customModelCapabilities.ts";
import type { ServerSettings } from "@t3tools/contracts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { OmpExecutableGate } from "./OmpExecutableGate.ts";
import {
  ompExtensionBootstrapPrelude,
  ompExtensionProcessPrefix,
  writeOmpExtensionFiles,
} from "./OmpExtensionBootstrap.ts";
import { OMP_PENDING_CONNECTION_DETAIL, OmpModelRefreshError } from "./OmpModel.ts";
import {
  makeOmpRpcProcess,
  redactOmpDiagnostic,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "./OmpRpcProcess.ts";

/**
 * The generated extension OMP loads. It registers Scient's custom models, then
 * long-polls the loopback endpoint for a newer model generation. Each refresh
 * is acknowledged with the generation it applied (and any registration
 * error), so the server can wait until OMP really knows a model before it
 * selects one. A change that arrives mid-refresh runs the refresh again.
 *
 * The endpoint, its token and the connection keys come from the bootstrap
 * file (`OmpExtensionBootstrap`), never the environment. Keys are handed to
 * OMP as literal values: OMP reads a provider `apiKey` that names an
 * environment variable from `process.env`, which its shell tools can see, and
 * runs one that starts with `!` as a command, so neither form is used.
 *
 * The first run in a process owns the bridge: the refresh loop, the
 * acknowledgements and the refresh command. OMP re-runs the extension for
 * each in-process subagent; a re-run replays the current registrations into
 * the subagent's API and starts nothing.
 */
const OMP_CUSTOM_MODELS_EXTENSION_BODY = `
const scientModelsBridge = (bootstrap) => {
  const { url, token } = bootstrap;
  const keys = new Map(Object.entries(bootstrap.keys ?? {}));
  if (typeof url !== "string" || typeof token !== "string")
    throw new Error("Scient custom-model bootstrap is missing.");
  const stopped = new AbortController();
  /** id -> { signature, config } of what OMP currently has registered. */
  const registered = new Map();
  let owner;
  let initial;
  let applied = 0;
  const request = async (path, init, timeoutMs) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    stopped.signal.addEventListener("abort", abort, { once: true });
    try {
      return await fetch(url + path, {
        ...init,
        headers: { authorization: "Bearer " + token, ...(init?.headers ?? {}) },
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      stopped.signal.removeEventListener("abort", abort);
    }
  };
  const apiKeyFor = (connection) => {
    if (connection.apiKey === "scient-keyless") return connection.apiKey;
    const literal = keys.get(connection.apiKey);
    if (literal === undefined) throw new Error("A Scient custom-model credential is unavailable.");
    if (literal.startsWith("!"))
      throw new Error("Oh My Pi would run an API key that starts with ! as a command.");
    if (Object.hasOwn(process.env, literal))
      throw new Error("Oh My Pi would read an API key that names an environment variable from the environment.");
    return literal;
  };
  const register = (connections) => {
    const present = new Set(connections.map((connection) => connection.id));
    for (const id of registered.keys()) {
      if (!present.has(id)) {
        owner.unregisterProvider(id);
        registered.delete(id);
      }
    }
    for (const connection of connections) {
      const signature = JSON.stringify(connection);
      if (registered.get(connection.id)?.signature === signature) continue;
      if (registered.has(connection.id)) {
        owner.unregisterProvider(connection.id);
        registered.delete(connection.id);
      }
      const config = {
        name: connection.name,
        baseUrl: connection.baseUrl,
        api: connection.api,
        apiKey: apiKeyFor(connection),
        models: connection.models,
      };
      owner.registerProvider(connection.id, config);
      registered.set(connection.id, { signature, config });
    }
  };
  const acknowledge = async (generation, error) => {
    const response = await request("/applied", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(error === undefined ? { generation } : { generation, error }),
    }, 5000);
    if (!response.ok) throw new Error("Scient did not accept the custom-model acknowledgement.");
  };
  const load = async () => {
    const response = await request("", undefined, 5000);
    if (!response.ok) throw new Error("Could not load Scient custom models.");
    const body = await response.json();
    if (!body || !Number.isSafeInteger(body.generation) || !Array.isArray(body.connections)) {
      throw new Error("Scient custom models were malformed.");
    }
    applied = Math.max(applied, body.generation);
    try {
      register(body.connections);
    } catch (error) {
      await acknowledge(body.generation, error instanceof Error ? error.message : String(error));
      throw error;
    }
    await acknowledge(body.generation);
  };
  let running;
  let dirty = false;
  const refresh = () => {
    if (running) {
      dirty = true;
      return running;
    }
    running = (async () => {
      do {
        dirty = false;
        await load();
      } while (dirty);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  const watch = async () => {
    while (!stopped.signal.aborted) {
      try {
        const response = await request("/wait?after=" + applied, undefined, 60000);
        if (response.status === 403 || response.status === 503) return;
        if (!response.ok) {
          await pause(1000);
          continue;
        }
        const body = await response.json();
        if (Number.isSafeInteger(body?.generation) && body.generation > applied) await refresh();
      } catch {
        if (stopped.signal.aborted) return;
        await pause(1000);
      }
    }
  };
  const attach = async (pi) => {
    if (owner === undefined) {
      owner = pi;
      pi.registerCommand("scient-models-refresh", {
        description: "Refresh Scient custom models",
        handler: async () => { await refresh(); },
      });
      pi.on("session_start", async () => { await refresh(); });
      pi.on("session_shutdown", () => stopped.abort());
      initial = refresh();
      await initial;
      void watch();
      return;
    }
    await initial;
    for (const [id, { config }] of registered) pi.registerProvider(id, config);
  };
  return { attach };
};

export default async function scientOmpCustomModels(pi) {
  await scientOnce(scientModelsBridge).attach(pi);
}
`;

/** Module source of Scient's OMP custom-model extension, reading `bootstrapPath`. */
export const ompCustomModelsExtensionSource = (bootstrapPath: string): string =>
  `${ompExtensionBootstrapPrelude(bootstrapPath)}${OMP_CUSTOM_MODELS_EXTENSION_BODY}`;

type OmpProcessFactory = (
  options: OmpRpcProcessOptions,
) => Effect.Effect<
  OmpRpcProcess,
  OmpRpcError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
  | OmpExecutableGate
>;

/**
 * A connection's key is referenced by an opaque name in the model payload
 * the loopback endpoint serves; the key itself is only in the bootstrap.
 */
const OMP_MODEL_KEY_PREFIX = "scient-model-key-";
// OMP's provider-model schema accepts positive effort names only. Its
// `reasoning: false` bit represents the off state.
const OMP_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type OmpReasoningLevel = (typeof OMP_REASONING_LEVELS)[number];

const isReasoningLevel = (value: string): value is OmpReasoningLevel =>
  OMP_REASONING_LEVELS.includes(value as OmpReasoningLevel);

const keyReference = (value: string): string =>
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
  /** Key reference -> key, delivered only through the extension bootstrap. */
  readonly keys: Record<string, string>;
} => {
  const payload: Array<OmpModelServerPayload> = [];
  const keys: Record<string, string> = {};
  publishableConnections(connections).forEach((connection) => {
    const models = connection.models.flatMap((model) => {
      const value = modelPayload(model, connection.protocol);
      return value ? [value] : [];
    });
    const key = connection.apiKey === null ? null : Redacted.value(connection.apiKey);
    const apiKey = key === null ? "scient-keyless" : keyReference(connection.id);
    if (key !== null) keys[apiKey] = key;
    payload.push({
      id: customModelProviderId(connection.id),
      name: connection.name,
      api: connection.protocol,
      baseUrl: connection.baseUrl,
      apiKey,
      models,
    });
  });
  return { payload, keys };
};

/**
 * OMP runs a provider key that starts with `!` as a shell command, so such a
 * key is reported as unusable here rather than registered.
 */
const OMP_COMMAND_KEY_DETAIL =
  "Oh My Pi cannot use an API key that starts with “!”. Re-enter the key in Custom models.";

const ompConnections = (
  connections: ReadonlyArray<ResolvedModelConnection>,
): ReadonlyArray<ResolvedModelConnection> =>
  connections.map((connection) => {
    if (!connection.apiKey || !Redacted.value(connection.apiKey).startsWith("!")) return connection;
    const { apiKey: _apiKey, ...rest } = connection;
    return { ...rest, credentialError: OMP_COMMAND_KEY_DETAIL };
  });

const publishableConnectionIds = (
  connections: ReadonlyArray<ResolvedModelConnection>,
): ReadonlySet<string> =>
  new Set(publishableConnections(connections).map((connection) => connection.id));

/**
 * A newly attached keyed connection cannot be added to an existing process
 * because keys reach OMP only through the bootstrap it read at start.
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
 * OMP receives each key once, in the bootstrap it read at start. A
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

/** Timing of the model bridge. Tests shorten it; production uses the defaults. */
export interface OmpCustomModelsTiming {
  /** How long a refresh waits for OMP's acknowledgement. */
  readonly refreshTimeoutMs?: number | undefined;
  /** How long `GET /models/wait` holds before answering with no change. */
  readonly waitHoldMs?: number | undefined;
  /**
   * Node's per-request receive timeout, and how long a connection may stay
   * idle before it authenticates. The long-poll is not bound by it.
   */
  readonly requestTimeoutMs?: number | undefined;
  /** How often Node enforces its request and header timeouts. */
  readonly connectionsCheckingIntervalMs?: number | undefined;
}

const OMP_MODELS_REFRESH_TIMEOUT_MS = 5_000;
const OMP_MODELS_WAIT_HOLD_MS = 25_000;
const OMP_MODELS_REQUEST_TIMEOUT_MS = 5_000;
// Node's default is 30 s, which would let a stalled request hold a
// connection six times longer than the request timeout.
const OMP_MODELS_CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;
const OMP_MODELS_ACK_MAX_BYTES = 4096;
/**
 * Authorized requests in flight at once. The extension needs its long-poll,
 * a refresh and an acknowledgement; the rest is headroom. Unauthenticated
 * connections never count: they are closed as soon as they are refused or
 * stay idle for the request timeout.
 */
const OMP_MODELS_MAX_AUTHORIZED_REQUESTS = 8;
const OMP_MODELS_RETIRED_DETAIL = "Oh My Pi model connections are retired.";
const OMP_MODELS_CHANGED_DETAIL =
  "Scient model connections changed. Start a new turn to reconnect to Oh My Pi.";

/**
 * Model generations. Scient bumps `generation` whenever the models it would
 * serve change (or a refresh is forced); OMP's extension acknowledges each
 * generation it applied. A selection waits until `applied` reaches the
 * generation current when it started, so an in-flight refresh of an older
 * generation never satisfies a newer target.
 */
interface OmpModelBarrier {
  readonly generation: number;
  readonly applied: number;
  /** The latest acknowledged generation whose registration failed. */
  readonly failure?: { readonly generation: number; readonly detail: string } | undefined;
  readonly retired: boolean;
}

const OmpModelsAcknowledgement = Schema.fromJsonString(
  Schema.Struct({
    generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    error: Schema.optional(Schema.String),
  }),
);
const decodeAcknowledgement = Schema.decodeUnknownEffect(OmpModelsAcknowledgement);

const settingsRevision = (settings: ServerSettings): number | undefined => {
  // Change events are whole settings snapshots; custom models carry a revision.
  const catalog: Partial<ServerSettings["customModels"]> | undefined = settings.customModels;
  return typeof catalog?.revision === "number" ? catalog.revision : undefined;
};

/**
 * Creates a process factory that loads a credential-free OMP extension. The
 * extension receives model definitions over an authenticated loopback endpoint.
 * The endpoint token and publishable connection keys reach it only through its
 * per-process bootstrap file (`OmpExtensionBootstrap`), which it deletes while
 * OMP loads; they are never in OMP's environment, arguments or extension file.
 *
 * Connections are resolved (which reads the secret store) once at start and
 * again only when the custom-model settings revision changes or a refresh is
 * forced. Guarded RPCs check the cached authority and never read secrets.
 *
 * The loopback server is not shared with Pi's (`PiCustomModels`): this one
 * also serves the generation long-poll and acknowledgement, and Pi's resolves
 * settings per request. Sharing only the token and listen code would change
 * Pi's error text for no behavioural gain.
 */
export const makeOmpCustomModelsClientFactory = Effect.fn("OmpCustomModels.makeClientFactory")(
  function* (
    settings: Pick<ServerSettingsService["Service"], "resolveCustomModels" | "subscribeChanges">,
    instanceId: ProviderInstanceId,
    stateDir: string,
    makeProcess: OmpProcessFactory = makeOmpRpcProcess,
    timing: OmpCustomModelsTiming = {},
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Every process this factory starts leases its executable from the
    // server's gate, whichever caller runs it.
    const gate = yield* OmpExecutableGate;
    const refreshTimeoutMs = timing.refreshTimeoutMs ?? OMP_MODELS_REFRESH_TIMEOUT_MS;
    const waitHoldMs = timing.waitHoldMs ?? OMP_MODELS_WAIT_HOLD_MS;
    const requestTimeoutMs = timing.requestTimeoutMs ?? OMP_MODELS_REQUEST_TIMEOUT_MS;
    const connectionsCheckingInterval =
      timing.connectionsCheckingIntervalMs ?? OMP_MODELS_CONNECTIONS_CHECKING_INTERVAL_MS;
    const extensionDirectory = path.join(stateDir, "omp", "extensions");
    yield* fs.makeDirectory(extensionDirectory, { recursive: true });
    return (options: OmpRpcProcessOptions) =>
      Effect.gen(function* () {
        // Subscribe before the initial read so a settings change cannot be
        // missed between startup resolution and the live bridge.
        const changes = yield* settings.subscribeChanges;
        const initialConnections = yield* settings.resolveCustomModels(instanceId).pipe(
          Effect.map(ompConnections),
          Effect.mapError(
            (cause) =>
              new OmpRpcProtocolError({ detail: "Could not resolve OMP custom models.", cause }),
          ),
        );
        let loaded = publishableConnections(initialConnections);
        let resolvedConnections = initialConnections;
        /** The custom-model revision `resolvedConnections` was read at, when known. */
        let resolvedRevision: number | undefined;
        let pendingCredentialIds: ReadonlySet<string> = new Set();
        let retired = false;
        let closed = false;
        let native: OmpRpcProcess | undefined;
        const authority = yield* Semaphore.make(1);
        const token = NodeCrypto.randomBytes(32).toString("hex");
        const expected = Buffer.from(`Bearer ${token}`);
        const initialPayload = buildOmpCustomModelPayload(initialConnections);
        const payloadSignature = (connections: ReadonlyArray<ResolvedModelConnection>) =>
          JSON.stringify(buildOmpCustomModelPayload(connections).payload);
        let publishedSignature = payloadSignature(initialConnections);
        const barrier = yield* SubscriptionRef.make<OmpModelBarrier>({
          generation: 1,
          applied: 0,
          retired: false,
        });
        const markRetired = SubscriptionRef.update(barrier, (state) => ({
          ...state,
          retired: true,
        }));
        const resolveCurrent: Effect.Effect<
          ReadonlyArray<ResolvedModelConnection>,
          OmpRpcProtocolError
        > = Effect.suspend(() => settings.resolveCustomModels(instanceId)).pipe(
          Effect.map(ompConnections),
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
          yield* markRetired;
          if (native) {
            yield* native.shutdown.pipe(Effect.ignore);
            yield* native.close();
          }
        });
        const activeConnections = (current: ReadonlyArray<ResolvedModelConnection>) => {
          pendingCredentialIds = pendingCredentialConnectionIds(loaded, current);
          return current.filter((connection) => !pendingCredentialIds.has(connection.id));
        };
        /** Adopt a fresh resolution. Runs under the authority permit. */
        const adopt = (current: ReadonlyArray<ResolvedModelConnection>) =>
          Effect.gen(function* () {
            resolvedConnections = current;
            const active = activeConnections(current);
            const change = customModelRuntimeChange(loaded, current, instanceId);
            if (change === "revoke" || requiresCredentialRestart(loaded, current)) {
              yield* retire;
              return yield* fail(OMP_MODELS_CHANGED_DETAIL);
            }
            const signature = payloadSignature(active);
            if (signature !== publishedSignature) {
              publishedSignature = signature;
              yield* SubscriptionRef.update(barrier, (state) => ({
                ...state,
                generation: state.generation + 1,
              }));
            }
          });
        /**
         * Re-read the connections when the settings revision changed (or it is
         * unknown, or `force` is set). This is the only secret-store read after
         * startup.
         */
        const synchronize = (revision: number | undefined, force: boolean) =>
          authority.withPermit(
            Effect.gen(function* () {
              if (retired || closed) return yield* fail(OMP_MODELS_RETIRED_DETAIL);
              if (!force && revision !== undefined && revision === resolvedRevision) return;
              const current = yield* resolveCurrent;
              if (retired || closed) return yield* fail(OMP_MODELS_RETIRED_DETAIL);
              resolvedRevision = force ? undefined : revision;
              yield* adopt(current);
            }),
          );
        /** Every guarded RPC: the cached authority only, never the secret store. */
        const checkAuthority: Effect.Effect<void, OmpRpcProtocolError> = authority.withPermit(
          Effect.suspend(() => (retired || closed ? fail(OMP_MODELS_RETIRED_DETAIL) : Effect.void)),
        );
        const guarded = <A>(effect: Effect.Effect<A, OmpRpcError>): Effect.Effect<A, OmpRpcError> =>
          checkAuthority.pipe(Effect.andThen(effect));
        const retiredError = new OmpModelRefreshError({
          reason: "retired",
          detail: OMP_MODELS_CHANGED_DETAIL,
        });
        /** Wait until OMP acknowledged `target`, bounded by the refresh timeout. */
        const awaitApplied = (target: number): Effect.Effect<void, OmpModelRefreshError> =>
          SubscriptionRef.changes(barrier).pipe(
            Stream.filter((state) => state.retired || state.applied >= target),
            Stream.runHead,
            Effect.timeoutOrElse({
              duration: Duration.millis(refreshTimeoutMs),
              orElse: () =>
                Effect.fail(
                  new OmpModelRefreshError({
                    reason: "timeout",
                    detail: `Oh My Pi did not load the updated Scient models within ${Math.ceil(refreshTimeoutMs / 1000)} seconds.`,
                  }),
                ),
            }),
            Effect.flatMap((state) => {
              if (Option.isNone(state) || state.value.retired) return Effect.fail(retiredError);
              const failure = state.value.failure;
              return failure !== undefined && failure.generation >= target
                ? Effect.fail(
                    new OmpModelRefreshError({
                      reason: "failed",
                      detail: `Oh My Pi could not load the Scient models: ${failure.detail}`,
                    }),
                  )
                : Effect.void;
            }),
          );
        /** Model-dependent RPCs wait for a pending generation to be applied. */
        const awaitCurrent: Effect.Effect<void, OmpRpcError> = SubscriptionRef.get(barrier).pipe(
          Effect.flatMap((state) =>
            state.applied >= state.generation ? Effect.void : awaitApplied(state.generation),
          ),
          Effect.mapError((cause) => new OmpRpcProtocolError({ detail: cause.detail, cause })),
        );
        const refreshModels = (): Effect.Effect<void, OmpRpcError | OmpModelRefreshError> =>
          Effect.gen(function* () {
            yield* synchronize(undefined, true);
            const target = yield* SubscriptionRef.modify(barrier, (state) => [
              state.generation + 1,
              { ...state, generation: state.generation + 1 },
            ]);
            yield* awaitApplied(target);
          });
        const effectContext = yield* Effect.context<never>();
        const run = Effect.runPromiseWith(effectContext);

        const serveModels = (response: NodeHttp.ServerResponse) => {
          void run(
            authority.withPermit(
              Effect.gen(function* () {
                if (retired || closed) return yield* fail(OMP_MODELS_RETIRED_DETAIL);
                const active = activeConnections(resolvedConnections);
                const change = customModelRuntimeChange(loaded, active, instanceId);
                if (change === "revoke" || requiresCredentialRestart(loaded, active)) {
                  yield* retire;
                  return yield* fail(OMP_MODELS_CHANGED_DETAIL);
                }
                const next = buildOmpCustomModelPayload(active);
                loaded = publishableConnections(active);
                const { generation } = yield* SubscriptionRef.get(barrier);
                return { generation, connections: next.payload };
              }),
            ),
          ).then(
            (body) => {
              if (retired || closed) {
                response.writeHead(503).end();
                return;
              }
              response
                .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
                .end(JSON.stringify(body));
            },
            () => response.writeHead(503).end(),
          );
        };
        /**
         * Long-poll: answer as soon as a generation newer than `after` exists,
         * or after the hold with the current one. Node's request timeout
         * bounds only receiving the request, so the hold is not cut short; it
         * counts as one authorized request while it is held.
         */
        const serveWait = (
          request: NodeHttp.IncomingMessage,
          response: NodeHttp.ServerResponse,
          after: number,
        ) => {
          const abandoned = new AbortController();
          response.once("close", () => abandoned.abort());
          void run(
            SubscriptionRef.changes(barrier).pipe(
              Stream.filter((state) => state.retired || state.generation > after),
              Stream.runHead,
              Effect.timeoutOption(Duration.millis(waitHoldMs)),
              Effect.flatMap(() => SubscriptionRef.get(barrier)),
            ),
            { signal: abandoned.signal },
          ).then(
            (state) => {
              if (response.destroyed) return;
              if (state.retired || retired || closed) {
                response.writeHead(503).end();
                return;
              }
              response
                .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
                .end(JSON.stringify({ generation: state.generation }));
            },
            () => {
              if (!response.destroyed && !response.headersSent) response.writeHead(503).end();
            },
          );
          request.resume();
        };
        const serveApplied = (
          request: NodeHttp.IncomingMessage,
          response: NodeHttp.ServerResponse,
        ) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > OMP_MODELS_ACK_MAX_BYTES) {
              response.writeHead(413).end();
              request.destroy();
            }
          });
          request.on("end", () => {
            if (response.headersSent) return;
            void run(
              Effect.gen(function* () {
                const acknowledgement = yield* decodeAcknowledgement(body);
                yield* SubscriptionRef.update(barrier, (state) => {
                  // A generation Scient never published cannot be acknowledged.
                  if (acknowledgement.generation > state.generation) return state;
                  const failure =
                    acknowledgement.error === undefined
                      ? state.failure !== undefined &&
                        state.failure.generation > acknowledgement.generation
                        ? state.failure
                        : undefined
                      : {
                          generation: acknowledgement.generation,
                          detail: redactOmpDiagnostic(
                            acknowledgement.error.slice(0, 500),
                            initialPayload.keys,
                          ),
                        };
                  return {
                    ...state,
                    applied: Math.max(state.applied, acknowledgement.generation),
                    failure,
                  };
                });
              }),
            ).then(
              () => response.writeHead(204).end(),
              () => response.writeHead(400).end(),
            );
          });
        };

        let authorizedRequests = 0;
        const server = NodeHttp.createServer(
          { connectionsCheckingInterval },
          (request, response) => {
            const supplied = Buffer.from(request.headers.authorization ?? "");
            if (
              supplied.length !== expected.length ||
              !NodeCrypto.timingSafeEqual(supplied, expected)
            ) {
              response.writeHead(403, { connection: "close" }).end();
              request.resume();
              return;
            }
            // Authenticated: the long-poll may now idle past the socket timeout.
            request.socket.setTimeout(0);
            if (authorizedRequests >= OMP_MODELS_MAX_AUTHORIZED_REQUESTS) {
              response.writeHead(429, { connection: "close" }).end();
              request.resume();
              return;
            }
            authorizedRequests += 1;
            response.once("close", () => {
              authorizedRequests -= 1;
            });
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (request.method === "GET" && url.pathname === "/models" && url.search === "") {
              serveModels(response);
              return;
            }
            if (request.method === "GET" && url.pathname === "/models/wait") {
              const after = Number(url.searchParams.get("after"));
              if (!Number.isSafeInteger(after) || after < 0) {
                response.writeHead(400).end();
                return;
              }
              serveWait(request, response, after);
              return;
            }
            if (request.method === "POST" && url.pathname === "/models/applied") {
              serveApplied(request, response);
              return;
            }
            response.writeHead(404).end();
          },
        );
        server.requestTimeout = requestTimeoutMs;
        server.headersTimeout = requestTimeoutMs;
        // A connection that has not authenticated within the request timeout
        // is closed, whether it sent nothing or stalled mid-request, so idle
        // local sockets cannot pile up in front of the extension.
        server.on("connection", (socket: NodeNet.Socket) => {
          socket.setTimeout(requestTimeoutMs, () => socket.destroy());
        });
        yield* Effect.acquireRelease(listen(server), () =>
          markRetired.pipe(Effect.andThen(close(server))),
        );
        const address = server.address();
        if (!address || typeof address === "string") {
          return yield* fail("Could not determine the OMP custom-model endpoint.");
        }
        // A private directory per process, removed with it.
        const directory = yield* Effect.acquireRelease(
          fs.makeTempDirectory({
            directory: extensionDirectory,
            prefix: ompExtensionProcessPrefix(process.pid),
          }),
          (created) => fs.remove(created, { recursive: true, force: true }).pipe(Effect.ignore),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OmpRpcProtocolError({
                detail: "Could not prepare Scient's Oh My Pi extension.",
                cause,
              }),
          ),
        );
        const extension = yield* writeOmpExtensionFiles({
          directory,
          name: "scient-custom-models",
          source: ompCustomModelsExtensionSource,
          bootstrap: {
            url: `http://127.0.0.1:${address.port}/models`,
            token,
            keys: initialPayload.keys,
          },
        }).pipe(
          Effect.mapError((cause) => new OmpRpcProtocolError({ detail: cause.detail, cause })),
        );
        native = yield* makeProcess({
          ...options,
          extraArgs: [...(options.extraArgs ?? []), "--extension", extension.extensionPath],
          secrets: [...(options.secrets ?? []), token, ...Object.values(initialPayload.keys)],
        });
        if (!native) return yield* fail("Oh My Pi has not started.");
        const nativeProcess: OmpRpcProcess = native;
        yield* changes.pipe(
          Stream.runForEach((next) =>
            synchronize(settingsRevision(next), false).pipe(
              Effect.catch(() =>
                retired
                  ? Effect.void
                  : Effect.logWarning("Could not verify OMP model connections."),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        const pendingProvider = (provider: string) =>
          [...pendingCredentialIds].some((id) => customModelProviderId(id) === provider);
        const closeWith = (effect: Effect.Effect<void>) =>
          Effect.suspend(() => {
            closed = true;
            return markRetired.pipe(Effect.andThen(effect));
          });
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
          modelProviderLabel: (provider) =>
            resolvedConnections.find(
              (connection) => customModelProviderId(connection.id) === provider,
            )?.name,
          refreshModels,
          // Built from the secrets passed above: the endpoint token and every
          // key this process received. Keys only change by retiring it.
          redaction: nativeProcess.redaction,
          // OMP loads every explicit extension before it reports ready.
          ready: nativeProcess.ready.pipe(Effect.tap(() => extension.discardUnconsumed)),
          events: nativeProcess.events,
          flushEvents: nativeProcess.flushEvents,
          command: (body) => guarded(nativeProcess.command(body)),
          prompt: (input) => guarded(nativeProcess.prompt(input)),
          steer: (message, images) => guarded(nativeProcess.steer(message, images)),
          followUp: (message, images) => guarded(nativeProcess.followUp(message, images)),
          abort: () => nativeProcess.abort(),
          getState: () => guarded(nativeProcess.getState()),
          getModels: () => guarded(awaitCurrent.pipe(Effect.andThen(nativeProcess.getModels()))),
          getCommands: () => guarded(nativeProcess.getCommands()),
          setModel: (provider, modelId) =>
            guarded(
              Effect.suspend(() =>
                pendingProvider(provider)
                  ? fail(OMP_PENDING_CONNECTION_DETAIL)
                  : awaitCurrent.pipe(Effect.andThen(nativeProcess.setModel(provider, modelId))),
              ),
            ),
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
          close: () => closeWith(nativeProcess.close()),
          shutdown: Effect.suspend(() => {
            closed = true;
            return markRetired.pipe(Effect.andThen(nativeProcess.shutdown));
          }),
        };
        return wrapped;
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(OmpExecutableGate, gate),
      );
  },
);

export type OmpCustomModelsProcessFactory = ReturnType<typeof makeOmpCustomModelsClientFactory>;
