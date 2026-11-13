// @effect-diagnostics nodeBuiltinImport:off -- The archive is plain files in the project folder.
// @effect-diagnostics globalDate:off -- Archive manifests use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { atomicWriteJson, ensureDirectory, isNodeError, readBoundedJson } from "./storeFiles.ts";

/**
 * Sealed copies of a project's evidence from before each Library move. Nothing reads this folder
 * on its own (listing, move discovery, hydration, annotations, warming, bibliography): only an
 * explicit restore does.
 */
const SCIENT_PRE_MOVE_ARCHIVE_DIRECTORY = ".scient/library/retained-before-library";
const V1_PREFIX = ".scient/sources/";
const ANNOTATIONS_PREFIX = ".scient/annotations/v1/";
const MANIFEST_FILE = "manifest.json";
const README_FILE = "README.md";
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const ArchiveFile = Schema.Struct({
  /** Archive-relative: `sources/…` or `annotations/…`. */
  path: Schema.String,
  /** Project-relative, where it was before the move. */
  original: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Int,
});

export const ScientPreMoveArchiveManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  kind: Schema.Literal("scient-pre-move-archive"),
  archiveId: Schema.String,
  capturedAt: Schema.String,
  project: Schema.Struct({ projectId: Schema.String, title: Schema.String }),
  move: Schema.Struct({ run: Schema.Int, instanceId: Schema.String, libraryId: Schema.String }),
  counts: Schema.Struct({
    records: Schema.Int,
    revisions: Schema.Int,
    trash: Schema.Int,
    pdfs: Schema.Int,
    annotations: Schema.Int,
    reviews: Schema.Int,
    other: Schema.Int,
    bytes: Schema.Int,
  }),
  files: Schema.Array(ArchiveFile),
  /** Files the move listed that were gone when the archive was built. */
  missing: Schema.Array(Schema.String),
});
export type ScientPreMoveArchiveManifest = typeof ScientPreMoveArchiveManifest.Type;

/** Not evidence: derived or temporary, rebuilt from what is kept. */
function scientPreMoveArchiveKeeps(projectRelative: string): boolean {
  if (projectRelative.startsWith(ANNOTATIONS_PREFIX)) return true;
  if (!projectRelative.startsWith(V1_PREFIX)) return false;
  const inside = projectRelative.slice(V1_PREFIX.length);
  return !inside.startsWith("text/") && !inside.startsWith("staging/");
}

const absolute = (base: string, relative: string) => NodePath.join(base, ...relative.split("/"));

async function hashFile(filePath: string): Promise<string | null> {
  const hash = NodeCrypto.createHash("sha256");
  try {
    for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk as Buffer);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  return hash.digest("hex");
}

const SHA256_FILE = /^[0-9a-f]{64}\.json$/u;

/** Slash-separated and relative: no root, drive, backslash, NUL, empty, `.` or `..` segment. */
function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !/[\\:\0]/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/**
 * Whether a manifest entry is one the archive could have written: a payload under `sources/` or
 * `annotations/` whose original path is exactly where that payload came from. A matching hash
 * never makes another destination acceptable.
 */
function safeEntry(file: typeof ArchiveFile.Type): boolean {
  if (!safeRelative(file.path) || !safeRelative(file.original)) return false;
  if (file.path.startsWith("annotations/")) {
    const name = file.path.slice("annotations/".length);
    return SHA256_FILE.test(name) && file.original === `${ANNOTATIONS_PREFIX}${name}`;
  }
  return (
    file.path.startsWith("sources/") &&
    file.original === `${V1_PREFIX}${file.path.slice("sources/".length)}` &&
    scientPreMoveArchiveKeeps(file.original)
  );
}

/**
 * Every existing part of `relative` under `root`, the last one included, is a real folder (or, for
 * the last, a regular file when `leaf` is "file"), never a link: nothing then leads outside.
 */
async function safePath(
  root: string,
  relative: string,
  leaf: "file" | "directory",
): Promise<boolean> {
  if (!safeRelative(relative)) return false;
  const segments = relative.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = NodePath.join(current, segment);
    const stats = await NodeFSP.lstat(current).catch(() => null);
    if (!stats) return true;
    const last = index === segments.length - 1;
    if (!(last && leaf === "file" ? stats.isFile() : stats.isDirectory())) return false;
  }
  return true;
}

function payloadPath(original: string): string {
  return original.startsWith(ANNOTATIONS_PREFIX)
    ? `annotations/${original.slice(ANNOTATIONS_PREFIX.length)}`
    : `sources/${original.slice(V1_PREFIX.length)}`;
}

