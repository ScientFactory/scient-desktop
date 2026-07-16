import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { sha256File } from "./hash.ts";
import { ProjectInitializationError, type PathSnapshot } from "./types.ts";

export const MAX_MANAGED_TEXT_BYTES = 1_048_576;
export const MAX_TRANSACTION_BYTES = 4_194_304;
export const MAX_IDENTITY_BYTES = 65_536;

export async function snapshotPath(targetPath: string): Promise<PathSnapshot> {
  try {
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) {
      return { kind: "symlink", target: await readlink(targetPath) };
    }
    if (stat.isDirectory()) return { kind: "directory" };
    if (!stat.isFile()) return { kind: "other" };
    return { kind: "file", sha256: await sha256File(targetPath), size: stat.size };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
}

export async function readUtf8FileBounded(targetPath: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(targetPath);
  if (fileStat.size > maxBytes) {
    throw new ProjectInitializationError(
      "INVALID_FOLDER",
      `${targetPath} exceeds the ${maxBytes}-byte safety limit.`,
    );
  }
  const contents = await readFile(targetPath);
  if (contents.byteLength > maxBytes) {
    throw new ProjectInitializationError(
      "INVALID_FOLDER",
      `${targetPath} exceeds the ${maxBytes}-byte safety limit.`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new ProjectInitializationError(
      "INVALID_FOLDER",
      `${targetPath} is not valid UTF-8 text.`,
      { cause: error },
    );
  }
}

export async function snapshotRelativePathSafely(
  root: string,
  relativePath: string,
): Promise<PathSnapshot> {
  assertRelativePathWithinRoot(root, relativePath);
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const observed = await snapshotPath(current);
    if (observed.kind === "missing") return { kind: "missing" };
    if (observed.kind === "symlink") return observed;
    if (observed.kind !== "directory") return { kind: "other" };
  }
  return snapshotPath(path.join(root, ...segments));
}

export async function resolveProjectRoot(requestedRoot: string): Promise<string> {
  if (requestedRoot.trim().length === 0) {
    throw new ProjectInitializationError("INVALID_FOLDER", "Project folder path is empty.");
  }
  const absoluteRoot = path.resolve(requestedRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absoluteRoot);
  } catch (error) {
    throw new ProjectInitializationError(
      "INVALID_FOLDER",
      `Project folder does not exist: ${absoluteRoot}`,
      { cause: error },
    );
  }
  const rootSnapshot = await snapshotPath(canonicalRoot);
  if (rootSnapshot.kind !== "directory") {
    throw new ProjectInitializationError(
      "INVALID_FOLDER",
      `Project path is not a directory: ${canonicalRoot}`,
    );
  }
  return canonicalRoot;
}

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function snapshotsEqual(left: PathSnapshot, right: PathSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "missing":
    case "directory":
    case "other":
      return true;
    case "file":
      return right.kind === "file" && left.sha256 === right.sha256 && left.size === right.size;
    case "symlink":
      return right.kind === "symlink" && left.target === right.target;
  }
}

export function assertRelativePathWithinRoot(root: string, relativePath: string): string {
  if (relativePath.includes("\0") || relativePath.includes("\\") || path.isAbsolute(relativePath)) {
    throw new ProjectInitializationError(
      "PATH_ESCAPE",
      `Unsafe project-relative path: ${relativePath}`,
    );
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ProjectInitializationError(
      "PATH_ESCAPE",
      `Unsafe project-relative path: ${relativePath}`,
    );
  }
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProjectInitializationError(
      "PATH_ESCAPE",
      `Path escapes project root: ${relativePath}`,
    );
  }
  return target;
}
