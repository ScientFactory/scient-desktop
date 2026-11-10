// @effect-diagnostics nodeBuiltinImport:off -- Full text is part of Scient's explicit project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { ScientSourceFullText } from "./fullText.ts";
import { canonicalizeScientSourceRoot, SCIENT_SOURCES_DIRECTORY } from "./store.ts";

export const SCIENT_SOURCE_TEXT_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/text/sha256`;

const MAX_TEXT_FILE_BYTES = 48 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const decodeFullText = Schema.decodeUnknownSync(ScientSourceFullText);
const encodeFullText = Schema.encodeSync(ScientSourceFullText);

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function textPath(root: string, sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) throw new Error("The full-text key is not a SHA-256 digest.");
  return NodePath.join(root, SCIENT_SOURCE_TEXT_DIRECTORY, sha256.slice(0, 2), `${sha256}.json`);
}

/** Checks each directory below the project root, optionally creating missing ones, never through a symlink. */
async function assertSafeDirectory(root: string, directory: string, create = false): Promise<void> {
  let current = root;
  for (const segment of NodePath.relative(root, directory).split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, segment);
    let stats;
    try {
      stats = await NodeFSP.lstat(current);
    } catch (error) {
      if (!create || !isNodeError(error, "ENOENT")) throw error;
      await NodeFSP.mkdir(current).catch((mkdirError: unknown) => {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
      });
      stats = await NodeFSP.lstat(current);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${segment} is not a safe directory.`);
    }
  }
}

/** The stored text for a PDF hash, or null when none is stored or it no longer decodes. */
export async function readScientSourceFullText(
  root: string,
  sha256: string,
): Promise<ScientSourceFullText | null> {
  const resolvedRoot = await canonicalizeScientSourceRoot(root);
  const filePath = textPath(resolvedRoot, sha256);
  let stats;
  try {
    stats = await NodeFSP.lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_TEXT_FILE_BYTES) return null;
  await assertSafeDirectory(resolvedRoot, NodePath.dirname(filePath));
  try {
    const decoded = decodeFullText(JSON.parse(await NodeFSP.readFile(filePath, "utf8")));
    return decoded.sha256 === sha256 ? decoded : null;
  } catch {
    // Derived text is rebuilt from the PDF, so an unreadable copy is replaced rather than reported.
    return null;
  }
}

export async function writeScientSourceFullText(
  root: string,
  text: ScientSourceFullText,
): Promise<void> {
  const resolvedRoot = await canonicalizeScientSourceRoot(root);
  const filePath = textPath(resolvedRoot, text.sha256);
  const serialized = JSON.stringify(encodeFullText(text));
  if (Buffer.byteLength(serialized, "utf8") > MAX_TEXT_FILE_BYTES) {
    throw new Error("The extracted text exceeds the safe size limit.");
  }
  const directory = NodePath.dirname(filePath);
  await assertSafeDirectory(resolvedRoot, directory, true);
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

/** Hashes with a stored text file, valid or not. */
export async function listScientSourceFullTextHashes(root: string): Promise<ReadonlyArray<string>> {
  const resolvedRoot = await canonicalizeScientSourceRoot(root);
  const base = NodePath.join(resolvedRoot, SCIENT_SOURCE_TEXT_DIRECTORY);
  let prefixes;
  try {
    await assertSafeDirectory(resolvedRoot, base);
    prefixes = await NodeFSP.readdir(base, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const hashes: string[] = [];
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/u.test(prefix.name)) continue;
    for (const entry of await NodeFSP.readdir(NodePath.join(base, prefix.name), {
      withFileTypes: true,
    })) {
      const hash = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (entry.isFile() && SHA256_PATTERN.test(hash) && hash.startsWith(prefix.name)) {
        hashes.push(hash);
      }
    }
  }
  return hashes.toSorted();
}

export async function removeScientSourceFullText(root: string, sha256: string): Promise<void> {
  const resolvedRoot = await canonicalizeScientSourceRoot(root);
  const filePath = textPath(resolvedRoot, sha256);
  await assertSafeDirectory(resolvedRoot, NodePath.dirname(filePath)).catch((error: unknown) => {
    if (!isNodeError(error, "ENOENT")) throw error;
  });
  await NodeFSP.rm(filePath, { force: true });
}
