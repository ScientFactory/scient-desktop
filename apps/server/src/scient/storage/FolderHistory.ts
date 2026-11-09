// @effect-diagnostics nodeBuiltinImport:off -- Saved folders are plain folders on this computer.
/**
 * Folders Scient keeps for the user (personal skills, local connectors) change in one step. Each
 * change leaves `<stamp>-created|replaced|removed`: the earlier folder (empty for a new one) and
 * an optional `.meta` file beside it with what its owner needs to undo the change.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Saved versions kept per folder for Undo. */
const HISTORY_KEEP = 10;
const ENTRY = /^(.+)-(created|replaced|removed)(\.meta)?$/u;

export type HistoryKind = "created" | "replaced" | "removed";

// @effect-diagnostics-next-line extendsNativeError:off -- plain async folder helpers; owners map it to their typed errors.
export class FolderHistoryError extends Error {
  override readonly name = "FolderHistoryError";
  readonly reason: "unsafe" | "not-found" | "no-history";
  constructor(message: string, reason: FolderHistoryError["reason"]) {
    super(message);
    this.reason = reason;
  }
}

export interface HistoryEntry {
  readonly kind: HistoryKind;
  /** The kept folder; absent when the change kept no files (a folder left in place). */
  readonly folder: string | undefined;
  readonly meta: Uint8Array | undefined;
}

/** What a folder change writes: files held in memory, or a folder copied as it is. */
export type FolderSource =
  | { readonly files: Readonly<Record<string, Uint8Array>> }
  | {
      readonly copyFrom: string;
      /** Names left out anywhere in the copy (system clutter, version control). */
      readonly skip?: ReadonlySet<string>;
    };

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

const randomSuffix = () => NodeCrypto.randomBytes(4).toString("hex");

/** Entry names (without `.meta`) in a history folder, oldest first. */
async function entryNames(folder: string): Promise<ReadonlyArray<string>> {
  const names = new Set<string>();
  for (const name of await NodeFSP.readdir(folder).catch(() => [] as string[])) {
    const match = ENTRY.exec(name);
    if (match) names.add(`${match[1]}-${match[2]}`);
  }
  return [...names].sort(compareStrings);
}

async function readEntry(folder: string, name: string): Promise<HistoryEntry> {
  const path = NodePath.join(folder, name);
  const meta = await NodeFSP.readFile(`${path}.meta`).then(
    (bytes) => new Uint8Array(bytes),
    () => undefined,
  );
  const isFolder = await NodeFSP.lstat(path).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
  return {
    kind: name.slice(name.lastIndexOf("-") + 1) as HistoryKind,
    folder: isFolder ? path : undefined,
    meta,
  };
}

async function discardEntry(entry: Pick<HistoryEntry, "folder">, path: string): Promise<void> {
  if (entry.folder !== undefined) await NodeFSP.rm(entry.folder, { recursive: true, force: true });
  await NodeFSP.rm(`${path}.meta`, { force: true });
}

/** The newest kept version under `key`, if any. */
export async function latestHistory(
  historyRoot: string,
  key: string,
): Promise<HistoryEntry | undefined> {
  const folder = NodePath.join(historyRoot, key);
  const last = (await entryNames(folder)).at(-1);
  return last === undefined ? undefined : readEntry(folder, last);
}

async function pruneHistory(historyRoot: string, key: string): Promise<void> {
  const folder = NodePath.join(historyRoot, key);
  const names = await entryNames(folder);
  for (const old of names.slice(0, Math.max(0, names.length - HISTORY_KEEP))) {
    const path = NodePath.join(folder, old);
    await NodeFSP.rm(path, { recursive: true, force: true });
    await NodeFSP.rm(`${path}.meta`, { force: true });
  }
}

/**
 * Keeps one change in history: `current` (the folder being replaced or removed) moves into the
 * entry, a new folder leaves an empty one, and `keepInPlace` leaves no folder at all.
 */
async function remember(input: {
  readonly historyRoot: string;
  readonly key: string;
  readonly kind: HistoryKind;
  readonly current: string | undefined;
  readonly stamp: string;
  readonly meta: Uint8Array | undefined;
  readonly keepInPlace?: boolean;
}): Promise<string> {
  const folder = NodePath.join(input.historyRoot, input.key);
  await NodeFSP.mkdir(folder, { recursive: true });
  // Two changes within one stamp still sort in the order they happened.
  let target = NodePath.join(folder, `${input.stamp}-${input.kind}`);
  for (let turn = 1; (await exists(target)) || (await exists(`${target}.meta`)); turn++) {
    target = NodePath.join(folder, `${input.stamp}~${String(turn).padStart(3, "0")}-${input.kind}`);
  }
  if (input.meta !== undefined) await NodeFSP.writeFile(`${target}.meta`, input.meta);
  if (input.keepInPlace) return target;
  if (input.current === undefined) await NodeFSP.mkdir(target);
  else await NodeFSP.rename(input.current, target);
  return target;
}