function countsOf(files: ReadonlyArray<typeof ArchiveFile.Type>) {
  const counts = {
    records: 0,
    revisions: 0,
    trash: 0,
    pdfs: 0,
    annotations: 0,
    reviews: 0,
    other: 0,
    bytes: 0,
  };
  for (const file of files) {
    counts.bytes += file.bytes;
    const path = file.path;
    if (path.startsWith("annotations/")) counts.annotations += 1;
    else if (path.startsWith("sources/records/")) counts.records += 1;
    else if (path.startsWith("sources/history/")) counts.revisions += 1;
    else if (path.startsWith("sources/trash/")) counts.trash += 1;
    else if (path.startsWith("sources/files/") && path.endsWith(".pdf")) counts.pdfs += 1;
    else if (path.startsWith("sources/reviews/")) counts.reviews += 1;
    else counts.other += 1;
  }
  return counts;
}

function readme(manifest: ScientPreMoveArchiveManifest): string {
  const { counts } = manifest;
  return `# Before the Library move: saved ${manifest.capturedAt}

This folder is a sealed copy of the sources of "${manifest.project.title}" as they were before
Scient moved them into the personal Library on the computer that made the move. Changes made
after that are in that computer's Library, not here.

- \`sources/\`: ${counts.records} records with ${counts.revisions} kept revisions, ${counts.trash} in the trash, ${counts.pdfs} PDFs, ${counts.reviews} reviews, collections, saved searches and bibliography copies.
- \`annotations/\`: ${counts.annotations} files of highlights and PDF notes on those PDFs.
- \`manifest.json\`: every file with its original path, size and SHA-256, and any file that was
  missing when this copy was made.

Scient never reads this folder on its own. To bring it back into the project, ask Scient's agent
to restore the copy from before the move (\`scient_sources_organize\`, action
\`restore-pre-move\`); this works on any computer. Deleting the folder frees its disk space; it
does not remove copies already committed to git.
`;
}

export interface ScientPreMoveArchiveInput {
  /** Canonical project root. */
  readonly projectRoot: string;
  readonly archiveId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly run: number;
  readonly instanceId: string;
  readonly libraryId: string;
  /** Project-relative files the move will delete; those that are not evidence are skipped. */
  readonly files: ReadonlyArray<string>;
  /** Test-only: an interrupted build. */
  readonly afterFirstFile?: () => void;
}

export interface ScientPreMoveArchiveSeal {
  /** Project-relative folder. */
  readonly path: string;
  readonly manifestSha256: string;
}

const archivePath = (archiveId: string) => `${SCIENT_PRE_MOVE_ARCHIVE_DIRECTORY}/${archiveId}`;

/** Every payload file against the manifest; the names of those changed or gone. */
async function changedFiles(
  folder: string,
  manifest: ScientPreMoveArchiveManifest,
): Promise<ReadonlyArray<string>> {
  const changed: string[] = [];
  for (const file of manifest.files) {
    if ((await hashFile(absolute(folder, file.path))) !== file.sha256) changed.push(file.path);
  }
  return changed;
}

