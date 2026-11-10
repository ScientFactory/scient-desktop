// @effect-diagnostics nodeBuiltinImport:off -- Personal skills are plain folders on this computer.
/**
 * Plain folder work for personal skills: reading a skill folder within the skill limits,
 * finding skill folders in something the user gave, saving one atomically, and the history
 * that backs Undo.
 *
 * @module PersonalSkillFiles
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  MAX_RELEASE_BYTES,
  MAX_RELEASE_FILES,
  MAX_RESOURCE_BYTES,
  SKILL_DOCUMENT_FILE,
} from "@scientfactory/scient-skills";
import type { PersonalSkillFailure } from "@t3tools/contracts";

/** Left out when a skill is copied in: system clutter and version control. */
const JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".git", "__MACOSX", "node_modules"]);
/** A reviewed release's manifest; Scient derives a personal skill's identity itself. */
const RELEASE_MANIFEST = "scient.skill.json";
const MAX_SEARCH_DEPTH = 4;
const MAX_SEARCH_ENTRIES = 5_000;
/** Saved versions kept per skill for Undo. */
const HISTORY_KEEP = 10;

// @effect-diagnostics-next-line extendsNativeError:off -- plain async folder helpers; the service maps it to a typed error.
export class SkillFolderError extends Error {
  override readonly name = "SkillFolderError";
  readonly reason: PersonalSkillFailure;
  constructor(message: string, reason: PersonalSkillFailure) {
    super(message);
    this.reason = reason;
  }
}

export interface FolderFiles {
  readonly files: Record<string, Uint8Array>;
  /** Plain-words notes on what was left out. */
  readonly notes: ReadonlyArray<string>;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * A skill folder's files, as the skill limits allow: links and clutter are left out, and a
 * reviewed release manifest is dropped (Scient names personal skills itself).
 */
export async function readSkillFolder(root: string): Promise<FolderFiles> {
  const files: Record<string, Uint8Array> = {};
  const notes = new Set<string>();
  let count = 0;
  let total = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await NodeFSP.readdir(directory, { withFileTypes: true })).sort(
      (left, right) => compareStrings(left.name, right.name),
    );
    for (const entry of entries) {
      if (JUNK.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        notes.add("Left out links, which skills cannot contain.");
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relative === RELEASE_MANIFEST) {
        notes.add("Left out its Scient release file; Scient names your skills itself.");
        continue;
      }
      const stat = await NodeFSP.lstat(absolute);
      if (stat.size > MAX_RESOURCE_BYTES) {
        throw new SkillFolderError(
          `${relative} is larger than the 1 MiB a skill file can be.`,
          "too-large",
        );
      }
      count += 1;
      total += stat.size;
      if (count > MAX_RELEASE_FILES) {
        throw new SkillFolderError(`It has more than ${MAX_RELEASE_FILES} files.`, "too-large");
      }
      if (total > MAX_RELEASE_BYTES) {
        throw new SkillFolderError("It is larger than the 5 MiB a skill can be.", "too-large");
      }
      files[relative] = new Uint8Array(await NodeFSP.readFile(absolute));
    }
  };
  await walk(root, "");
  return { files, notes: [...notes] };
}

/**
 * Folders holding a `SKILL.md`, searched a few levels down. A skill folder is not searched
 * inside, so a skill's own examples are not mistaken for skills.
 */
export async function findSkillFolders(root: string): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  let seen = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
    seen += entries.length;
    if (seen > MAX_SEARCH_ENTRIES) return;
    if (entries.some((entry) => entry.isFile() && entry.name === SKILL_DOCUMENT_FILE)) {
      found.push(directory);
      return;
    }
    if (depth >= MAX_SEARCH_DEPTH) return;
    for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || JUNK.has(entry.name)) continue;
      await walk(NodePath.join(directory, entry.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

/** Text files at the top of a folder that could be a skill's material. */
export async function materialFiles(root: string): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(md|markdown|txt)$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareStrings);
}

/**
 * How many skill folders the skills folder holds and their total size, valid or not and
 * however many the catalog loads, leaving out one name (the skill being replaced).
 */
export async function skillsFolderUsage(
  root: string,
  except: string,
): Promise<{ readonly count: number; readonly bytes: number }> {
  let count = 0;
  let bytes = 0;
  const size = async (directory: string): Promise<number> => {
    let total = 0;
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) total += await size(path);
      else if (entry.isFile()) total += (await NodeFSP.lstat(path).catch(() => null))?.size ?? 0;
    }
    return total;
  };
  for (const entry of await NodeFSP.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === except) continue;
    count += 1;
    bytes += await size(NodePath.join(root, entry.name));
  }
  return { count, bytes };
}

/** What a skills folder looks like on disk, to tell whether it changed since the last read. */
export async function folderSignature(root: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`d${relative}\n`);
        await walk(NodePath.join(directory, entry.name), relative);
        continue;
      }
      const stat = await NodeFSP.lstat(NodePath.join(directory, entry.name)).catch(() => null);
      hash.update(`f${relative}:${stat?.size ?? -1}:${stat?.mtimeMs ?? -1}\n`);
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

