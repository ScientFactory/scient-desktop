// @effect-diagnostics nodeBuiltinImport:off -- The move copies a project's Sources files into the personal library.
// @effect-diagnostics globalDate:off -- Journals and project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { assignCitationKey, citationKeyComparisonValue } from "./citationKeys.ts";
import { scientSourceCollectionsInternals } from "./collections.ts";
import {
  readLibraryAliasesAt,
  resolveScientLibraryAlias,
  type ScientLibraryAliases,
} from "./libraryAliases.ts";
import {
  recordScientProjectSourceMappings,
  resolveScientProjectSources,
} from "./libraryInstanceMap.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import { markScientLibrarySourcesDistinct, mergeScientLibraryDuplicates } from "./libraryMerge.ts";
import {
  decodeScientReviewSnapshotText,
  scientReviewNamedIds,
  scientReviewSnapshotText,
  scientReviewWorkFromRecord,
  scientReviewWorksEqual,
  type ScientReviewWork,
} from "./libraryReviews.ts";
import {
  listScientLibraryInstances,
  readScientLibraryManifest,
  registerScientLibraryInstance,
  type ScientLibraryLocation,
} from "./libraryRoot.ts";
import {
  ScientSourceCollectionsDocument,
  type ScientSourceCollection,
  type ScientSourceSavedSearch,
} from "./organize.ts";
import {
  ScientSourceTrashEntry,
  type ScientSourceActor,
  type ScientSourceRecord,
} from "./model.ts";
import { assertScientProjectDirectory } from "./projectFiles.ts";
import {
  decodeScientProjectPinsText,
  joinScientProjectPinsText,
  scientPinWorkFromRecord,
  scientProjectPinsText,
  type ScientProjectPin,
} from "./projectPins.ts";
import {
  decodePersistedScientSourceRecord,
  inspectScientSources,
  SCIENT_SOURCES_DIRECTORY,
  scientSourceIdFor,
  scientSourceStoreInternals,
} from "./store.ts";
import {
  assertSafeIdentifier,
  atomicWriteJson,
  ensureDirectory,
  isNodeError,
} from "./storeFiles.ts";
import { ScientSystematicReview } from "./systematicReview.ts";

const MIGRATIONS_DIRECTORY = "migrations";
const JOURNAL_FILE = "journal.json";
const PROJECT_LIBRARY_DIRECTORY = ".scient/library";
const PROJECT_STAGING_DIRECTORY = ".scient/library/.staging";
const PROJECT_ANNOTATIONS_DIRECTORY = ".scient/annotations/v1";
const LIBRARY_ANNOTATIONS_DIRECTORY = "annotations/v1";
const BIBLIOGRAPHY_FILES = ["references.bib", "references.json"] as const;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ANNOTATION_PATHS = 16;
/** An import another process touched this recently is still running; the move waits for it. */
const RUNNING_IMPORT_MS = 10 * 60 * 1000;
const PUBLISH_ATTEMPTS = 4;
const SHA256 = /^[0-9a-f]{64}$/u;

const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());
const Sha256 = Schema.String.check(Schema.isPattern(SHA256));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ScientLibraryMoveState = Schema.Literals([
  "copying",
  "prepared",
  "committed",
  "cleanup",
  "done",
  /** "Move back into this project" ran; nothing moves this checkout again on its own. */
  "moved-back",
]);
export type ScientLibraryMoveState = typeof ScientLibraryMoveState.Type;

const MoveArtifact = Schema.Struct({
  /** Project-relative, slash-separated destination. */
  path: NonEmptyString,
  kind: Schema.Literals([
    "review",
    "snapshot",
    "bibliography",
    "pins",
    "review-conflict",
    "snapshot-conflict",
  ]),
  plan: Schema.Literals(["create", "keep", "replace", "conflict-copy"]),
  /** File name in this run's staging folder. */
  staged: NonEmptyString,
  stagedSha256: Sha256,
  /** The destination's hash when staged; null when it was absent. */
  destinationSha256: Schema.NullOr(Sha256),
  /** The v1 file this artifact stands for, which cleanup may delete once it verifies. */
  v1Path: Schema.optionalKey(NonEmptyString),
  reviewId: Schema.optionalKey(NonEmptyString),
});
type MoveArtifact = typeof MoveArtifact.Type;

const MovedSource = Schema.Struct({
  projectSourceId: NonEmptyString,
  sourceId: NonEmptyString,
  identity: Schema.Literals(["copied", "same", "older", "newer", "diverged", "removed"]),
});
type MovedSource = typeof MovedSource.Type;

export const ScientLibraryMoveJournal = Schema.Struct({
  formatVersion: Schema.Literal(1),
  instanceId: NonEmptyString,
  projectId: NonEmptyString,
  /** Starts at 1; a new run after an older Scient wrote `.scient/sources` again adds one. */
  run: Schema.Int.check(Schema.isGreaterThan(0)),
  runId: NonEmptyString,
  state: ScientLibraryMoveState,
  startedAt: NonEmptyString,
  updatedAt: NonEmptyString,
  sources: Schema.Array(MovedSource),
  pdfs: Schema.Array(Sha256),
  annotations: Schema.Array(Sha256),
  artifacts: Schema.Array(MoveArtifact),
  /** v1 files still to delete, project-relative. */
  cleanup: Schema.Array(NonEmptyString),
  /** v1 files that could not be deleted (a PDF open on Windows); retried on the next open. */
  retry: Schema.Array(NonEmptyString),
  merges: Schema.Struct({ merged: Count, keptDifferent: Count }),
  reviewConflicts: Schema.Array(NonEmptyString),
  divergedSources: Count,
  gitTracked: Schema.Boolean,
});
export type ScientLibraryMoveJournal = typeof ScientLibraryMoveJournal.Type;

/** Test-only faults, so each crash point and the Windows-only paths run on every platform. */
export interface ScientLibraryMoveFaults {
  readonly crashAt?:
    | "after-library-copy"
    | "after-verify"
    | "after-stage"
    | "after-prepared"
    | "after-pins-published"
    | "mid-cleanup";
  /** The volume refuses hard links (FAT, some network and Windows volumes). */
  readonly refuseLinks?: boolean;
  /** With `refuseLinks`, the copy fallback of `pins.json` stops halfway. */
  readonly interruptPinsCopy?: boolean;
  /** A file another program holds open, which Windows refuses to delete. */
  readonly undeletable?: (projectRelativePath: string) => boolean;
}

// @effect-diagnostics-next-line extendsNativeError:off - The source stores are Promise-based; callers catch native errors.
export class ScientLibraryMoveCrash extends Error {
  constructor(point: string) {
    super(`Simulated crash at ${point}.`);
    this.name = "ScientLibraryMoveCrash";
  }
}

export type ScientLibraryMoveOutcome =
  /** The library holds the project's Sources and its v1 files are gone (or listed for retry). */
  | "moved"
  /** No v1 store here: never had Sources, or already moved. */
  | "not-needed"
  /** An import in another process is still running; v1 stays the truth until it settles. */
  | "waiting-import"
  /** This checkout was moved back; the move does not run again on its own. */
  | "moved-back";

export interface ScientLibraryMoveResult {
  readonly outcome: ScientLibraryMoveOutcome;
  readonly journal: ScientLibraryMoveJournal | null;
}

interface MoveContext {
  readonly root: string;
  readonly projectId: string;
  readonly title: string;
  readonly library: ScientLibraryLocation;
  readonly libraryRoot: string;
  readonly libraryId: string;
  readonly instanceId: string;
  readonly actor: ScientSourceActor;
  readonly faults: ScientLibraryMoveFaults;
  readonly gitTracked: () => Promise<boolean>;
}

