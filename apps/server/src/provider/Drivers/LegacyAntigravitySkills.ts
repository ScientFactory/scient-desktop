/** Read-only discovery of the global skills Antigravity makes available. */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseSkillFrontmatter(
  contents: string,
): { readonly name: string; readonly description?: string } | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!name) return undefined;
  return { name, ...(description ? { description } : {}) };
}

/**
 * Mirror Antigravity's documented global precedence without inspecting
 * credentials: provider-bundled skills first, then user skills.
 */
export const discoverAntigravitySkills = Effect.fn("discoverAntigravitySkills")(function* (
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = path.resolve(environment.HOME?.trim() || NodeOS.homedir());
  const roots = [
    {
      directory: path.join(homeDirectory, ".gemini", "antigravity-cli", "builtin", "skills"),
      scope: "app",
    },
    {
      directory: path.join(homeDirectory, ".gemini", "config", "skills"),
      scope: "user",
    },
  ] as const;

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) continue;

      const metadata = parseSkillFrontmatter(contents);
      if (!metadata) continue;
      skillsByName.set(metadata.name, {
        name: metadata.name,
        path: skillPath,
        scope: root.scope,
        enabled: true,
        ...(metadata.description ? { description: metadata.description } : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
