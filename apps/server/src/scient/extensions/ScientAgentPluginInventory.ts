import { type ServerProviderPlugin, type ServerProviderMcpServer } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { nextInventoryReadSequence } from "../../provider/ProviderNativeInventory.ts";
import type {
  ProviderPluginActions,
  ProviderNativeInventory,
} from "../../provider/ScientProviderInstanceSeams.ts";
import { runScientAgentPluginCommand } from "./ProviderPluginCommand.ts";
import { readPluginJson } from "./LocalPluginFiles.ts";

const Installed = Schema.Struct({
  npm: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      path: Schema.String,
      enabled: Schema.Boolean,
      manifest: Schema.Struct({ description: Schema.optional(Schema.String) }),
    }),
  ),
  marketplace: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      scope: Schema.Literals(["user", "project"]),
      entries: Schema.Array(
        Schema.Struct({
          installPath: Schema.String,
          version: Schema.String,
          enabled: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
});
const decodeInstalled = Schema.decodeUnknownEffect(Schema.fromJsonString(Installed));

export function scientAgentInstalledPlugins(
  data: typeof Installed.Type,
): ReadonlyArray<ServerProviderPlugin & { readonly path: string }> {
  return [
    ...data.npm.map((plugin) => ({
      id: `npm:${plugin.name}`,
      name: plugin.name,
      version: plugin.version,
      path: plugin.path,
      enabled: plugin.enabled,
      description: plugin.manifest.description,
      source: "local" as const,
      sourceLabel: "npm/git",
      canUninstall: true,
      canSetEnabled: true,
    })),
    ...data.marketplace.flatMap((plugin) => {
      const entry = plugin.entries[0];
      return entry
        ? [
            {
              id: `${plugin.scope}:${plugin.id}`,
              name: plugin.id,
              version: entry.version,
              path: entry.installPath,
              enabled: entry.enabled !== false,
              marketplace: plugin.id.split("@")[1],
              scope: plugin.scope,
              source: "local" as const,
              sourceLabel: "Marketplace",
              canUninstall: true,
              canSetEnabled: true,
            },
          ]
        : [];
    }),
  ];
}

const McpFile = Schema.Record(Schema.String, Schema.Unknown);
const decodeMcp = Schema.decodeUnknownOption(McpFile);
export const pluginMcpServers = Effect.fn("pluginMcpServers")(function* (
  plugin: ServerProviderPlugin & { readonly path: string },
) {
  const path = yield* Path.Path;
  for (const name of [".mcp.json", "mcp.json"]) {
    const result = yield* readPluginJson(path.join(plugin.path, name)).pipe(Effect.option);
    if (result._tag === "None") continue;
    const root = decodeMcp(result.value);
    if (root._tag === "None") continue;
    const nested = decodeMcp(root.value.mcpServers);
    const servers = nested._tag === "Some" ? nested.value : root.value;
    return Object.keys(servers)
      .slice(0, 1000)
      .map((name): ServerProviderMcpServer => ({
        name,
        pluginId: plugin.id,
        scope: plugin.scope ?? "user",
        status: plugin.enabled ? "unknown" : "disabled",
      }));
  }
  return [];
});

export const makeScientAgentPluginInventory = Effect.fn("makeScientAgentPluginInventory")(
  function* (
    run: (
      cwd: string | undefined,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<string, { readonly message: string }>,
  ) {
    const reports = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderNativeInventory>({ replay: 1 }),
      PubSub.shutdown,
    );
    const retired = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(retired, undefined));
    const lock = yield* Semaphore.make(1);
    const lastRead = yield* Ref.make<number | undefined>(undefined);
    const path = yield* Path.Path;
    const list = Effect.fn("ScientAgentPluginInventory.list")(
      function* (cwd: string | undefined) {
        const sequence = yield* nextInventoryReadSequence;
        const data = yield* run(cwd, ["plugin", "list", "--json"]).pipe(
          Effect.flatMap(decodeInstalled),
        );
        return { plugins: scientAgentInstalledPlugins(data), sequence };
      },
      Effect.mapError(() => ({ message: "Scient Agent could not list all its plugins." })),
    );
    const mutate = Effect.fn("ScientAgentPluginInventory.mutate")(function* (
      input: { readonly pluginId: string; readonly cwd?: string | undefined },
      action: string,
    ) {
      const listing = yield* list(input.cwd);
      const plugin = listing.plugins.find((plugin) => plugin.id === input.pluginId);
      if (!plugin) return yield* Effect.fail({ message: "This plugin is no longer installed." });
      yield* run(input.cwd, [
        "plugin",
        action,
        ...(plugin.scope ? ["--scope", plugin.scope] : []),
        plugin.name,
      ]);
    });
    const actions: ProviderPluginActions = {
      listPlugins: ({ cwd }) => list(cwd),
      uninstall: (input) => mutate(input, "uninstall"),
      setEnabled: (input) => mutate(input, input.enabled ? "enable" : "disable"),
      readMcpServer: () => Effect.succeed(undefined),
      startMcpSignIn: () =>
        Effect.fail({ message: "Manage this MCP server's sign-in in Scient Agent." }),
      isRetired: Deferred.isDone(retired),
      whenRetired: Deferred.await(retired),
      refreshInventory: ({ force }) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const previous = yield* Ref.get(lastRead);
            if (!force && previous !== undefined && now - previous < 600_000) return;
            const listing = yield* list(undefined);
            const mcpServers = (yield* Effect.forEach(listing.plugins, (plugin) =>
              pluginMcpServers(plugin).pipe(Effect.provideService(Path.Path, path)),
            )).flat();
            yield* PubSub.publish(reports, {
              plugins: listing.plugins,
              mcpServers,
              sequence: listing.sequence,
            });
            yield* Ref.set(lastRead, now);
          }),
        ),
    };
    return { actions, reports: Stream.fromPubSub(reports) };
  },
);

export { runScientAgentPluginCommand };