async function fill(staging: string, source: FolderSource): Promise<void> {
  if ("copyFrom" in source) {
    await NodeFSP.cp(source.copyFrom, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter: (from) => !source.skip?.has(NodePath.basename(from)),
    });
    return;
  }
  await NodeFSP.mkdir(staging, { recursive: true });
  for (const [relative, bytes] of Object.entries(source.files)) {
    const destination = NodePath.join(staging, ...relative.split("/"));
    if (!destination.startsWith(staging + NodePath.sep)) {
      throw new FolderHistoryError(`${relative} is outside the folder.`, "unsafe");
    }
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, bytes, { flag: "wx" });
  }
}

/**
 * Writes `root/name` as one folder change: the files go to a hidden folder first and replace the
 * folder in one rename. The version it replaces, or the fact that it is new, goes to history
 * under `key` (the folder name unless given).
 */
export async function writeFolder(input: {
  readonly root: string;
  readonly historyRoot: string;
  readonly name: string;
  readonly key?: string;
  readonly source: FolderSource;
  /** Sortable time of the change, naming its history entry. */
  readonly stamp: string;
  readonly meta?: Uint8Array;
}): Promise<{ readonly created: boolean }> {
  const key = input.key ?? input.name;
  await NodeFSP.mkdir(input.root, { recursive: true });
  const target = NodePath.join(input.root, input.name);
  const staging = NodePath.join(input.root, `.${input.name}.saving-${randomSuffix()}`);
  try {
    await fill(staging, input.source);
    const created = !(await exists(target));
    const entry = await remember({
      historyRoot: input.historyRoot,
      key,
      kind: created ? "created" : "replaced",
      current: created ? undefined : target,
      stamp: input.stamp,
      meta: input.meta,
    });
    try {
      await NodeFSP.rename(staging, target);
    } catch (error) {
      // Put the folder back as it was: the previous one returns, the history entry goes.
      if (created) await NodeFSP.rm(entry, { recursive: true, force: true });
      else await NodeFSP.rename(entry, target).catch(() => undefined);
      await NodeFSP.rm(`${entry}.meta`, { force: true });
      throw error;
    }
    await pruneHistory(input.historyRoot, key);
    return { created };
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Moves `root/name` to history so Undo can bring it back. `keepInPlace` records the removal
 * without moving anything (a folder Scient does not own), with `meta` saying what it was.
 */
export async function removeFolder(input: {
  readonly root: string;
  readonly historyRoot: string;
  readonly name: string;
  readonly key?: string;
  readonly stamp: string;
  readonly meta?: Uint8Array;
  readonly keepInPlace?: boolean;
}): Promise<void> {
  const key = input.key ?? input.name;
  const target = NodePath.join(input.root, input.name);
  if (!input.keepInPlace && !(await exists(target)))
    throw new FolderHistoryError("That folder is not there anymore.", "not-found");
  await remember({
    historyRoot: input.historyRoot,
    key,
    kind: "removed",
    current: target,
    stamp: input.stamp,
    meta: input.meta,
    ...(input.keepInPlace ? { keepInPlace: true } : {}),
  });
  await pruneHistory(input.historyRoot, key);
}

/**
 * Undoes the last change: a new folder is removed, a replaced or removed one comes back. The
 * version being undone is discarded. Returns what was undone and its `meta`.
 */
export async function restoreFolder(input: {
  readonly root: string;
  readonly historyRoot: string;
  readonly name: string;
  readonly key?: string;
}): Promise<{ readonly kind: HistoryKind; readonly meta: Uint8Array | undefined }> {
  const key = input.key ?? input.name;
  const folder = NodePath.join(input.historyRoot, key);
  const lastName = (await entryNames(folder)).at(-1);
  if (lastName === undefined)
    throw new FolderHistoryError("There is no earlier version to go back to.", "no-history");
  const entryPath = NodePath.join(folder, lastName);
  const last = await readEntry(folder, lastName);
  const target = NodePath.join(input.root, input.name);
  const bringsBack = last.kind !== "created" && last.folder !== undefined;
  const replacesCurrent = last.kind === "created" || bringsBack;
  const discarded = NodePath.join(input.root, `.${input.name}.undone-${randomSuffix()}`);
  if (replacesCurrent && (await exists(target))) await NodeFSP.rename(target, discarded);
  try {
    if (bringsBack) await NodeFSP.rename(last.folder!, target);
  } catch (error) {
    if (await exists(discarded)) await NodeFSP.rename(discarded, target).catch(() => undefined);
    throw error;
  }
  await discardEntry(bringsBack ? { folder: undefined } : last, entryPath);
  await NodeFSP.rm(discarded, { recursive: true, force: true });
  return { kind: last.kind, meta: last.meta };
}
