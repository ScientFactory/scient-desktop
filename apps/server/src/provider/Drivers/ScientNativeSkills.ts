/**
 * Scient's native skill on/off writers for provider-owned settings files.
 * Each writer edits only the provider's own skill setting, preserving every
 * unrelated byte, and replaces the file atomically through a sibling
 * temporary file.
 *
 * @module provider/Drivers/ScientNativeSkills
 */
import * as NodeOS from "node:os";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseToml } from "smol-toml";

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
