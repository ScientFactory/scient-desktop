// @effect-diagnostics nodeBuiltinImport:off -- The pure custom-model ID fingerprint retains its persisted identity.
import * as NodeCrypto from "node:crypto";
import { customModelImageInput, droidAdaptiveClaudeLevels } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as EffectAcpErrors from "effect-acp/errors";
import { AcpProcessExitedError, AcpRequestError } from "effect-acp/errors";
// SCIENT-FORK:START — legacy v1 vocabulary; see compat rationale in
// `acp/DroidAcpSupport.ts`. Upstream moved the pre-v2 hand-written ACP module
// from `effect-acp/schema` to `effect-acp/compat`.
import type * as EffectAcpSchema from "effect-acp/compat";
import type { SessionConfigOption } from "effect-acp/compat";
// SCIENT-FORK:END

import { droidCanUseKey, type ResolvedModelConnection } from "../../customModels.ts";
import { assessModelConnections } from "../../customModelReadiness.ts";
import {
  customModelDiscoverySnapshot,
  customModelRuntimeChange,
  effectiveCustomModelReasoning,
  type CustomModelReasoning,
} from "../../customModelCapabilities.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeDroidAcpRuntime, type DroidAcpRuntimeFactory } from "../acp/DroidAcpSupport.ts";
import {
  makeDroidRunBudgetStore,
  makeDroidKeyBroker,
  type DroidKeyBroker,
} from "./DroidKeyBroker.ts";
import { readDroidOrgHookPolicy, type DroidOrgHookPolicy } from "./DroidOrgPolicy.ts";

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

const DROID_CUSTOM_MODEL_PREFIX = "custom:scient-";

