/**
 * Projects only the skill component of the user's Antigravity plugins into the
 * managed ACP runtime's private profile.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Incremental plugin projection fingerprints are synchronous at the native filesystem boundary.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Plugin projection uses native path semantics while preparing the runtime.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const maxPluginProjectionEntries = 10_000;
const maxPluginManifestBytes = 1_000_000;
const decodePluginProjectionManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);
const decodePluginSwitches = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      plugins: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
      ),
    }),
  ),
);
const projectionGeneration = /^[a-f0-9]{64}$/u;

/** Plugins `agy plugin disable` turned off, read as the skill picker reads them; null when
 * the user's config cannot be read. */
async function readDisabledPlugins(userHome: string): Promise<ReadonlySet<string> | null> {
  const configPath = NodePath.join(userHome, ".gemini", "config", "config.json");
  const info = await NodeFSP.stat(configPath).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : null,
  );
  if (info === null || (info?.isFile() && info.size > maxPluginManifestBytes)) return null;
  if (!info?.isFile()) return new Set();
  const contents = await NodeFSP.readFile(configPath, "utf8").catch(() => null);
  if (contents === null) return null;
  const switches = decodePluginSwitches(contents);
  return new Set(
    Object.entries(Option.isSome(switches) ? (switches.value.plugins ?? {}) : {}).flatMap(
      ([name, plugin]) => (plugin.enabled === false ? [name] : []),
    ),
  );
}

/**
 * Give the managed ACP runtime the skill component of each Antigravity plugin
 * without importing the plugin's other authority-bearing components. The
 * immutable generation keeps an already-running session's paths stable when
 * plugins are added, removed, or upgraded.
 */
