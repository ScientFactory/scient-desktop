import { parse as parseYamlDocument } from "yaml";

import type { AgentSkillMetadata } from "./model.ts";

const MAX_SKILL_DOCUMENT_BYTES = 256 * 1024;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface ParsedSkillDocument {
  readonly metadata: AgentSkillMetadata;
  readonly instructions: string;
}

export class SkillDocumentError extends Error {
  override readonly name = "SkillDocumentError";
}

function optionalTrimmedString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SkillDocumentError(`SKILL.md frontmatter field '${key}' must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximumLength) {
    throw new SkillDocumentError(
      `SKILL.md frontmatter field '${key}' must contain 1 to ${maximumLength} characters.`,
    );
  }
  return trimmed;
}

function parseMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillDocumentError("SKILL.md metadata must be a string-to-string mapping.");
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new SkillDocumentError("SKILL.md metadata must be a string-to-string mapping.");
    }
    result[key] = entry;
  }
  return result;
}

/** Parse the current Agent Skills format without treating `allowed-tools` as permission. */
export function parseSkillDocument(contents: string, directoryName: string): ParsedSkillDocument {
  if (Buffer.byteLength(contents, "utf8") > MAX_SKILL_DOCUMENT_BYTES) {
    throw new SkillDocumentError("SKILL.md exceeds the 256 KiB instruction limit.");
  }
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    throw new SkillDocumentError("SKILL.md requires YAML frontmatter.");
  }

  let frontmatter: unknown;
  try {
    frontmatter = parseYamlDocument(match[1] ?? "");
  } catch {
    throw new SkillDocumentError("SKILL.md frontmatter is not valid YAML.");
  }
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new SkillDocumentError("SKILL.md frontmatter must be a mapping.");
  }
  const record = frontmatter as Record<string, unknown>;
  const name = optionalTrimmedString(record, "name", 64);
  if (name === undefined || !SKILL_NAME_PATTERN.test(name)) {
    throw new SkillDocumentError(
      "Skill name must be lowercase kebab-case without consecutive hyphens.",
    );
  }
  if (name !== directoryName) {
    throw new SkillDocumentError("Skill name must match its parent directory name.");
  }
  const description = optionalTrimmedString(record, "description", 1_024);
  if (description === undefined) {
    throw new SkillDocumentError("Skill description is required.");
  }
  const instructions = contents.slice(match[0].length).trim();
  if (instructions.length === 0) {
    throw new SkillDocumentError("SKILL.md has no instructions after its frontmatter.");
  }

  const license = optionalTrimmedString(record, "license", 500);
  const compatibility = optionalTrimmedString(record, "compatibility", 500);
  const allowedTools = optionalTrimmedString(record, "allowed-tools", 2_048);
  const metadata = parseMetadata(record.metadata);
  return {
    metadata: {
      name,
      description,
      ...(license === undefined ? {} : { license }),
      ...(compatibility === undefined ? {} : { compatibility }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
    },
    instructions,
  };
}