const decodeJournal = Schema.decodeUnknownSync(ScientLibraryMoveJournal);
const decodeReview = Schema.decodeUnknownSync(ScientSystematicReview);
const decodeTrashEntry = Schema.decodeUnknownSync(ScientSourceTrashEntry);
const decodeCollections = Schema.decodeUnknownSync(ScientSourceCollectionsDocument);
const { sourceStorePaths, maxRecordBytes } = scientSourceStoreInternals;

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
const sha256Of = (bytes: Buffer | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const formatJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const absolute = (base: string, relative: string) => NodePath.join(base, ...relative.split("/"));

function crash(ctx: MoveContext, point: NonNullable<ScientLibraryMoveFaults["crashAt"]>): void {
  if (ctx.faults.crashAt === point) throw new ScientLibraryMoveCrash(point);
}

/** Sorted keys at every level, so equal content compares equal whatever order wrote it. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type StoredRecord = ScientSourceRecord & {
  readonly readingStatus?: string;
  readonly starred?: boolean;
};

/** What a record says, apart from where it is stored, its note and personal reading state. */
function recordContent(record: StoredRecord): string {
  const {
    formatVersion: _version,
    projectId: _project,
    sourceId: _source,
    note: _note,
    readingStatus: _reading,
    starred: _starred,
    ...content
  } = record;
  return stableJson(content);
}

/** The library form of a v1 record: no project, the note moved to the pin, unread. */
function toLibraryRecord(record: ScientSourceRecord, sourceId = record.sourceId) {
  const { projectId: _project, note: _note, ...rest } = record;
  return { ...rest, formatVersion: 2 as const, sourceId, readingStatus: "unread", starred: false };
}

async function readRegularFile(filePath: string): Promise<Buffer | null> {
  try {
    const stats = await NodeFSP.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    return await NodeFSP.readFile(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  return NodeFSP.lstat(filePath).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    },
  );
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    const stats = await NodeFSP.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  const digest = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

/** Regular files under a folder, slash-separated and relative to it. Links are never followed. */
async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (folder: string, prefix: string) => {
    let entries: NodeFS.Dirent[];
    try {
      entries = await NodeFSP.readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return;
      throw error;
    }
    for (const entry of entries.toSorted((left, right) => (left.name < right.name ? -1 : 1))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(NodePath.join(folder, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  await walk(directory, "");
  return files;
}

async function removeEmptyDirectories(directory: string): Promise<void> {
  let entries: NodeFS.Dirent[];
  try {
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(NodePath.join(directory, entry.name));
  }
  await NodeFSP.rmdir(directory).catch((error: unknown) => {
    if (!isNodeError(error, "ENOTEMPTY") && !isNodeError(error, "ENOENT")) throw error;
  });
}

/**
 * Publishes bytes with an exclusive create: a synced temporary file, then a hard link, or an
 * exclusive copy where links are refused. False when the destination already exists.
 */
async function createExclusive(
  ctx: MoveContext,
  filePath: string,
  bytes: Buffer,
  options: { readonly pins?: boolean } = {},
): Promise<boolean> {
  await ensureDirectory(NodePath.dirname(filePath));
  const temporary = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (ctx.faults.refuseLinks) {
        throw Object.assign(new Error("Links are refused."), { code: "EPERM" });
      }
      await NodeFSP.link(temporary, filePath);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      if (!isNodeError(error, "EPERM") && !isNodeError(error, "ENOTSUP")) throw error;
      if (options.pins && ctx.faults.interruptPinsCopy) {
        await NodeFSP.writeFile(filePath, bytes.subarray(0, Math.floor(bytes.length / 2)), {
          flag: "wx",
        });
        throw new ScientLibraryMoveCrash("pins copy fallback");
      }
      try {
        await NodeFSP.copyFile(temporary, filePath, NodeFSP.constants.COPYFILE_EXCL);
        return true;
      } catch (copyError) {
        if (isNodeError(copyError, "EEXIST")) return false;
        throw copyError;
      }
    }
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

async function replaceAtomically(filePath: string, bytes: Buffer): Promise<void> {
  await ensureDirectory(NodePath.dirname(filePath));
  const temporary = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, filePath);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

const createJson = (ctx: MoveContext, filePath: string, value: unknown) =>
  createExclusive(ctx, filePath, Buffer.from(formatJson(value), "utf8"));

function migrationDirectory(ctx: Pick<MoveContext, "libraryRoot" | "instanceId">): string {
  assertSafeIdentifier(ctx.instanceId, "Instance ID");
  return NodePath.join(ctx.libraryRoot, MIGRATIONS_DIRECTORY, ctx.instanceId);
}

function backupDirectory(ctx: MoveContext, run: number): string {
  return NodePath.join(migrationDirectory(ctx), "v1", String(run));
}

async function readJournalAt(directory: string): Promise<ScientLibraryMoveJournal | null> {
  const bytes = await readRegularFile(NodePath.join(directory, JOURNAL_FILE));
  if (!bytes) return null;
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error("The move journal is too large.");
  return decodeJournal(JSON.parse(bytes.toString("utf8")));
}

async function writeJournal(
  ctx: MoveContext,
  journal: ScientLibraryMoveJournal,
): Promise<ScientLibraryMoveJournal> {
  const next = { ...journal, updatedAt: now() };
  await atomicWriteJson(
    NodePath.join(migrationDirectory(ctx), JOURNAL_FILE),
    next,
    MAX_JOURNAL_BYTES,
  );
  return next;
}

function freshJournal(ctx: MoveContext, run: number): ScientLibraryMoveJournal {
  const at = now();
  return {
    formatVersion: 1,
    instanceId: ctx.instanceId,
    projectId: ctx.projectId,
    run,
    runId: newId("move"),
    state: "copying",
    startedAt: at,
    updatedAt: at,
    sources: [],
    pdfs: [],
    annotations: [],
    artifacts: [],
    cleanup: [],
    retry: [],
    merges: { merged: 0, keptDifferent: 0 },
    reviewConflicts: [],
    divergedSources: 0,
    gitTracked: false,
  };
}

interface V1Record {
  readonly record: ScientSourceRecord;
  readonly history: ReadonlyMap<number, ScientSourceRecord>;
}

interface V1Store {
  readonly files: ReadonlyArray<string>;
  readonly records: ReadonlyArray<V1Record>;
  readonly trash: ReadonlyArray<ScientSourceTrashEntry>;
  readonly reviews: ReadonlyArray<{
    readonly path: string;
    readonly bytes: Buffer;
    readonly review: ScientSystematicReview;
  }>;
  readonly collections: ScientSourceCollectionsDocument | null;
}

const v1Base = (ctx: Pick<MoveContext, "root">) => absolute(ctx.root, SCIENT_SOURCES_DIRECTORY);
const v1Relative = (path: string) => `${SCIENT_SOURCES_DIRECTORY}/${path}`;

async function readV1Json(ctx: MoveContext, relative: string): Promise<unknown> {
  const bytes = await readRegularFile(absolute(v1Base(ctx), relative));
  if (!bytes || bytes.length > MAX_JSON_BYTES) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

function ownRecord(ctx: MoveContext, value: unknown, sourceId: string): ScientSourceRecord | null {
  try {
    const record = decodePersistedScientSourceRecord(value);
    return record.formatVersion === 1 &&
      record.projectId === ctx.projectId &&
      record.sourceId === sourceId
      ? record
      : null;
  } catch {
    return null;
  }
}

/** Reads what can be moved. A file that does not decode is not moved; it goes to the backup. */
async function readV1Store(ctx: MoveContext): Promise<V1Store> {
  const files = await listFiles(v1Base(ctx));
  const historyFiles = new Map<
    string,
    Array<{ readonly file: string; readonly revision: number }>
  >();
  for (const file of files) {
    const match = /^history\/([^/]+)\/(\d+)\.json$/u.exec(file);
    if (!match) continue;
    const entries = historyFiles.get(match[1]!) ?? [];
    entries.push({ file, revision: Number.parseInt(match[2]!, 10) });
    historyFiles.set(match[1]!, entries);
  }
  const records: V1Record[] = [];
  const trash: ScientSourceTrashEntry[] = [];
  const reviews: Array<V1Store["reviews"][number]> = [];
  for (const file of files) {
    const recordMatch = /^records\/([^/]+)\.json$/u.exec(file);
    if (recordMatch) {
      const record = ownRecord(ctx, await readV1Json(ctx, file), recordMatch[1]!);
      if (!record) continue;
      const history = new Map<number, ScientSourceRecord>();
      for (const { file: entry, revision } of historyFiles.get(record.sourceId) ?? []) {
        const old = ownRecord(ctx, await readV1Json(ctx, entry), record.sourceId);
        if (old && old.revision === revision) history.set(revision, old);
      }
      records.push({ record, history });
      continue;
    }
    if (/^trash\/[^/]+\.json$/u.test(file)) {
      try {
        const entry = decodeTrashEntry(await readV1Json(ctx, file));
        if (entry.projectId === ctx.projectId) trash.push(entry);
      } catch {
        // Kept in the backup only.
      }
      continue;
    }
    const reviewMatch = /^reviews\/([^/]+)\.json$/u.exec(file);
    if (reviewMatch) {
      const bytes = await readRegularFile(absolute(v1Base(ctx), file));
      if (!bytes) continue;
      try {
        const review = decodeReview(JSON.parse(bytes.toString("utf8")));
        if (review.reviewId === reviewMatch[1]) {
          reviews.push({ path: v1Relative(file), bytes, review });
        }
      } catch {
        // Kept in the backup only.
      }
    }
  }
  let collections: ScientSourceCollectionsDocument | null = null;
  if (files.includes("collections.json")) {
    try {
      collections = decodeCollections(await readV1Json(ctx, "collections.json"));
    } catch {
      collections = null;
    }
  }
  return { files, records, trash, reviews, collections };
}

/** The project still has a v1 store when any regular file is left under `.scient/sources`. */
async function v1StorePresent(root: string): Promise<boolean> {
  const directory = absolute(root, SCIENT_SOURCES_DIRECTORY);
  const stack = [directory];
  while (stack.length > 0) {
    const folder = stack.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = await NodeFSP.readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory()) stack.push(NodePath.join(folder, entry.name));
    }
  }
  return false;
}

interface LibraryFiles {
  readonly records: string;
  readonly history: string;
  readonly trash: string;
  readonly zotero: string;
  readonly files: string;
  readonly text: string;
  readonly annotations: string;
}

function libraryFiles(ctx: MoveContext): LibraryFiles {
  return {
    records: NodePath.join(ctx.libraryRoot, "records"),
    history: NodePath.join(ctx.libraryRoot, "history"),
    trash: NodePath.join(ctx.libraryRoot, "trash"),
    zotero: NodePath.join(ctx.libraryRoot, "zotero"),
    files: NodePath.join(ctx.libraryRoot, "files", "sha256"),
    text: NodePath.join(ctx.libraryRoot, "text", "sha256"),
    annotations: absolute(ctx.libraryRoot, LIBRARY_ANNOTATIONS_DIRECTORY),
  };
}

async function readLibraryRecord(
  ctx: MoveContext,
  sourceId: string,
): Promise<ScientSourceRecord | null> {
  assertSafeIdentifier(sourceId, "Source ID");
  const bytes = await readRegularFile(NodePath.join(libraryFiles(ctx).records, `${sourceId}.json`));
  if (!bytes) return null;
  const record = decodePersistedScientSourceRecord(JSON.parse(bytes.toString("utf8")));
  if (record.formatVersion !== 2 || record.sourceId !== sourceId) {
    throw new Error("A library record has an inconsistent identity.");
  }
  return record;
}

async function readLibraryHistory(
  ctx: MoveContext,
  sourceId: string,
  revision: number,
): Promise<ScientSourceRecord | null> {
  const bytes = await readRegularFile(
    NodePath.join(libraryFiles(ctx).history, sourceId, `${revision}.json`),
  );
  if (!bytes) return null;
  try {
    return decodePersistedScientSourceRecord(JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
}

async function readLibraryTrash(
  ctx: MoveContext,
  sourceId: string,
): Promise<ScientSourceTrashEntry | null> {
  const bytes = await readRegularFile(NodePath.join(libraryFiles(ctx).trash, `${sourceId}.json`));
  if (!bytes) return null;
  try {
    return decodeTrashEntry(JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
}

type Lineage = "same" | "older" | "newer" | "diverged";

/** The four identity-check rows of "Copies of one project". */
async function lineage(
  ctx: MoveContext,
  library: ScientSourceRecord,
  incoming: V1Record,
): Promise<Lineage> {
  const theirs = incoming.record;
  if (library.revision === theirs.revision && recordContent(library) === recordContent(theirs)) {
    return "same";
  }
  if (library.revision > theirs.revision) {
    const kept = await readLibraryHistory(ctx, library.sourceId, theirs.revision);
    if (kept && recordContent(kept) === recordContent(theirs)) return "older";
  }
  if (theirs.revision > library.revision) {
    const kept = incoming.history.get(library.revision);
    if (kept && recordContent(kept) === recordContent(library)) return "newer";
  }
  return "diverged";
}

/** Creates history files that are missing; an existing file with the same number is never touched. */
async function copyHistory(
  ctx: MoveContext,
  sourceId: string,
  history: ReadonlyMap<number, ScientSourceRecord>,
  above = 0,
): Promise<void> {
  for (const [revision, record] of history) {
    if (revision <= above) continue;
    await createJson(
      ctx,
      NodePath.join(libraryFiles(ctx).history, sourceId, `${revision}.json`),
      toLibraryRecord(record, sourceId),
    );
  }
}

/** A later copy of the same lineage: its revisions become the library's next revisions. */
async function applyNewer(
  ctx: MoveContext,
  library: ScientSourceRecord,
  incoming: V1Record,
): Promise<void> {
  const files = libraryFiles(ctx);
  await createJson(
    ctx,
    NodePath.join(files.history, library.sourceId, `${library.revision}.json`),
    library,
  );
  await copyHistory(ctx, library.sourceId, incoming.history, library.revision);
  const current: StoredRecord = library;
  await atomicWriteJson(
    NodePath.join(files.records, `${library.sourceId}.json`),
    {
      ...toLibraryRecord(incoming.record, library.sourceId),
      readingStatus: current.readingStatus ?? "unread",
      starred: current.starred ?? false,
    },
    maxRecordBytes,
  );
}

/** A copy that diverged: the same project source, imported again under an ID of its own. */
async function importDiverged(
  ctx: MoveContext,
  incoming: V1Record,
  against: string,
): Promise<MovedSource> {
  const projectSourceId = incoming.record.sourceId;
  const sourceId = scientSourceIdFor(
    ctx.libraryId,
    `moved-copy:${ctx.instanceId}:${projectSourceId}`,
  );
  const existing = await readLibraryRecord(ctx, sourceId);
  if (existing) {
    const relation = await lineage(ctx, existing, incoming);
    if (relation === "newer") await applyNewer(ctx, existing, incoming);
  } else {
    const created = await createJson(
      ctx,
      NodePath.join(libraryFiles(ctx).records, `${sourceId}.json`),
      toLibraryRecord(incoming.record, sourceId),
    );
    if (!created) return importDiverged(ctx, incoming, against);
    await copyHistory(ctx, sourceId, incoming.history);
  }
  await markScientLibrarySourcesDistinct({
    library: ctx.library,
    sourceIds: [against, sourceId],
    reason: "divergent-copies",
    actor: ctx.actor,
  });
  return { projectSourceId, sourceId, identity: "diverged" };
}

/** Copies one v1 record, or finds it already there. Never overwrites a record or history file. */
async function settleRecord(
  ctx: MoveContext,
  incoming: V1Record,
  aliases: ScientLibraryAliases,
): Promise<MovedSource> {
  const projectSourceId = incoming.record.sourceId;
  const library = await readLibraryRecord(ctx, projectSourceId);
  if (!library) {
    // Merged away after an earlier run copied it: the survivor holds it now.
    const survivor = resolveScientLibraryAlias(aliases, projectSourceId);
    if (survivor !== projectSourceId) {
      return { projectSourceId, sourceId: survivor, identity: "same" };
    }
    const trashed = await readLibraryTrash(ctx, projectSourceId);
    if (trashed) {
      const relation = await lineage(ctx, trashed.record, incoming);
      if (relation === "same" || relation === "older") {
        return { projectSourceId, sourceId: projectSourceId, identity: "removed" };
      }
      return importDiverged(ctx, incoming, projectSourceId);
    }
    const created = await createJson(
      ctx,
      NodePath.join(libraryFiles(ctx).records, `${projectSourceId}.json`),
      toLibraryRecord(incoming.record),
    );
    if (!created) return settleRecord(ctx, incoming, aliases);
    await copyHistory(ctx, projectSourceId, incoming.history);
    return { projectSourceId, sourceId: projectSourceId, identity: "copied" };
  }
  const relation = await lineage(ctx, library, incoming);
  if (relation === "same" || relation === "older") {
    return { projectSourceId, sourceId: projectSourceId, identity: relation };
  }
  if (relation === "newer") {
    await applyNewer(ctx, library, incoming);
    return { projectSourceId, sourceId: projectSourceId, identity: "newer" };
  }
  return importDiverged(ctx, incoming, projectSourceId);
}

/** Copies one file into the library unless that path exists; content-addressed files compare. */
async function copyByHash(
  ctx: MoveContext,
  source: string,
  destination: string,
  expectedSha256: string | null,
): Promise<"copied" | "present" | "damaged"> {
  const existing = await hashFile(destination);
  if (existing !== null) {
    if (expectedSha256 && existing !== expectedSha256) {
      throw new Error("The library holds a damaged copy of a PDF.");
    }
    return "present";
  }
  await ensureDirectory(NodePath.dirname(destination));
  // Beside the destination, so the final link never crosses volumes.
  const temporary = `${destination}.tmp-${NodeCrypto.randomUUID()}`;
  try {
    await NodeFSP.copyFile(source, temporary, NodeFSP.constants.COPYFILE_EXCL);
    const handle = await NodeFSP.open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const copied = await hashFile(temporary);
    if (expectedSha256 && copied !== expectedSha256) return "damaged";
    try {
      if (ctx.faults.refuseLinks) {
        throw Object.assign(new Error("Links are refused."), { code: "EPERM" });
      }
      await NodeFSP.link(temporary, destination);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return "present";
      if (!isNodeError(error, "EPERM") && !isNodeError(error, "ENOTSUP")) throw error;
      try {
        await NodeFSP.copyFile(temporary, destination, NodeFSP.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (isNodeError(copyError, "EEXIST")) return "present";
        throw copyError;
      }
    }
    return "copied";
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

const PDF_FILE = /^files\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.pdf$/u;
const TEXT_FILE = /^text\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/u;
const ZOTERO_FILE = /^sync\/zotero\/([^/]+)\.json$/u;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function annotationFile(value: unknown, sha256: string): JsonObject | null {
  if (!isObject(value) || value["formatVersion"] !== 1) return null;
  const material = value["material"];
  if (!isObject(material) || material["sha256"] !== sha256) return null;
  if (!Array.isArray(value["annotations"]) || !Array.isArray(value["history"])) return null;
  return value;
}

/** Highlights and PDF notes join by annotation ID; for one ID the higher revision wins. */
function mergeAnnotationFiles(library: JsonObject, incoming: JsonObject): JsonObject {
  const annotations = new Map<string, JsonObject>();
  for (const entry of library["annotations"] as unknown[]) {
    if (isObject(entry)) annotations.set(String(entry["annotationId"]), entry);
  }
  for (const entry of incoming["annotations"] as unknown[]) {
    if (!isObject(entry)) continue;
    const id = String(entry["annotationId"]);
    const kept = annotations.get(id);
    if (!kept || Number(entry["revision"]) > Number(kept["revision"])) annotations.set(id, entry);
  }
  const history = new Map<string, unknown>();
  for (const entry of [
    ...(library["history"] as unknown[]),
    ...(incoming["history"] as unknown[]),
  ]) {
    if (isObject(entry)) {
      history.set(`${String(entry["annotationId"])}:${String(entry["revision"])}`, entry);
    }
  }
  const paths = [
    ...new Set([
      ...((library["paths"] as unknown[]) ?? []),
      ...((incoming["paths"] as unknown[]) ?? []),
    ]),
  ].slice(0, MAX_ANNOTATION_PATHS);
  return {
    ...library,
    paths,
    annotations: [...annotations.values()],
    history: [...history.values()],
  };
}

/** Whether every annotation of the v1 file is in the library file at the same or a later revision. */
function annotationsCovered(library: JsonObject, incoming: JsonObject): boolean {
  const kept = new Map<string, number>();
  for (const entry of library["annotations"] as unknown[]) {
    if (isObject(entry)) kept.set(String(entry["annotationId"]), Number(entry["revision"]));
  }
  return (incoming["annotations"] as unknown[]).every(
    (entry) =>
      !isObject(entry) ||
      (kept.get(String(entry["annotationId"])) ?? -1) >= Number(entry["revision"]),
  );
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const bytes = await readRegularFile(filePath);
  if (!bytes || bytes.length > MAX_JSON_BYTES) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

async function copyAnnotations(ctx: MoveContext, pdfs: ReadonlySet<string>): Promise<string[]> {
  const merged: string[] = [];
  const projectAnnotations = absolute(ctx.root, PROJECT_ANNOTATIONS_DIRECTORY);
  for (const name of await listFiles(projectAnnotations)) {
    const sha256 = /^([0-9a-f]{64})\.json$/u.exec(name)?.[1];
    if (!sha256 || !pdfs.has(sha256)) continue;
    const incoming = annotationFile(
      await readJsonFile(NodePath.join(projectAnnotations, name)),
      sha256,
    );
    if (!incoming) continue;
    const destination = NodePath.join(libraryFiles(ctx).annotations, name);
    const current = await readJsonFile(destination);
    if (current === undefined) {
      if (!(await createJson(ctx, destination, incoming))) {
        const raced = annotationFile(await readJsonFile(destination), sha256);
        if (!raced) throw new Error("A library annotation file cannot be read.");
        await atomicWriteJson(destination, mergeAnnotationFiles(raced, incoming), MAX_JSON_BYTES);
      }
    } else {
      const library = annotationFile(current, sha256);
      if (!library) throw new Error("A library annotation file cannot be read.");
      if (!annotationsCovered(library, incoming)) {
        await atomicWriteJson(destination, mergeAnnotationFiles(library, incoming), MAX_JSON_BYTES);
      }
    }
    merged.push(sha256);
  }
  return merged;
}

/** Step 2. Every write is an exclusive create, or the identity check's apply-newer revision. */
async function copyIntoLibrary(
  ctx: MoveContext,
  v1: V1Store,
  journal: ScientLibraryMoveJournal,
): Promise<ScientLibraryMoveJournal> {
  const files = libraryFiles(ctx);
  const aliases = await readLibraryAliasesAt(ctx.libraryRoot);
  const sources: MovedSource[] = [];
  for (const record of v1.records) sources.push(await settleRecord(ctx, record, aliases));
  const mapped = new Map(sources.map((source) => [source.projectSourceId, source.sourceId]));
  for (const entry of v1.trash) {
    if (mapped.has(entry.sourceId) || (await readLibraryRecord(ctx, entry.sourceId))) continue;
    const { projectId: _project, ...rest } = entry;
    await createJson(ctx, NodePath.join(files.trash, `${entry.sourceId}.json`), {
      ...rest,
      formatVersion: 2,
      record: toLibraryRecord(entry.record),
    });
  }
  const pdfs = new Set<string>();
  for (const file of v1.files) {
    const source = absolute(v1Base(ctx), file);
    const pdf = PDF_FILE.exec(file);
    if (pdf) {
      const outcome = await copyByHash(
        ctx,
        source,
        NodePath.join(files.files, pdf[1]!, `${pdf[2]!}.pdf`),
        pdf[2]!,
      );
      if (outcome !== "damaged") pdfs.add(pdf[2]!);
      continue;
    }
    const text = TEXT_FILE.exec(file);
    if (text) {
      await copyByHash(ctx, source, NodePath.join(files.text, text[1]!, `${text[2]!}.json`), null);
      continue;
    }
    // A merge base names its record; a diverged copy under a new ID starts without one.
    const zotero = ZOTERO_FILE.exec(file);
    if (zotero && mapped.get(zotero[1]!) === zotero[1]) {
      await copyByHash(ctx, source, NodePath.join(files.zotero, `${zotero[1]!}.json`), null);
    }
  }
  const annotations = await copyAnnotations(ctx, pdfs);
  await recordScientProjectSourceMappings({
    library: ctx.library,
    instanceId: ctx.instanceId,
    mappings: sources.filter((source) => source.identity !== "removed"),
  });
  return {
    ...journal,
    sources,
    pdfs: [...pdfs].toSorted(),
    annotations: annotations.toSorted(),
    divergedSources: sources.filter((source) => source.identity === "diverged").length,
  };
}

async function backUpFile(ctx: MoveContext, run: number, relative: string, bytes: Buffer) {
  const destination = absolute(backupDirectory(ctx, run), relative);
  if (await createExclusive(ctx, destination, bytes)) return;
  const kept = await readRegularFile(destination);
  if (kept && kept.equals(bytes)) return;
  // A backup is never overwritten; a different version sits beside it under its hash.
  await createExclusive(ctx, `${destination}.~${sha256Of(bytes).slice(0, 12)}`, bytes);
}

/** Whether the backup holds these exact bytes for a v1 file. */
async function inBackup(ctx: MoveContext, run: number, relative: string, sha256: string) {
  const destination = absolute(backupDirectory(ctx, run), relative);
  return (
    (await hashFile(destination)) === sha256 ||
    (await hashFile(`${destination}.~${sha256.slice(0, 12)}`)) === sha256
  );
}

async function verifyAndBackUp(
  ctx: MoveContext,
  v1: V1Store,
  journal: ScientLibraryMoveJournal,
): Promise<void> {
  const files = libraryFiles(ctx);
  for (const sha256 of journal.pdfs) {
    const copied = await hashFile(NodePath.join(files.files, sha256.slice(0, 2), `${sha256}.pdf`));
    if (copied !== sha256) throw new Error("A PDF copied into the library does not verify.");
  }
  const aliases = await readLibraryAliasesAt(ctx.libraryRoot);
  for (const source of journal.sources) {
    if (source.identity === "removed") continue;
    const target = resolveScientLibraryAlias(aliases, source.sourceId);
    if (!(await readLibraryRecord(ctx, target)) && !(await readLibraryTrash(ctx, target))) {
      throw new Error("A record copied into the library is missing.");
    }
  }
  for (const file of v1.files) {
    if (TEXT_FILE.test(file)) continue;
    // A PDF whose bytes do not match its name cannot join the library; the backup keeps it.
    const pdf = PDF_FILE.exec(file);
    if (pdf && journal.pdfs.includes(pdf[2]!)) continue;
    const bytes = await readRegularFile(absolute(v1Base(ctx), file));
    if (bytes) await backUpFile(ctx, journal.run, `sources/${file}`, bytes);
  }
  for (const sha256 of journal.annotations) {
    const bytes = await readRegularFile(
      absolute(ctx.root, `${PROJECT_ANNOTATIONS_DIRECTORY}/${sha256}.json`),
    );
    if (bytes) await backUpFile(ctx, journal.run, `annotations/${sha256}.json`, bytes);
  }
}

function uniqueName(name: string, taken: ReadonlySet<string>, title: string): string {
  const key = (value: string) => value.trim().toLocaleLowerCase();
  if (!taken.has(key(name))) return name;
  const suffixed = `${name} (${title})`.slice(0, 200);
  if (!taken.has(key(suffixed))) return suffixed;
  for (let index = 2; ; index += 1) {
    const numbered = `${name} (${title} ${index})`.slice(0, 200);
    if (!taken.has(key(numbered))) return numbered;
  }
}

function moveOrganization(
  ctx: MoveContext,
  library: ScientSourceCollectionsDocument,
  incoming: ScientSourceCollectionsDocument,
  map: (sourceId: string) => string,
): ScientSourceCollectionsDocument {
  const at = now();
  const collections = [...library.collections];
  const liveNames = new Set(
    collections
      .filter((collection) => collection.deletedAt === undefined)
      .map((collection) => collection.name.trim().toLocaleLowerCase()),
  );
  const incomingIds = new Set(incoming.collections.map((collection) => collection.collectionId));
  for (const collection of incoming.collections) {
    if (collection.deletedAt !== undefined) continue;
    const sourceIds = [...new Set(collection.sourceIds.map(map))];
    const index = collections.findIndex((entry) => entry.collectionId === collection.collectionId);
    if (index >= 0) {
      const existing = collections[index]!;
      const union = [...new Set([...existing.sourceIds, ...sourceIds])];
      if (union.length !== existing.sourceIds.length) {
        collections[index] = { ...existing, sourceIds: union, updatedAt: at, updatedBy: ctx.actor };
      }
      continue;
    }
    const name = uniqueName(collection.name, liveNames, ctx.title);
    liveNames.add(name.trim().toLocaleLowerCase());
    const parent = collection.parentCollectionId;
    const keepParent =
      parent !== undefined &&
      (incomingIds.has(parent) || collections.some((entry) => entry.collectionId === parent));
    const { parentCollectionId: _parent, ...rest } = collection;
    const moved: ScientSourceCollection = {
      ...rest,
      ...(keepParent ? { parentCollectionId: parent } : {}),
      name,
      sourceIds,
    };
    collections.push(moved);
  }
  const savedSearches = [...library.savedSearches];
  const searchNames = new Set(
    savedSearches
      .filter((search) => search.deletedAt === undefined)
      .map((search) => search.name.trim().toLocaleLowerCase()),
  );
  for (const search of incoming.savedSearches) {
    if (search.deletedAt !== undefined) continue;
    if (savedSearches.some((entry) => entry.searchId === search.searchId)) continue;
    const name = uniqueName(search.name, searchNames, ctx.title);
    searchNames.add(name.trim().toLocaleLowerCase());
    const moved: ScientSourceSavedSearch = { ...search, name };
    savedSearches.push(moved);
  }
  return { formatVersion: 1, collections, savedSearches };
}

async function mergeAndOrganize(
  ctx: MoveContext,
  v1: V1Store,
  journal: ScientLibraryMoveJournal,
): Promise<ScientLibraryMoveJournal> {
  const result = await mergeScientLibraryDuplicates({ library: ctx.library, actor: ctx.actor });
  if (v1.collections) {
    const aliases = await readLibraryAliasesAt(ctx.libraryRoot);
    const mapped = new Map(
      journal.sources.map((source) => [source.projectSourceId, source.sourceId]),
    );
    const map = (sourceId: string) =>
      resolveScientLibraryAlias(aliases, mapped.get(sourceId) ?? sourceId);
    const paths = await sourceStorePaths(ctx.library);
    const incoming = v1.collections;
    await scientSourceCollectionsInternals.rewriteLibraryOrganization(paths, (document) =>
      moveOrganization(ctx, document, incoming, map),
    );
  }
  return {
    ...journal,
    merges: {
      merged: journal.merges.merged + result.mergedCount,
      keptDifferent: journal.merges.keptDifferent + result.keptDifferentCount,
    },
  };
}

interface StagedArtifact {
  readonly artifact: Omit<MoveArtifact, "staged" | "stagedSha256">;
  readonly bytes: Buffer;
}

async function resolver(ctx: MoveContext, journal: ScientLibraryMoveJournal) {
  const aliases = await readLibraryAliasesAt(ctx.libraryRoot);
  const mapped = new Map(
    journal.sources.map((source) => [source.projectSourceId, source.sourceId]),
  );
  const target = (projectSourceId: string) =>
    resolveScientLibraryAlias(aliases, mapped.get(projectSourceId) ?? projectSourceId);
  const records = new Map<string, ScientSourceRecord | null>();
  const record = async (projectSourceId: string) => {
    const sourceId = target(projectSourceId);
    if (!records.has(sourceId)) {
      records.set(
        sourceId,
        (await readLibraryRecord(ctx, sourceId)) ??
          (await readLibraryTrash(ctx, sourceId))?.record ??
          null,
      );
    }
    return records.get(sourceId) ?? null;
  };
  return { target, record };
}

/** The snapshot of a review's records, captured at each record's own last change. */
async function snapshotFor(
  review: ScientSystematicReview,
  record: (id: string) => Promise<ScientSourceRecord | null>,
): Promise<Map<string, ScientReviewWork>> {
  const entries = new Map<string, ScientReviewWork>();
  for (const sourceId of scientReviewNamedIds(review)) {
    const found = await record(sourceId);
    if (found) {
      entries.set(sourceId, scientReviewWorkFromRecord(found, found.updatedAt ?? found.importedAt));
    }
  }
  return entries;
}

async function pinsFor(
  ctx: MoveContext,
  v1: V1Store,
  record: (id: string) => Promise<ScientSourceRecord | null>,
): Promise<ScientProjectPin[]> {
  const taken = new Set<string>();
  const pins: ScientProjectPin[] = [];
  for (const { record: own } of v1.records) {
    const found = (await record(own.sourceId)) ?? own;
    const citationKey = assignCitationKey({
      preferred: own.citationKey ?? null,
      creators: own.creators,
      issuedYear: own.issuedYear,
      title: own.title,
      taken,
    });
    taken.add(citationKeyComparisonValue(citationKey));
    const note = own.note?.trim();
    pins.push({
      citationKey,
      sourceId: own.sourceId,
      pinnedAt: own.importedAt,
      pinnedBy: ctx.actor,
      ...(note ? { note } : {}),
      work: scientPinWorkFromRecord(found),
    });
  }
  return pins;
}

async function setAside(filePath: string): Promise<void> {
  const stamp = now().replaceAll(":", "-").replaceAll(".", "-");
  await NodeFSP.rename(filePath, `${filePath}.broken-${stamp}`);
}

const reviewPath = (reviewId: string) => `${PROJECT_LIBRARY_DIRECTORY}/reviews/${reviewId}.json`;
const snapshotPath = (reviewId: string) =>
  `${PROJECT_LIBRARY_DIRECTORY}/reviews/${reviewId}.works.json`;
const conflictPath = (reviewId: string, name: string) =>
  `${PROJECT_LIBRARY_DIRECTORY}/conflicts/reviews/${reviewId}/${name}`;
const PINS_PATH = `${PROJECT_LIBRARY_DIRECTORY}/pins.json`;

/** The pins this checkout adds to a `pins.json` that already exists, under its keys where pinned. */
async function joinPins(
  existingText: string,
  staged: ReadonlyArray<ScientProjectPin>,
  target: (projectSourceId: string) => string,
): Promise<string | null> {
  const existing = decodeScientProjectPinsText(existingText);
  const ids = new Set(existing.map((pin) => pin.sourceId));
  const targets = new Set(existing.map((pin) => target(pin.sourceId)));
  const taken = new Set(existing.map((pin) => citationKeyComparisonValue(pin.citationKey)));
  const additions: ScientProjectPin[] = [];
  for (const pin of staged) {
    if (ids.has(pin.sourceId) || targets.has(target(pin.sourceId))) continue;
    const citationKey = assignCitationKey({
      preferred: pin.citationKey,
      creators: pin.work.creators,
      issuedYear: pin.work.issuedYear,
      title: pin.work.title,
      taken,
    });
    taken.add(citationKeyComparisonValue(citationKey));
    additions.push({ ...pin, citationKey });
  }
  return additions.length === 0 ? null : joinScientProjectPinsText(existingText, additions);
}

/** Step 5's plan: each artifact against the destination's bytes ("Joining project artifacts"). */
async function planArtifacts(
  ctx: MoveContext,
  v1: V1Store,
  journal: ScientLibraryMoveJournal,
): Promise<{ readonly staged: StagedArtifact[]; readonly conflicts: string[] }> {
  const { target, record } = await resolver(ctx, journal);
  const staged: StagedArtifact[] = [];
  const conflicts: string[] = [];
  const add = (artifact: StagedArtifact["artifact"], bytes: Buffer) =>
    staged.push({ artifact, bytes });
  const destination = async (relative: string) => readRegularFile(absolute(ctx.root, relative));

  for (const { path: v1Path, bytes, review } of v1.reviews) {
    const { reviewId } = review;
    const snapshot = Buffer.from(
      scientReviewSnapshotText(reviewId, await snapshotFor(review, record)),
      "utf8",
    );
    const current = await destination(reviewPath(reviewId));
    const currentSnapshot = await destination(snapshotPath(reviewId));
    if (current && !current.equals(bytes)) {
      const name = sha256Of(bytes).slice(0, 12);
      add(
        {
          path: conflictPath(reviewId, `${name}.json`),
          kind: "review-conflict",
          plan: "conflict-copy",
          destinationSha256: null,
          v1Path,
          reviewId,
        },
        bytes,
      );
      add(
        {
          path: conflictPath(reviewId, `${name}.works.json`),
          kind: "snapshot-conflict",
          plan: "conflict-copy",
          destinationSha256: null,
          reviewId,
        },
        snapshot,
      );
      conflicts.push(reviewId);
      continue;
    }
    add(
      {
        path: reviewPath(reviewId),
        kind: "review",
        plan: current ? "keep" : "create",
        destinationSha256: current ? sha256Of(current) : null,
        v1Path,
        reviewId,
      },
      bytes,
    );
    if (!currentSnapshot) {
      add(
        {
          path: snapshotPath(reviewId),
          kind: "snapshot",
          plan: "create",
          destinationSha256: null,
          reviewId,
        },
        snapshot,
      );
      continue;
    }
    const existing = decodeScientReviewSnapshotText(currentSnapshot.toString("utf8"), reviewId);
    if (!existing) {
      await setAside(absolute(ctx.root, snapshotPath(reviewId)));
      add(
        {
          path: snapshotPath(reviewId),
          kind: "snapshot",
          plan: "create",
          destinationSha256: null,
          reviewId,
        },
        snapshot,
      );
      continue;
    }
    const incoming = decodeScientReviewSnapshotText(snapshot.toString("utf8"), reviewId)!;
    const union = new Map(existing);
    const differing = new Map<string, ScientReviewWork>();
    for (const [sourceId, work] of incoming) {
      const kept = existing.get(sourceId);
      if (!kept) union.set(sourceId, work);
      else if (!scientReviewWorksEqual(kept, work)) differing.set(sourceId, work);
    }
    const unionText = Buffer.from(scientReviewSnapshotText(reviewId, union), "utf8");
    add(
      {
        path: snapshotPath(reviewId),
        kind: "snapshot",
        plan: union.size === existing.size ? "keep" : "replace",
        destinationSha256: sha256Of(currentSnapshot),
        reviewId,
      },
      union.size === existing.size ? currentSnapshot : unionText,
    );
    if (differing.size > 0) {
      const text = Buffer.from(scientReviewSnapshotText(reviewId, differing), "utf8");
      add(
        {
          path: conflictPath(reviewId, `snapshot-${sha256Of(text).slice(0, 12)}.works.json`),
          kind: "snapshot-conflict",
          plan: "conflict-copy",
          destinationSha256: null,
          reviewId,
        },
        text,
      );
    }
  }

  for (const name of BIBLIOGRAPHY_FILES) {
    const v1Path = `${SCIENT_SOURCES_DIRECTORY}/bibliography/${name}`;
    const bytes = await destination(v1Path);
    if (!bytes) continue;
    const path = `${PROJECT_LIBRARY_DIRECTORY}/bibliography/${name}`;
    const current = await destination(path);
    if (!current || current.equals(bytes)) {
      add(
        {
          path,
          kind: "bibliography",
          plan: current ? "keep" : "create",
          destinationSha256: current ? sha256Of(current) : null,
          v1Path,
        },
        bytes,
      );
      continue;
    }
    // Only the root file equal to this checkout's copy proves the root is this checkout's output.
    const rootFile = await destination(name);
    const reconciled = rootFile !== null && rootFile.equals(bytes);
    add(
      {
        path,
        kind: "bibliography",
        plan: reconciled ? "replace" : "keep",
        destinationSha256: sha256Of(current),
        v1Path,
      },
      reconciled ? bytes : current,
    );
  }

  const pins = await pinsFor(ctx, v1, record);
  const pinsText = Buffer.from(scientProjectPinsText(pins), "utf8");
  const currentPins = await destination(PINS_PATH);
  let pinsBytes: Buffer = pinsText;
  let plan: MoveArtifact["plan"] = "create";
  if (currentPins) {
    let decodes = true;
    try {
      decodeScientProjectPinsText(currentPins.toString("utf8"));
    } catch {
      decodes = false;
    }
    if (!decodes) {
      await setAside(absolute(ctx.root, PINS_PATH));
    } else if (currentPins.equals(pinsText)) {
      plan = "keep";
    } else {
      const joined = await joinPins(currentPins.toString("utf8"), pins, target);
      plan = joined ? "replace" : "keep";
      pinsBytes = joined ? Buffer.from(joined, "utf8") : currentPins;
    }
  }
  add(
    {
      path: PINS_PATH,
      kind: "pins",
      plan,
      destinationSha256: currentPins && plan !== "create" ? sha256Of(currentPins) : null,
    },
    pinsBytes,
  );
  return { staged, conflicts };
}

function decodesAs(kind: MoveArtifact["kind"], bytes: Buffer, reviewId?: string): boolean {
  const text = bytes.toString("utf8");
  try {
    switch (kind) {
      case "review":
      case "review-conflict":
        return decodeReview(JSON.parse(text)).reviewId === reviewId;
      case "snapshot":
      case "snapshot-conflict":
        return decodeScientReviewSnapshotText(text, reviewId ?? "") !== null;
      case "pins":
        decodeScientProjectPinsText(text);
        return true;
      case "bibliography":
        return true;
    }
  } catch {
    return false;
  }
}

/** Writes each artifact under a temporary name, reads it back and checks it before planning on it. */
async function stage(
  ctx: MoveContext,
  v1: V1Store,
  journal: ScientLibraryMoveJournal,
): Promise<ScientLibraryMoveJournal> {
  const directory = absolute(ctx.root, `${PROJECT_STAGING_DIRECTORY}/${journal.runId}`);
  await NodeFSP.rm(directory, { recursive: true, force: true });
  await assertScientProjectDirectory(ctx.root, directory, { create: true });
  const { staged, conflicts } = await planArtifacts(ctx, v1, journal);
  const artifacts: MoveArtifact[] = [];
  for (const [index, { artifact, bytes }] of staged.entries()) {
    const name = `${index}-${NodePath.posix.basename(artifact.path)}`;
    const filePath = NodePath.join(directory, name);
    if (!(await createExclusive(ctx, filePath, bytes))) {
      throw new Error("The move's staging folder is in use.");
    }
    const readBack = await readRegularFile(filePath);
    if (
      !readBack ||
      !readBack.equals(bytes) ||
      !decodesAs(artifact.kind, readBack, artifact.reviewId)
    ) {
      throw new Error("A staged project file does not verify.");
    }
    artifacts.push({ ...artifact, staged: name, stagedSha256: sha256Of(bytes) });
  }
  return {
    ...journal,
    artifacts,
    reviewConflicts: [...new Set([...journal.reviewConflicts, ...conflicts])].toSorted(),
  };
}

type PublishOutcome = "published" | "stale";

/** A destination shorter than the staged bytes and equal to their start is a copy cut short. */
function interruptedCopyOf(current: Buffer, staged: Buffer): boolean {
  return current.length < staged.length && staged.subarray(0, current.length).equals(current);
}

async function publishArtifact(
  ctx: MoveContext,
  journal: ScientLibraryMoveJournal,
  artifact: MoveArtifact,
): Promise<PublishOutcome> {
  const destination = absolute(ctx.root, artifact.path);
  const current = await readRegularFile(destination);
  const currentSha = current ? sha256Of(current) : null;
  if (currentSha === artifact.stagedSha256) return "published";
  const staged = await readRegularFile(
    absolute(ctx.root, `${PROJECT_STAGING_DIRECTORY}/${journal.runId}/${artifact.staged}`),
  );
  if (!staged || sha256Of(staged) !== artifact.stagedSha256) return "stale";
  await assertScientProjectDirectory(ctx.root, NodePath.dirname(destination), { create: true });
  switch (artifact.plan) {
    case "keep":
      return "stale";
    case "replace":
      // The stale check: only the bytes the plan was made against are ever replaced.
      if (!current || currentSha !== artifact.destinationSha256) return "stale";
      await replaceAtomically(destination, staged);
      break;
    case "create":
    case "conflict-copy":
      if (current) {
        if (!interruptedCopyOf(current, staged)) return "stale";
        await setAside(destination);
      }
      if (!(await createExclusive(ctx, destination, staged, { pins: artifact.kind === "pins" }))) {
        return "stale";
      }
      break;
  }
  return (await hashFile(destination)) === artifact.stagedSha256 ? "published" : "stale";
}

/** Publishes every artifact as its plan says, `pins.json` last; a stale one restages the plan. */
async function switchOver(
  ctx: MoveContext,
  v1: V1Store,
  journal: ScientLibraryMoveJournal,
): Promise<ScientLibraryMoveJournal> {
  let current = journal;
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    const ordered = [
      ...current.artifacts.filter((artifact) => artifact.kind !== "pins"),
      ...current.artifacts.filter((artifact) => artifact.kind === "pins"),
    ];
    let stale = false;
    for (const artifact of ordered) {
      if ((await publishArtifact(ctx, current, artifact)) === "stale") {
        stale = true;
        break;
      }
      if (artifact.kind === "pins") crash(ctx, "after-pins-published");
    }
    if (!stale) {
      const committed = await writeJournal(ctx, { ...current, state: "committed" });
      await NodeFSP.rm(absolute(ctx.root, PROJECT_STAGING_DIRECTORY), {
        recursive: true,
        force: true,
      });
      return committed;
    }
    current = await writeJournal(ctx, await stage(ctx, v1, current));
  }
  throw new Error("The project's files kept changing during the move. Try again.");
}

async function counterpartVerifies(
  ctx: MoveContext,
  journal: ScientLibraryMoveJournal,
  aliases: ScientLibraryAliases,
  relative: string,
): Promise<boolean> {
  const filePath = absolute(ctx.root, relative);
  const sha256 = await hashFile(filePath);
  if (sha256 === null) return true;
  if (relative.startsWith(`${PROJECT_ANNOTATIONS_DIRECTORY}/`)) {
    const hash = /([0-9a-f]{64})\.json$/u.exec(relative)![1]!;
    const library = annotationFile(
      await readJsonFile(NodePath.join(libraryFiles(ctx).annotations, `${hash}.json`)),
      hash,
    );
    const incoming = annotationFile(await readJsonFile(filePath), hash);
    return library !== null && incoming !== null && annotationsCovered(library, incoming);
  }
  const file = relative.slice(SCIENT_SOURCES_DIRECTORY.length + 1);
  const pdf = PDF_FILE.exec(file);
  if (pdf && journal.pdfs.includes(pdf[2]!)) {
    return (
      (await hashFile(NodePath.join(libraryFiles(ctx).files, pdf[1]!, `${pdf[2]!}.pdf`))) === pdf[2]
    );
  }
  const text = TEXT_FILE.exec(file);
  if (text) {
    return (
      (await hashFile(NodePath.join(libraryFiles(ctx).text, text[1]!, `${text[2]!}.json`))) !== null
    );
  }
  const record = /^records\/([^/]+)\.json$/u.exec(file);
  if (record) {
    const moved = journal.sources.find((source) => source.projectSourceId === record[1]);
    if (moved && moved.identity !== "removed") {
      const target = resolveScientLibraryAlias(aliases, moved.sourceId);
      if (!(await readLibraryRecord(ctx, target)) && !(await readLibraryTrash(ctx, target))) {
        return false;
      }
    }
  }
  const artifact = journal.artifacts.find((entry) => entry.v1Path === relative);
  if (artifact && (await hashFile(absolute(ctx.root, artifact.path))) === artifact.stagedSha256) {
    return true;
  }
  return inBackup(ctx, journal.run, `sources/${file}`, sha256);
}

async function cleanUp(
  ctx: MoveContext,
  journal: ScientLibraryMoveJournal,
): Promise<ScientLibraryMoveJournal> {
  let current = journal;
  if (current.state === "committed") {
    const v1 = (await listFiles(v1Base(ctx))).map(v1Relative);
    const annotations = current.annotations.map(
      (sha256) => `${PROJECT_ANNOTATIONS_DIRECTORY}/${sha256}.json`,
    );
    current = await writeJournal(ctx, {
      ...current,
      state: "cleanup",
      cleanup: [...v1, ...annotations],
      retry: [],
      gitTracked: current.gitTracked || (await ctx.gitTracked().catch(() => false)),
    });
  }
  const left = [...new Set([...current.cleanup, ...current.retry])];
  const aliases = await readLibraryAliasesAt(ctx.libraryRoot);
  const retry: string[] = [];
  for (const [index, relative] of left.entries()) {
    if (index === Math.floor(left.length / 2)) crash(ctx, "mid-cleanup");
    if (!(await counterpartVerifies(ctx, current, aliases, relative))) {
      retry.push(relative);
      continue;
    }
    try {
      if (ctx.faults.undeletable?.(relative)) {
        throw Object.assign(new Error("The file is open in another program."), { code: "EBUSY" });
      }
      await NodeFSP.rm(absolute(ctx.root, relative), { force: true });
    } catch (error) {
      if (!isNodeError(error, "EBUSY") && !isNodeError(error, "EPERM")) throw error;
      retry.push(relative);
    }
  }
  await removeEmptyDirectories(v1Base(ctx));
  await removeEmptyDirectories(absolute(ctx.root, PROJECT_ANNOTATIONS_DIRECTORY));
  return writeJournal(ctx, {
    ...current,
    state: retry.length === 0 ? "done" : "cleanup",
    cleanup: [],
    retry,
  });
}

async function importStillRunning(root: string): Promise<boolean> {
  const overview = await inspectScientSources(root).catch(() => null);
  const operation = overview?.activeOperation;
  if (!operation) return false;
  return Date.now() - Date.parse(operation.updatedAt) < RUNNING_IMPORT_MS;
}

/** Steps 1–7 from wherever the journal left off. */
async function runFrom(
  ctx: MoveContext,
  journal: ScientLibraryMoveJournal,
): Promise<ScientLibraryMoveJournal> {
  let current = journal;
  if (current.state === "copying") {
    await NodeFSP.rm(absolute(ctx.root, PROJECT_STAGING_DIRECTORY), {
      recursive: true,
      force: true,
    });
    current = await writeJournal(ctx, current);
    const v1 = await readV1Store(ctx);
    current = await copyIntoLibrary(ctx, v1, current);
    current = await writeJournal(ctx, current);
    crash(ctx, "after-library-copy");
    await verifyAndBackUp(ctx, v1, current);
    crash(ctx, "after-verify");
    current = await writeJournal(ctx, await mergeAndOrganize(ctx, v1, current));
    current = await stage(ctx, v1, current);
    crash(ctx, "after-stage");
    current = await writeJournal(ctx, { ...current, state: "prepared" });
    crash(ctx, "after-prepared");
  }
  if (current.state === "prepared") {
    current = await switchOver(ctx, await readV1Store(ctx), current);
  }
  if (current.state === "committed" || current.state === "cleanup") {
    current = await cleanUp(ctx, current);
  }
  return current;
}

/** The recovery table: what this open does, given the journal and the files on disk. */
async function recover(ctx: MoveContext): Promise<ScientLibraryMoveResult> {
  const journal = await readJournalAt(migrationDirectory(ctx));
  const v1 = await v1StorePresent(ctx.root);
  if (journal?.state === "moved-back") return { outcome: "moved-back", journal };
  if (!journal || journal.state === "done") {
    if (!v1) return { outcome: journal ? "moved" : "not-needed", journal };
    if (await importStillRunning(ctx.root)) return { outcome: "waiting-import", journal };
    const fresh = freshJournal(ctx, journal ? journal.run + 1 : 1);
    return { outcome: "moved", journal: await runFrom(ctx, fresh) };
  }
  if (journal.state === "copying") {
    if (await importStillRunning(ctx.root)) return { outcome: "waiting-import", journal };
    return { outcome: "moved", journal: await runFrom(ctx, { ...journal, runId: newId("move") }) };
  }
  if (journal.state === "prepared") {
    const pins = await readRegularFile(absolute(ctx.root, PINS_PATH));
    const artifact = journal.artifacts.find((entry) => entry.kind === "pins");
    if (pins && artifact && sha256Of(pins) !== artifact.stagedSha256) {
      let decodes = true;
      try {
        decodeScientProjectPinsText(pins.toString("utf8"));
      } catch {
        decodes = false;
      }
      // An interrupted copy is set aside; a decoding file someone else wrote is joined on restage.
      if (!decodes) await setAside(absolute(ctx.root, PINS_PATH));
    }
  }
  return { outcome: "moved", journal: await runFrom(ctx, journal) };
}

export interface ScientLibraryMoveInput {
  readonly library: ScientLibraryLocation;
  readonly projectRoot: string;
  readonly actor: ScientSourceActor;
  /** `git ls-files .scient/sources` through the server's git driver; untracked when absent. */
  readonly gitTracked?: () => Promise<boolean>;
  readonly faults?: ScientLibraryMoveFaults;
}

function withProjectLocks<A>(root: string, run: () => Promise<A>): Promise<A> {
  const lock = scientSourceStoreInternals.withOperationLock;
  return lock(`${root}:library-move`, () =>
    lock(`${root}:reviews-write`, () => lock(`${root}:pins-write`, run)),
  );
}

async function moveContext(
  input: ScientLibraryMoveInput,
  register: boolean,
): Promise<MoveContext | null> {
  const root = await NodeFSP.realpath(input.projectRoot);
  const { projectId } = await readScientProjectIdentity(root);
  const libraryRoot = await NodeFSP.realpath(input.library.root);
  const { libraryId } = await readScientLibraryManifest(libraryRoot);
  const instanceId = register
    ? (
        await registerScientLibraryInstance({
          library: input.library,
          projectId,
          projectRoot: root,
        })
      ).instanceId
    : (await listScientLibraryInstances(input.library)).find(
        (instance) => instance.projectId === projectId && instance.path === root,
      )?.instanceId;
  if (!instanceId) return null;
  return {
    root,
    projectId,
    title: NodePath.basename(root),
    library: input.library,
    libraryRoot,
    libraryId,
    instanceId,
    actor: input.actor,
    faults: input.faults ?? {},
    gitTracked: input.gitTracked ?? (async () => false),
  };
}

/**
 * The one-time move of a project's v1 Sources store into the library (design section 5). Safe to
 * call on every write-authorized open: it finishes or reruns whatever the journal says, and does
 * nothing for a project that has no v1 store left. Only this checkout's journal in `committed`
 * or `cleanup` ever deletes a v1 file.
 */
export async function runScientLibraryMove(
  input: ScientLibraryMoveInput,
): Promise<ScientLibraryMoveResult> {
  const ctx = await moveContext(input, true);
  if (!ctx) throw new Error("The project could not be registered with the library.");
  return withProjectLocks(ctx.root, () =>
    withScientLibraryLock(ctx.libraryRoot, () => recover(ctx)),
  );
}

/** Whether this checkout's Sources live in the library now. Reads only; registers nothing. */
export async function readScientLibraryMoveState(input: {
  readonly library: ScientLibraryLocation | null;
  readonly projectRoot: string;
}): Promise<{
  readonly moved: boolean;
  readonly v1Present: boolean;
  readonly journal: ScientLibraryMoveJournal | null;
}> {
  const root = await NodeFSP.realpath(input.projectRoot);
  const v1Present = await v1StorePresent(root);
  const ctx =
    input.library && (await exists(NodePath.join(input.library.root, "library.json")))
      ? await moveContext({ library: input.library, projectRoot: root, actor: "user" }, false)
      : null;
  const journal = ctx ? await readJournalAt(migrationDirectory(ctx)) : null;
  const state = journal?.state;
  // A run that committed is the truth even when an older Scient wrote v1 again; a write reruns it.
  const moved =
    state === "moved-back"
      ? false
      : state === "committed" || state === "cleanup" || state === "done"
        ? true
        : !v1Present;
  return { moved, v1Present, journal };
}

export type ScientLibraryMoveBackResult =
  | {
      readonly outcome: "moved-back";
      readonly restoredSources: number;
      readonly restoredPdfs: number;
      /** Pins this library cannot resolve and the backup lacks; their snapshots stay in the backup. */
      readonly skippedPins: number;
    }
  /** Nothing was moved from this checkout, or it was already moved back. */
  | { readonly outcome: "not-moved" }
  /** `.scient/sources` holds files again (an older Scient); move it in first, or remove them. */
  | { readonly outcome: "project-store-present" };

/** The v1 form of a library record under this project's pin. */
function toProjectRecord(
  ctx: MoveContext,
  record: StoredRecord,
  pin: ScientProjectPin,
  revision: number,
): ScientSourceRecord {
  const { readingStatus: _reading, starred: _starred, note: _note, ...rest } = record;
  return {
    ...rest,
    formatVersion: 1,
    projectId: ctx.projectId,
    sourceId: pin.sourceId,
    citationKey: pin.citationKey,
    revision,
    ...(pin.note !== undefined ? { note: pin.note } : {}),
  };
}

async function restoreBackups(ctx: MoveContext, journal: ScientLibraryMoveJournal) {
  const files = new Map<string, string>();
  for (let run = 1; run <= journal.run; run += 1) {
    const directory = backupDirectory(ctx, run);
    for (const file of await listFiles(directory)) {
      if (/\.~[0-9a-f]{12}$/u.test(file)) continue;
      files.set(file, NodePath.join(directory, ...file.split("/")));
    }
  }
  for (const [file, source] of files) {
    const target = file.startsWith("sources/")
      ? `${SCIENT_SOURCES_DIRECTORY}/${file.slice("sources/".length)}`
      : file.startsWith("annotations/")
        ? `${PROJECT_ANNOTATIONS_DIRECTORY}/${file.slice("annotations/".length)}`
        : null;
    const bytes = target ? await readRegularFile(source) : null;
    if (target && bytes) await createExclusive(ctx, absolute(ctx.root, target), bytes);
  }
}

async function readProjectRecord(
  ctx: MoveContext,
  sourceId: string,
): Promise<ScientSourceRecord | null> {
  assertSafeIdentifier(sourceId, "Source ID");
  const bytes = await readRegularFile(
    absolute(ctx.root, `${SCIENT_SOURCES_DIRECTORY}/records/${sourceId}.json`),
  );
  return bytes ? ownRecord(ctx, JSON.parse(bytes.toString("utf8")), sourceId) : null;
}

/**
 * "Move back into this project", the move's one Undo: rebuilds `.scient/sources` from this
 * checkout's backups plus later changes to its pinned records, copies their PDFs back and
 * removes `pins.json`. Library records stay; other projects may pin them.
 */
export async function moveScientProjectBackIntoProject(input: {
  readonly library: ScientLibraryLocation;
  readonly projectRoot: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientLibraryMoveBackResult> {
  const ctx = await moveContext(input, false);
  if (!ctx) return { outcome: "not-moved" };
  return withProjectLocks(ctx.root, () =>
    withScientLibraryLock(ctx.libraryRoot, async () => {
      let journal = await readJournalAt(migrationDirectory(ctx));
      if (!journal || journal.state === "moved-back") return { outcome: "not-moved" };
      if (journal.state !== "done") journal = (await recover(ctx)).journal;
      if (!journal || journal.state !== "done") return { outcome: "not-moved" };
      if (await v1StorePresent(ctx.root)) return { outcome: "project-store-present" };

      await restoreBackups(ctx, journal);
      const pinsText = await readRegularFile(absolute(ctx.root, PINS_PATH));
      const pins = pinsText ? decodeScientProjectPinsText(pinsText.toString("utf8")) : [];
      const aliases = await readLibraryAliasesAt(ctx.libraryRoot);
      const resolutions = await resolveScientProjectSources({
        library: ctx.library,
        projectRoot: ctx.root,
        mode: "read",
        sources: pins.map((pin) => ({ projectSourceId: pin.sourceId, work: pin.work })),
      });
      const recordsDirectory = absolute(ctx.root, `${SCIENT_SOURCES_DIRECTORY}/records`);
      const historyDirectory = absolute(ctx.root, `${SCIENT_SOURCES_DIRECTORY}/history`);
      let restoredSources = 0;
      let restoredPdfs = 0;
      let skippedPins = 0;
      for (const [index, pin] of pins.entries()) {
        const resolution = resolutions[index]!;
        const backup = await readProjectRecord(ctx, pin.sourceId);
        const library =
          resolution.kind === "resolved"
            ? await readLibraryRecord(ctx, resolveScientLibraryAlias(aliases, resolution.sourceId))
            : null;
        if (!library) {
          if (backup) restoredSources += 1;
          else skippedPins += 1;
          continue;
        }
        const sameLineage = library.sourceId === pin.sourceId;
        const revision =
          backup === null
            ? library.revision
            : sameLineage && library.revision >= backup.revision
              ? library.revision
              : backup.revision + 1;
        const next = toProjectRecord(ctx, library, pin, revision);
        if (!backup || recordContent(backup) !== recordContent(next) || backup.note !== next.note) {
          if (backup && backup.revision !== revision) {
            await createJson(
              ctx,
              NodePath.join(historyDirectory, pin.sourceId, `${backup.revision}.json`),
              backup,
            );
          }
          if (sameLineage) {
            for (let older = (backup?.revision ?? 0) + 1; older < revision; older += 1) {
              const kept = await readLibraryHistory(ctx, library.sourceId, older);
              if (kept) {
                await createJson(
                  ctx,
                  NodePath.join(historyDirectory, pin.sourceId, `${older}.json`),
                  toProjectRecord(ctx, kept, pin, older),
                );
              }
            }
          }
          await atomicWriteJson(
            NodePath.join(recordsDirectory, `${pin.sourceId}.json`),
            next,
            maxRecordBytes,
          );
        }
        restoredSources += 1;
        for (const attachment of next.attachments) {
          if (!SHA256.test(attachment.sha256)) continue;
          const name = NodePath.posix.join(
            "files",
            "sha256",
            attachment.sha256.slice(0, 2),
            `${attachment.sha256}.pdf`,
          );
          const outcome = await copyByHash(
            ctx,
            absolute(ctx.libraryRoot, name),
            absolute(ctx.root, `${SCIENT_SOURCES_DIRECTORY}/${name}`),
            attachment.sha256,
          ).catch((error: unknown) => {
            if (isNodeError(error, "ENOENT")) return "damaged" as const;
            throw error;
          });
          if (outcome === "copied") restoredPdfs += 1;
        }
      }
      // Reviews and managed-file copies changed after the move win over the backup.
      const reviews = absolute(ctx.root, `${PROJECT_LIBRARY_DIRECTORY}/reviews`);
      for (const file of await listFiles(reviews)) {
        if (file.includes("/") || !file.endsWith(".json") || file.endsWith(".works.json")) continue;
        const bytes = await readRegularFile(NodePath.join(reviews, file));
        if (bytes) {
          await replaceAtomically(
            absolute(ctx.root, `${SCIENT_SOURCES_DIRECTORY}/reviews/${file}`),
            bytes,
          );
        }
      }
      for (const name of BIBLIOGRAPHY_FILES) {
        const bytes = await readRegularFile(
          absolute(ctx.root, `${PROJECT_LIBRARY_DIRECTORY}/bibliography/${name}`),
        );
        if (bytes) {
          await replaceAtomically(
            absolute(ctx.root, `${SCIENT_SOURCES_DIRECTORY}/bibliography/${name}`),
            bytes,
          );
        }
      }
      if (pinsText) {
        await backUpFile(ctx, journal.run, "moved-back/pins.json", pinsText);
        await NodeFSP.rm(absolute(ctx.root, PINS_PATH), { force: true });
      }
      await writeJournal(ctx, { ...journal, state: "moved-back" });
      return { outcome: "moved-back", restoredSources, restoredPdfs, skippedPins };
    }),
  );
}

/** The Library's status lines after a move, for 5e to show. Empty when there is nothing to say. */
export function scientLibraryMoveStatusLines(journal: ScientLibraryMoveJournal | null): string[] {
  if (!journal || journal.state === "moved-back") return [];
  const lines: string[] = [];
  if (journal.merges.merged > 0) {
    const kept = journal.merges.keptDifferent;
    lines.push(
      `Merged ${journal.merges.merged} ${journal.merges.merged === 1 ? "duplicate" : "duplicates"}.${
        kept > 0 ? ` ${kept} kept different values: Review.` : ""
      }`,
    );
  }
  if (journal.gitTracked) {
    lines.push(
      "The Library moved out of this project. Commit the change to stop storing PDFs in git.",
    );
  }
  return lines;
}

export const scientLibraryMoveInternals = {
  migrationDirectory: (libraryRoot: string, instanceId: string) =>
    migrationDirectory({ libraryRoot, instanceId }),
  readJournalAt,
  backupRoot: (libraryRoot: string, instanceId: string) =>
    NodePath.join(migrationDirectory({ libraryRoot, instanceId }), "v1"),
  withProjectLocks,
  moveContext,
  writeJournal,
  toLibraryRecord,
  PINS_PATH,
};
