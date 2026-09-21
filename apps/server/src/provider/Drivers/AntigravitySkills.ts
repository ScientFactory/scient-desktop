import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { parse as parseYamlDocument } from "yaml";

/**
 * The home directory the agent expands `~` against, matching Python's
 * `os.path.expanduser` in the launch environment T3 hands the process:
 * `USERPROFILE`, then `HOMEDRIVE` + `HOMEPATH`, on Windows and `HOME`
 * elsewhere. Values are used verbatim; a path may contain spaces.
 */
export function resolveAntigravityUserHome(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") {
    if (environment.USERPROFILE) return environment.USERPROFILE;
    if (environment.HOMEDRIVE && environment.HOMEPATH) {
      return `${environment.HOMEDRIVE}${environment.HOMEPATH}`;
    }
    return NodeOS.homedir();
  }
  return environment.HOME || NodeOS.homedir();
}

/**
 * The agent's two user-global skill directories under a Gemini home, in
 * native precedence order: `config/skills` is shared with the Antigravity IDE
 * and CLI, and `antigravity-cli/skills` is where the `agy` CLI installs
 * skills. The agent resolves both under `GEMINI_HOME`, which T3 points at a
 * private profile, so the profile links these back to the user's `~/.gemini`.
 * `~/.agents/skills` is not read: the agent only treats `.agents/skills` as a
 * project directory.
 */
export function antigravityUserSkillDirectories(
  path: Path.Path,
  geminiHome: string,
): readonly [configSkills: string, cliSkills: string] {
  return [
    path.join(geminiHome, "config", "skills"),
    path.join(geminiHome, "antigravity-cli", "skills"),
  ];
}

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SCAN_ENTRIES = 10_000;

const SkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeSkillFrontmatter = Schema.decodeUnknownSync(SkillFrontmatter);
const PluginManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
  }),
);
const decodePluginManifest = Schema.decodeUnknownOption(PluginManifest);

/** Global plugins loaded by Antigravity 2.0 and the standalone IDE. */
function antigravityUserPluginDirectory(path: Path.Path, geminiHome: string): string {
  return path.join(geminiHome, "config", "plugins");
}

export class AntigravitySkillsProbeError extends Schema.TaggedError<AntigravitySkillsProbeError>()(
  "AntigravitySkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "scan-budget-exhausted"
      ? `Antigravity skill discovery exceeded its scan limit at '${this.path}'.`
      : `Antigravity could not read skills at '${this.path}'.`;
  }
}

interface ScanBudget {
  remainingBytes: number;
  remainingEntries: number;
}

const readIfPresent = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  path: string,
) =>
  effect.pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(
              new AntigravitySkillsProbeError({ reason: "filesystem-error", path, cause }),
            ),
    }),
  );

function parseSkillFrontmatter(contents: string, fileName: string) {
  const start = contents.indexOf("---");
  if (start === -1) return undefined;
  const end = contents.indexOf("---", start + 3);
  if (end === -1) return undefined;
  try {
    const frontmatter = decodeSkillFrontmatter(
      parseYamlDocument(contents.slice(start + 3, end).trim()) ?? {},
    );
    const name = frontmatter.name || fileName.slice(0, -3);
    const description = frontmatter.description?.trim();
    // Native names are not trimmed. Do not rename one to fit the picker contract.
    if (!name || name !== name.trim()) return undefined;
    return { name, ...(description ? { description } : {}) };
  } catch {
    return undefined;
  }
}

/** The native loader orders child paths with Go's URL.EscapedPath encoding. */
function skillPathSortKey(entry: string) {
  return encodeURI(entry).replace(
    /[!'()*?#]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Read only regular skill files, with a byte limit that applies during the read. */
const readSkill = Effect.fn("readAntigravitySkill")(function* (
  skillPath: string,
  budget: ScanBudget,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* readIfPresent(fileSystem.stat(skillPath), skillPath);
  if (info?.type !== "File") return undefined;

  const byteLimit = Math.min(MAX_SKILL_BYTES, budget.remainingBytes);
  if (info.size > BigInt(byteLimit)) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: skillPath,
    });
  }
  const chunks = yield* readIfPresent(
    fileSystem.stream(skillPath, { bytesToRead: byteLimit + 1 }).pipe(Stream.runCollect),
    skillPath,
  );
  if (chunks === undefined) return undefined;
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength > byteLimit) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: skillPath,
    });
  }
  budget.remainingBytes -= bytes.byteLength;
  return bytes.toString("utf8");
});

/**
 * Match the official ACP's documented skill locations. The first valid
 * same-name skill wins. Each loose root loads its own SKILL.md or those in its
 * immediate subdirectories; plugin skills are namespaced by their manifest.
 * Read failures remain typed so workspace snapshots do not cache partial results.
 */
