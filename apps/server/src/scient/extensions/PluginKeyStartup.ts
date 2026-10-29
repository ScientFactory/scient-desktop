import type { PluginKeyTarget, ProviderInstanceId } from "@t3tools/contracts";
import type { McpPluginKeyPolicy } from "@t3tools/provider-core/server/mcpSession";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import type {
  ProviderPluginActionFailure,
  ProviderPluginActions,
  ProviderPluginRoot,
} from "../../provider/ScientProviderInstanceSeams.ts";
import { pluginKeyHttpOrigins } from "./PluginKeyHttpServers.ts";
import {
  readLocalPluginContents,
  readLocalPluginKeyHttpServers,
  readLocalPluginKeyCommandLineBlocked,
  readLocalPluginRequiredKeys,
} from "./LocalPluginContents.ts";

const decodePath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));

const PLUGIN_KEY_STARTUP_TIMEOUT = "20 seconds";

/**
 * Plugin keys are optional: when preparing them fails, the session starts with
 * `fallback` and the failure is logged. Interruption still stops the start.
 */
export const orStartWithoutPluginKeys =
  <B>(message: string, fallback: B, annotations?: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning(message, { ...annotations, cause }).pipe(Effect.as(fallback)),
      ),
    );

/**
 * Installed plugins and their own folders, where plugins declare keys. Never the catalog: a
 * plugin's keys and servers are read from its folder. Session start may use the last listing;
 * key use and key status read `fresh`, so a disabled or removed plugin stops receiving keys.
 */
export const listPluginKeyRoots = (
  actions: ProviderPluginActions,
  cwd: string | undefined,
  fresh: boolean,
): Effect.Effect<ReadonlyArray<ProviderPluginRoot>, ProviderPluginActionFailure> =>
  actions.listPluginRoots
    ? actions.listPluginRoots({ ...(cwd ? { cwd } : {}), fresh })
    : actions.listPlugins(cwd ? { cwd } : {}).pipe(
        Effect.map((listing) =>
          listing.plugins.map((plugin) => {
            const parsed = decodePath(plugin);
            return {
              id: plugin.id,
              name: plugin.name,
              enabled: plugin.enabled,
              root: parsed._tag === "Some" ? parsed.value.path : undefined,
            };
          }),
        ),
      );

const pluginKeyPolicy = Effect.fnUntraced(function* (codex: boolean, plugin: ProviderPluginRoot) {
  const root = plugin.root;
  if (!root) return undefined;
  const declaredKeys = yield* Effect.tryPromise(() => readLocalPluginRequiredKeys(root));
  if (!declaredKeys?.length) return undefined;
  const contents = yield* Effect.tryPromise(() => readLocalPluginContents(root));
  if (!contents.requiredKeys?.length) return undefined;
  return {
    pluginId: codex ? plugin.id : plugin.name,
    bindingPluginId: plugin.id,
    requiredKeys: contents.requiredKeys,
    pluginName: plugin.name.split("@")[0]!,
    path: root,
    serverNames: contents.mcpServers.map((server) => server.name),
  } satisfies McpPluginKeyPolicy;
});

export const preparePluginKeyStartup = Effect.fn("PluginKeyStartup.prepare")(
  function* (
    providers: ProviderRegistryShape,
    instanceId: ProviderInstanceId,
    cwd: string | undefined,
  ) {
    const provider = (yield* providers.getProviders).find((item) => item.instanceId === instanceId);
    if (!provider || (provider.driver !== "claudeAgent" && provider.driver !== "codex")) return [];
    const actions = yield* providers.getProviderPluginActionsForInstance(instanceId);
    if (!actions || (yield* actions.isRetired)) return [];
    const plugins = yield* listPluginKeyRoots(actions, cwd, false);
    const policies = yield* Effect.forEach(
      plugins.filter((plugin) => plugin.enabled),
      (plugin) =>
        pluginKeyPolicy(provider.driver === "codex", plugin).pipe(
          orStartWithoutPluginKeys(
            "Starting without keys for a plugin that could not be read.",
            undefined,
            {
              pluginId: plugin.id,
            },
          ),
        ),
    );
    return policies.filter(Predicate.isNotUndefined);
  },
  Effect.timeout(PLUGIN_KEY_STARTUP_TIMEOUT),
  orStartWithoutPluginKeys(
    "Starting without plugin keys: plugins could not be read.",
    [] as McpPluginKeyPolicy[],
  ),
);

export const readPluginKeyTransport = Effect.fn("PluginKeyStartup.readTransport")(function* (
  providers: ProviderRegistryShape,
  target: PluginKeyTarget,
) {
  if (!target.agent) return { origins: new Map<string, string[]>(), commandLineBlocked: false };
  const actions = yield* providers.getProviderPluginActionsForInstance(target.agent);
  if (!actions || (yield* actions.isRetired))
    return { origins: new Map<string, string[]>(), commandLineBlocked: false };
  const root = (yield* listPluginKeyRoots(actions, target.cwd, true)).find(
    (plugin) => plugin.id === target.pluginId,
  )?.root;
  return root
    ? {
        origins: pluginKeyHttpOrigins(
          yield* Effect.tryPromise(() => readLocalPluginKeyHttpServers(root)),
        ),
        commandLineBlocked: yield* Effect.tryPromise(() =>
          readLocalPluginKeyCommandLineBlocked(root),
        ),
      }
    : { origins: new Map<string, string[]>(), commandLineBlocked: false };
});
