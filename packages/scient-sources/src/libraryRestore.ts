// @effect-diagnostics nodeBuiltinImport:off -- A restore copies a backup's files beside the personal library.
// @effect-diagnostics globalDate:off -- Restores carry interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import * as Schema from "effect/Schema";

import {
  SCIENT_LIBRARY_BACKUP_MANIFEST_FILE,
  SCIENT_LIBRARY_BACKUP_PAYLOAD,
  ScientLibraryBackupManifest,
  scientLibraryBackupEntries,
  scientLibraryBackupLeavesOut,
} from "./libraryBackup.ts";
import { ScientLibraryBusyError, withScientFileLock } from "./libraryLock.ts";
import { carryScientLibraryMoveBacks } from "./libraryMove.ts";
import { SCIENT_LIBRARY_RESTORE_INTENT_SUFFIX, type ScientLibraryLocation } from "./libraryRoot.ts";
import { ScientSourceActor } from "./model.ts";
import { atomicWriteJson, isNodeError, readBoundedJson, snapshot } from "./storeFiles.ts";

const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
const MAX_SMALL_BYTES = 1024 * 1024;
const RESTORES_FILE = "restores.json";
const SHA256 = /^[0-9a-f]{64}$/u;
/** What an unused Library may hold besides what a backup leaves out anyway. */
const UNUSED_FILES = new Set(["library.json", "instances.json"]);

/**
 * A restore's files sit beside the Library's folder and carry its name, so they are on its
 * volume (the swap is a rename) and outside it (the swap replaces the folder).
 */
const beside = (libraryRoot: string) => ({
  intent: `${libraryRoot}${SCIENT_LIBRARY_RESTORE_INTENT_SUFFIX}`,
  lock: `${libraryRoot}.restore.lock`,
  staged: (restoreId: string) => `${libraryRoot}.restoring-${restoreId}`,
  replaced: (restoreId: string) => `${libraryRoot}.replaced-${restoreId}`,
  stagedPrefix: `${NodePath.basename(libraryRoot)}.restoring-`,
  replacedPrefix: `${NodePath.basename(libraryRoot)}.replaced-`,
});

/** The Library's folder under its parent's real path; the folder itself need not exist. */
async function canonicalRoot(libraryRoot: string): Promise<string | null> {
  const parent = await NodeFSP.realpath(NodePath.dirname(libraryRoot)).catch(() => null);
  return parent === null ? null : NodePath.join(parent, NodePath.basename(libraryRoot));
}

const Counts = Schema.Struct({
  sources: Schema.Int,
  pdfs: Schema.Int,
  files: Schema.Int,
  bytes: Schema.Int,
});

/** A checked copy of a backup that waits beside the Library for the next start. */
export const ScientLibraryRestoreIntent = Schema.Struct({
  formatVersion: Schema.Literal(1),
  restoreId: Schema.String,
  backupId: Schema.String,
  backupCreatedAt: Schema.String,
  preparedAt: Schema.String,
  counts: Counts,
  /**
   * The folder name the Library was moved aside under, written before it is moved. While that
   * folder exists and no Library does, `ensureScientLibrary` refuses to make a new one.
   */
  replaced: Schema.optionalKey(Schema.String),
});
export type ScientLibraryRestoreIntent = typeof ScientLibraryRestoreIntent.Type;

const RestoreEntry = Schema.Struct({
  restoreId: Schema.String,
  backupId: Schema.String,
  backupCreatedAt: Schema.String,
  /** When the copy was made. */
  at: Schema.String,
  by: Schema.optionalKey(ScientSourceActor),
  sources: Schema.optionalKey(Schema.Int),
  pdfs: Schema.optionalKey(Schema.Int),
  /** When it took the Library's place; absent in a copy that still waits. */
  finishedAt: Schema.optionalKey(Schema.String),
  /** The Library it replaced, where that held anything: its folder and its source count. */
  kept: Schema.optionalKey(Schema.Struct({ path: Schema.String, sources: Schema.Int })),
});

/** Kept in the restored Library: which restores of which backups made it what it is. */
const ScientLibraryRestores = Schema.Struct({
  formatVersion: Schema.Literal(1),
  restores: Schema.Array(RestoreEntry),
});

