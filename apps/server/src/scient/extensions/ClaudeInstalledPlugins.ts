import { supportsScientClaudePlugins, type ServerProviderPlugin } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ProviderPluginActions } from "../../provider/ScientProviderInstanceSeams.ts";
import { scientAgentTarget } from "../../provider/scient/ScientAgentTarget.ts";
import { sharedPluginDisplayName } from "./SharedPluginStore.ts";
import { readPluginJson } from "./LocalPluginFiles.ts";

const Registry = Schema.Struct({
  version: Schema.Literal(2),
  plugins: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        scope: Schema.String,
        installPath: Schema.String,
        version: Schema.optional(Schema.String),
        enabled: Schema.optional(Schema.Boolean),
        projectPath: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const decodeRegistry = Schema.decodeUnknownEffect(Registry);
const decodeSettings = Schema.decodeUnknownEffect(
  Schema.Struct({ enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)) }),
);
const decodeSourceSetting = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.Array(Schema.String) })),
);

export const readClaudeInstalledPlugins = Effect.fn("readClaudeInstalledPlugins")(function* (
  home: string,
  cwd?: string,
  allowRemoval = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registryFile = path.join(home, "plugins", "installed_plugins.json");
  if (!(yield* fs.exists(registryFile))) return [];
  const registry = yield* readPluginJson(registryFile).pipe(Effect.flatMap(decodeRegistry));
  const settingsFiles = [path.join(home, "settings.json")];
  const canonicalCwd = cwd
    ? yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)))
    : undefined;
  if (canonicalCwd) {
    let project = canonicalCwd;
    for (let depth = 0; depth < 64; depth++) {
      if (
        (yield* fs.exists(path.join(project, ".scient-agent"))) ||
        (yield* fs.exists(path.join(project, ".git")))
      )
        break;
      const parent = path.dirname(project);
      if (parent === project) {
        project = canonicalCwd;
        break;
      }
      project = parent;
    }
    for (const dir of new Set([project, canonicalCwd]))
      settingsFiles.push(
        path.join(dir, ".claude", "settings.json"),
        path.join(dir, ".claude", "settings.local.json"),
      );
  }
  const overrides: Record<string, boolean> = {};
  for (const file of settingsFiles)
    if (yield* fs.exists(file))
      Object.assign(
        overrides,
        (yield* readPluginJson(file).pipe(Effect.flatMap(decodeSettings))).enabledPlugins,
      );
  const plugins: Array<ServerProviderPlugin & { readonly path: string }> = [];
  for (const [name, entries] of Object.entries(registry.plugins)) {
    for (const [index, entry] of entries.entries()) {
      if (entry.scope === "project" || entry.scope === "local") {
        if (!canonicalCwd) continue;
        const projectPath = entry.projectPath
          ? yield* fs
              .realPath(entry.projectPath)
              .pipe(Effect.orElseSucceed(() => path.resolve(entry.projectPath!)))
          : undefined;
        const projectRoot = settingsFiles[1]
          ? path.dirname(path.dirname(settingsFiles[1]))
          : canonicalCwd;
        if (overrides[name] !== true && projectPath !== projectRoot) continue;
      }
      plugins.push({
        id: `claude:${entry.scope}:${name}:${index}`,
        name,
        displayName: sharedPluginDisplayName(name.split("@")[0]!),
        canUninstall: allowRemoval && entry.scope === "user",
        path: entry.installPath,
        enabled: entry.enabled !== false && overrides[name] !== false,
        scope: entry.scope === "local" ? "project" : entry.scope,
        source: "local",
        sourceLabel: "Claude Code's plugins",
        ...(entry.version ? { version: entry.version } : {}),
        ...(name.includes("@") ? { marketplace: name.slice(name.lastIndexOf("@") + 1) } : {}),
      });
    }
  }
  return plugins;
});

export const readScientClaudePlugins = Effect.fn("readScientClaudePlugins")(
  function* (
    run: (args: ReadonlyArray<string>) => Effect.Effect<string, { readonly message: string }>,
    home: string,
    useClaudePlugins: boolean,
    cwd?: string,
  ) {
    const info = yield* run(["--runtime-info"]);
    if (!supportsScientClaudePlugins(scientAgentTarget.identify(info)?.version)) return [];
    const disabled = yield* run(["config", "get", "disabledProviders", "--json"]).pipe(
      Effect.flatMap(decodeSourceSetting),
    );
    if (disabled.value.includes("claude-plugins")) return [];
    if (!useClaudePlugins) {
      const enabled = yield* run(["config", "get", "enabledProviders", "--json"]).pipe(
        Effect.flatMap(decodeSourceSetting),
      );
      if (!enabled.value.includes("claude-plugins") && !enabled.value.includes("claude")) return [];
    }
    return yield* readClaudeInstalledPlugins(home, cwd);
  },
  Effect.mapError(() => ({ message: "Could not read Claude Code's plugins for Scient Agent." })),
);

export const uninstallClaudePlugin = Effect.fn("uninstallClaudePlugin")(function* (
  list: ProviderPluginActions["listPlugins"],
  run: (args: ReadonlyArray<string>) => Effect.Effect<string, { readonly message: string }>,
  input: { readonly pluginId: string; readonly cwd?: string | undefined },
) {
  const plugin = (yield* list({ cwd: input.cwd })).plugins.find(
    (item) => item.id === input.pluginId,
  );
  if (!plugin?.canUninstall || plugin.scope !== "user")
    return yield* Effect.fail({
      message: "Only user-scope Claude Code plugins can be removed here.",
    });
  yield* run(["plugin", "uninstall", plugin.name, "--scope", "user", "--keep-data", "--json"]);
});