async function readManifest(folder: string): Promise<ScientPreMoveArchiveManifest | null> {
  try {
    return await readBoundedJson(
      NodePath.join(folder, MANIFEST_FILE),
      MAX_MANIFEST_BYTES,
      ScientPreMoveArchiveManifest,
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

/**
 * Builds the archive in a hidden folder, copying each file and checking the copy's hash against
 * the original, writes the manifest and README, checks every file again and publishes the folder
 * with one rename. A rerun keeps the copies that already match. A sealed archive is never
 * written again; one whose files changed since is refused, so the move keeps the originals.
 */
export async function sealScientPreMoveArchive(
  input: ScientPreMoveArchiveInput,
): Promise<ScientPreMoveArchiveSeal> {
  if (!SAFE_ID.test(input.archiveId)) throw new Error("The archive ID is not a safe name.");
  const relative = archivePath(input.archiveId);
  const final = absolute(input.projectRoot, relative);
  const sealed = await readManifest(final);
  if (sealed) {
    if ((await changedFiles(final, sealed)).length > 0) {
      throw new Error(`Files in ${relative} changed after it was sealed; it is kept as it is.`);
    }
    return {
      path: relative,
      manifestSha256: (await hashFile(NodePath.join(final, MANIFEST_FILE)))!,
    };
  }
  const partial = absolute(
    input.projectRoot,
    `${SCIENT_PRE_MOVE_ARCHIVE_DIRECTORY}/.${input.archiveId}.partial`,
  );
  await ensureDirectory(partial);
  const files: Array<typeof ArchiveFile.Type> = [];
  const missing: string[] = [];
  for (const original of [...new Set(input.files)].filter(scientPreMoveArchiveKeeps).toSorted()) {
    const source = absolute(input.projectRoot, original);
    const sha256 = await hashFile(source);
    if (sha256 === null) {
      missing.push(original);
      continue;
    }
    const path = payloadPath(original);
    const destination = absolute(partial, path);
    if ((await hashFile(destination)) !== sha256) {
      await ensureDirectory(NodePath.dirname(destination));
      const temporary = `${destination}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.copyFile(source, temporary);
        if ((await hashFile(temporary)) !== sha256) {
          throw new Error(`${original} changed while it was archived.`);
        }
        await NodeFSP.rename(temporary, destination);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    }
    files.push({ path, original, sha256, bytes: (await NodeFSP.stat(destination)).size });
    if (files.length === 1) input.afterFirstFile?.();
  }
  const manifest: ScientPreMoveArchiveManifest = {
    formatVersion: 1,
    kind: "scient-pre-move-archive",
    archiveId: input.archiveId,
    capturedAt: new Date().toISOString(),
    project: { projectId: input.projectId, title: input.projectTitle },
    move: { run: input.run, instanceId: input.instanceId, libraryId: input.libraryId },
    counts: countsOf(files),
    files,
    missing,
  };
  await NodeFSP.writeFile(NodePath.join(partial, README_FILE), readme(manifest), "utf8");
  await atomicWriteJson(NodePath.join(partial, MANIFEST_FILE), manifest, MAX_MANIFEST_BYTES);
  const changed = await changedFiles(partial, manifest);
  if (changed.length > 0) throw new Error(`${changed[0]} changed while it was archived.`);
  await NodeFSP.rename(partial, final);
  return { path: relative, manifestSha256: (await hashFile(NodePath.join(final, MANIFEST_FILE)))! };
}

export interface ScientPreMoveArchiveSummary {
  readonly archiveId: string;
  readonly capturedAt: string;
  readonly counts: ScientPreMoveArchiveManifest["counts"];
}

/** The project's sealed archives, newest first. Reads only their manifests. */
async function listScientPreMoveArchives(
  projectRoot: string,
): Promise<ReadonlyArray<ScientPreMoveArchiveSummary>> {
  const folder = absolute(projectRoot, SCIENT_PRE_MOVE_ARCHIVE_DIRECTORY);
  if (!(await safePath(projectRoot, SCIENT_PRE_MOVE_ARCHIVE_DIRECTORY, "directory"))) return [];
  let entries: NodeFS.Dirent[];
  try {
    entries = await NodeFSP.readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const archives: ScientPreMoveArchiveSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = `${SCIENT_PRE_MOVE_ARCHIVE_DIRECTORY}/${entry.name}/${MANIFEST_FILE}`;
    if (!(await safePath(projectRoot, manifestPath, "file"))) continue;
    const manifest = await readManifest(NodePath.join(folder, entry.name)).catch(() => null);
    if (manifest?.archiveId === entry.name) {
      archives.push({
        archiveId: manifest.archiveId,
        capturedAt: manifest.capturedAt,
        counts: manifest.counts,
      });
    }
  }
  return archives.toSorted((left, right) => (left.capturedAt < right.capturedAt ? 1 : -1));
}

const RESTORE_PROGRESS = ".scient/library/restore-progress.json";
const RESTORE_STAGING = ".scient/library/.restoring-archive";
const PROJECT_STORE = ".scient/sources";

/** Written before the restored store is published; a retry with it finishes the highlights. */
const RestoreProgress = Schema.Struct({
  formatVersion: Schema.Literal(1),
  archiveId: Schema.String,
  manifestSha256: Schema.String,
});

async function readRestoreProgress(projectRoot: string) {
  if (!(await safePath(projectRoot, RESTORE_PROGRESS, "file"))) {
    throw new ScientPreMoveRestorePendingError(`${RESTORE_PROGRESS} is not a plain file.`);
  }
  try {
    return await readBoundedJson(absolute(projectRoot, RESTORE_PROGRESS), 4096, RestoreProgress);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw new ScientPreMoveRestorePendingError(`${RESTORE_PROGRESS} cannot be read.`);
  }
}

/** A restore that stopped part way cannot finish; the move waits until it does or is abandoned. */
// @effect-diagnostics-next-line extendsNativeError:off - The source stores are Promise-based; callers catch native errors.
export class ScientPreMoveRestorePendingError extends Error {
  constructor(reason: string) {
    super(
      `A restore of this project's copy from before the Library move stopped part way and cannot finish: ${reason} Its sources stay out of the Library until the copy is repaired and the restore is run again, or the unfinished restore is abandoned (scient_sources_organize, restore-pre-move with abandon).`,
    );
    this.name = "ScientPreMoveRestorePendingError";
  }
}

/** Test-only: replaces the copy of one archived file to its temporary destination. */
export interface ScientPreMoveRestoreFaults {
  readonly copyFile?: (from: string, to: string) => Promise<void>;
}

/** The project-relative paths a restore reads, deletes or writes that are not plain folders. */
async function unsafeRestorePaths(
  projectRoot: string,
  relative: string,
  manifest: ScientPreMoveArchiveManifest,
): Promise<ReadonlyArray<string>> {
  const unsafe: string[] = [];
  for (const file of manifest.files) {
    if (
      !safeEntry(file) ||
      !(await safePath(projectRoot, `${relative}/${file.path}`, "file")) ||
      !(await safePath(projectRoot, file.original, "file"))
    ) {
      unsafe.push(file.path);
    }
  }
  const places = [
    [`${RESTORE_STAGING}/${manifest.archiveId}`, "directory"],
    [RESTORE_PROGRESS, "file"],
    [PROJECT_STORE, "directory"],
  ] as const;
  for (const [place, leaf] of places) {
    if (!(await safePath(projectRoot, place, leaf))) unsafe.push(place);
  }
  return unsafe;
}

/**
 * Copies through a fresh temporary file in the destination's folder, checks it, then publishes it
 * only where nothing is: a file at `destination` is never a part-written copy. False when one was
 * already there.
 */
async function publishCopy(
  from: string,
  destination: string,
  sha256: string,
  faults: ScientPreMoveRestoreFaults | undefined,
): Promise<boolean> {
  await ensureDirectory(NodePath.dirname(destination));
  const temporary = NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await (faults?.copyFile ?? NodeFSP.copyFile)(from, temporary);
    if ((await hashFile(temporary)) !== sha256) {
      throw new Error(`${NodePath.basename(destination)} did not copy back whole.`);
    }
    try {
      await NodeFSP.link(temporary, destination);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      // Folders without hard links: the gap between this check and the rename is the only race.
      if ((await NodeFSP.lstat(destination).catch(() => null)) !== null) return false;
      await NodeFSP.rename(temporary, destination);
    }
    return true;
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export type ScientPreMoveArchiveRestore =
  | {
      readonly outcome: "restored";
      readonly archiveId: string;
      readonly restoredSources: number;
      readonly restoredPdfs: number;
      /** Highlight files the project already had, kept as they are. */
      readonly keptAnnotations: number;
    }
  | { readonly outcome: "no-archive" }
  /** `.scient/sources` holds files; nothing is written over them. */
  | { readonly outcome: "project-store-present" }
  /**
   * Files changed since the archive was sealed, entries that name no place it could restore, or
   * places on the way that are links rather than folders.
   */
  | { readonly outcome: "archive-changed"; readonly files: ReadonlyArray<string> };

/**
 * Puts an archive's sources back at `.scient/sources` and its highlights where they were, after
 * checking every path it reads, deletes or writes and every archived file; needs no move journal,
 * so any computer can. A stopped restore resumes from its progress record. The caller holds the
 * project's move and pins locks.
 */
export async function restoreScientPreMoveArchive(input: {
  readonly projectRoot: string;
  readonly archiveId?: string;
  readonly storePresent: () => Promise<boolean>;
  readonly faults?: ScientPreMoveRestoreFaults;
}): Promise<ScientPreMoveArchiveRestore> {
  const archiveId =
    input.archiveId ?? (await listScientPreMoveArchives(input.projectRoot))[0]?.archiveId;
  if (!archiveId || !SAFE_ID.test(archiveId)) return { outcome: "no-archive" };
  const relative = archivePath(archiveId);
  if (!(await safePath(input.projectRoot, `${relative}/${MANIFEST_FILE}`, "file"))) {
    return { outcome: "archive-changed", files: [MANIFEST_FILE] };
  }
  const folder = absolute(input.projectRoot, relative);
  const manifest = await readManifest(folder);
  if (!manifest) return { outcome: "no-archive" };
  if (manifest.archiveId !== archiveId) {
    return { outcome: "archive-changed", files: [MANIFEST_FILE] };
  }
  const unsafe = await unsafeRestorePaths(input.projectRoot, relative, manifest);
  if (unsafe.length > 0) return { outcome: "archive-changed", files: unsafe };
  const changed = await changedFiles(folder, manifest);
  if (changed.length > 0) return { outcome: "archive-changed", files: changed };
  const manifestSha256 = (await hashFile(NodePath.join(folder, MANIFEST_FILE)))!;
  const progress = await readRestoreProgress(input.projectRoot);
  const resuming = progress?.archiveId === archiveId && progress.manifestSha256 === manifestSha256;
  if (!resuming && (await input.storePresent())) return { outcome: "project-store-present" };

  if (!resuming || !(await input.storePresent())) {
    const staging = absolute(input.projectRoot, `${RESTORE_STAGING}/${archiveId}`);
    await NodeFSP.rm(staging, { recursive: true, force: true });
    for (const file of manifest.files.filter((entry) => entry.path.startsWith("sources/"))) {
      const destination = absolute(staging, file.path.slice("sources/".length));
      if (
        !(await publishCopy(absolute(folder, file.path), destination, file.sha256, input.faults))
      ) {
        throw new Error(`${file.path} is listed twice.`);
      }
    }
    await atomicWriteJson(
      absolute(input.projectRoot, RESTORE_PROGRESS),
      { formatVersion: 1, archiveId, manifestSha256 },
      4096,
    );
    const store = absolute(input.projectRoot, PROJECT_STORE);
    // An empty folder left by the move's cleanup is replaced; files there were refused above.
    await NodeFSP.rm(store, { recursive: true, force: true });
    await ensureDirectory(NodePath.dirname(store));
    await NodeFSP.rename(staging, store);
    await NodeFSP.rm(absolute(input.projectRoot, RESTORE_STAGING), {
      recursive: true,
      force: true,
    });
  }
  let keptAnnotations = 0;
  for (const file of manifest.files.filter((entry) => entry.path.startsWith("annotations/"))) {
    const destination = absolute(input.projectRoot, file.original);
    if (await publishCopy(absolute(folder, file.path), destination, file.sha256, input.faults)) {
      continue;
    }
    // Published whole by an earlier attempt, or the project's own: that one is kept.
    if ((await hashFile(destination)) !== file.sha256) keptAnnotations += 1;
  }
  await NodeFSP.rm(absolute(input.projectRoot, RESTORE_PROGRESS), { force: true });
  return {
    outcome: "restored",
    archiveId,
    restoredSources: manifest.counts.records,
    restoredPdfs: manifest.counts.pdfs,
    keptAnnotations,
  };
}

/**
 * Finishes a restore that stopped after publishing its store (its highlights are missing), so a
 * move never takes in half of it. One that cannot finish, its archive changed or gone, throws and
 * keeps its progress record: only a repaired archive or an explicit abandon lets the move go on.
 */
export async function finishScientPreMoveRestore(input: {
  readonly projectRoot: string;
  readonly storePresent: () => Promise<boolean>;
}): Promise<void> {
  const progress = await readRestoreProgress(input.projectRoot);
  if (!progress) return;
  const result = await restoreScientPreMoveArchive({ ...input, archiveId: progress.archiveId });
  switch (result.outcome) {
    case "restored":
      return;
    case "no-archive":
      throw new ScientPreMoveRestorePendingError(`the copy ${progress.archiveId} is gone.`);
    case "project-store-present":
      throw new ScientPreMoveRestorePendingError(
        `the copy ${progress.archiveId} changed after its restore began.`,
      );
    case "archive-changed":
      throw new ScientPreMoveRestorePendingError(
        `in the copy ${progress.archiveId}, ${result.files.slice(0, 3).join(", ")} changed or cannot be used.`,
      );
  }
}

/**
 * Drops an unfinished restore's progress record, so the next move takes in what it published.
 * The person's explicit choice; the caller holds the project's move and pins locks.
 */
export async function abandonScientPreMoveRestore(
  projectRoot: string,
): Promise<"dismissed" | "nothing-to-dismiss"> {
  if (!(await safePath(projectRoot, RESTORE_PROGRESS, "file"))) {
    throw new ScientPreMoveRestorePendingError(`${RESTORE_PROGRESS} is not a plain file.`);
  }
  const path = absolute(projectRoot, RESTORE_PROGRESS);
  if ((await NodeFSP.lstat(path).catch(() => null)) === null) return "nothing-to-dismiss";
  await NodeFSP.rm(path, { force: true });
  return "dismissed";
}
