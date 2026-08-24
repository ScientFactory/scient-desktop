// @effect-diagnostics nodeBuiltinImport:off -- Skill release verification is a Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  SCIENT_SKILL_MANIFEST_FILE,
  SKILL_DOCUMENT_FILE,
  skillOriginKey,
  type SkillActivationScope,
  type SkillOrigin,
  type SkillRelease,
  type SkillReleaseManifest,
  type SkillResourceSummary,
  type SkillRole,
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
  const activationScope = requiredString(record, "activationScope", 32);
  const role = requiredString(record, "role", 32);
  if (apiVersion !== "scient.skills/v1alpha1") {
    throw new SkillReleaseValidationError("Unsupported skill manifest apiVersion.");
  }
  if (!SKILL_ID_PATTERN.test(id) || !SEMVER_PATTERN.test(version)) {
    throw new SkillReleaseValidationError("Skill manifest has an invalid id or version.");
  }
  if (activationScope !== "project" && activationScope !== "user") {
    throw new SkillReleaseValidationError("Skill activationScope must be 'project' or 'user'.");
  }
  if (role !== "constructive" && role !== "orientation" && role !== "review") {
    throw new SkillReleaseValidationError(
      "Skill role must be 'constructive', 'orientation', or 'review'.",
    );
  }
  return {
    apiVersion,
    id,
    version,
    activationScope: activationScope as SkillActivationScope,
    role: role as SkillRole,
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

async function collectReleaseFiles(rootPath: string): Promise<ReadonlyArray<ReleaseFile>> {
  const files: ReleaseFile[] = [];
  let totalBytes = 0;

  async function walk(directoryPath: string, prefix: string): Promise<void> {
    const entries = await NodeFSP.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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
      const stat = await NodeFSP.stat(absolutePath);
      if (stat.size > MAX_RESOURCE_BYTES) {
        throw new SkillReleaseValidationError(
          `Skill release file '${relativePath}' exceeds the 1 MiB file limit.`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_RELEASE_BYTES) {
        throw new SkillReleaseValidationError("Skill release exceeds the 5 MiB total limit.");
      }
      files.push({ relativePath, bytes: await NodeFSP.readFile(absolutePath) });
    }
  }

  await walk(rootPath, "");
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
    NodePath.basename(rootPath),
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
    rootPath,
    resources,
    id: manifest.id,
    version: manifest.version,
    digest: digestReleaseFiles(files),
    origin: skillOriginKey(manifest.origin),
    name: parsed.metadata.name,
    description: parsed.metadata.description,
    activationScope: manifest.activationScope,
    role: manifest.role,
  });
  verifiedFiles.set(release, byPath);
  return release;
}

export function readSkillResource(
  release: SkillRelease,
  relativePath: string,
): Uint8Array | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
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