export type HistoryKind = "created" | "replaced" | "removed";

export interface SkillHistory {
  readonly kind: HistoryKind;
  readonly folder: string;
}

const historyFolder = (historyRoot: string, name: string) => NodePath.join(historyRoot, name);

/** The newest saved version of a skill, if any. */
export async function latestHistory(
  historyRoot: string,
  name: string,
): Promise<SkillHistory | undefined> {
  const folder = historyFolder(historyRoot, name);
  const entries = (await NodeFSP.readdir(folder).catch(() => [] as string[]))
    .filter((entry) => /-(created|replaced|removed)$/u.test(entry))
    .sort(compareStrings);
  const last = entries.at(-1);
  if (last === undefined) return undefined;
  return {
    kind: last.slice(last.lastIndexOf("-") + 1) as HistoryKind,
    folder: NodePath.join(folder, last),
  };
}

async function pruneHistory(historyRoot: string, name: string): Promise<void> {
  const folder = historyFolder(historyRoot, name);
  const entries = (await NodeFSP.readdir(folder).catch(() => [] as string[])).sort(compareStrings);
  for (const old of entries.slice(0, Math.max(0, entries.length - HISTORY_KEEP))) {
    await NodeFSP.rm(NodePath.join(folder, old), { recursive: true, force: true });
  }
}

async function remember(
  historyRoot: string,
  name: string,
  kind: HistoryKind,
  current: string | undefined,
  stamp: string,
): Promise<string> {
  const target = NodePath.join(historyFolder(historyRoot, name), `${stamp}-${kind}`);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  if (current === undefined) await NodeFSP.mkdir(target);
  else await NodeFSP.rename(current, target);
  return target;
}

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

/**
 * Write a skill as one folder change: the files go to a hidden folder first and replace the
 * skill in one rename. The version it replaces, or the fact that it is new, goes to history.
 */
export async function writeSkillFolder(input: {
  readonly root: string;
  readonly historyRoot: string;
  readonly name: string;
  readonly files: Readonly<Record<string, Uint8Array>>;
  /** Sortable time of the change, naming its history entry. */
  readonly stamp: string;
}): Promise<{ readonly created: boolean }> {
  await NodeFSP.mkdir(input.root, { recursive: true });
  const target = NodePath.join(input.root, input.name);
  const staging = NodePath.join(
    input.root,
    `.${input.name}.saving-${NodeCrypto.randomBytes(4).toString("hex")}`,
  );
  try {
    for (const [relative, bytes] of Object.entries(input.files)) {
      const destination = NodePath.join(staging, ...relative.split("/"));
      if (!destination.startsWith(staging + NodePath.sep)) {
        throw new SkillFolderError(`${relative} is outside the skill.`, "unsafe");
      }
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFSP.writeFile(destination, bytes, { flag: "wx" });
    }
    const created = !(await exists(target));
    const entry = await remember(
      input.historyRoot,
      input.name,
      created ? "created" : "replaced",
      created ? undefined : target,
      input.stamp,
    );
    try {
      await NodeFSP.rename(staging, target);
    } catch (error) {
      // Put the skill back as it was: the previous folder returns, the history entry goes.
      if (created) await NodeFSP.rm(entry, { recursive: true, force: true });
      else await NodeFSP.rename(entry, target).catch(() => undefined);
      throw error;
    }
    await pruneHistory(input.historyRoot, input.name);
    return { created };
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

/** Move a skill to history, so Undo can bring it back. */
export async function removeSkillFolder(input: {
  readonly root: string;
  readonly historyRoot: string;
  readonly name: string;
  readonly stamp: string;
}): Promise<void> {
  const target = NodePath.join(input.root, input.name);
  if (!(await exists(target)))
    throw new SkillFolderError("That skill is not there anymore.", "not-found");
  await remember(input.historyRoot, input.name, "removed", target, input.stamp);
  await pruneHistory(input.historyRoot, input.name);
}

/**
 * Undo the last change: a new skill is removed, a replaced or removed one comes back. The
 * version being undone is discarded.
 */
export async function restoreSkillFolder(input: {
  readonly root: string;
  readonly historyRoot: string;
  readonly name: string;
}): Promise<HistoryKind> {
  const last = await latestHistory(input.historyRoot, input.name);
  if (last === undefined)
    throw new SkillFolderError("There is no earlier version to go back to.", "no-history");
  const target = NodePath.join(input.root, input.name);
  const discarded = NodePath.join(
    input.root,
    `.${input.name}.undone-${NodeCrypto.randomBytes(4).toString("hex")}`,
  );
  if (await exists(target)) await NodeFSP.rename(target, discarded);
  try {
    if (last.kind === "created") await NodeFSP.rm(last.folder, { recursive: true, force: true });
    else await NodeFSP.rename(last.folder, target);
  } catch (error) {
    if (await exists(discarded)) await NodeFSP.rename(discarded, target).catch(() => undefined);
    throw error;
  }
  await NodeFSP.rm(discarded, { recursive: true, force: true });
  return last.kind;
}
