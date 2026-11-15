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
import { readScientLibraryManifest, type ScientLibraryLocation } from "./libraryRoot.ts";
import { isNodeError, readBoundedJson, snapshot } from "./storeFiles.ts";

const MANIFEST_FILE = "backup.json";
const README_FILE = "README.md";
const PAYLOAD = "library";
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

/**
 * What a backup leaves out, each for a stated reason. Everything else in the Library's folder
 * is kept, also what this version does not know.
 */
const LEFT_OUT: ReadonlyArray<{ readonly test: (path: string) => boolean; readonly why: string }> =
  [
    { test: (path) => path.startsWith("text/"), why: "extracted text, rebuilt from the PDFs" },
    { test: (path) => /(^|\/)[^/]*\.lock[^/]*$/u.test(path), why: "locks of a running Scient" },
    { test: (path) => path.includes(".tmp-"), why: "unfinished temporary files" },
  ];

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
  leftOut: Schema.Array(Schema.String),
  notInALibrary: Schema.Array(Schema.String),
});
export type ScientLibraryBackupManifest = typeof ScientLibraryBackupManifest.Type;

export type ScientLibraryBackupResult =
  | {
      readonly outcome: "backed-up";
      /** The finished backup folder. */
      readonly path: string;
      readonly counts: ScientLibraryBackupManifest["counts"];
    }
  /** A project is moving into or out of the Library right now; its files are in flux. */
  | { readonly outcome: "busy" }
  | { readonly outcome: "stopped" }
  /** The destination is not a folder, or is inside the Library. */
  | { readonly outcome: "unsafe-destination" };

async function hashOf(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Every regular file under `root`, slash-separated and sorted; links are never followed. */
async function filesUnder(root: string): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const directory = relative ? NodePath.join(root, ...relative.split("/")) : root;
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await walk("");
  return found.toSorted();
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
${manifest.leftOut.map((line) => `- ${line}`).join("\n")}

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

/** Holds every checkout's move lock, or answers `busy` when a move holds one now. */
async function withNoMoveRunning<A>(
  libraryRoot: string,
  run: () => Promise<A>,
): Promise<A | "busy"> {
  const migrations = NodePath.join(libraryRoot, "migrations");
  const locks =
    (await snapshot(migrations)) === "directory"
      ? (await NodeFSP.readdir(migrations, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => NodePath.join(migrations, entry.name, "move.lock"))
      : [];
  const hold = (index: number): Promise<A> =>
    index === locks.length
      ? run()
      : withScientFileLock(locks[index]!, () => hold(index + 1), { timeoutMs: 0 });
  try {
    return await hold(0);
  } catch (error) {
    if (error instanceof ScientLibraryBusyError) return "busy";
    throw error;
  }
}

/**
 * Copies everything in the Library into a new dated folder under `destination`. The copy is
 * made inside the Library's write lock, so changes wait while it runs; each file's copy is
 * checked against the original, and the folder gets its name only once `backup.json` is written.
 */
export async function backUpScientLibrary(input: {
  readonly library: ScientLibraryLocation;
  /** An existing folder, outside the Library. */
  readonly destination: string;
  /** Called inside the Library's lock: it must only report, never change the Library. */
  readonly onProgress?: (progress: { readonly done: number; readonly total: number }) => void;
  /** Asked between files; true abandons the backup and removes what was copied. */
  readonly shouldStop?: () => boolean;
}): Promise<ScientLibraryBackupResult> {
  const libraryRoot = await NodeFSP.realpath(input.library.root);
  const destination = await NodeFSP.realpath(input.destination).catch(() => null);
  if (
    destination === null ||
    (await snapshot(destination)) !== "directory" ||
    `${destination}${NodePath.sep}`.startsWith(`${libraryRoot}${NodePath.sep}`)
  ) {
    return { outcome: "unsafe-destination" };
  }
  // Finishes a merge or an Undo a stopped Scient left halfway; it takes the lock itself.
  await settleScientLibraryMerges(input.library);
  const createdAt = new Date().toISOString();
  const backupId = `backup_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const partial = NodePath.join(destination, `.scient-library-backup-${backupId}.partial`);

  const copied = await withNoMoveRunning(libraryRoot, () =>
    withScientLibraryLock(libraryRoot, async () => {
      const library = await readScientLibraryManifest(libraryRoot);
      const paths = (await filesUnder(libraryRoot)).filter(
        (path) => !LEFT_OUT.some((rule) => rule.test(path)),
      );
      const files: Array<typeof BackupFile.Type> = [];
      for (const [index, path] of paths.entries()) {
        if (input.shouldStop?.()) return "stopped" as const;
        const from = NodePath.join(libraryRoot, ...path.split("/"));
        const to = NodePath.join(partial, PAYLOAD, ...path.split("/"));
        await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
        const hash = NodeCrypto.createHash("sha256");
        let bytes = 0;
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
        const sha256 = hash.digest("hex");
        if ((await hashOf(to)) !== sha256) {
          throw new Error(`The copy of ${path} does not match the original.`);
        }
        files.push({ path, sha256, bytes });
        input.onProgress?.({ done: index + 1, total: paths.length });
      }
      return { library, files };
    }),
  ).catch(async (error: unknown) => {
    await NodeFSP.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  });

  if (copied === "busy" || copied === "stopped") {
    await NodeFSP.rm(partial, { recursive: true, force: true }).catch(() => undefined);
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
    leftOut: LEFT_OUT.map((rule) => rule.why),
    notInALibrary: [...NOT_IN_A_LIBRARY],
  };
  try {
    await NodeFSP.writeFile(NodePath.join(partial, README_FILE), readme(manifest), { flag: "wx" });
    await NodeFSP.writeFile(
      NodePath.join(partial, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    const name = await freeName(destination, `Scient Library backup ${stamp(createdAt)}`);
    const path = NodePath.join(destination, name);
    await NodeFSP.rename(partial, path);
    return { outcome: "backed-up", path, counts: manifest.counts };
  } catch (error) {
    await NodeFSP.rm(partial, { recursive: true, force: true }).catch(() => undefined);
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
      /** Files that are gone or no longer match their recorded hash. */
      readonly changed: ReadonlyArray<string>;
      /** Files under `library/` that the manifest does not list. */
      readonly unlisted: ReadonlyArray<string>;
    };

/** Reads a backup folder against its own manifest: every listed file present and unchanged. */
export async function checkScientLibraryBackup(folder: string): Promise<ScientLibraryBackupCheck> {
  const manifest = await readBoundedJson(
    NodePath.join(folder, MANIFEST_FILE),
    MAX_MANIFEST_BYTES,
    ScientLibraryBackupManifest,
  ).catch(() => null);
  if (!manifest) return { outcome: "not-a-backup" };
  const payload = NodePath.join(folder, PAYLOAD);
  const changed: string[] = [];
  for (const file of manifest.files) {
    const hash = await hashOf(NodePath.join(payload, ...file.path.split("/"))).catch(
      (error: unknown) => {
        if (isNodeError(error, "ENOENT")) return null;
        throw error;
      },
    );
    if (hash !== file.sha256) changed.push(file.path);
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  const unlisted =
    (await snapshot(payload)) === "directory"
      ? (await filesUnder(payload)).filter((path) => !listed.has(path))
      : [];
  return changed.length === 0 && unlisted.length === 0
    ? { outcome: "complete", createdAt: manifest.createdAt, counts: manifest.counts }
    : { outcome: "damaged", changed, unlisted };
}