export const discoverAntigravitySkills = Effect.fn("discoverAntigravitySkills")(function* (input: {
  readonly cwd?: string;
  readonly userHome: string;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  AntigravitySkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [configSkills, cliSkills] = antigravityUserSkillDirectories(
    path,
    path.join(input.userHome, ".gemini"),
  );
  const userGeminiHome = path.join(input.userHome, ".gemini");
  const globalPlugins = antigravityUserPluginDirectory(path, userGeminiHome);
  const roots = [
    { directory: configSkills, scope: "user" },
    ...(input.cwd
      ? [{ directory: path.resolve(input.cwd, ".gemini", "skills"), scope: "project" }]
      : []),
    { directory: cliSkills, scope: "user" },
    ...(input.cwd
      ? [
          { directory: path.resolve(input.cwd, ".agents", "skills"), scope: "project" },
          { directory: path.resolve(input.cwd, ".agent", "skills"), scope: "project" },
        ]
      : []),
  ];
  const budget: ScanBudget = {
    remainingBytes: MAX_SCAN_BYTES,
    remainingEntries: MAX_SCAN_ENTRIES,
  };
  const skillsByName = new Map<string, ServerProviderSkill>();

  const scanDirectory = Effect.fn("scanAntigravitySkillDirectory")(function* (
    directory: string,
    scope: string,
    scanChildren: boolean,
    namePrefix?: string,
  ): Effect.fn.Return<void, AntigravitySkillsProbeError, FileSystem.FileSystem> {
    const info = yield* readIfPresent(fileSystem.stat(directory), directory);
    if (info?.type !== "Directory") return;
    const entries = yield* readIfPresent(fileSystem.readDirectory(directory), directory);
    if (entries === undefined) return;
    if (entries.length > budget.remainingEntries) {
      return yield* new AntigravitySkillsProbeError({
        reason: "scan-budget-exhausted",
        path: directory,
      });
    }
    budget.remainingEntries -= entries.length;

    const sortedEntries = entries.toSorted();
    const skillFileName = sortedEntries.find((entry) => entry.toLowerCase() === "skill.md");
    if (skillFileName !== undefined) {
      if (!skillFileName.endsWith(".md")) return;
      const skillPath = path.join(directory, skillFileName);
      const contents = yield* readSkill(skillPath, budget);
      if (contents === undefined) return;
      const skill = parseSkillFrontmatter(contents, skillFileName);
      if (!skill) return;
      const name = namePrefix ? `${namePrefix}:${skill.name}` : skill.name;
      if (skillsByName.has(name)) return;
      skillsByName.set(name, {
        ...skill,
        name,
        path: skillPath,
        scope,
        enabled: true,
      });
      return;
    }
    if (scanChildren) {
      const children = sortedEntries
        .map((entry) => ({ entry, sortKey: skillPathSortKey(entry) }))
        .sort((left, right) =>
          left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0,
        );
      for (const { entry } of children) {
        yield* scanDirectory(path.join(directory, entry), scope, false, namePrefix);
      }
    }
  });

  const scanPluginDirectory = Effect.fn("scanAntigravityPluginDirectory")(function* (
    directory: string,
  ): Effect.fn.Return<void, AntigravitySkillsProbeError, FileSystem.FileSystem> {
    const info = yield* readIfPresent(fileSystem.stat(directory), directory);
    if (info?.type !== "Directory") return;
    const entries = yield* readIfPresent(fileSystem.readDirectory(directory), directory);
    if (entries === undefined) return;
    if (entries.length > budget.remainingEntries) {
      return yield* new AntigravitySkillsProbeError({
        reason: "scan-budget-exhausted",
        path: directory,
      });
    }
    budget.remainingEntries -= entries.length;

    for (const entry of entries.toSorted()) {
      const pluginDirectory = path.join(directory, entry);
      const manifestPath = path.join(pluginDirectory, "plugin.json");
      const manifestContents = yield* readSkill(manifestPath, budget);
      if (manifestContents === undefined) continue;
      const manifest = decodePluginManifest(manifestContents);
      if (Option.isNone(manifest)) continue;
      const pluginName = manifest.value.name.trim();
      if (!pluginName) continue;
      yield* scanDirectory(path.join(pluginDirectory, "skills"), "plugin", true, pluginName);
    }
  });

  for (const root of roots) {
    yield* scanDirectory(root.directory, root.scope, true);
  }
  yield* scanPluginDirectory(globalPlugins);
  if (input.cwd) {
    yield* scanPluginDirectory(path.resolve(input.cwd, ".agents", "plugins"));
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
