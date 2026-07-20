import { createHash } from "node:crypto";

import type { BuiltInSkillMetadata } from "./types.ts";

const ID_PATTERN = /^scient\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST_INPUT_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}

export interface DigestInputFile {
  readonly path: string;
  readonly contents: string;
}

export function compareBuiltInSkillVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown.replaceAll("\r\n", "\n"));
  if (!match) throw new Error("SKILL.md must begin with YAML frontmatter.");

  const fields = Object.fromEntries(
    (match[1] ?? "").split("\n").flatMap((line) => {
      const separator = line.indexOf(":");
      return separator > 0
        ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]]
        : [];
    }),
  );
  const name = fields.name;
  const description = fields.description;
  if (!name || !description) {
    throw new Error("SKILL.md frontmatter requires non-empty name and description fields.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Skill name ${name} must use lowercase hyphen-case.`);
  }
  return { name, description };
}

export function assertBuiltInSkillMetadata(value: unknown): asserts value is BuiltInSkillMetadata {
  if (!isRecord(value)) throw new Error("scient.skill.json must contain an object.");
  requireExactKeys(value, "scient.skill.json", [
    "id",
    "version",
    "displayName",
    "kind",
    "role",
    "scope",
    "visibility",
    "activation",
    "maintainer",
    "capabilities",
    "requirements",
    "limitations",
  ]);
  requireText(value.id, "id", ID_PATTERN);
  requireText(value.version, "version", VERSION_PATTERN);
  requireText(value.displayName, "displayName");
  requireLiteral(value.kind, "kind", ["scientific", "meta"]);
  requireLiteral(value.role, "role", ["constructive", "review", "orientation"]);
  requireLiteral(value.scope, "scope", ["universal", "domain"]);
  requireLiteral(value.visibility, "visibility", ["internal", "user"]);
  if (!isRecord(value.activation)) throw new Error("activation must contain an object.");
  requireExactKeys(value.activation, "activation", ["scope", "defaultEnabled"]);
  requireLiteral(value.activation.scope, "activation.scope", ["user", "project"]);
  requireBoolean(value.activation.defaultEnabled, "activation.defaultEnabled");
  requireText(value.maintainer, "maintainer");

  if (!isRecord(value.capabilities)) throw new Error("capabilities must contain an object.");
  requireExactKeys(value.capabilities, "capabilities", [
    "network",
    "codeExecution",
    "projectWrites",
  ]);
  requireBoolean(value.capabilities.network, "capabilities.network");
  requireBoolean(value.capabilities.codeExecution, "capabilities.codeExecution");
  requireLiteral(value.capabilities.projectWrites, "capabilities.projectWrites", [
    "none",
    "proposal-only",
  ]);

  if (!isRecord(value.requirements)) throw new Error("requirements must contain an object.");
  requireExactKeys(value.requirements, "requirements", ["projectObjects", "operations"]);
  requireTextArray(value.requirements.projectObjects, "requirements.projectObjects");
  requireTextArray(value.requirements.operations, "requirements.operations");
  requireTextArray(value.limitations, "limitations");
}

export function computeBuiltInSkillDigest(files: readonly DigestInputFile[]): `sha256:${string}` {
  const hash = createHash("sha256");
  const sorted = files.toSorted((left, right) => left.path.localeCompare(right.path));
  const seen = new Set<string>();
  for (const file of sorted) {
    if (!DIGEST_INPUT_PATH_PATTERN.test(file.path) || file.path.includes("..")) {
      throw new Error(`Digest input path ${file.path} is not portable.`);
    }
    if (seen.has(file.path)) throw new Error(`Duplicate digest input path ${file.path}.`);
    seen.add(file.path);
    const contents = Buffer.from(file.contents, "utf8");
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(contents.byteLength), "utf8");
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  field: string,
  expected: readonly string[],
): void {
  const expectedKeys = new Set(expected);
  const missing = expected.filter((key) => !(key in value));
  const unexpected = Object.keys(value).filter((key) => !expectedKeys.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unexpected ${unexpected.join(", ")}`] : []),
    ].join("; ");
    throw new Error(`${field} has invalid fields: ${details}.`);
  }
}

function requireText(value: unknown, field: string, pattern?: RegExp): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${field} must be non-empty trimmed text.`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${field} has an invalid value: ${value}.`);
}

function requireBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean.`);
}

function requireLiteral<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}.`);
  }
}

function requireTextArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  for (const entry of value) requireText(entry, `${field} entry`);
}
