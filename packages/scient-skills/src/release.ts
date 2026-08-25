// @effect-diagnostics nodeBuiltinImport:off -- Skill release verification is a Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  SCIENT_SKILL_MANIFEST_FILE,
  SKILL_DOCUMENT_FILE,
  skillOriginKey,
  type SkillActivationScope,
  type SkillInvocationPolicy,
  type SkillOrigin,
  type SkillRelease,
  type SkillReleaseManifest,
  type SkillResourceSummary,
} from "./model.ts";
import { parseSkillDocument } from "./skillDocument.ts";

const MAX_RELEASE_FILES = 200;
const MAX_RELEASE_BYTES = 5 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_PATTERN = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);
const verifiedFiles = new WeakMap<SkillRelease, ReadonlyMap<string, Uint8Array>>();

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export class SkillReleaseValidationError extends Error {
  override readonly name = "SkillReleaseValidationError";
}

interface ReleaseFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillReleaseValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength = 128,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new SkillReleaseValidationError(`Skill manifest field '${key}' must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximumLength) {
    throw new SkillReleaseValidationError(
      `Skill manifest field '${key}' must contain 1 to ${maximumLength} characters.`,
    );
  }
  return trimmed;
}

function requiredDisplayOrder(record: Readonly<Record<string, unknown>>): number {
  const value = record.displayOrder;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 10_000) {
    throw new SkillReleaseValidationError(
      "Skill manifest field 'displayOrder' must be an integer from 0 to 10000.",
    );
  }
  return value;
}

function parseOrigin(value: unknown): SkillOrigin {
  const record = requireRecord(value, "Skill manifest origin");
  const kind = requiredString(record, "kind", 32);
  if (kind === "scient") return { kind: "scient" };
  if (kind !== "addon") {
    throw new SkillReleaseValidationError("Skill origin must be 'scient' or 'addon'.");
  }
  const addonId = requiredString(record, "addonId");
  const addonVersion = requiredString(record, "addonVersion", 64);
  if (!SKILL_ID_PATTERN.test(addonId) || !SEMVER_PATTERN.test(addonVersion)) {
    throw new SkillReleaseValidationError("Add-on skill origin has an invalid id or version.");
  }
  return { kind: "addon", addonId, addonVersion };
}

function parseSupportedScopes(value: unknown): ReadonlyArray<SkillActivationScope> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SkillReleaseValidationError(
      "Skill supportedScopes must contain 'project', 'user', or both.",
    );
  }
  const scopes = new Set<SkillActivationScope>();
  for (const scope of value) {
    if (scope !== "project" && scope !== "user") {
      throw new SkillReleaseValidationError(
        "Skill supportedScopes must contain only 'project' or 'user'.",
      );
    }
    scopes.add(scope);
  }
  return Object.freeze([...scopes].sort());
}

export function parseSkillReleaseManifest(contents: string): SkillReleaseManifest {
  if (Buffer.byteLength(contents, "utf8") > MAX_MANIFEST_BYTES) {
    throw new SkillReleaseValidationError("scient.skill.json exceeds 64 KiB.");
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new SkillReleaseValidationError("scient.skill.json is not valid JSON.");
  }
  const record = requireRecord(value, "Skill manifest");
  const apiVersion = requiredString(record, "apiVersion");
  const id = requiredString(record, "id");
  const version = requiredString(record, "version", 64);
  const category = requiredString(record, "category", 64);
  const categoryDescription = requiredString(record, "categoryDescription", 160);
  const displayOrder = requiredDisplayOrder(record);
  const defaultInvocationPolicy = requiredString(record, "defaultInvocationPolicy", 32);
  if (apiVersion !== "scient.skills/v1alpha1") {
    throw new SkillReleaseValidationError("Unsupported skill manifest apiVersion.");
  }
  if (!SKILL_ID_PATTERN.test(id) || !SEMVER_PATTERN.test(version)) {
    throw new SkillReleaseValidationError("Skill manifest has an invalid id or version.");
  }
  if (defaultInvocationPolicy !== "automatic" && defaultInvocationPolicy !== "explicit") {
    throw new SkillReleaseValidationError(
      "Skill defaultInvocationPolicy must be 'automatic' or 'explicit'.",
    );
  }
  return {
    apiVersion,
    id,
    version,
    category,
    categoryDescription,
    displayOrder,
    supportedScopes: parseSupportedScopes(record.supportedScopes),
    defaultInvocationPolicy: defaultInvocationPolicy as SkillInvocationPolicy,
    origin: parseOrigin(record.origin),
  };
}

function resourceKind(path: string): SkillResourceSummary["kind"] {
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  return "other";
}

function digestReleaseFiles(files: ReadonlyArray<ReleaseFile>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    hash.update(`${pathBytes.byteLength}:`);
    hash.update(pathBytes);
    hash.update(`:${file.bytes.byteLength}:`);
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function validateReleaseFiles(files: ReadonlyArray<ReleaseFile>): void {
  if (files.length > MAX_RELEASE_FILES) {
    throw new SkillReleaseValidationError(
      `Skill release contains more than ${MAX_RELEASE_FILES} files.`,
    );
  }
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const file of files) {
    const path = file.relativePath;
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new SkillReleaseValidationError(`Skill release file '${path}' has an invalid path.`);
    }
    if (paths.has(path)) {
      throw new SkillReleaseValidationError(`Skill release file '${path}' is duplicated.`);
    }
    paths.add(path);
    if (file.bytes.byteLength > MAX_RESOURCE_BYTES) {
      throw new SkillReleaseValidationError(
        `Skill release file '${path}' exceeds the 1 MiB file limit.`,
      );
    }
    totalBytes += file.bytes.byteLength;
    if (totalBytes > MAX_RELEASE_BYTES) {
      throw new SkillReleaseValidationError("Skill release exceeds the 5 MiB total limit.");
    }
  }
}

async function collectReleaseFiles(rootPath: string): Promise<ReadonlyArray<ReleaseFile>> {
  const files: ReleaseFile[] = [];
  let totalBytes = 0;

  async function walk(directoryPath: string, prefix: string): Promise<void> {
    const entries = await NodeFSP.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
      if (entry.name.includes("\\")) {
        throw new SkillReleaseValidationError(
          `Skill release entry '${entry.name}' must use a portable file name.`,
        );
      }
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = NodePath.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SkillReleaseValidationError(
          `Skill release file '${relativePath}' must not be a symbolic link.`,
        );
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new SkillReleaseValidationError(
          `Skill release entry '${relativePath}' is not a regular file.`,
        );
      }
      if (files.length >= MAX_RELEASE_FILES) {
        throw new SkillReleaseValidationError(
          `Skill release contains more than ${MAX_RELEASE_FILES} files.`,
        );
      }
      const stat = await NodeFSP.lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SkillReleaseValidationError(
          `Skill release entry '${relativePath}' is no longer a regular file.`,
        );
      }
      if (stat.size > MAX_RESOURCE_BYTES) {
        throw new SkillReleaseValidationError(
          `Skill release file '${relativePath}' exceeds the 1 MiB file limit.`,
        );
      }
      const bytes = await NodeFSP.readFile(absolutePath);
      if (bytes.byteLength > MAX_RESOURCE_BYTES) {
        throw new SkillReleaseValidationError(
          `Skill release file '${relativePath}' exceeds the 1 MiB file limit.`,
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_RELEASE_BYTES) {
        throw new SkillReleaseValidationError("Skill release exceeds the 5 MiB total limit.");
      }
      files.push({ relativePath, bytes });
    }
  }

  await walk(rootPath, "");
  const sorted = files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  validateReleaseFiles(sorted);
  return sorted;
}

function releaseFromFiles(
  directoryName: string,
  releaseFiles: ReadonlyArray<ReleaseFile>,
): SkillRelease {
  const files = [...releaseFiles].sort((left, right) =>
    compareStrings(left.relativePath, right.relativePath),
  );
  validateReleaseFiles(files);
  const byPath = new Map(files.map((file) => [file.relativePath, file.bytes] as const));
  const skillDocumentBytes = byPath.get(SKILL_DOCUMENT_FILE);
  const manifestBytes = byPath.get(SCIENT_SKILL_MANIFEST_FILE);
  if (!skillDocumentBytes || !manifestBytes) {
    throw new SkillReleaseValidationError(
      `Skill release requires ${SKILL_DOCUMENT_FILE} and ${SCIENT_SKILL_MANIFEST_FILE}.`,
    );
  }
  const manifest = parseSkillReleaseManifest(Buffer.from(manifestBytes).toString("utf8"));
  const parsed = parseSkillDocument(
    Buffer.from(skillDocumentBytes).toString("utf8"),
    directoryName,
  );
  const resources = Object.freeze(
    files
      .filter(
        (file) =>
          file.relativePath !== SKILL_DOCUMENT_FILE &&
          file.relativePath !== SCIENT_SKILL_MANIFEST_FILE,
      )
      .map((file) =>
        Object.freeze({
          path: file.relativePath,
          bytes: file.bytes.byteLength,
          kind: resourceKind(file.relativePath),
        }),
      ),
  );
  const frozenManifest = Object.freeze({
    ...manifest,
    supportedScopes: Object.freeze([...manifest.supportedScopes]),
    origin: Object.freeze({ ...manifest.origin }),
  });
  const frozenMetadata = Object.freeze({
    ...parsed.metadata,
    ...(parsed.metadata.metadata
      ? { metadata: Object.freeze({ ...parsed.metadata.metadata }) }
      : {}),
  });
  const release: SkillRelease = Object.freeze({
    manifest: frozenManifest,
    metadata: frozenMetadata,
    instructions: parsed.instructions,
    resources,
    id: manifest.id,
    version: manifest.version,
    digest: digestReleaseFiles(files),
    origin: skillOriginKey(manifest.origin),
    name: parsed.metadata.name,
    description: parsed.metadata.description,
    category: manifest.category,
    categoryDescription: manifest.categoryDescription,
    displayOrder: manifest.displayOrder,
    supportedScopes: frozenManifest.supportedScopes,
    defaultInvocationPolicy: manifest.defaultInvocationPolicy,
  });
  verifiedFiles.set(release, byPath);
  return release;
}

/** Load and fully snapshot one immutable release directory. */
export async function loadSkillRelease(root: string): Promise<SkillRelease> {
  const requestedRoot = NodePath.resolve(root);
  const requestedRootStat = await NodeFSP.lstat(requestedRoot);
  if (!requestedRootStat.isDirectory() || requestedRootStat.isSymbolicLink()) {
    throw new SkillReleaseValidationError("Skill release root must be a real directory.");
  }
  const rootPath = await NodeFSP.realpath(requestedRoot);
  const rootStat = await NodeFSP.lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new SkillReleaseValidationError("Skill release root must be a real directory.");
  }
  const files = await collectReleaseFiles(rootPath);
  return releaseFromFiles(NodePath.basename(rootPath), files);
}

/** Build a verified immutable release from files embedded in a server bundle. */
export function loadEmbeddedSkillRelease(
  directoryName: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): SkillRelease {
  return releaseFromFiles(
    directoryName,
    Object.entries(files).map(([relativePath, contents]) => ({
      relativePath,
      bytes:
        typeof contents === "string"
          ? new TextEncoder().encode(contents)
          : new Uint8Array(contents),
    })),
  );
}

export function readSkillResource(
  release: SkillRelease,
  relativePath: string,
): Uint8Array | undefined {
  const normalized = relativePath;
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  const bytes = verifiedFiles.get(release)?.get(normalized);
  if (
    normalized === SKILL_DOCUMENT_FILE ||
    normalized === SCIENT_SKILL_MANIFEST_FILE ||
    bytes === undefined
  ) {
    return undefined;
  }
  return new Uint8Array(bytes);
}
