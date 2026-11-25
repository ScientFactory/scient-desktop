// @effect-diagnostics nodeBuiltinImport:off -- A backup copies the personal library's files.
// @effect-diagnostics globalDate:off -- Backups carry interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import * as Schema from "effect/Schema";

import {
  ScientLibraryBusyError,
  withScientFileLock,
  withScientLibraryLock,
} from "./libraryLock.ts";
import { settleScientLibraryMerges } from "./libraryMerge.ts";
import { countScientLibraryUnfinishedMoves } from "./libraryMove.ts";
import { readScientLibraryManifest, type ScientLibraryLocation } from "./libraryRoot.ts";
import { isSettled } from "./folderIndex.ts";
import { isNodeError, readBoundedJson, snapshot } from "./storeFiles.ts";

export const SCIENT_LIBRARY_BACKUP_MANIFEST_FILE = "backup.json";
const README_FILE = "README.md";
export const SCIENT_LIBRARY_BACKUP_PAYLOAD = "library";
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The two names Scient gives a file it is still writing. */
const TEMPORARY = new RegExp(`(\\.tmp-${UUID}|\\.${UUID}\\.tmp)$`, "u");
const LOCK = /^(library\.lock|migrations\/[^/]+\/move\.lock)(-journal|-wal|-shm)?$/u;

/**
 * What a backup leaves out, each for a stated reason and by its exact place or name: a kept
 * file whose name merely resembles a lock or a temporary file stays. Everything else in the
 * Library's folder is kept, also what this version does not know.
 */
const LEFT_OUT: ReadonlyArray<{ readonly test: (path: string) => boolean; readonly why: string }> =
  [
    { test: (path) => path.startsWith("text/"), why: "extracted text, rebuilt from the PDFs" },
    {
      test: (path) => path.startsWith("staging/"),
      why: "working files of imports that had not finished",
    },
    { test: (path) => LOCK.test(path), why: "locks of a running Scient" },
    {
      // A move's sealed evidence under `migrations/` is kept byte for byte, whatever its names.
      test: (path) => !path.startsWith("migrations/") && TEMPORARY.test(path),
      why: "unfinished temporary files",
    },
  ];

/** Whether a backup leaves this file of the Library out (slash-separated, from its root). */
export const scientLibraryBackupLeavesOut = (path: string) =>
  LEFT_OUT.some((rule) => rule.test(path));

/** What lives in project folders and is therefore not in a Library backup. */
const NOT_IN_A_LIBRARY = [
  "each project's citation keys, project notes and their earlier versions",
  "systematic reviews and their versions",
  "the copy of a project's sources from before it moved into the Library",
  "the sources of a project that has not moved into the Library yet",
  "highlights on a project's own PDFs",
  "each project's citation style choice",
  "the Zotero sign-in (Accounts)",
] as const;

const BackupFile = Schema.Struct({
  /** Under `library/`, slash-separated, as in the Library's own folder. */
  path: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Int,
});

export const ScientLibraryBackupManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  kind: Schema.Literal("scient-library-backup"),
  /** This backup; two restores of it share it. */
  backupId: Schema.String,
  createdAt: Schema.String,
  library: Schema.Struct({ libraryId: Schema.String, createdAt: Schema.String }),
  counts: Schema.Struct({
    sources: Schema.Int,
    trashed: Schema.Int,
    pdfs: Schema.Int,
    annotations: Schema.Int,
    files: Schema.Int,
    bytes: Schema.Int,
  }),
  files: Schema.Array(BackupFile),
  /** Each reason with the number of files it left out of this backup. */
  leftOut: Schema.Array(Schema.Struct({ why: Schema.String, files: Schema.Int })),
  /** Entries that are neither files nor folders (links, sockets): never copied. */
  skipped: Schema.Array(Schema.String),
  /**
   * Projects whose move into or out of the Library had stopped part way. Some of their
   * sources may be only in the project's folder, so that folder is to be kept too.
   */
  unfinishedMoves: Schema.Int,
  notInALibrary: Schema.Array(Schema.String),
});
export type ScientLibraryBackupManifest = typeof ScientLibraryBackupManifest.Type;

