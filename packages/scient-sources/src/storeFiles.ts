// @effect-diagnostics nodeBuiltinImport:off -- Shared filesystem rules of the project and library stores.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is not a safe portable identifier.`);
  }
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function boundedJson(value: unknown, maximumBytes: number, label: string): string {
  const serialized = formatJson(value);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds the safe size limit.`);
  }
  return serialized;
}

export async function snapshot(
  filePath: string,
): Promise<"missing" | "file" | "directory" | "unsafe"> {
  try {
    const value = await NodeFSP.lstat(filePath);
    if (value.isSymbolicLink()) return "unsafe";
    if (value.isFile()) return "file";
    if (value.isDirectory()) return "directory";
    return "unsafe";
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "missing";
    throw error;
  }
}

export async function readBoundedJson<S extends Schema.ConstraintDecoder<unknown>>(
  filePath: string,
  maximumBytes: number,
  schema: S,
): Promise<S["Type"]> {
  const stats = await NodeFSP.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${NodePath.basename(filePath)} is not a safe regular file.`);
  }
  if (stats.size > maximumBytes) {
    throw new Error(`${NodePath.basename(filePath)} exceeds the safe size limit.`);
  }
  const value: unknown = JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
  return Schema.decodeUnknownSync(schema)(value);
}

export async function ensureDirectory(filePath: string): Promise<void> {
  await NodeFSP.mkdir(filePath, { recursive: true });
  if ((await snapshot(filePath)) !== "directory") {
    throw new Error(`${NodePath.basename(filePath)} is not a safe directory.`);
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  maximumBytes: number,
): Promise<void> {
  const serialized = boundedJson(value, maximumBytes, NodePath.basename(filePath));
  await ensureDirectory(NodePath.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await NodeFSP.rename(temporaryPath, filePath);
  } finally {
    await handle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
  }
}

export async function atomicCreateJson(
  filePath: string,
  value: unknown,
  maximumBytes: number,
): Promise<boolean> {
  const serialized = boundedJson(value, maximumBytes, NodePath.basename(filePath));
  await ensureDirectory(NodePath.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await NodeFSP.link(temporaryPath, filePath);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      if (!isNodeError(error, "EPERM") && !isNodeError(error, "ENOTSUP")) throw error;
      try {
        await NodeFSP.copyFile(temporaryPath, filePath, NodeFSP.constants.COPYFILE_EXCL);
        return true;
      } catch (copyError) {
        if (isNodeError(copyError, "EEXIST")) return false;
        throw copyError;
      }
    }
  } finally {
    await handle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
  }
}
