// @effect-diagnostics nodeBuiltinImport:off -- package paths and byte copies use the host filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import * as Schema from "effect/Schema";

import { sha256File } from "../resultRevisions.ts";

class HandoffRefusal extends Schema.TaggedError<HandoffRefusal>()("HandoffRefusal", {
  message: Schema.String,
}) {}
export const isHandoffRefusal = Schema.is(HandoffRefusal);
export const handoffRefusal = (message: string) => new HandoffRefusal({ message });

export const MAXIMUM_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAXIMUM_PACKAGE_LIST_BYTES = 2 * 1024 * 1024;

export function relativeInputPath(path: string): string {
  if (
    /^[a-z]:[/\\]/iu.test(path) ||
    /[\\\p{Cc}]/u.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw handoffRefusal("The package contains a path outside its working folder.");
  }
  return path;
}

export function isPortablePackagePath(path: string): boolean {
  try {
    relativeInputPath(path);
    return path
      .split("/")
      .every(
        (part) =>
          !/[<>:"|?*]/u.test(part) &&
          !/[. ]$/u.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
      );
  } catch {
    return false;
  }
}

export function relativePackagePath(path: string): string {
  if (!isPortablePackagePath(path)) {
    throw handoffRefusal("A file name cannot be carried between computers safely.");
  }
  return path;
}

export const includedDataPath = (path: string, version: 1 | 2 = 2) =>
  version === 2 && path.startsWith("data/") ? path : `data/${path}`;

type PathKind = "portable" | "input";

export function packagePath(root: string, path: string, kind: PathKind = "portable"): string {
  const checked =
    kind === "portable" || NodePath.sep === "\\"
      ? relativePackagePath(path)
      : relativeInputPath(path);
  return NodePath.join(root, ...checked.split("/"));
}

export async function regularPackageFile(
  root: string,
  path: string,
  kind?: PathKind,
): Promise<string | null> {
  const target = packagePath(root, path, kind);
  const resolved = await NodeFSP.realpath(target).catch(() => null);
  if (resolved !== target) return null;
  const status = await NodeFSP.lstat(target).catch(() => null);
  return status?.isFile() === true ? target : null;
}

export const hashBytes = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export async function matchesFile(
  file: string,
  sha256: string,
  size?: number,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const status = await NodeFSP.lstat(file);
  return (
    status.isFile() &&
    (size === undefined || status.size === size) &&
    (await sha256File(file, signal)) === sha256
  );
}

export async function copyPackageFile(
  file: string,
  root: string,
  path: string,
  sha256: string,
  size?: number,
  kind?: PathKind,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const status = await NodeFSP.lstat(file);
  if (!status.isFile() || (size !== undefined && status.size !== size)) return false;
  const target = packagePath(root, path, kind);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await copyFileExclusively(file, target, signal);
  if (await matchesFile(target, sha256, size, signal)) return true;
  await NodeFSP.unlink(target);
  return false;
}

export async function copyFileExclusively(file: string, target: string, signal?: AbortSignal) {
  if (signal === undefined) {
    await NodeFSP.copyFile(file, target, NodeFS.constants.COPYFILE_EXCL);
  } else {
    await NodeStreamPromises.pipeline(
      NodeFS.createReadStream(file),
      NodeFS.createWriteStream(target, { flags: "wx" }),
      { signal },
    );
  }
}

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function publishJson(path: string, value: unknown, signal?: AbortSignal) {
  return NodeFSP.writeFile(path, jsonText(value), { flag: "wx", signal });
}
