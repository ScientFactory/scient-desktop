import type { ServerProviderPlugin } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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
const Settings = Schema.Struct({
  enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeSettings = Schema.decodeUnknownOption(Settings);

export const readClaudeInstalledPlugins = Effect.fn("readClaudeInstalledPlugins")(function* (
  home: string,
  cwd?: string,
) {
  const path = yield* Path.Path;
  const raw = yield* readPluginJson(path.join(home, "plugins", "installed_plugins.json")).pipe(
    Effect.option,
  );
  if (raw._tag === "None") return [];
  const registry = yield* decodeRegistry(raw.value);
  const settingsRaw = yield* readPluginJson(path.join(home, "settings.json")).pipe(Effect.option);
  const settings = settingsRaw._tag === "Some" ? decodeSettings(settingsRaw.value) : undefined;
  const overrides = settings?._tag === "Some" ? settings.value.enabledPlugins : undefined;
  return Object.entries(registry.plugins).flatMap(([name, entries]) =>
    entries.flatMap((entry): ReadonlyArray<ServerProviderPlugin & { readonly path: string }> => {
      if (entry.scope !== "user" && (!cwd || entry.projectPath !== cwd)) return [];
      return [
        {
          id: `claude:${entry.scope}:${name}`,
          name,
          path: entry.installPath,
          enabled: entry.enabled !== false && overrides?.[name] !== false,
          scope: entry.scope,
          source: "local",
          sourceLabel: "Claude Code's plugins",
          ...(entry.version ? { version: entry.version } : {}),
          ...(name.includes("@") ? { marketplace: name.split("@")[1] } : {}),
        },
      ];
    }),
  );
});