export type ScientLibraryBackupResult =
  | {
      readonly outcome: "backed-up";
      /** The finished backup folder. */
      readonly path: string;
      readonly counts: ScientLibraryBackupManifest["counts"];
      readonly unfinishedMoves: number;
      /** Links and other entries that are not files, which a backup never copies. */
      readonly skipped: number;
    }
  /** A project is moving into or out of the Library right now; its files are in flux. */
  | { readonly outcome: "busy" }
  /** The destination is not an absolute path to a folder, or is inside the Library. */
  | { readonly outcome: "unsafe-destination" };

async function hashOf(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Every regular file under `root`, slash-separated and sorted, and `others`: what is neither a
 * file nor a folder. Links are never followed.
 */
export async function scientLibraryBackupEntries(
  root: string,
): Promise<{ readonly files: ReadonlyArray<string>; readonly others: ReadonlyArray<string> }> {
  const files: string[] = [];
  const others: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const directory = relative ? NodePath.join(root, ...relative.split("/")) : root;
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else others.push(path);
    }
  };
  await walk("");
  return { files: files.toSorted(), others: others.toSorted() };
}

function countsOf(files: ReadonlyArray<typeof BackupFile.Type>) {
  const under = (prefix: string, suffix: string) =>
    files.filter((file) => file.path.startsWith(prefix) && file.path.endsWith(suffix)).length;
  return {
    sources: under("records/", ".json"),
    trashed: under("trash/", ".json"),
    pdfs: under("files/sha256/", ".pdf"),
    annotations: under("annotations/", ".json"),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function readme(manifest: ScientLibraryBackupManifest): string {
  const { counts } = manifest;
  const notes = [
    manifest.skipped.length > 0
      ? `\nNot copied, because they are links or other entries that are not files:\n${manifest.skipped.map((path) => `- ${path}`).join("\n")}\n`
      : "",
    manifest.unfinishedMoves > 0
      ? `\n${manifest.unfinishedMoves} project(s) had not finished moving into or out of the Library. Keep those project\nfolders too: some of their sources may be only there.\n`
      : "",
  ];
  return `# Scient Library backup, ${manifest.createdAt}

This folder is a copy of everything in one Scient Library as it was at that moment:
${counts.sources} sources, ${counts.trashed} in the Trash, ${counts.pdfs} PDFs, ${counts.annotations} files of highlights, with
their versions, personal notes, reading state, collections, saved searches, merges and their
Undo, "not duplicates" decisions and the markers that keep a deleted source deleted.

- \`library/\` holds the files exactly as Scient keeps them: JSON you can read, and PDFs named by
  their SHA-256.
- \`backup.json\` lists every file with its size and SHA-256. A folder without it is not a
  finished backup.

Not in this backup, because they are kept elsewhere:
${manifest.notInALibrary.map((line) => `- ${line}`).join("\n")}

Left out on purpose:
${manifest.leftOut.map((rule) => `- ${rule.why} (${rule.files} files)`).join("\n")}
${notes.join("")}
An earlier version of a source can name a PDF that the Library no longer had when this copy was
made; such a PDF is not here either.

Keep the folder whole. To check it later, ask Scient to check this backup.
`;
}

const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}`;

/** A name no existing entry of `parent` has, from `wanted`. */
async function freeName(parent: string, wanted: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? wanted : `${wanted} (${attempt})`;
    if ((await snapshot(NodePath.join(parent, name))) === "missing") return name;
  }
}

/** The move lock of every checkout that has a folder under `migrations/`. */
async function moveLocks(libraryRoot: string): Promise<ReadonlyArray<string>> {
  const migrations = NodePath.join(libraryRoot, "migrations");
  if ((await snapshot(migrations)) !== "directory") return [];
  return (await NodeFSP.readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => NodePath.join(migrations, entry.name, "move.lock"));
}

/** Runs holding each of these locks, or answers `busy` when another holder has one now. */
async function holding<A>(
  locks: ReadonlyArray<string>,
  run: () => Promise<A>,
): Promise<A | "busy"> {
  const hold = async (index: number): Promise<A | "busy"> => {
    if (index === locks.length) return run();
    let held = false;
    try {
      return await withScientFileLock(
        locks[index]!,
        () => {
          held = true;
          return hold(index + 1);
        },
        { timeoutMs: 0 },
      );
    } catch (error) {
      // Only a lock that could not be taken means a move is running; anything else is an error.
      if (error instanceof ScientLibraryBusyError && !held) return "busy";
      throw error;
    }
  };
  return hold(0);
}

type CopiedFile = typeof BackupFile.Type;

/** What a file was before it was copied; files Scient writes are replaced, never changed in place. */
const stampOf = (stats: NodeFS.BigIntStats) =>
  [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");

/**
 * Copies one Library file and checks the copy; null when the file is gone or is not a file.
 * `trusted` holds when the file had not changed for a while and did not change while copied.
 */
async function copyLibraryFile(
  libraryRoot: string,
  partial: string,
  path: string,
): Promise<{
  readonly file: CopiedFile;
  readonly stamp: string;
  readonly trusted: boolean;
} | null> {
  const from = NodePath.join(libraryRoot, ...path.split("/"));
  const to = NodePath.join(partial, SCIENT_LIBRARY_BACKUP_PAYLOAD, ...path.split("/"));
  const startedNs = BigInt(Date.now()) * 1_000_000n;
  const before = await NodeFSP.lstat(from, { bigint: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  });
  if (!before?.isFile()) return null;
  await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
  await NodeFSP.rm(to, { force: true });
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  try {
    await NodeStreamPromises.pipeline(
      NodeFS.createReadStream(from),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk as Buffer);
          bytes += (chunk as Buffer).length;
          yield chunk;
        }
      },
      NodeFS.createWriteStream(to, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    // Replaced or removed between the listing and the read: the final pass decides.
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  const sha256 = hash.digest("hex");
  if ((await hashOf(to)) !== sha256) {
    throw new Error(`The copy of ${path} does not match the original.`);
  }
  const after = await NodeFSP.lstat(from, { bigint: true }).catch(() => null);
  const stamp = stampOf(before);
  return {
    file: { path, sha256, bytes },
    stamp,
    trusted: after !== null && stampOf(after) === stamp && isSettled(before, startedNs),
  };
}

const PARTIAL_FOLDER = /^\.scient-library-backup-(backup_[0-9a-f]{32})\.partial$/u;
const lockOf = (destination: string, backupId: string) =>
  NodePath.join(destination, `.scient-library-backup-${backupId}.lock`);
/** A partial folder that older versions left without a lock is taken as abandoned after this. */
const UNLOCKED_PARTIAL_AGE_MS = 24 * 60 * 60 * 1000;

/** Removes partial folders that backups into `destination` left when they were stopped. */
async function removeAbandonedBackups(destination: string): Promise<void> {
  for (const entry of await NodeFSP.readdir(destination, { withFileTypes: true })) {
    const backupId = PARTIAL_FOLDER.exec(entry.name)?.[1];
    if (!backupId || !entry.isDirectory()) continue;
    const partial = NodePath.join(destination, entry.name);
    const lock = lockOf(destination, backupId);
    try {
      if ((await snapshot(lock)) === "missing") {
        const { mtimeMs } = await NodeFSP.lstat(partial);
        if (Date.now() - mtimeMs < UNLOCKED_PARTIAL_AGE_MS) continue;
      } else {
        // A running backup holds its lock from before its folder exists until it is renamed.
        await withScientFileLock(lock, async () => undefined, { timeoutMs: 0 });
      }
      await NodeFSP.rm(partial, { recursive: true, force: true });
      await NodeFSP.rm(lock, { force: true });
    } catch {
      // Still running, or not ours to remove: left alone.
    }
  }
}

/**
 * Copies the Library, as it was at one moment, into a new dated folder under `destination`:
 * first without the write lock, then under it only what is new or changed since. The folder
 * gets its name once `backup.json` is written; ones stopped backups left there are removed.
 */
export async function backUpScientLibrary(input: {
  readonly library: ScientLibraryLocation;
  /** An existing folder, outside the Library. */
  readonly destination: string;
  /** It must only report, never change the Library. */
  readonly onProgress?: (progress: { readonly done: number; readonly total: number }) => void;
  /** Tests only: runs after the first copy, before the Library's lock is asked for. */
  readonly faults?: { readonly beforeLibraryLock?: () => Promise<void> };
}): Promise<ScientLibraryBackupResult> {
  const libraryRoot = await NodeFSP.realpath(input.library.root);
  const destination = NodePath.isAbsolute(input.destination)
    ? await NodeFSP.realpath(input.destination).catch(() => null)
    : null;
  if (
    destination === null ||
    (await snapshot(destination)) !== "directory" ||
    `${destination}${NodePath.sep}`.startsWith(`${libraryRoot}${NodePath.sep}`)
  ) {
    return { outcome: "unsafe-destination" };
  }
  await removeAbandonedBackups(destination);
  const createdAt = new Date().toISOString();
  const backupId = `backup_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const lock = lockOf(destination, backupId);
  try {
    return await withScientFileLock(
      lock,
      () => backUpInto({ ...input, libraryRoot, destination, createdAt, backupId }),
      { timeoutMs: 0 },
    );
  } finally {
    await NodeFSP.rm(lock, { force: true }).catch(() => undefined);
  }
}