export const projectAntigravityPluginSkills = Effect.fn("projectAntigravityPluginSkills")(
  function* (input: {
    readonly profileDirectory: string;
    readonly userHome: string;
    readonly platform: NodeJS.Platform;
  }) {
    yield* Effect.tryPromise({
      try: async () => {
        const sourceRoot = NodePath.join(input.userHome, ".gemini", "config", "plugins");
        const sourceEntries = await NodeFSP.readdir(sourceRoot, { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : Promise.reject(error)),
        );
        if (sourceEntries.length > maxPluginProjectionEntries) {
          throw new Error("Antigravity plugin discovery exceeded its entry limit.");
        }
        // Unknown switches project nothing, as the skill picker shows nothing for them.
        const disabled = await readDisabledPlugins(input.userHome);
        const plugins: Array<{
          readonly directoryName: string;
          readonly manifest: string;
          readonly skillsDirectory: string;
        }> = [];
        for (const entry of disabled === null
          ? []
          : sourceEntries.toSorted((left, right) => left.name.localeCompare(right.name))) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (disabled?.has(entry.name)) continue;
          const pluginDirectory = NodePath.join(sourceRoot, entry.name);
          const manifestPath = NodePath.join(pluginDirectory, "plugin.json");
          const skillsDirectory = NodePath.join(pluginDirectory, "skills");
          const [manifestInfo, skillsInfo] = await Promise.all([
            NodeFSP.stat(manifestPath).catch(() => undefined),
            NodeFSP.stat(skillsDirectory).catch(() => undefined),
          ]);
          if (
            !manifestInfo?.isFile() ||
            manifestInfo.size > maxPluginManifestBytes ||
            !skillsInfo?.isDirectory()
          ) {
            continue;
          }
          const manifest = await NodeFSP.readFile(manifestPath, "utf8");
          let parsed: { readonly name: string };
          try {
            parsed = decodePluginProjectionManifest(manifest);
          } catch {
            continue;
          }
          if (!parsed.name.trim() || disabled?.has(parsed.name.trim())) continue;
          plugins.push({ directoryName: entry.name, manifest, skillsDirectory });
        }

        const generationHash = NodeCrypto.createHash("sha256");
        for (const plugin of plugins) {
          generationHash.update(plugin.directoryName);
          generationHash.update("\0");
          generationHash.update(plugin.manifest);
          generationHash.update("\0");
          generationHash.update(plugin.skillsDirectory);
          generationHash.update("\0");
        }
        const projectionRoot = NodePath.join(
          input.profileDirectory,
          "antigravity-acp",
          "skill-plugins",
        );
        const generation = NodePath.join(projectionRoot, generationHash.digest("hex"));
        const marker = NodePath.join(generation, ".complete");
        const isComplete = await NodeFSP.stat(marker)
          .then((info) => info.isFile())
          .catch(() => false);
        if (!isComplete) {
          const temporary = NodePath.join(projectionRoot, `.next-${NodeCrypto.randomUUID()}`);
          await NodeFSP.mkdir(temporary, { recursive: true, mode: 0o700 });
          try {
            for (const plugin of plugins) {
              const target = NodePath.join(temporary, plugin.directoryName);
              await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
              await NodeFSP.writeFile(NodePath.join(target, "plugin.json"), plugin.manifest, {
                mode: 0o600,
              });
              await NodeFSP.symlink(
                plugin.skillsDirectory,
                NodePath.join(target, "skills"),
                input.platform === "win32" ? "junction" : "dir",
              );
            }
            await NodeFSP.writeFile(NodePath.join(temporary, ".complete"), "", { mode: 0o600 });
            await NodeFSP.mkdir(projectionRoot, { recursive: true, mode: 0o700 });
            await NodeFSP.rename(temporary, generation).catch(
              async (error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
                await NodeFSP.rm(temporary, { recursive: true, force: true });
              },
            );
          } catch (error) {
            await NodeFSP.rm(temporary, { recursive: true, force: true });
            throw error;
          }
        }

        const pluginsLink = NodePath.join(input.profileDirectory, "config", "plugins");
        const existing = await NodeFSP.lstat(pluginsLink).catch((error: NodeJS.ErrnoException) =>
          error.code === "ENOENT" ? undefined : Promise.reject(error),
        );
        if (existing && !existing.isSymbolicLink()) return;
        if (existing?.isSymbolicLink()) {
          const target = NodePath.resolve(
            NodePath.dirname(pluginsLink),
            await NodeFSP.readlink(pluginsLink),
          );
          if (target === generation) return;
          await NodeFSP.rm(pluginsLink);
        }
        await NodeFSP.mkdir(NodePath.dirname(pluginsLink), { recursive: true, mode: 0o700 });
        await NodeFSP.symlink(
          generation,
          pluginsLink,
          input.platform === "win32" ? "junction" : "dir",
        );
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Antigravity plugin skills are not projected into the profile.", {
          error,
        }),
      ),
    );
  },
);

/**
 * The agy CLI loads plugins itself from the user's ~/.gemini. Remove the profile's
 * `config/plugins` link only when it is one Scient made to a projected generation; user
 * directories and other links stay, and generations stay for any running paired session.
 */
export const removeAntigravityPluginSkillProjection = Effect.fn(
  "removeAntigravityPluginSkillProjection",
)(function* (input: { readonly profileDirectory: string }) {
  yield* Effect.tryPromise({
    try: async () => {
      const pluginsLink = NodePath.join(input.profileDirectory, "config", "plugins");
      const existing = await NodeFSP.lstat(pluginsLink).catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error),
      );
      if (!existing?.isSymbolicLink()) return;
      // Windows may report a junction's target with the \\?\ long-path prefix.
      const written = (await NodeFSP.readlink(pluginsLink)).replace(/^\\\\\?\\/u, "");
      const target = NodePath.resolve(NodePath.dirname(pluginsLink), written);
      const projectionRoot = NodePath.resolve(
        input.profileDirectory,
        "antigravity-acp",
        "skill-plugins",
      );
      if (
        NodePath.dirname(target) !== projectionRoot ||
        !projectionGeneration.test(NodePath.basename(target))
      ) {
        return;
      }
      await NodeFSP.rm(pluginsLink);
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Antigravity's projected plugin skills link was not removed.", { error }),
    ),
  );
});
