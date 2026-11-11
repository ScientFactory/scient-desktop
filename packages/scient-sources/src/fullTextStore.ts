// @effect-diagnostics nodeBuiltinImport:off -- Full text is part of Scient's explicit source store filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { ScientSourceFullText } from "./fullText.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import { isScientLibraryLocation, type ScientSourceStoreLocation } from "./libraryRoot.ts";
import { assertScientProjectDirectory } from "./projectFiles.ts";
import { canonicalizeScientSourceRoot, SCIENT_SOURCES_DIRECTORY } from "./store.ts";
import { ensureDirectory, snapshot } from "./storeFiles.ts";

export const SCIENT_SOURCE_TEXT_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/text/sha256`;
const LIBRARY_TEXT_DIRECTORY = "text/sha256";

interface TextStore {
  readonly root: string;
  readonly base: string;
  readonly library: boolean;
}

async function textStore(location: ScientSourceStoreLocation): Promise<TextStore> {
  const library = isScientLibraryLocation(location);
  const root = await canonicalizeScientSourceRoot(library ? location.root : location);
  const relative = library ? LIBRARY_TEXT_DIRECTORY : SCIENT_SOURCE_TEXT_DIRECTORY;
  return { root, base: NodePath.join(root, ...relative.split("/")), library };
}

/** A project folder is checked for links on the way; the library folder is Scient's own. */
async function assertTextDirectory(
  store: TextStore,
  directory: string,
  options?: { readonly create: true },
): Promise<void> {
  if (!store.library) {
    await assertScientProjectDirectory(store.root, directory, options);
    return;
  }
  if (options?.create) {
    await ensureDirectory(directory);
    return;
  }
  const state = await snapshot(directory);
  if (state === "missing") throw Object.assign(new Error("No stored text."), { code: "ENOENT" });
  if (state !== "directory") throw new Error("The full-text folder is not a safe directory.");
}

/** Library writes hold the cross-process library lock; project writes need none. */
function asWriter<A>(store: TextStore, run: () => Promise<A>): Promise<A> {
  return store.library ? withScientLibraryLock(store.root, run) : run();
}

const MAX_TEXT_FILE_BYTES = 48 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const decodeFullText = Schema.decodeUnknownSync(ScientSourceFullText);
const encodeFullText = Schema.encodeSync(ScientSourceFullText);

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function textPath(store: TextStore, sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) throw new Error("The full-text key is not a SHA-256 digest.");
  return NodePath.join(store.base, sha256.slice(0, 2), `${sha256}.json`);
}

/** The stored text for a PDF hash, or null when none is stored or it no longer decodes. */
export async function readScientSourceFullText(
  root: ScientSourceStoreLocation,
  sha256: string,
): Promise<ScientSourceFullText | null> {
  const store = await textStore(root);
  const filePath = textPath(store, sha256);
  let stats;
  try {
    stats = await NodeFSP.lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_TEXT_FILE_BYTES) return null;
  await assertTextDirectory(store, NodePath.dirname(filePath));
  try {
    const decoded = decodeFullText(JSON.parse(await NodeFSP.readFile(filePath, "utf8")));
    return decoded.sha256 === sha256 ? decoded : null;
  } catch {
    // Derived text is rebuilt from the PDF, so an unreadable copy is replaced rather than reported.
    return null;
  }
}

/** The stored text file's size in bytes, or null when there is none; does not read it. */
export async function scientSourceFullTextByteLength(
  root: ScientSourceStoreLocation,
  sha256: string,
): Promise<number | null> {
  const store = await textStore(root);
  try {
    const stats = await NodeFSP.lstat(textPath(store, sha256));
    return stats.isFile() && !stats.isSymbolicLink() ? stats.size : null;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

export async function writeScientSourceFullText(
  root: ScientSourceStoreLocation,
  text: ScientSourceFullText,
): Promise<void> {
  const store = await textStore(root);
  const filePath = textPath(store, text.sha256);
  const serialized = JSON.stringify(encodeFullText(text));
  if (Buffer.byteLength(serialized, "utf8") > MAX_TEXT_FILE_BYTES) {
    throw new Error("The extracted text exceeds the safe size limit.");
  }
  await asWriter(store, async () => {
    await assertTextDirectory(store, NodePath.dirname(filePath), { create: true });
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
  });
}

/** Hashes with a stored text file, valid or not. */
export async function listScientSourceFullTextHashes(
  root: ScientSourceStoreLocation,
): Promise<ReadonlyArray<string>> {
  const store = await textStore(root);
  const base = store.base;
  let prefixes;
  try {
    await assertTextDirectory(store, base);
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

export async function removeScientSourceFullText(
  root: ScientSourceStoreLocation,
  sha256: string,
): Promise<void> {
  const store = await textStore(root);
  const filePath = textPath(store, sha256);
  await asWriter(store, async () => {
    await assertTextDirectory(store, NodePath.dirname(filePath)).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    await NodeFSP.rm(filePath, { force: true });
  });
}
