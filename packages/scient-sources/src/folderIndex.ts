// @effect-diagnostics nodeBuiltinImport:off -- In-memory indexes of the store's folders, rebuilt from their files.
// @effect-diagnostics globalDate:off -- File timestamps are compared with the wall clock.
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isNodeError } from "./storeFiles.ts";

/**
 * Timestamps this close to a scan may still change without changing again (coarse clocks on some
 * volumes), so such files and folders are checked again on the next scan instead of trusted.
 */
const RACY_TIMESTAMP_NS = 2_000_000_000n;

/** One file at a time waits on each stat and read in turn: 20,000 serial stats take 0.6 s. */
const SCAN_CONCURRENCY = 32;

/** Editing a file in place leaves its folder's timestamps alone, so the folder alone is trusted briefly. */
const FOLDER_TRUST_MS = 30_000;

/** True when a file's timestamps are old enough that an unchanged stamp means unchanged bytes. */
export const isSettled = (stats: NodeFS.BigIntStats, scanStartedNs: bigint) =>
  scanStartedNs - stats.mtimeNs > RACY_TIMESTAMP_NS &&
  scanStartedNs - stats.ctimeNs > RACY_TIMESTAMP_NS;

export interface IndexedFile<A> {
  readonly stamp: string;
  readonly settled: boolean;
  readonly value: A;
}

/** What a folder's files decoded to, kept with the stamps that say when to read them again. */
export interface FolderIndex<A> {
  readonly fingerprint: string;
  readonly settled: boolean;
  readonly validatedAtMs: number;
  /** By file name, in name order. */
  readonly files: ReadonlyMap<string, IndexedFile<A>>;
}

/**
 * The folder's `.json` files as `read` decodes them, reading again only files whose stamp
 * changed since `previous`. Every write of these stores replaces, links or unlinks a file, which
 * changes the folder's timestamps; while those are unchanged and recently checked, `previous` is
 * the answer without touching a file. The files stay the truth: null when the folder is missing.
 */
export async function refreshFolderIndex<A>(input: {
  readonly folder: string;
  readonly previous: FolderIndex<A> | undefined;
  readonly read: (name: string) => Promise<A>;
  /** For an entry that is not a plain file. */
  readonly unsafe: (filePath: string) => A;
  readonly unsafeFolderMessage: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<FolderIndex<A> | null> {
  const scanStartedMs = Date.now();
  const scanStartedNs = BigInt(scanStartedMs) * 1_000_000n;
  const folder = await NodeFSP.lstat(input.folder, { bigint: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  });
  if (!folder) return null;
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error(input.unsafeFolderMessage);
  const fingerprint = [folder.dev, folder.ino, folder.mtimeNs, folder.ctimeNs].join(":");
  const { previous } = input;
  if (
    previous?.settled &&
    previous.fingerprint === fingerprint &&
    scanStartedMs - previous.validatedAtMs < FOLDER_TRUST_MS
  ) {
    return previous;
  }

  const names = (await NodeFSP.readdir(input.folder))
    .filter((name) => name.endsWith(".json"))
    .toSorted((left, right) => left.localeCompare(right));
  const indexFile = async (name: string): Promise<IndexedFile<A> | null> => {
    const filePath = NodePath.join(input.folder, name);
    const stats = await NodeFSP.lstat(filePath, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!stats) return null;
    if (!stats.isFile()) return { stamp: "unsafe", settled: false, value: input.unsafe(filePath) };
    const stamp = [stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
    const known = previous?.files.get(name);
    return known?.settled && known.stamp === stamp
      ? known
      : { stamp, settled: isSettled(stats, scanStartedNs), value: await input.read(name) };
  };
  const files = new Map<string, IndexedFile<A>>();
  for (let start = 0; start < names.length; start += SCAN_CONCURRENCY) {
    input.signal?.throwIfAborted();
    const part = names.slice(start, start + SCAN_CONCURRENCY);
    const indexed = await Promise.all(part.map(indexFile));
    for (const [offset, file] of indexed.entries()) if (file) files.set(part[offset]!, file);
  }
  return {
    fingerprint,
    settled: isSettled(folder, scanStartedNs),
    validatedAtMs: scanStartedMs,
    files,
  };
}