/** Stable, collision-resistant id used by both Droid's model picker and Scient selection. */
export function droidCustomModelId(connectionId: string, customModelId: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(connectionId)
    .update("\0")
    .update(customModelId)
    .digest("hex")
    .slice(0, 12);
  return `${DROID_CUSTOM_MODEL_PREFIX}${customModelId.slice(0, 40)}-${digest}`;
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

const DROID_LADDER: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/**
 * A model's reasoning as Droid applies it. For Messages the model ID decides
 * (see `droidAdaptiveClaudeLevels`): an adaptive Claude model keeps Off and
 * the extra levels Droid sends for it; any other model gets budget thinking,
 * so only Low, Medium and High, and no Off.
 */
function droidReasoning(
  model: CustomModel,
  protocol: CustomModelProtocol,
): CustomModelReasoning | undefined {
  const reasoning = effectiveCustomModelReasoning(model, protocol);
  if (protocol !== "anthropic-messages" || reasoning?.status !== "known" || !reasoning.supported)
    return reasoning;
  const extra: ReadonlyArray<string> | undefined = droidAdaptiveClaudeLevels(model.modelId);
  return {
    ...reasoning,
    mode: extra ? "adaptive" : "budget",
    levels: reasoning.levels.filter((level) => DROID_LADDER.has(level) || extra?.includes(level)),
  };
}

/**
 * The level the overlay configures for a model: the user's default when it is
 * one of the levels Droid sends for the model, otherwise its metadata default.
 * Undefined unless reasoning is known: Droid then applies no reasoning to the
 * model.
 */
function droidConfiguredEffort(
  model: CustomModel,
  protocol: CustomModelProtocol,
): string | undefined {
  const reasoning = droidReasoning(model, protocol);
  return reasoning?.status === "known" && reasoning.supported
    ? preferredReasoningLevel(reasoning.levels, reasoning.defaultLevel, model.defaultReasoningLevel)
    : undefined;
}

/** Each attached model's configured level, to notice a change that needs a new overlay. */
function droidConfiguredEfforts(
  connections: ReadonlyArray<CustomModelConnection>,
  instanceId: ProviderInstanceId,
): string {
  return connections
    .flatMap((connection) =>
      connection.models
        .filter((model) => model.instanceIds.includes(instanceId))
        .map(
          (model) =>
            `${droidCustomModelId(connection.id, model.id)}=${droidConfiguredEffort(model, connection.protocol) ?? ""}`,
        ),
    )
    .join("\n");
}

/**
 * Droid advertises off/low/medium/high for every custom model. For effort
 * APIs (Chat Completions, Responses) it also sends the overlay's configured
 * level when that is selected, xhigh, minimal or max included (other unlisted
 * levels are sent as the configured one), so the ladder is the model's levels
 * that Droid advertises plus the configured one. A model ID Droid knows is the
 * exception (`gpt-5.2` configured with Minimal or Max runs at Low); only its
 * answer to the write says so (see `applyDroidModelAndEffort`). For Messages
 * the ladder is what `droidReasoning` keeps, whatever the overlay configures.
 * Native and unknown models keep Droid's ladder. Verified against Droid
 * 0.213.0 and 0.230.0 with a local wire-capture fixture.
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
    const model = connection.models.find(
      (entry) => droidCustomModelId(connection.id, entry.id) === selected.currentValue,
    );
    const metadata = model && droidReasoning(model, connection.protocol);
    if (!model) continue;
    const messages = connection.protocol === "anthropic-messages";
    if (
      metadata?.status !== "known" ||
      !metadata.supported ||
      (!messages && metadata.mode !== "effort")
    )
      continue;
    const configured = droidConfiguredEffort(model, connection.protocol);
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
      // Off turns adaptive (Messages) thinking off; elsewhere it is the model's default.
      const off = metadata.mode === "adaptive" && advertised.has("off") ? ["off"] : [];
      return {
        ...option,
        options: [...off, ...metadata.levels.filter((level) => level !== "off")]
          // Droid serializes its advertised ladder plus, for Messages, the levels of its own
          // table and, for effort APIs, the configured custom effort. Other extra levels may
          // be acknowledged but silently mapped to another value.
          .filter((level) => advertised.has(level) || messages || level === configured)
          .map((value) => ({
            value,
            name: value === "xhigh" ? "Extra-high" : value.charAt(0).toUpperCase() + value.slice(1),
          })),
      };
    });
  }
  return configOptions;
}

/**
 * The per-process overlay Droid reads. Each connection points at its key
 * broker route and carries that route's capability, never the real key.
 */
export function buildDroidCustomModelsSettings(
  connections: ReadonlyArray<ResolvedModelConnection>,
  route: DroidKeyBroker["route"],
): { readonly customModels: ReadonlyArray<Record<string, unknown>> } {
  let index = 0;
  return {
    customModels: connections.flatMap((connection) => {
      const brokered = connection.credentialError === undefined && route(connection.id);
      if (!brokered) return [];
      return connection.models.map((model) => {
        const limits = droidModelLimits(model);
        const reasoning = effectiveCustomModelReasoning(model, connection.protocol);
        const reasoningEffort = droidConfiguredEffort(model, connection.protocol);
        return {
          id: droidCustomModelId(connection.id, model.id),
          index: index++,
          model: model.modelId,
          displayName: model.name,
          baseUrl: brokered.baseUrl,
          // The broker authenticates keyless connections too; it never forwards this value.
          apiKey: brokered.apiKey,
          provider: DROID_PROVIDER_BY_PROTOCOL[connection.protocol],
          maxContextLimit: limits.contextWindow,
          maxOutputTokens: limits.maxOutputTokens,
          noImageSupport: !droidModelImages(model),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          // Known evidence decides. Otherwise only a legacy model's saved flag is intent:
          // newer models store it unset, and choosing limits must not turn thinking off.
          ...(reasoning?.supported !== null && reasoning?.supported !== undefined
            ? { enableThinking: reasoning.supported }
            : model.configurationMode === undefined
              ? { enableThinking: model.reasoning }
              : {}),
        };
      });
    }),
  };
}

/**
 * Refuses every tool call before it runs, MCP tools included. Droid cannot
 * withhold its tools in ACP mode: verified against Droid 0.228.0, the
 * `--only-tools`/`--remove-tools` flags and the `enabledToolIds`,
 * `disabledToolIds` and `restrictToolIds` settings leave every tool offered,
 * and Read then opens any path without asking, whatever the autonomy. Droid
 * does run PreToolUse hooks from the overlay (also when the user disabled
 * their own hooks) and blocks the call when one exits 2, for Factory-hosted
 * and custom models alike. `exit 2` means the same in sh, cmd and PowerShell,
 * but the hook has not been verified on Windows.
 */
const REFUSE_EVERY_TOOL_CALL = {
  PreToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }],
} as const;