async function backUpInto(input: {
  readonly library: ScientLibraryLocation;
  readonly libraryRoot: string;
  readonly destination: string;
  readonly createdAt: string;
  readonly backupId: string;
  readonly onProgress?: (progress: { readonly done: number; readonly total: number }) => void;
  readonly faults?: { readonly beforeLibraryLock?: () => Promise<void> };
}): Promise<ScientLibraryBackupResult> {
  const { libraryRoot, destination, createdAt, backupId } = input;
  const partial = NodePath.join(destination, `.scient-library-backup-${backupId}.partial`);
  let created = false;
  /** Removes what this backup wrote; never a folder it did not create. */
  const discard = async () => {
    if (created) await NodeFSP.rm(partial, { recursive: true, force: true }).catch(() => undefined);
  };
  const backedUp = (path: string) => !scientLibraryBackupLeavesOut(path);

  const lockedFirst = await moveLocks(libraryRoot);
  const copied = await holding(lockedFirst, async () => {
    // Exclusive, so a folder another backup left under this name is never written into.
    await NodeFSP.mkdir(partial);
    created = true;
    const early = new Map<string, NonNullable<Awaited<ReturnType<typeof copyLibraryFile>>>>();
    const first = (await scientLibraryBackupEntries(libraryRoot)).files.filter(backedUp);
    for (const [index, path] of first.entries()) {
      const copy = await copyLibraryFile(libraryRoot, partial, path);
      if (copy) early.set(path, copy);
      input.onProgress?.({ done: index + 1, total: first.length });
    }
    await input.faults?.beforeLibraryLock?.();
    return withScientLibraryLock(libraryRoot, async () => {
      // A checkout that began its move since: its lock too, or the copy could split its files.
      const since = (await moveLocks(libraryRoot)).filter((lock) => !lockedFirst.includes(lock));
      return holding(since, async () => {
        // Inside the lock, so no merge can start and stop between this and the copy.
        await settleScientLibraryMerges(input.library);
        const library = await readScientLibraryManifest(libraryRoot);
        const found = await scientLibraryBackupEntries(libraryRoot);
        const leftOut = LEFT_OUT.map((rule) => ({
          why: rule.why,
          files: found.files.filter((path) => rule.test(path)).length,
        }));
        const paths = found.files.filter(backedUp);
        const skipped = found.others.filter(backedUp);
        const unfinishedMoves = await countScientLibraryUnfinishedMoves(libraryRoot);
        const files: CopiedFile[] = [];
        for (const path of paths) {
          const known = early.get(path);
          const now = await NodeFSP.lstat(NodePath.join(libraryRoot, ...path.split("/")), {
            bigint: true,
          });
          if (known?.trusted && known.stamp === stampOf(now)) {
            files.push(known.file);
            continue;
          }
          const copy = await copyLibraryFile(libraryRoot, partial, path);
          if (!copy) throw new Error(`${path} could not be copied.`);
          files.push(copy.file);
        }
        // The payload is exactly what is listed: a file copied first and gone by now, or one
        // whose copy was abandoned when it vanished mid-read, is not the Library at this moment.
        const payload = NodePath.join(partial, SCIENT_LIBRARY_BACKUP_PAYLOAD);
        const listed = new Set(files.map((file) => file.path));
        for (const path of (await scientLibraryBackupEntries(payload)).files) {
          if (!listed.has(path)) await NodeFSP.rm(NodePath.join(payload, ...path.split("/")));
        }
        return { library, files, leftOut, skipped, unfinishedMoves };
      });
    });
  }).catch(async (error: unknown) => {
    await discard();
    throw error;
  });

  if (copied === "busy") {
    await discard();
    return { outcome: copied };
  }
  const manifest: ScientLibraryBackupManifest = {
    formatVersion: 1,
    kind: "scient-library-backup",
    backupId,
    createdAt,
    library: { libraryId: copied.library.libraryId, createdAt: copied.library.createdAt },
    counts: countsOf(copied.files),
    files: copied.files,
    leftOut: copied.leftOut,
    skipped: copied.skipped,
    unfinishedMoves: copied.unfinishedMoves,
    notInALibrary: [...NOT_IN_A_LIBRARY],
  };
  try {
    await NodeFSP.writeFile(NodePath.join(partial, README_FILE), readme(manifest), { flag: "wx" });
    await NodeFSP.writeFile(
      NodePath.join(partial, SCIENT_LIBRARY_BACKUP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    const name = await freeName(destination, `Scient Library backup ${stamp(createdAt)}`);
    const path = NodePath.join(destination, name);
    await NodeFSP.rename(partial, path);
    return {
      outcome: "backed-up",
      path,
      counts: manifest.counts,
      unfinishedMoves: manifest.unfinishedMoves,
      skipped: manifest.skipped.length,
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

export type ScientLibraryBackupCheck =
  | {
      readonly outcome: "complete";
      readonly createdAt: string;
      readonly counts: ScientLibraryBackupManifest["counts"];
    }
  /** No readable `backup.json`: not a backup, or one that never finished. */
  | { readonly outcome: "not-a-backup" }
  | {
      readonly outcome: "damaged";
      /** Files that are unsafe to read, gone or no longer match their recorded hash. */
      readonly changed: ReadonlyArray<string>;
      /** Files or unsafe entries under `library/` that the manifest does not list. */
      readonly unlisted: ReadonlyArray<string>;
    };

/** Containment rules shared by backup checks and the stricter restore-name policy. */
export const scientLibraryBackupPathIsUnsafe = (path: string): boolean =>
  NodePath.win32.isAbsolute(path) ||
  path
    .split("/")
    .some((part) => part === "" || part === "." || part === ".." || /[\\\u0000]/u.test(part));

/** Reads a backup folder against its own manifest: every listed file present and unchanged. */
export async function checkScientLibraryBackup(folder: string): Promise<ScientLibraryBackupCheck> {
  const manifest = await readBoundedJson(
    NodePath.join(folder, SCIENT_LIBRARY_BACKUP_MANIFEST_FILE),
    MAX_MANIFEST_BYTES,
    ScientLibraryBackupManifest,
  ).catch(() => null);
  if (!manifest) return { outcome: "not-a-backup" };
  const unsafe = manifest.files.filter((file) => scientLibraryBackupPathIsUnsafe(file.path));
  if (unsafe.length > 0) {
    return { outcome: "damaged", changed: unsafe.map((file) => file.path), unlisted: [] };
  }
  const backup = await NodeFSP.realpath(folder);
  const payload = NodePath.join(backup, SCIENT_LIBRARY_BACKUP_PAYLOAD);
  if ((await snapshot(payload)) !== "directory") {
    return { outcome: "damaged", changed: [SCIENT_LIBRARY_BACKUP_PAYLOAD], unlisted: [] };
  }
  const found = await scientLibraryBackupEntries(payload);
  const regular = new Set(found.files);
  const changed: string[] = [];
  for (const file of manifest.files) {
    const path = NodePath.join(payload, ...file.path.split("/"));
    const canonical = regular.has(file.path)
      ? await NodeFSP.realpath(path).catch((error: unknown) => {
          if (isNodeError(error, "ENOENT")) return null;
          throw error;
        })
      : null;
    if (canonical !== path || (await snapshot(path)) !== "file") {
      changed.push(file.path);
      continue;
    }
    const hash = await hashOf(path).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (hash !== file.sha256) changed.push(file.path);
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  const unlisted = [...found.files, ...found.others].filter((path) => !listed.has(path));
  return changed.length === 0 && unlisted.length === 0
    ? { outcome: "complete", createdAt: manifest.createdAt, counts: manifest.counts }
    : { outcome: "damaged", changed, unlisted };
}
