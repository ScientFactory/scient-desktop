// @effect-diagnostics nodeBuiltinImport:off -- The project lock is a portable Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";

import { SCIENT_SKILLS_LOCK_FILE, type SkillReleaseRef } from "./model.ts";

const MAX_LOCK_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_PATTERN = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export interface ProjectSkillLock {
  readonly formatVersion: 1;
  readonly skills: ReadonlyArray<SkillReleaseRef>;
}

export type ProjectSkillLockReadResult =
  | { readonly status: "absent"; readonly rootPath: string }
  | { readonly status: "invalid"; readonly rootPath: string; readonly message: string }
  | {
      readonly status: "valid";
      readonly rootPath: string;
      readonly projectId: string;
      readonly lock: ProjectSkillLock;
      readonly lockDigest: string;
    };

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function requireRealScientDirectory(rootPath: string): Promise<void> {
  const metadataDirectory = NodePath.join(rootPath, ".scient");
  let stat;
  try {
    stat = await NodeFSP.lstat(metadataDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error("The folder is not an initialized Scient project.", { cause: error });
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The project .scient path must be a real directory.");
  }
}

function parseReleaseRef(value: unknown): SkillReleaseRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !ID_PATTERN.test(record.id) ||
    typeof record.version !== "string" ||
    !SEMVER_PATTERN.test(record.version) ||
    typeof record.digest !== "string" ||
    !DIGEST_PATTERN.test(record.digest) ||
    typeof record.origin !== "string" ||
    record.origin.trim().length === 0 ||
    record.origin.length > 256
  ) {
    return undefined;
  }
  return {
    id: record.id,
    version: record.version,
    digest: record.digest,
    origin: record.origin,
  };
}

export function parseProjectSkillLock(contents: string): ProjectSkillLock | undefined {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== 1 || !Array.isArray(record.skills)) return undefined;
  const skills: SkillReleaseRef[] = [];
  const identities = new Set<string>();
  for (const entry of record.skills) {
    const parsed = parseReleaseRef(entry);
    if (!parsed) return undefined;
    const identity = `${parsed.id}@${parsed.version}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    skills.push(parsed);
  }
  return { formatVersion: 1, skills };
}

export function renderProjectSkillLock(references: ReadonlyArray<SkillReleaseRef>): string {
  const skills = [...references].sort(
    (left, right) =>
      compareStrings(left.id, right.id) || compareStrings(left.version, right.version),
  );
  const seen = new Set<string>();
  for (const reference of skills) {
    const identity = `${reference.id}@${reference.version}`;
    if (seen.has(identity) || !parseReleaseRef(reference)) {
      throw new Error(`Invalid or duplicate project skill release '${identity}'.`);
    }
    seen.add(identity);
  }
  return `${JSON.stringify({ formatVersion: 1, skills }, null, 2)}\n`;
}

export async function readProjectSkillLock(root: string): Promise<ProjectSkillLockReadResult> {
  let rootPath: string;
  try {
    rootPath = await NodeFSP.realpath(NodePath.resolve(root));
  } catch {
    return {
      status: "invalid",
      rootPath: NodePath.resolve(root),
      message: "Project root is unavailable.",
    };
  }
  const lockPath = NodePath.join(rootPath, SCIENT_SKILLS_LOCK_FILE);
  let stat;
  try {
    stat = await NodeFSP.lstat(lockPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "absent", rootPath };
    return { status: "invalid", rootPath, message: "Project skill lock could not be inspected." };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOCK_BYTES) {
    return {
      status: "invalid",
      rootPath,
      message: "Project skill lock must be a regular file no larger than 1 MiB.",
    };
  }
  let contents: string;
  let projectId: string;
  try {
    await requireRealScientDirectory(rootPath);
    contents = await NodeFSP.readFile(lockPath, "utf8");
    projectId = (await readScientProjectIdentity(rootPath)).projectId;
  } catch (error) {
    return {
      status: "invalid",
      rootPath,
      message: error instanceof Error ? error.message : "Project skill lock could not be read.",
    };
  }
  const lock = parseProjectSkillLock(contents);
  return lock
    ? { status: "valid", rootPath, projectId, lock, lockDigest: sha256(contents) }
    : { status: "invalid", rootPath, message: "Project skill lock is not valid." };
}

/** Explicit action only. Merely opening a folder never calls this function. */
export async function writeProjectSkillLock(
  root: string,
  references: ReadonlyArray<SkillReleaseRef>,
): Promise<ProjectSkillLockReadResult & { readonly status: "valid" }> {
  const rootPath = await NodeFSP.realpath(NodePath.resolve(root));
  await requireRealScientDirectory(rootPath);
  await readScientProjectIdentity(rootPath);
  const contents = renderProjectSkillLock(references);
  const lockPath = NodePath.join(rootPath, SCIENT_SKILLS_LOCK_FILE);
  try {
    const existing = await NodeFSP.lstat(lockPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Project skill lock path is not a regular file.");
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const temporaryPath = `${lockPath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await NodeFSP.rename(temporaryPath, lockPath);
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true });
  }
  const result = await readProjectSkillLock(rootPath);
  if (result.status !== "valid") {
    throw new Error("The project skill lock could not be verified after writing.");
  }
  return result;
}
