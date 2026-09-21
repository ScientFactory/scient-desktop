/**
 * GrokSkills — skill discovery for the `$` picker via `grok inspect --json`.
 *
 * Unlike Claude Code, the Grok CLI reports its full skill catalog itself:
 * `grok inspect --json` returns `skills[]` with `name`, `description`,
 * `source.type` (`user` / `project` / `bundled` / `plugin`), `source.path`
 * (the absolute `SKILL.md` path), and `userInvocable`. Asking the CLI beats
 * scanning the filesystem because the catalog honors Grok's own skill config
 * (ignore lists, disabled skills) and includes plugin skills, which live
 * three levels deep under `~/.grok/installed-plugins/` where a flat scan
 * cannot see them. This mirrors how the Codex app-server reports skills over
 * `skills/list`. Probe failures stay typed so workspace snapshots do not
 * cache an empty catalog; machine-level discovery recovers them to an empty
 * list without degrading the provider.
 *
 * @module provider/Drivers/GrokSkills
 */
import * as NodeOS from "node:os";

import type { GrokSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { parse as parseToml } from "smol-toml";

import { spawnAndCollect } from "../providerSnapshot.ts";

const GROK_SKILLS_PROBE_TIMEOUT_MS = 4_000;

class GrokSkillsProbeError extends Schema.TaggedError<GrokSkillsProbeError>()(
  "GrokSkillsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `\`grok inspect --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

/**
 * Map `grok inspect --json` output onto provider skills. Entries without a
 * name or a filesystem path are skipped. Native `disabled` state and manual
 * invocation are separate capabilities and must not be collapsed together.
 */
function decodeGrokInspectSkills(stdout: string): ReadonlyArray<ServerProviderSkill> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) {
    return undefined;
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const source =
      typeof record.source === "object" && record.source !== null
        ? (record.source as Record<string, unknown>)
        : undefined;
    const path = typeof source?.path === "string" ? source.path.trim() : "";
    if (!name || !path) {
      continue;
    }
    const scope = typeof source?.type === "string" ? source.type.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    skillsByName.set(name, {
      name,
      path,
      enabled: record.disabled !== true,
      canSetEnabled: true,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
      ...(typeof record.userInvocable === "boolean" ? { userInvocable: record.userInvocable } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Run `grok inspect --json` and map the reported catalog onto provider
 * skills. Callers that need best-effort discovery can recover this effect to
 * an empty list; workspace callers leave failures typed so they are not cached.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = grokSettings.binaryPath || "grok";
  const inspectResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new GrokSkillsProbeError({
          stage: "spawn",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
    Effect.timeoutOption(GROK_SKILLS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(inspectResult)) {
    return yield* new GrokSkillsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  const output = inspectResult.value;
  if (output.code !== 0) {
    return yield* new GrokSkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: output.code,
    });
  }
  const skills = decodeGrokInspectSkills(output.stdout);
  if (!skills) {
    return yield* new GrokSkillsProbeError({
      stage: "decode",
      ...(cwd ? { cwd } : {}),
    });
  }
  return skills;
});

const GROK_SKILL_SETTINGS_ERROR_TAG = "GrokSkillSettingsError";
class GrokSkillSettingsError extends Data.TaggedError(GROK_SKILL_SETTINGS_ERROR_TAG)<{
  readonly cause?: unknown;
  readonly detail: string;
}> {}

function stringArray(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function findTomlArrayEnd(contents: string, start: number): number | undefined {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let comment = false;
  for (let index = start; index < contents.length; index += 1) {
    const character = contents[index];
    if (comment) {
      if (character === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "#") {
      comment = true;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

function replaceTomlArrayAssignment(
  contents: string,
  regionStart: number,
  regionEnd: number,
  keyPattern: RegExp,
  replacementValue: string,
): string | undefined {
  const region = contents.slice(regionStart, regionEnd);
  const match = keyPattern.exec(region);
  if (!match || match.index === undefined) return undefined;
  const assignmentStart = regionStart + match.index;
  const valueStart = assignmentStart + match[0].lastIndexOf("[");
  const valueEnd = findTomlArrayEnd(contents, valueStart);
  if (valueEnd === undefined || valueEnd > regionEnd) {
    throw new Error("The skills.disabled array is incomplete.");
  }
  return `${contents.slice(0, valueStart)}${replacementValue}${contents.slice(valueEnd)}`;
}

/** Update only `[skills].disabled`, preserving every unrelated TOML byte. */
export function updateGrokDisabledSkills(
  contents: string,
  skillName: string,
  enabled: boolean,
): string {
  const parsed = parseToml(contents) as { readonly skills?: unknown };
  const skillsTable = parsed.skills;
  if (
    skillsTable !== undefined &&
    (typeof skillsTable !== "object" || skillsTable === null || Array.isArray(skillsTable))
  ) {
    throw new Error("skills must be a TOML table.");
  }
  const existingValue = (skillsTable as { readonly disabled?: unknown } | undefined)?.disabled;
  const existing = existingValue === undefined ? [] : stringArray(existingValue);
  if (!existing) {
    throw new Error("skills.disabled must be an array of skill names.");
  }
  const next = enabled
    ? existing.filter((name) => name !== skillName)
    : existing.includes(skillName)
      ? [...existing]
      : [...existing, skillName];
  const replacementValue = `[${next.map((name) => JSON.stringify(name)).join(", ")}]`;

  const lineEnding = contents.includes("\r\n") ? "\r\n" : "\n";
  const sectionPattern = /^\s*\[\s*skills\s*\]\s*(?:#.*)?$/gm;
  const section = sectionPattern.exec(contents);
  if (section?.index !== undefined) {
    const bodyStart = section.index + section[0].length;
    const nextSection = /^\s*\[(?!\s*skills\s*\])[^\r\n]*\]\s*(?:#.*)?$/gm;
    nextSection.lastIndex = bodyStart;
    const sectionEnd = nextSection.exec(contents)?.index ?? contents.length;
    const replaced = replaceTomlArrayAssignment(
      contents,
      bodyStart,
      sectionEnd,
      /^\s*disabled\s*=\s*\[/m,
      replacementValue,
    );
    if (replaced !== undefined) {
      parseToml(replaced);
      return replaced;
    }
    if (existingValue !== undefined) {
      throw new Error("The existing skills.disabled setting cannot be edited safely.");
    }
    const prefix = contents.slice(0, sectionEnd);
    const separator = prefix.endsWith("\n") || prefix.endsWith("\r") ? "" : lineEnding;
    const updated = `${prefix}${separator}disabled = ${replacementValue}${lineEnding}${contents.slice(sectionEnd)}`;
    parseToml(updated);
    return updated;
  }

  const dotted = replaceTomlArrayAssignment(
    contents,
    0,
    contents.length,
    /^\s*skills\.disabled\s*=\s*\[/m,
    replacementValue,
  );
  if (dotted !== undefined) {
    parseToml(dotted);
    return dotted;
  }
  if (existingValue !== undefined) {
    throw new Error("The existing skills.disabled setting cannot be edited safely.");
  }
  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : lineEnding;
  const updated = `${contents}${separator}[skills]${lineEnding}disabled = ${replacementValue}${lineEnding}`;
  parseToml(updated);
  return updated;
}

export const setGrokSkillEnabled = Effect.fn("setGrokSkillEnabled")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly name: string;
  readonly enabled: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home =
    input.environment.GROK_HOME?.trim() ||
    path.join(input.environment.HOME || input.environment.USERPROFILE || NodeOS.homedir(), ".grok");
  const configDirectory = path.resolve(input.cwd, home);
  const configPath = path.join(configDirectory, "config.toml");
  const contents = yield* fileSystem.readFileString(configPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    }),
    Effect.mapError(
      (cause) =>
        new GrokSkillSettingsError({
          cause,
          detail: "Grok's user configuration could not be read.",
        }),
    ),
  );
  const updated = yield* Effect.try({
    try: () => updateGrokDisabledSkills(contents, input.name, input.enabled),
    catch: (cause) =>
      new GrokSkillSettingsError({
        cause,
        detail: "Grok's skill settings could not be updated safely.",
      }),
  });
  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(configDirectory, { recursive: true });
    const temporaryPath = yield* fileSystem.makeTempFile({
      directory: configDirectory,
      prefix: ".config.toml.scient-",
    });
    yield* fileSystem
      .writeFileString(temporaryPath, updated)
      .pipe(
        Effect.andThen(fileSystem.rename(temporaryPath, configPath)),
        Effect.ensuring(fileSystem.remove(temporaryPath).pipe(Effect.ignore)),
      );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new GrokSkillSettingsError({ cause, detail: "Grok's skill setting could not be saved." }),
    ),
  );
  return { effectiveEnabled: input.enabled };
});
