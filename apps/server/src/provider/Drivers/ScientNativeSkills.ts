/**
 * Scient's native skill on/off writers for provider-owned settings files.
 * Each writer edits only the provider's own skill setting, preserving every
 * unrelated byte, and replaces the file atomically through a sibling
 * temporary file. It also holds Claude's skill activation control and the
 * merge of SDK-reported Claude skills with filesystem discovery.
 *
 * @module provider/Drivers/ScientNativeSkills
 */
import * as NodeOS from "node:os";

import type {
  ClaudeSettings,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
// Direct Node imports use the public entry; CLI packaging selects its ESM closure.
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

const CLAUDE_REPORTED_SKILL_PREFIX = "claude://skills/";

/** Write a settings file through a sibling temporary file and one rename. */
const writeSettingsFileAtomically = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly directory: string;
  readonly filePath: string;
  readonly temporaryPrefix: string;
  readonly contents: string;
}) =>
  Effect.gen(function* () {
    const { fileSystem } = input;
    yield* fileSystem.makeDirectory(input.directory, { recursive: true });
    const temporaryPath = yield* fileSystem.makeTempFile({
      directory: input.directory,
      prefix: input.temporaryPrefix,
    });
    yield* fileSystem
      .writeFileString(temporaryPath, input.contents)
      .pipe(
        Effect.andThen(fileSystem.rename(temporaryPath, input.filePath)),
        Effect.ensuring(fileSystem.remove(temporaryPath).pipe(Effect.ignore)),
      );
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
  yield* writeSettingsFileAtomically({
    fileSystem,
    directory: configDirectory,
    filePath: configPath,
    temporaryPrefix: ".config.toml.scient-",
    contents: updated,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new GrokSkillSettingsError({ cause, detail: "Grok's skill setting could not be saved." }),
    ),
  );
  return { effectiveEnabled: input.enabled };
});

/**
 * Whether Scient may switch a discovered Claude skill on or off, or why not.
 * Only a user-scoped skill without an override, or with a plain on/off user
 * override, is writable; project, managed-policy and invocation-mode
 * overrides stay read-only.
 */
export function claudeSkillEnabledControl(
  scope: "user" | "project",
  override: { readonly source: "user" | "project" | "managed"; readonly mode: string } | undefined,
): Pick<ServerProviderSkill, "canSetEnabled" | "enabledReadOnlyReason"> {
  return scope === "user" &&
    (override === undefined ||
      (override.source === "user" && (override.mode === "on" || override.mode === "off")))
    ? { canSetEnabled: true }
    : {
        enabledReadOnlyReason:
          scope === "project"
            ? "Managed in this project"
            : override?.source === "managed"
              ? "Managed by policy"
              : override?.source === "project"
                ? "Overridden by this project"
                : "Uses a Claude invocation mode",
      };
}

/**
 * Combine Claude's authoritative SDK skill list with filesystem metadata.
 *
 * The SDK reports bundled skills that have no stable public filesystem path,
 * while direct discovery identifies the scope of personal and project skills.
 * Filesystem entries therefore override matching SDK entries; unmatched SDK
 * entries are provider-bundled and receive a stable virtual identity.
 */
export function mergeClaudeReportedSkills(
  discoveredSkills: ReadonlyArray<ServerProviderSkill>,
  reportedSkills: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSkill> {
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const skill of reportedSkills) {
    const name = skill.name.trim();
    if (!name) continue;
    skillsByName.set(name.toLowerCase(), {
      name,
      path: `${CLAUDE_REPORTED_SKILL_PREFIX}${encodeURIComponent(name)}`,
      scope: "app",
      enabled: true,
      enabledReadOnlyReason: "Managed by Claude",
      ...(skill.description ? { description: skill.description } : {}),
    });
  }

  for (const skill of discoveredSkills) {
    const key = skill.name.trim().toLowerCase();
    if (!key) continue;
    const reported = skillsByName.get(key);
    const { enabledReadOnlyReason: _reportedReadOnlyReason, ...reportedMetadata } = reported ?? {};
    skillsByName.set(key, {
      ...reportedMetadata,
      ...skill,
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const CLAUDE_SKILL_SETTINGS_ERROR_TAG = "ClaudeSkillSettingsError";
class ClaudeSkillSettingsError extends Data.TaggedError(CLAUDE_SKILL_SETTINGS_ERROR_TAG)<{
  readonly cause?: unknown;
  readonly detail: string;
}> {}

/**
 * Persist one user-scoped Claude skill override without rewriting unrelated
 * JSONC settings or comments. Higher-precedence project and managed settings
 * remain authoritative and are caught by the shared refresh/readback gate.
 */
export const makeSetClaudeSkillEnabled = <R>(
  resolveClaudeConfigDirPath: (
    config: Pick<ClaudeSettings, "homePath">,
    environment: NodeJS.ProcessEnv,
    cwd?: string,
  ) => Effect.Effect<string, never, R>,
) =>
  Effect.fn("setClaudeSkillEnabled")(function* (input: {
    readonly config: Pick<ClaudeSettings, "homePath">;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd?: string | undefined;
    readonly name: string;
    readonly scope?: string | undefined;
    readonly enabled: boolean;
  }) {
    if (input.scope !== "user") {
      return yield* new ClaudeSkillSettingsError({
        detail: "Only user-scoped Claude skills can be changed from External skills.",
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDirPath = yield* resolveClaudeConfigDirPath(
      input.config,
      input.environment,
      input.cwd,
    );
    const settingsPath = path.join(configDirPath, "settings.json");
    const contents = yield* fileSystem.readFileString(settingsPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}\n") : Effect.fail(error),
      }),
      Effect.mapError(
        (cause) =>
          new ClaudeSkillSettingsError({
            cause,
            detail: "Claude's user settings could not be read.",
          }),
      ),
    );

    const parseErrors: ParseError[] = [];
    const parsedSettings = parse(contents, parseErrors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (
      parseErrors.length > 0 ||
      typeof parsedSettings !== "object" ||
      parsedSettings === null ||
      Array.isArray(parsedSettings)
    ) {
      return yield* new ClaudeSkillSettingsError({
        detail: "Claude's user settings contain invalid JSON and were not changed.",
      });
    }

    const lineEnding = contents.includes("\r\n") ? "\r\n" : "\n";
    const updated = applyEdits(
      contents,
      modify(contents, ["skillOverrides", input.name], input.enabled ? "on" : "off", {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: lineEnding },
      }),
    );
    yield* writeSettingsFileAtomically({
      fileSystem,
      directory: configDirPath,
      filePath: settingsPath,
      temporaryPrefix: ".settings.json.scient-",
      contents: updated,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeSkillSettingsError({
            cause,
            detail: "Claude's user skill setting could not be saved.",
          }),
      ),
    );

    return { effectiveEnabled: input.enabled };
  });