/**
 * Leaves a marker when the session starts, so Scient can see that Droid runs
 * the overlay's hooks in this process: an organization policy that allows
 * only managed hooks drops them all. Droid runs SessionStart hooks before
 * answering `session/new` (verified against Droid 0.213.0 and 0.230.0).
 */
const markSessionStart = (marker: string) =>
  ({
    SessionStart: [{ hooks: [{ type: "command", command: `echo started > "${marker}"` }] }],
  }) as const;

type ReadDroidOrgHookPolicy = (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}) => Effect.Effect<DroidOrgHookPolicy, never, FileSystem.FileSystem | Path.Path>;

/** A key Droid cannot use (see `droidCanUseKey`) is reported on its connection, never brokered. */
const droidConnections = (
  connections: ReadonlyArray<ResolvedModelConnection>,
): ReadonlyArray<ResolvedModelConnection> =>
  connections.map((connection) => {
    if (!connection.apiKey || droidCanUseKey(Redacted.value(connection.apiKey))) return connection;
    const { apiKey: _apiKey, ...rest } = connection;
    return {
      ...rest,
      credentialError: `Droid cannot use the API key for ${connection.name}: it contains a space or a control character. Re-enter the key in Custom models.`,
    };
  });

/** How long Droid may take to stop a prompt after the broker ended its turn. */
const REQUEST_LIMIT_CANCEL_GRACE = "5 seconds";

/**
 * Runs one prompt against the broker's per-turn request budget. When the
 * budget is exhausted the broker already refuses further model requests;
 * this cancels the Droid prompt and ends it with the truncation outcome, so
 * partial output stands and the turn ends as a token-limit stop.
 */
const promptWithinBudget = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "cancel">,
  broker: Pick<DroidKeyBroker, "turnBreached" | "currentBreach">,
  prompt: Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(prompt);
    yield* Effect.raceFirst(Fiber.await(fiber), broker.turnBreached);
    if (broker.currentBreach() === undefined) return yield* Fiber.join(fiber);
    yield* runtime.cancel.pipe(Effect.ignore);
    const stopped = yield* Fiber.await(fiber).pipe(
      Effect.timeoutOption(REQUEST_LIMIT_CANCEL_GRACE),
    );
    if (Option.isNone(stopped)) yield* Fiber.interrupt(fiber);
    return { stopReason: "max_tokens" } satisfies EffectAcpSchema.PromptResponse;
  });

/**
 * Adds Scient-managed models to every disposable Droid process through a
 * private overlay and a key broker owned by that process's scope. Droid never
 * receives a real key: not in its overlay, argv or environment.
 */