const newRestoreId = () => `restore_${NodeCrypto.randomUUID().replaceAll("-", "")}`;

async function readIntent(libraryRoot: string): Promise<ScientLibraryRestoreIntent | null> {
  try {
    return await readBoundedJson(
      beside(libraryRoot).intent,
      MAX_SMALL_BYTES,
      ScientLibraryRestoreIntent,
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function restoresOf(folder: string) {
  try {
    return (
      await readBoundedJson(
        NodePath.join(folder, RESTORES_FILE),
        MAX_SMALL_BYTES,
        ScientLibraryRestores,
      )
    ).restores;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

/**
 * Whether a Library folder holds nothing at all worth keeping: it is absent, or has only its own
 * `library.json`, the list of this computer's projects, what a backup leaves out anyway, and
 * folders of those. Anything else, also something this version does not know, means it is kept
 * when a restore replaces it.
 */
export async function scientLibraryUnused(libraryRoot: string): Promise<boolean> {
  const state = await snapshot(libraryRoot);
  if (state === "missing") return true;
  if (state !== "directory") return false;
  const { files, others } = await scientLibraryBackupEntries(libraryRoot);
  return [...files, ...others].every(
    (path) => UNUSED_FILES.has(path) || scientLibraryBackupLeavesOut(path),
  );
}

/** Names Windows will not create, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu;

/**
 * The first path a restore will not write, or null: every path must stay inside the Library,
 * be writable on any of Scient's platforms, and not collide with another when case or Unicode
 * form is ignored. `library.json` must be among them.
 */
function unsafePath(files: ScientLibraryBackupManifest["files"]): string | null {
  const seen = new Set<string>();
  const folders = new Set<string>();
  const keyOf = (path: string) => path.normalize("NFC").toLowerCase();
  for (const file of files) {
    const parts = file.path.split("/");
    if (
      parts.some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          /[\\:*?"<>|\u0000-\u001f]/u.test(part) ||
          /[. ]$/u.test(part) ||
          RESERVED.test(part) ||
          Buffer.byteLength(part) > 255,
      ) ||
      !SHA256.test(file.sha256) ||
      file.bytes < 0 ||
      scientLibraryBackupLeavesOut(file.path) ||
      seen.has(keyOf(file.path))
    ) {
      return file.path;
    }
    seen.add(keyOf(file.path));
    for (let depth = 1; depth < parts.length; depth += 1) {
      folders.add(keyOf(parts.slice(0, depth).join("/")));
    }
  }
  // A name that is a file for one entry and a folder for another.
  for (const file of files) if (folders.has(keyOf(file.path))) return file.path;
  return seen.has("library.json") ? null : "library.json";
}

async function readBackupManifest(
  folder: string,
): Promise<ScientLibraryBackupManifest | "not-a-backup" | "unsupported"> {
  const path = NodePath.join(folder, SCIENT_LIBRARY_BACKUP_MANIFEST_FILE);
  try {
    return await readBoundedJson(path, MAX_MANIFEST_BYTES, ScientLibraryBackupManifest);
  } catch {
    // A backup of a later format says so itself; anything else is not a backup.
    const raw: unknown = await NodeFSP.readFile(path, "utf8").then(
      (text) => JSON.parse(text) as unknown,
      () => null,
    );
    const later =
      typeof raw === "object" &&
      raw !== null &&
      "kind" in raw &&
      raw.kind === "scient-library-backup" &&
      "formatVersion" in raw &&
      raw.formatVersion !== 1;
    return later ? "unsupported" : "not-a-backup";
  }
}

export type ScientLibraryRestorePrepared =
  | {
      readonly outcome: "ready";
      readonly restoreId: string;
      readonly backupCreatedAt: string;
      readonly counts: ScientLibraryRestoreIntent["counts"];
    }
  /** No readable `backup.json`. */
  | { readonly outcome: "not-a-backup" }
  /** It lists a file whose name a restore will not write here (or lacks `library.json`). */
  | { readonly outcome: "unsafe-paths"; readonly file: string }
  /** A backup written by a later Scient. */
  | { readonly outcome: "unsupported" }
  /** A listed file is gone or changed, or the backup holds something it does not list. */
  | { readonly outcome: "damaged"; readonly file: string }
  /** Another restore is being prepared, cancelled or finished right now. */
  | { readonly outcome: "busy" }
  /** An earlier restore already moved a folder; the next start finishes it first. */
  | { readonly outcome: "unfinished" }
  | { readonly outcome: "stopped" };

/**
 * Checks a backup and copies it beside the Library, each file compared with the backup's own
 * list. Changes nothing in the Library: the copy takes its place at the next start
 * (`finishScientLibraryRestore`). An earlier copy that was waiting is replaced once this one
 * is whole; a restore that failed before that leaves the earlier one waiting.
 */
export async function prepareScientLibraryRestore(input: {
  /** The Library's folder; it need not exist yet. Its parent folder must. */
  readonly libraryRoot: string;
  /** A finished backup folder. */
  readonly backup: string;
  readonly onProgress?: (progress: { readonly done: number; readonly total: number }) => void;
  /** Asked between files; true abandons the copy and removes it. */
  readonly shouldStop?: () => boolean;
  readonly actor?: ScientSourceActor;
}): Promise<ScientLibraryRestorePrepared> {
  await NodeFSP.mkdir(NodePath.dirname(input.libraryRoot), { recursive: true });
  const libraryRoot = (await canonicalRoot(input.libraryRoot))!;
  const paths = beside(libraryRoot);
  const backup = NodePath.isAbsolute(input.backup)
    ? await NodeFSP.realpath(input.backup).catch(() => null)
    : null;
  if (backup === null) return { outcome: "not-a-backup" };
  const manifest = await readBackupManifest(backup);
  if (typeof manifest === "string") return { outcome: manifest };
  const refused = unsafePath(manifest.files);
  if (refused !== null) return { outcome: "unsafe-paths", file: refused };
  const payload = NodePath.join(backup, SCIENT_LIBRARY_BACKUP_PAYLOAD);
  if ((await snapshot(payload)) !== "directory") return { outcome: "damaged", file: "library" };
  const listed = new Set(manifest.files.map((file) => file.path));
  const found = await scientLibraryBackupEntries(payload);
  const stray = [...found.files, ...found.others].find((path) => !listed.has(path));
  if (stray !== undefined) return { outcome: "damaged", file: stray };

  const restoreId = newRestoreId();
  const staged = paths.staged(restoreId);
  let created = false;
  const discard = async () => {
    if (created) await NodeFSP.rm(staged, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    return await withScientFileLock(
      paths.lock,
      async (): Promise<ScientLibraryRestorePrepared> => {
        // A restore that already moved a folder is finished by the next start, never replaced.
        const earlier = await readIntent(libraryRoot);
        if (earlier && (await begun(libraryRoot, earlier))) return { outcome: "unfinished" };
        await NodeFSP.mkdir(staged);
        created = true;
        for (const [index, file] of manifest.files.entries()) {
          if (input.shouldStop?.()) {
            await discard();
            return { outcome: "stopped" };
          }
          const from = NodePath.join(payload, ...file.path.split("/"));
          const to = NodePath.join(staged, ...file.path.split("/"));
          await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
          const hash = NodeCrypto.createHash("sha256");
          const copied = await NodeStreamPromises.pipeline(
            NodeFS.createReadStream(from),
            async function* (source) {
              for await (const chunk of source) {
                hash.update(chunk as Buffer);
                yield chunk;
              }
            },
            // Flushed to the disk before it closes: this copy becomes the Library.
            NodeFS.createWriteStream(to, { flags: "wx", mode: 0o600, flush: true }),
          ).then(
            () => true,
            (error: unknown) => {
              if (isNodeError(error, "ENOENT") && !NodeFS.existsSync(from)) return false;
              throw error;
            },
          );
          if (!copied || hash.digest("hex") !== file.sha256) {
            await discard();
            return { outcome: "damaged", file: file.path };
          }
          input.onProgress?.({ done: index + 1, total: manifest.files.length });
        }
        // The Library it becomes says which restore of which backup it came from.
        const at = new Date().toISOString();
        await atomicWriteJson(
          NodePath.join(staged, RESTORES_FILE),
          {
            formatVersion: 1,
            restores: [
              ...(await restoresOf(staged)),
              {
                restoreId,
                backupId: manifest.backupId,
                backupCreatedAt: manifest.createdAt,
                at,
                by: input.actor ?? "user",
                sources: manifest.counts.sources,
                pdfs: manifest.counts.pdfs,
              },
            ],
          },
          MAX_SMALL_BYTES,
        );
        const counts = {
          sources: manifest.counts.sources,
          pdfs: manifest.counts.pdfs,
          files: manifest.counts.files,
          bytes: manifest.counts.bytes,
        };
        // Written last: only a whole, checked copy is ever put in place. It takes the place of
        // a copy that was waiting, which goes only now that this one is whole.
        await atomicWriteJson(
          paths.intent,
          {
            formatVersion: 1,
            restoreId,
            backupId: manifest.backupId,
            backupCreatedAt: manifest.createdAt,
            preparedAt: at,
            counts,
          } satisfies ScientLibraryRestoreIntent,
          MAX_SMALL_BYTES,
        );
        if (earlier) {
          await NodeFSP.rm(paths.staged(earlier.restoreId), { recursive: true, force: true });
        }
        return { outcome: "ready", restoreId, backupCreatedAt: manifest.createdAt, counts };
      },
      { timeoutMs: 0 },
    );
  } catch (error) {
    await discard();
    if (error instanceof ScientLibraryBusyError && !created) return { outcome: "busy" };
    throw error;
  }
}

/**
 * A start already moved a folder for this restore: the Library stepped aside, or the copy is
 * no longer where it waited. From then on only the next start may end it; dropping the intent
 * would leave a Library that was swapped in without the projects' "moved back" decisions.
 */
async function begun(libraryRoot: string, intent: ScientLibraryRestoreIntent): Promise<boolean> {
  const paths = beside(libraryRoot);
  // A Library that was never there (a new computer) is not one that stepped aside.
  return (
    (await snapshot(paths.staged(intent.restoreId))) !== "directory" ||
    (await snapshot(paths.replaced(intent.restoreId))) === "directory"
  );
}

/**
 * The copy of a backup that waits for the next start, if there is one. `begun`: a start
 * already moved a folder for it and could not finish, so it can no longer be cancelled.
 */
export async function readScientLibraryRestorePending(
  libraryRoot: string,
): Promise<(ScientLibraryRestoreIntent & { readonly begun: boolean }) | null> {
  const root = await canonicalRoot(libraryRoot);
  const intent = root === null ? null : await readIntent(root);
  return root === null || intent === null ? null : { ...intent, begun: await begun(root, intent) };
}

/** Drops the copy that was waiting; the Library was never touched. */
export async function cancelScientLibraryRestore(
  libraryRoot: string,
): Promise<{ readonly outcome: "cancelled" | "nothing-waiting" | "begun" }> {
  const root = await canonicalRoot(libraryRoot);
  if (root === null || !(await readIntent(root))) return { outcome: "nothing-waiting" };
  const paths = beside(root);
  return withScientFileLock(paths.lock, async () => {
    const intent = await readIntent(root);
    if (!intent) return { outcome: "nothing-waiting" as const };
    if (await begun(root, intent)) return { outcome: "begun" as const };
    await NodeFSP.rm(paths.intent, { force: true });
    await NodeFSP.rm(paths.staged(intent.restoreId), { recursive: true, force: true });
    return { outcome: "cancelled" as const };
  });
}

export type ScientLibraryRestoreFinished =
  /** No restore was waiting. */
  | { readonly outcome: "none" }
  | {
      readonly outcome: "restored";
      readonly restoreId: string;
      readonly backupCreatedAt: string;
      readonly counts: ScientLibraryRestoreIntent["counts"];
      /**
       * The Library that was replaced, when it held anything: its folder beside the Library and
       * how many sources it has. Scient never removes it.
       */
      readonly keptReplaced: { readonly path: string; readonly sources: number } | null;
    }
  /** `waiting`: the copy is still there and the next start tries again. */
  | {
      readonly outcome: "failed";
      readonly restoreId: string;
      readonly waiting: boolean;
      readonly reason: string;
    };

/** Stops the finish at a named point, as a killed process would; tests only. */
export type ScientLibraryRestoreFault = "after-aside" | "after-swap" | "before-intent-removed";

async function folderNames(parent: string, prefix: string): Promise<ReadonlyArray<string>> {
  return (await NodeFSP.readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => NodePath.join(parent, entry.name))
    .toSorted();
}

/**
 * Puts a waiting copy of a backup in the Library's place. Call it when nothing else can read
 * or write the Library: at the server's start, after it owns its data folder. Every step can be
 * repeated, so a start that was killed part way is finished by the next one. The Library that
 * was there is renamed aside, never deleted unless it holds nothing (`scientLibraryUnused`).
 */
export async function finishScientLibraryRestore(
  root: string,
  options: { readonly fault?: ScientLibraryRestoreFault } = {},
): Promise<ScientLibraryRestoreFinished> {
  const libraryRoot = await canonicalRoot(root);
  if (libraryRoot === null) return { outcome: "none" };
  const paths = beside(libraryRoot);
  const parent = NodePath.dirname(libraryRoot);
  const stop = (at: ScientLibraryRestoreFault) => {
    if (options.fault === at) throw new Error(`Stopped ${at} (test fault).`);
  };
  // Nothing of a restore beside the Library: the usual start, which takes no lock.
  const leftovers = [
    ...(await folderNames(parent, paths.stagedPrefix)),
    ...(await folderNames(parent, paths.replacedPrefix)),
  ];
  if (leftovers.length === 0 && !(await readIntent(libraryRoot))) return { outcome: "none" };

  return withScientFileLock(paths.lock, async (): Promise<ScientLibraryRestoreFinished> => {
    /** Removes staged copies nothing waits for and replaced Libraries that hold nothing. */
    const sweep = async () => {
      for (const folder of await folderNames(parent, paths.stagedPrefix)) {
        await NodeFSP.rm(folder, { recursive: true, force: true });
      }
      for (const folder of await folderNames(parent, paths.replacedPrefix)) {
        if (await scientLibraryUnused(folder)) {
          await NodeFSP.rm(folder, { recursive: true, force: true });
        }
      }
    };

    const intent = await readIntent(libraryRoot);
    if (!intent) {
      await sweep();
      return { outcome: "none" };
    }
    const { restoreId } = intent;
    const staged = paths.staged(restoreId);
    const aside = paths.replaced(restoreId);
    const asideThere = async () => (await snapshot(aside)) === "directory";
    const failed = (reason: string, waiting: boolean): ScientLibraryRestoreFinished => ({
      outcome: "failed",
      restoreId,
      waiting,
      reason,
    });
    const reasonOf = (error: unknown) =>
      error instanceof Error && error.message ? error.message : "A folder could not be renamed.";
    const committed = async (): Promise<ScientLibraryRestoreFinished> => {
      // A "Move back into this project" chosen after the backup was made is known only to the
      // Library that was replaced. It is carried over now, before any move pass can run.
      if (await asideThere()) {
        await carryScientLibraryMoveBacks({ from: aside, into: libraryRoot, mark: restoreId });
      }
      // A replaced Library that held anything stays; the restored Library records where it is
      // before the intent goes, so a start killed right here still leaves the record.
      const kept =
        (await asideThere()) && !(await scientLibraryUnused(aside))
          ? {
              path: aside,
              sources: (await scientLibraryBackupEntries(aside)).files.filter((path) =>
                path.startsWith("records/"),
              ).length,
            }
          : null;
      const restores = await restoresOf(libraryRoot);
      if (restores.some((entry) => entry.restoreId === restoreId && !entry.finishedAt)) {
        const finishedAt = new Date().toISOString();
        // Libraries that earlier restores kept are known only to the Library replaced now:
        // its records of them come along, or their folders could never be found again.
        const known = new Set(restores.map((entry) => entry.restoreId));
        const earlierKept = (await asideThere())
          ? (await restoresOf(aside).catch(() => [])).filter(
              (entry) => entry.finishedAt && entry.kept && !known.has(entry.restoreId),
            )
          : [];
        await atomicWriteJson(
          NodePath.join(libraryRoot, RESTORES_FILE),
          {
            formatVersion: 1,
            restores: [
              ...earlierKept,
              ...restores.map((entry) =>
                entry.restoreId === restoreId
                  ? { ...entry, finishedAt, ...(kept ? { kept } : {}) }
                  : entry,
              ),
            ],
          },
          MAX_SMALL_BYTES,
        );
      }
      stop("before-intent-removed");
      await NodeFSP.rm(paths.intent, { force: true });
      await sweep();
      return {
        outcome: "restored",
        restoreId,
        backupCreatedAt: intent.backupCreatedAt,
        counts: intent.counts,
        keptReplaced: kept,
      };
    };

    const libraryState = await snapshot(libraryRoot);
    if ((await snapshot(staged)) !== "directory") {
      const done =
        libraryState === "directory" &&
        (await restoresOf(libraryRoot)).some((entry) => entry.restoreId === restoreId);
      if (done) return committed();
      // The copy is gone. A Library this restore had moved aside goes back to its place; if
      // that fails the intent stays, so no new Library is made and the next start tries again.
      if (libraryState === "missing" && (await asideThere())) {
        await NodeFSP.rename(aside, libraryRoot);
      }
      await NodeFSP.rm(paths.intent, { force: true });
      return failed("The copy of the backup that was waiting is gone.", false);
    }
    if (libraryState !== "missing") {
      if (await asideThere()) {
        return failed("A folder of an earlier attempt is in the way; nothing was changed.", true);
      }
      // Named in the intent first: from the rename until the copy is in place, no new Library
      // may be made here (`ensureScientLibrary` checks).
      await atomicWriteJson(
        paths.intent,
        { ...intent, replaced: NodePath.basename(aside) } satisfies ScientLibraryRestoreIntent,
        MAX_SMALL_BYTES,
      );
      try {
        // The Library that is there, whatever it holds, steps aside under a name of its own.
        await NodeFSP.rename(libraryRoot, aside);
      } catch (error) {
        // A file held open (Windows): nothing moved; the next start tries again.
        return failed(reasonOf(error), true);
      }
      stop("after-aside");
    }
    try {
      await NodeFSP.rename(staged, libraryRoot);
    } catch (error) {
      // Put the Library back. If that fails too it stays aside, named in the intent: no new
      // Library is made, and the next start finishes one way or the other.
      const putBack = (await asideThere())
        ? await NodeFSP.rename(aside, libraryRoot).then(
            () => true,
            () => false,
          )
        : true;
      return failed(
        putBack
          ? reasonOf(error)
          : `${reasonOf(error)} The Library is kept beside its place until Scient restarts.`,
        true,
      );
    }
    stop("after-swap");
    return committed();
  });
}

/** One restore that took this Library's place, as the Library itself records it. */
export interface ScientLibraryRestoreRecord {
  readonly restoreId: string;
  readonly finishedAt: string;
  readonly by: ScientSourceActor;
  readonly backupCreatedAt: string;
  readonly sources: number;
  readonly pdfs: number;
  /** The replaced Library's folder, while that folder is still there. */
  readonly kept: { readonly path: string; readonly sources: number } | null;
}

/** The restores that made this Library, oldest first; reads only. */
export async function listScientLibraryRestores(
  library: ScientLibraryLocation,
): Promise<ReadonlyArray<ScientLibraryRestoreRecord>> {
  const listed: ScientLibraryRestoreRecord[] = [];
  for (const entry of await restoresOf(library.root).catch(() => [])) {
    if (!entry.finishedAt) continue;
    const kept =
      entry.kept && (await snapshot(entry.kept.path).catch(() => "missing")) === "directory"
        ? entry.kept
        : null;
    listed.push({
      restoreId: entry.restoreId,
      finishedAt: entry.finishedAt,
      by: entry.by ?? "user",
      backupCreatedAt: entry.backupCreatedAt,
      sources: entry.sources ?? 0,
      pdfs: entry.pdfs ?? 0,
      kept,
    });
  }
  return listed;
}