export const makeDroidCustomModelsRuntimeFactory = Effect.fn(
  "DroidCustomModels.makeRuntimeFactory",
)(function* (
  settings: Pick<
    ServerSettingsService["Service"],
    "resolveCustomModels" | "committedCustomModels" | "subscribeChanges"
  >,
  instanceId: ProviderInstanceId,
  makeRuntime: DroidAcpRuntimeFactory = makeDroidAcpRuntime,
  readOrgHookPolicy?: ReadDroidOrgHookPolicy,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const runBudgetStore = makeDroidRunBudgetStore();
  const readPolicy: ReadDroidOrgHookPolicy =
    readOrgHookPolicy ?? ((input) => readDroidOrgHookPolicy({ ...input, platform }));
  return ({ modelTools, ...input }: Parameters<DroidAcpRuntimeFactory>[0]) =>
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
      // Subscribe before resolving credentials, including while process construction is in flight.
      const changes = yield* settings.subscribeChanges;
      const connections = droidConnections(
        yield* settings.resolveCustomModels(instanceId).pipe(
          Effect.mapError(
            () =>
              new AcpRequestError({
                code: -32603,
                errorMessage: "Could not load Droid custom models.",
              }),
          ),
        ),
      );
      let currentConnections: ReadonlyArray<CustomModelConnection> = connections;
      let refreshPending = false;
      let invalidated = false;
      const invalidate = yield* Effect.cached(
        Effect.gen(function* () {
          invalidated = true;
          // Closing the transport wakes the request, whose scope cancels this watcher.
          // Finish all finalizers before allowing that cancellation to interrupt cleanup.
          yield* Scope.close(runtimeScope, Exit.void).pipe(Effect.uninterruptible);
        }),
      );
      // A connection whose key was unavailable was never loaded, so only the
      // loaded ones can be revoked; any change to the catalog as a whole refreshes.
      const unavailable = new Set(
        connections.flatMap((connection) =>
          connection.credentialError === undefined ? [] : [connection.id],
        ),
      );
      const loadedEfforts = droidConfiguredEfforts(
        connections.filter((connection) => !unavailable.has(connection.id)),
        instanceId,
      );
      const revokedBy = (current: ReadonlyArray<CustomModelConnection>) =>
        customModelRuntimeChange(
          connections.filter((connection) => !unavailable.has(connection.id)),
          current.filter((connection) => !unavailable.has(connection.id)),
          instanceId,
        ) === "revoke";
      /**
       * At every runtime step, against the committed catalog: no keys, no
       * settings load, no lock (the broker checks the same catalog
       * synchronously before each upstream request, see `isCurrent`).
       */
      const assertCurrent = Effect.gen(function* () {
        const current = settings.committedCustomModels();
        if (invalidated || revokedBy(current.connections)) {
          yield* invalidate;
          return yield* new AcpProcessExitedError({});
        }
        // A new default level changes which extra level Droid can send.
        refreshPending =
          customModelRuntimeChange(connections, current.connections, instanceId) !== "unchanged" ||
          droidConfiguredEfforts(
            current.connections.filter((connection) => !unavailable.has(connection.id)),
            instanceId,
          ) !== loadedEfforts;
        currentConnections = current.connections;
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
        const broker = yield* makeDroidKeyBroker({
          connections,
          runBudgetStore,
          // Checked in the step that starts each upstream request, so a
          // committed rotation or removal is either seen or after dispatch.
          isCurrent: () => !invalidated && !revokedBy(settings.committedCustomModels().connections),
          retire: invalidate,
          ...(modelTools === "disabled" ? { withoutTools: true } : {}),
          // Upstream requests take the route, and trust the CAs, Droid's own would have.
          environment: input.environment ?? process.env,
        });
        const { overlayPath, sessionStartMarker } = yield* Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-models-" });
          yield* fs.chmod(directory, 0o700);
          const overlayPath = path.join(directory, "settings.json");
          const sessionStartMarker = path.join(directory, "session-started");
          yield* fs.writeFileString(
            overlayPath,
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              // Off stops Droid uploading messages and titles to Factory for the
              // whole process (verified against Droid 0.213.0 and 0.230.0).
              ...(input.droidSettings?.cloudSessionSync === false
                ? { cloudSessionSync: false }
                : {}),
              ...buildDroidCustomModelsSettings(connections, broker.route),
              ...(modelTools === "disabled"
                ? { hooks: { ...REFUSE_EVERY_TOOL_CALL, ...markSessionStart(sessionStartMarker) } }
                : {}),
            }),
            { mode: 0o600, flag: "wx" },
          );
          return { overlayPath, sessionStartMarker };
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
          runtimeSettingsPath: overlayPath,
        });
        yield* assertCurrent;
        // Every prompt of a turn, steers included, shares that turn's budget.
        const prompt = (...args: Parameters<typeof runtime.prompt>) =>
          promptWithinBudget(runtime, broker, runtime.prompt(...args));
        return {
          ...runtime,
          beginTurn: broker.beginTurn,
          beginRunBudget: broker.beginRunBudget,
          requestLimitBreach: broker.currentBreach,
          upstreamRetrying: broker.turnRetrying,
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
              if (model) return droidReasoning(model, connection.protocol) ?? null;
            }
            return undefined;
          },
          getContextWindow: (modelId: string) => {
            for (const connection of connections) {
              const model = connection.models.find(
                (entry) => droidCustomModelId(connection.id, entry.id) === modelId,
              );
              if (model) return droidModelLimits(model).contextWindow;
            }
            return undefined;
          },
          describeUnavailableModel: (modelId: string) => {
            const find = (catalog: ReadonlyArray<CustomModelConnection>) =>
              catalog
                .flatMap((connection) => connection.models.map((model) => ({ connection, model })))
                .find(
                  ({ connection, model }) =>
                    droidCustomModelId(connection.id, model.id) === modelId,
                );
            if (!modelId.startsWith(DROID_CUSTOM_MODEL_PREFIX)) return undefined;
            const current = find(settings.committedCustomModels().connections);
            if (current === undefined) {
              const removed = find(connections);
              return removed === undefined
                ? "This custom model was removed from Custom models. Pick another model."
                : `"${removed.model.name}" was removed from Custom models. Pick another model.`;
            }
            const name = current.model.name;
            if (!current.model.instanceIds.includes(instanceId))
              return `"${name}" isn't attached to this Droid. Select Droid under Use with in Settings > Custom models, or pick another model.`;
            const loaded = connections.find((entry) => entry.id === current.connection.id);
            if (
              loaded?.credentialError !== undefined &&
              loaded.credentialId === current.connection.credentialId
            )
              return loaded.credentialError;
            // Attached after this process loaded its catalog: the next message reconnects.
            return `"${name}" is not loaded in this Droid session yet. Send the message again.`;
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
          // One rule for every model. The broker removes tool definitions from a
          // custom model's requests, but its endpoint can still answer with a tool
          // call; Droid dispatches it, and only the hook refuses it (verified
          // against Droid 0.213.0 and 0.230.0: without the hook a Read returns the
          // file to the endpoint).
          backgroundToolGuard: () =>
            Effect.gen(function* () {
              if (modelTools !== "disabled") return "unconfirmed" as const;
              const policy = yield* readPolicy({
                environment: input.environment ?? process.env,
                cwd: input.cwd,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
              if (policy === "managed-hooks-only") return "disabled-by-policy" as const;
              if (policy === "unknown") return "unconfirmed" as const;
              const started = yield* fs
                .exists(sessionStartMarker)
                .pipe(Effect.orElseSucceed(() => false));
              return started ? ("enforced" as const) : ("unconfirmed" as const);
            }),
          isConfigurationCurrent: () => !invalidated && !refreshPending,
          isConfigurationRetired: () => invalidated,
          checkConfiguration: () => assertCurrent,
          start: () => assertCurrent.pipe(Effect.andThen(runtime.start())),
          setModel: (modelId: string) =>
            assertCurrent.pipe(Effect.andThen(runtime.setModel(modelId))),
          prompt: (...args: Parameters<typeof runtime.prompt>) =>
            assertCurrent.pipe(Effect.andThen(prompt(...args))),
        };
      }).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.onError(() => invalidate),
      );
    });
});
