// @effect-diagnostics nodeBuiltinImport:off -- A join copies another Library's files into the personal library.
// @effect-diagnostics globalDate:off -- Joins carry interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import * as Schema from "effect/Schema";

import {
  changeScientSourceCollectionMembers,
  createScientSourceCollection,
  deleteScientSourceCollection,
  readScientSourcesOrganization,
} from "./collections.ts";
import { readScientLibraryAliases, resolveScientLibraryAlias } from "./libraryAliases.ts";
import {
  SCIENT_LIBRARY_BACKUP_MANIFEST_FILE,
  SCIENT_LIBRARY_BACKUP_PAYLOAD,
  ScientLibraryBackupManifest,
  checkScientLibraryBackup,
} from "./libraryBackup.ts";
import { readScientLibraryDistinctPairs } from "./libraryExclusions.ts";
import {
  ScientLibraryBusyError,
  withScientFileLock,
  withScientLibraryLock,
} from "./libraryLock.ts";
import { markScientLibrarySourcesDistinct } from "./libraryMerge.ts";
import { listScientLibraryRestores } from "./libraryRestore.ts";
import {
  readScientLibraryManifest,
  scientLibraryLocation,
  type ScientLibraryLocation,
} from "./libraryRoot.ts";
import {
  ScientSourceActor,
  scientSourceReadingState,
  type ScientSourceCandidate,
  type ScientSourceRecord,
} from "./model.ts";
import {
  decodePersistedScientSourceRecord,
  listScientSourceRecords,
  readScientSourceIntakeAssessor,
  readScientSourceRecord,
  readScientSourceTombstones,
  readScientSourceTrashEntries,
  readScientSourcesRemovedByPerson,
  removeScientSource,
  sourceAttachmentAbsolutePath,
} from "./store.ts";
import {
  assertSafeIdentifier,
  atomicWriteJson,
  isNodeError,
  readBoundedJson,
  snapshot,
} from "./storeFiles.ts";

const JOINS_DIRECTORY = "joins";
const HEADER_FILE = "join.json";
const ANNOTATIONS_DIRECTORY = NodePath.join("annotations", "v1");
const MAX_HEADER_BYTES = 128 * 1024 * 1024;
const MAX_PART_BYTES = 8 * 1024 * 1024;
/** Sources added under one hold of the Library's lock, so other changes get their turn. */
const PART_SIZE = 100;

const PARTS = ["details", "tags", "note", "reading", "pdfs", "highlights"] as const;
export type ScientLibraryJoinPart = (typeof PARTS)[number];

/**
 * How the other Library's source stands to one here: both hold it (`same-id`); it was merged
 * away here; one side's is a copy Scient rebuilt from a project (`rebuilt-there`, `rebuilt-here`);
 * the import's rule takes them for one work (`same-paper`), or cannot say (`possibly-same`).
 */
const Relation = Schema.Literals([
  "same-id",
  "merged-here",
  "rebuilt-there",
  "rebuilt-here",
  "same-paper",
  "possibly-same",
]);

const Difference = Schema.Struct({
  otherSourceId: Schema.String,
  /** The source here it stands against; null when several might be it. */
  sourceId: Schema.NullOr(Schema.String),
  relation: Relation,
  /** What differs (`same-id`), or what the other has that this one lacks. */
  parts: Schema.Array(Schema.Literals(PARTS)),
});
export type ScientLibraryJoinDifference = typeof Difference.Type;

const RemovedHere = Schema.Struct({
  otherSourceId: Schema.String,
  state: Schema.Literals(["trash", "deleted"]),
});

const Other = Schema.Struct({
  libraryId: Schema.String,
  kind: Schema.Literals(["backup", "replaced"]),
  /** The folder that was chosen: a backup folder, or a Library a restore moved aside. */
  folder: Schema.String,
  backupCreatedAt: Schema.optionalKey(Schema.String),
});

const JoinHeader = Schema.Struct({
  formatVersion: Schema.Literal(1),
  joinId: Schema.String,
  startedAt: Schema.String,
  by: ScientSourceActor,
  other: Other,
  /** `running` with no join under way in this Scient is one that stopped part way. */
  state: Schema.Literals(["running", "stopped", "done", "undone"]),
  finishedAt: Schema.optionalKey(Schema.String),
  /** Sources that were certainly new when the join looked. */
  planned: Schema.Int,
  identical: Schema.Int,
  /** Live here, in the other Library's Trash or deleted for good there: left as they are. */
  removedThere: Schema.Int,
  different: Schema.Array(Difference),
  removedHere: Schema.Array(RemovedHere),
  /** The other Library's collections that hold a new source, and the one here each goes to. */
  collections: Schema.Array(
    Schema.Struct({
      otherId: Schema.String,
      collectionId: Schema.String,
      /** Made by this join; Undo deletes it once nothing here is in it. */
      created: Schema.Boolean,
    }),
  ),
  undone: Schema.optionalKey(
    Schema.Struct({
      at: Schema.String,
      by: ScientSourceActor,
      trashed: Schema.Int,
      left: Schema.Int,
    }),
  ),
});
type JoinHeader = typeof JoinHeader.Type;

/** One source a join added, with what Undo needs to tell whether it was used since. */
const Arrived = Schema.Struct({
  sourceId: Schema.String,
  /** The collections here the join put it in. */
  collections: Schema.Array(Schema.String),
  /** Each PDF the join copied for it, with the hash of its highlights file as written, or null. */
  highlights: Schema.Array(
    Schema.Struct({ sha256: Schema.String, hash: Schema.NullOr(Schema.String) }),
  ),
  /** PDFs it names that the other Library's folder did not hold. */
  missingPdfs: Schema.Int,
  /** A PDF of it was already here with other highlights: this Library's stayed. */
  highlightsKept: Schema.Boolean,
});
type Arrived = typeof Arrived.Type;

/** Written before its sources are added, so a join that stops still says what it may have added. */
const JoinPart = Schema.Struct({
  formatVersion: Schema.Literal(1),
  number: Schema.Int,
  sources: Schema.Array(Schema.Struct({ sourceId: Schema.String, fingerprint: Schema.String })),
  state: Schema.Literals(["pending", "done"]),
  added: Schema.Array(Arrived),
  skipped: Schema.Array(Schema.Struct({ sourceId: Schema.String, why: Schema.String })),
});
type JoinPart = typeof JoinPart.Type;

/** Sorted keys at every level, so equal content compares equal whatever order wrote it. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sha256Of = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** Everything a record says, as one value: an unchanged source has the same fingerprint. */
const fingerprintOf = (record: ScientSourceRecord) => sha256Of(stableJson(record));

/** The bibliographic fields; check results, dates and where it came from are not details. */
function detailsOf(record: ScientSourceRecord): string {
  return stableJson({
    type: record.type,
    customType: record.customType ?? null,
    title: record.title,
    creators: record.creators,
    issuedRaw: record.issuedRaw,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    abstract: record.abstract,
    containerTitle: record.containerTitle,
    publisher: record.publisher,
    volume: record.volume,
    issue: record.issue,
    pages: record.pages,
    language: record.language,
    url: record.url,
  });
}

const noteOf = (record: ScientSourceRecord) => record.note?.trim() ?? "";
const tagsOf = (record: ScientSourceRecord) => record.tags.map((tag) => stableJson(tag));
const pdfsOf = (record: ScientSourceRecord) =>
  record.attachments.map((attachment) => attachment.sha256);
const readingOf = (record: ScientSourceRecord) =>
  scientSourceReadingState(record) ?? { readingStatus: "unread" as const, starred: false };

function candidateOf(record: ScientSourceRecord): ScientSourceCandidate {
  return {
    sourceKey: `library-join:${record.sourceId}`,
    ...(record.citationKey ? { citationKey: record.citationKey } : {}),
    type: record.type,
    customType: record.customType ?? null,
    title: record.title,
    creators: record.creators,
    issuedRaw: record.issuedRaw,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    abstract: record.abstract,
    ...(record.abstractSections ? { abstractSections: record.abstractSections } : {}),
    containerTitle: record.containerTitle,
    publisher: record.publisher,
    volume: record.volume,
    issue: record.issue,
    pages: record.pages,
    language: record.language,
    url: record.url,
    tags: record.tags,
    externalReferences: record.externalReferences,
    fieldProvenance: record.fieldProvenance,
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

const annotationPath = (root: string, sha256: string) =>
  NodePath.join(root, ANNOTATIONS_DIRECTORY, `${sha256}.json`);

async function fileBytes(path: string): Promise<Buffer | null> {
  try {
    return await NodeFSP.readFile(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return null;
    throw error;
  }
}

/** Whether the other Library has highlights on one of these PDFs that this one lacks or holds differently. */
async function highlightsDiffer(
  libraryRoot: string,
  otherRoot: string,
  pdfs: ReadonlyArray<string>,
): Promise<boolean> {
  for (const sha256 of pdfs) {
    const theirs = await fileBytes(annotationPath(otherRoot, sha256));
    if (!theirs) continue;
    const ours = await fileBytes(annotationPath(libraryRoot, sha256));
    if (!ours || !ours.equals(theirs)) return true;
  }
  return false;
}

export type ScientLibraryJoinSource =
  | {
      readonly outcome: "ready";
      /** The other Library's folder, in the Library's own layout. */
      readonly root: string;
      readonly other: typeof Other.Type;
    }
  /** Not a finished backup, and not a Library this Library's own restore moved aside. */
  | { readonly outcome: "not-a-library" }
  /** A backup whose files do not match its own list. */
  | { readonly outcome: "damaged" }
  /** The folder is this Library itself. */
  | { readonly outcome: "same-library" };

/**
 * Accepts only folders nothing can be writing: a finished backup (checked against its
 * checksums), or the Library a restore of this one moved aside, as that restore recorded it.
 * Reads only.
 */
export async function openScientLibraryJoinSource(
  library: ScientLibraryLocation,
  folder: string,
): Promise<ScientLibraryJoinSource> {
  const libraryRoot = await NodeFSP.realpath(library.root);
  const chosen = NodePath.isAbsolute(folder)
    ? await NodeFSP.realpath(folder).catch(() => null)
    : null;
  if (chosen === null || chosen === libraryRoot) {
    return chosen === null ? { outcome: "not-a-library" } : { outcome: "same-library" };
  }
  if ((await snapshot(NodePath.join(chosen, SCIENT_LIBRARY_BACKUP_MANIFEST_FILE))) === "file") {
    const check = await checkScientLibraryBackup(chosen);
    if (check.outcome === "not-a-backup") return { outcome: "not-a-library" };
    if (check.outcome === "damaged") return { outcome: "damaged" };
    const manifest = await readBoundedJson(
      NodePath.join(chosen, SCIENT_LIBRARY_BACKUP_MANIFEST_FILE),
      MAX_HEADER_BYTES * 2,
      ScientLibraryBackupManifest,
    );
    return {
      outcome: "ready",
      root: NodePath.join(chosen, SCIENT_LIBRARY_BACKUP_PAYLOAD),
      other: {
        libraryId: manifest.library.libraryId,
        kind: "backup",
        folder: chosen,
        backupCreatedAt: manifest.createdAt,
      },
    };
  }
  // Only a folder this Library's own record of a restore names: its name alone proves nothing.
  const kept = (await listScientLibraryRestores(scientLibraryLocation(libraryRoot))).some(
    (restore) => restore.kept?.path === chosen,
  );
  if (!kept) return { outcome: "not-a-library" };
  const manifest = await readScientLibraryManifest(chosen).catch(() => null);
  if (!manifest) return { outcome: "not-a-library" };
  return {
    outcome: "ready",
    root: chosen,
    other: { libraryId: manifest.libraryId, kind: "replaced", folder: chosen },
  };
}

/** What this Library holds and has removed, as far as deciding what is new needs it. */
async function localState(library: ScientLibraryLocation) {
  const [ours, aliases, trashed, deleted, assessor] = await Promise.all([
    listScientSourceRecords(library),
    readScientLibraryAliases(library),
    readScientSourceTrashEntries(library),
    readScientSourceTombstones(library),
    readScientSourceIntakeAssessor(library),
  ]);
  const live = new Map(ours.map((record) => [record.sourceId, record]));
  /** Copies Scient rebuilt from a project, by the project source they stand for. */
  const rebuilt = new Map(
    ours.flatMap((record) =>
      record.hydratedFromProjectSourceId ? [[record.hydratedFromProjectSourceId, record]] : [],
    ),
  );
  const removed = new Map<string, "trash" | "deleted">();
  const removedRebuilt = new Map<string, "trash" | "deleted">();
  // The Trash copy is whole, so it says more than the marker of a deletion that stopped half way.
  for (const [entries, state] of [
    [deleted, "deleted"],
    [trashed, "trash"],
  ] as const) {
    for (const entry of entries) {
      removed.set(entry.sourceId, state);
      const from = entry.record.hydratedFromProjectSourceId;
      if (from) removedRebuilt.set(from, state);
    }
  }
  const resolve = (sourceId: string) => resolveScientLibraryAlias(aliases, sourceId);
  return { live, rebuilt, removed, removedRebuilt, resolve, assess: assessor.assess };
}
type LocalState = Awaited<ReturnType<typeof localState>>;

type Standing =
  | { readonly kind: "fresh" }
  | { readonly kind: "removed"; readonly state: "trash" | "deleted" }
  | {
      readonly kind: "here";
      readonly relation: ScientLibraryJoinDifference["relation"];
      readonly against: ScientSourceRecord | null;
    };

/**
 * Where a source of the other Library stands in this one. `fresh` only when nothing here could
 * be it, by its ID, by the project source a rebuilt copy stands for (on either side), or by the
 * import's duplicate rule, which must name no candidate at all.
 */
function standingOf(record: ScientSourceRecord, state: LocalState): Standing {
  const id = record.sourceId;
  const here = (
    relation: ScientLibraryJoinDifference["relation"],
    against: ScientSourceRecord | null,
  ): Standing => ({ kind: "here", relation, against });
  const same = state.live.get(id);
  if (same) return here("same-id", same);
  const survivor = state.live.get(state.resolve(id));
  if (survivor) return here("merged-here", survivor);
  const gone = state.removed.get(id) ?? state.removed.get(state.resolve(id));
  if (gone) return { kind: "removed", state: gone };
  // A copy Scient rebuilt from a project stands for the source the project named.
  const from = record.hydratedFromProjectSourceId;
  if (from) {
    const original = state.live.get(state.resolve(from));
    if (original) return here("rebuilt-there", original);
    // Both Libraries rebuilt the same project source, each under its own ID.
    const twin = state.rebuilt.get(from);
    if (twin) return here("rebuilt-here", twin);
    const goneOriginal =
      state.removed.get(from) ??
      state.removed.get(state.resolve(from)) ??
      state.removedRebuilt.get(from);
    if (goneOriginal) return { kind: "removed", state: goneOriginal };
  }
  const copy = state.rebuilt.get(id);
  if (copy) return here("rebuilt-here", copy);
  const goneCopy = state.removedRebuilt.get(id);
  if (goneCopy) return { kind: "removed", state: goneCopy };
  const assessed = state.assess(candidateOf(record), record.attachments[0]?.sha256);
  // `new` with candidates means several sources here could be it: not certainly new.
  if (assessed.kind === "new" && assessed.matchingSourceIds.length === 0) return { kind: "fresh" };
  const sure =
    assessed.kind !== "possible-metadata-match" &&
    assessed.kind !== "new" &&
    assessed.matchingSourceIds.length === 1;
  // One candidate is named even when it is not certain; several are not, since none is "it".
  const match =
    assessed.matchingSourceIds.length === 1
      ? (state.live.get(assessed.matchingSourceIds[0]!) ?? null)
      : null;
  return here(sure && match ? "same-paper" : "possibly-same", match);
}

export interface ScientLibraryComparison {
  /** Sources of the other Library that are certainly new here, as its records. */
  readonly fresh: ReadonlyArray<ScientSourceRecord>;
  readonly different: ReadonlyArray<ScientLibraryJoinDifference>;
  /** In this Library's Trash or deleted for good here: a join does not bring them back. */
  readonly removedHere: ReadonlyArray<typeof RemovedHere.Type>;
  readonly identical: number;
  readonly removedThere: number;
}

/** What the other Library holds, against this one; reads only. */
export async function compareScientLibraries(
  library: ScientLibraryLocation,
  otherRoot: string,
): Promise<ScientLibraryComparison> {
  const libraryRoot = await NodeFSP.realpath(library.root);
  const other = scientLibraryLocation(otherRoot);
  const [state, theirs, theirTrash, theirDeleted] = await Promise.all([
    localState(library),
    listScientSourceRecords(other),
    readScientSourcesRemovedByPerson(other),
    readScientSourceTombstones(other),
  ]);
  const fresh: ScientSourceRecord[] = [];
  const different: ScientLibraryJoinDifference[] = [];
  const removedHere: Array<typeof RemovedHere.Type> = [];
  let identical = 0;

  /** What the other's source has that the one here lacks. */
  const lacks = async (
    theirsRecord: ScientSourceRecord,
    oursRecord: ScientSourceRecord,
    withDetails: boolean,
  ): Promise<ReadonlyArray<ScientLibraryJoinPart>> => {
    const parts: ScientLibraryJoinPart[] = [];
    if (withDetails && detailsOf(theirsRecord) !== detailsOf(oursRecord)) parts.push("details");
    const ourTags = new Set(tagsOf(oursRecord));
    if (tagsOf(theirsRecord).some((tag) => !ourTags.has(tag))) parts.push("tags");
    const note = noteOf(theirsRecord);
    if (note && !noteOf(oursRecord).includes(note)) parts.push("note");
    const [theirReading, ourReading] = [readingOf(theirsRecord), readingOf(oursRecord)];
    if (
      (theirReading.readingStatus === "read" && ourReading.readingStatus !== "read") ||
      (theirReading.starred && !ourReading.starred)
    ) {
      parts.push("reading");
    }
    const ourPdfs = new Set(pdfsOf(oursRecord));
    if (pdfsOf(theirsRecord).some((sha256) => !ourPdfs.has(sha256))) parts.push("pdfs");
    if (await highlightsDiffer(libraryRoot, otherRoot, pdfsOf(theirsRecord))) {
      parts.push("highlights");
    }
    return parts;
  };
  /** How two records under one ID differ, in either direction. */
  const differs = async (
    theirsRecord: ScientSourceRecord,
    oursRecord: ScientSourceRecord,
  ): Promise<ReadonlyArray<ScientLibraryJoinPart>> => {
    const parts: ScientLibraryJoinPart[] = [];
    if (detailsOf(theirsRecord) !== detailsOf(oursRecord)) parts.push("details");
    if (stableJson(tagsOf(theirsRecord).toSorted()) !== stableJson(tagsOf(oursRecord).toSorted())) {
      parts.push("tags");
    }
    if (noteOf(theirsRecord) !== noteOf(oursRecord)) parts.push("note");
    if (stableJson(readingOf(theirsRecord)) !== stableJson(readingOf(oursRecord))) {
      parts.push("reading");
    }
    if (stableJson(pdfsOf(theirsRecord).toSorted()) !== stableJson(pdfsOf(oursRecord).toSorted())) {
      parts.push("pdfs");
    }
    if (await highlightsDiffer(libraryRoot, otherRoot, pdfsOf(theirsRecord))) {
      parts.push("highlights");
    }
    return parts;
  };

  for (const record of theirs) {
    const standing = standingOf(record, state);
    if (standing.kind === "fresh") {
      fresh.push(record);
      continue;
    }
    if (standing.kind === "removed") {
      removedHere.push({ otherSourceId: record.sourceId, state: standing.state });
      continue;
    }
    const { relation, against } = standing;
    const parts = !against
      ? []
      : relation === "same-id"
        ? await differs(record, against)
        : await lacks(record, against, relation === "rebuilt-here" || relation === "same-paper");
    // A paper that may be the same is always shown; the others only when something differs.
    if (parts.length === 0 && relation !== "possibly-same") identical += 1;
    else {
      different.push({
        otherSourceId: record.sourceId,
        sourceId: against?.sourceId ?? null,
        relation,
        parts: [...parts],
      });
    }
  }
  const goneThere = new Set(
    [...theirTrash, ...theirDeleted]
      .map((entry) => entry.sourceId)
      .filter((id) => state.live.has(id)),
  );
  return { fresh, different, removedHere, identical, removedThere: goneThere.size };
}

const joinDirectory = (libraryRoot: string, joinId: string) => {
  assertSafeIdentifier(joinId, "Join ID");
  return NodePath.join(libraryRoot, JOINS_DIRECTORY, joinId);
};
const partPath = (directory: string, number: number) =>
  NodePath.join(directory, `part-${String(number).padStart(5, "0")}.json`);
/** Beside the Library: held for a join's or an Undo's whole life, so only one runs. */
const lifetimeLock = (libraryRoot: string) => `${libraryRoot}.join.lock`;

async function readHeader(libraryRoot: string, joinId: string): Promise<JoinHeader | null> {
  try {
    return await readBoundedJson(
      NodePath.join(joinDirectory(libraryRoot, joinId), HEADER_FILE),
      MAX_HEADER_BYTES,
      JoinHeader,
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function readParts(directory: string): Promise<ReadonlyArray<JoinPart>> {
  const names = (await NodeFSP.readdir(directory)).filter((name) => /^part-\d+\.json$/u.test(name));
  const parts: JoinPart[] = [];
  for (const name of names.toSorted()) {
    parts.push(await readBoundedJson(NodePath.join(directory, name), MAX_PART_BYTES, JoinPart));
  }
  return parts;
}

async function exists(path: string): Promise<boolean> {
  return (await snapshot(path)) !== "missing";
}

/**
 * Creates a file with these bytes only if no file has its name: written beside it, flushed,
 * then linked into place, so a kill never leaves half a file under the final name.
 */
async function createExclusively(path: string, bytes: Uint8Array): Promise<boolean> {
  if (await exists(path)) return false;
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await NodeFSP.link(temporary, path);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      if (!isNodeError(error, "EPERM") && !isNodeError(error, "ENOTSUP")) throw error;
      // No hard links on this volume: an exclusive copy is the nearest thing.
      return await NodeFSP.copyFile(temporary, path, NodeFSP.constants.COPYFILE_EXCL).then(
        () => true,
        (failure: unknown) => {
          if (isNodeError(failure, "EEXIST")) return false;
          throw failure;
        },
      );
    }
  } finally {
    await handle?.close();
    await NodeFSP.rm(temporary, { force: true });
  }
}

/** Copies a PDF by its hash, checking the bytes. A file already here is left. */
async function copyPdf(
  from: string,
  to: string,
  sha256: string,
): Promise<"copied" | "here" | "missing"> {
  if (await exists(to)) return "here";
  if (!(await exists(from))) return "missing";
  await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
  const temporary = `${to}.tmp-${NodeCrypto.randomUUID()}`;
  const hash = NodeCrypto.createHash("sha256");
  try {
    await NodeStreamPromises.pipeline(
      NodeFS.createReadStream(from),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk as Buffer);
          yield chunk;
        }
      },
      NodeFS.createWriteStream(temporary, { flags: "wx", mode: 0o600, flush: true }),
    );
    if (hash.digest("hex") !== sha256) throw new Error("A PDF does not match its checksum.");
    await NodeFSP.rename(temporary, to);
    return "copied";
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

const hashOfBytes = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** What the other Library decided about its sources that must hold here too. */
interface OtherDecisions {
  /** The other Library's collections each source is in. */
  readonly collectionsOf: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Sources each source must stay apart from: "not duplicates", and merges it undid. */
  readonly apartFrom: ReadonlyMap<string, ReadonlyArray<string>>;
}

async function otherDecisions(otherRoot: string): Promise<OtherDecisions> {
  const other = scientLibraryLocation(otherRoot);
  const [organization, pairs, aliases] = await Promise.all([
    readScientSourcesOrganization(other),
    readScientLibraryDistinctPairs(otherRoot).catch(() => []),
    readScientLibraryAliases(other).catch(() => new Map()),
  ]);
  const collectionsOf = new Map<string, string[]>();
  for (const collection of organization.collections) {
    for (const sourceId of collection.sourceIds) {
      collectionsOf.set(sourceId, [
        ...(collectionsOf.get(sourceId) ?? []),
        collection.collectionId,
      ]);
    }
  }
  const apartFrom = new Map<string, string[]>();
  const apart = (first: string, second: string) => {
    apartFrom.set(first, [...(apartFrom.get(first) ?? []), second]);
    apartFrom.set(second, [...(apartFrom.get(second) ?? []), first]);
  };
  for (const pair of pairs) apart(pair.sourceIds[0], pair.sourceIds[1]);
  // A merge the other Library undid keeps its two sources apart there; so it must here.
  for (const alias of aliases.values()) {
    if (alias.undoneAt !== undefined) apart(alias.sourceId, alias.survivorId);
  }
  return { collectionsOf, apartFrom };
}

/**
 * Finds or makes here the collections of the other Library that hold a new source, matched by
 * name under the same parent. Members are added later, one source at a time. A collection that
 * cannot be made (a limit) is left out, and its sources arrive without it.
 */
async function ensureCollections(input: {
  readonly library: ScientLibraryLocation;
  readonly otherRoot: string;
  readonly fresh: ReadonlySet<string>;
  readonly actor: ScientSourceActor;
}): Promise<JoinHeader["collections"]> {
  if (input.fresh.size === 0) return [];
  const theirs = await readScientSourcesOrganization(scientLibraryLocation(input.otherRoot));
  const byId = new Map(theirs.collections.map((entry) => [entry.collectionId, entry]));
  const mapped = new Map<string, { collectionId: string; created: boolean }>();
  const ensure = async (otherId: string): Promise<string | null> => {
    const known = mapped.get(otherId);
    if (known) return known.collectionId;
    const collection = byId.get(otherId);
    if (!collection) return null;
    const parentId = collection.parentCollectionId
      ? await ensure(collection.parentCollectionId)
      : null;
    if (collection.parentCollectionId && !parentId) return null;
    const change = await createScientSourceCollection({
      root: input.library,
      name: collection.name,
      ...(parentId ? { parentCollectionId: parentId } : {}),
      actor: input.actor,
    }).catch(() => null);
    if (!change?.collection) return null;
    mapped.set(otherId, {
      collectionId: change.collection.collectionId,
      created: change.outcome === "created",
    });
    return change.collection.collectionId;
  };
  for (const collection of theirs.collections) {
    if (collection.sourceIds.some((sourceId) => input.fresh.has(sourceId))) {
      await ensure(collection.collectionId);
    }
  }
  return [...mapped].map(([otherId, entry]) => ({ otherId, ...entry }));
}

/**
 * Puts a source the join added where the other Library had it and keeps it apart from what the
 * other Library kept it apart from. Safe to repeat. Caller holds the Library's lock, so no
 * automatic merge can see the source before its "not duplicates" decisions are here.
 */
async function organise(input: {
  readonly library: ScientLibraryLocation;
  readonly sourceId: string;
  readonly decisions: OtherDecisions;
  readonly collections: JoinHeader["collections"];
  readonly present: (sourceId: string) => Promise<boolean>;
  readonly actor: ScientSourceActor;
}): Promise<ReadonlyArray<string>> {
  for (const other of input.decisions.apartFrom.get(input.sourceId) ?? []) {
    if (!(await input.present(other))) continue;
    await markScientLibrarySourcesDistinct({
      library: input.library,
      sourceIds: [input.sourceId, other],
      reason: "marked-distinct",
      actor: input.actor,
    });
  }
  const placed: string[] = [];
  for (const otherId of input.decisions.collectionsOf.get(input.sourceId) ?? []) {
    const collectionId = input.collections.find((entry) => entry.otherId === otherId)?.collectionId;
    if (!collectionId) continue;
    // A full collection or one deleted meanwhile: the source arrives without it.
    const change = await changeScientSourceCollectionMembers({
      root: input.library,
      collectionId,
      add: [input.sourceId],
      actor: input.actor,
    }).catch(() => null);
    if (change?.collection?.sourceIds.includes(input.sourceId)) placed.push(collectionId);
  }
  return placed;
}

/**
 * Adds one source as the other Library has it: PDFs and highlights first, then its earlier
 * versions with the PDFs they name, the record last, each created only if no file has its
 * name. Highlights come only with a PDF this Library did not have. Caller holds the lock.
 */
async function addSource(input: {
  readonly libraryRoot: string;
  readonly otherRoot: string;
  readonly record: ScientSourceRecord;
}): Promise<Omit<Arrived, "collections"> | string> {
  const { libraryRoot, otherRoot, record } = input;
  const id = record.sourceId;
  assertSafeIdentifier(id, "Source ID");
  const recordPath = NodePath.join(libraryRoot, "records", `${id}.json`);
  if (await exists(recordPath)) return "it is here now";
  if (
    (await exists(NodePath.join(libraryRoot, "trash", `${id}.json`))) ||
    (await exists(NodePath.join(libraryRoot, "deleted", `${id}.json`)))
  ) {
    return "it was removed here";
  }
  const library = scientLibraryLocation(libraryRoot);
  const other = scientLibraryLocation(otherRoot);
  const highlights: Array<Arrived["highlights"][number]> = [];
  let missingPdfs = 0;
  let highlightsKept = false;
  for (const attachment of record.attachments) {
    const copied = await copyPdf(
      sourceAttachmentAbsolutePath(other, attachment),
      sourceAttachmentAbsolutePath(library, attachment),
      attachment.sha256,
    );
    if (copied === "missing") {
      missingPdfs += 1;
      continue;
    }
    const theirs = await fileBytes(annotationPath(otherRoot, attachment.sha256));
    const ours = annotationPath(libraryRoot, attachment.sha256);
    if (copied === "here") {
      // The PDF belongs to a source of this Library too: its highlights stay as they are.
      const mine = await fileBytes(ours);
      if (theirs && (!mine || !mine.equals(theirs))) highlightsKept = true;
      continue;
    }
    if (theirs) await createExclusively(ours, theirs);
    const written = await fileBytes(ours);
    highlights.push({ sha256: attachment.sha256, hash: written ? hashOfBytes(written) : null });
  }
  const history = NodePath.join(otherRoot, "history", id);
  for (const name of await NodeFSP.readdir(history).catch(() => [] as string[])) {
    if (!/^\d+\.json$/u.test(name)) continue;
    const bytes = await NodeFSP.readFile(NodePath.join(history, name));
    // A PDF only an earlier version names comes too while the other Library still has it, so
    // going back to that version here finds it.
    const version = await Promise.resolve(bytes.toString("utf8"))
      .then((text) => decodePersistedScientSourceRecord(JSON.parse(text)))
      .catch(() => null);
    for (const attachment of version?.attachments ?? []) {
      await copyPdf(
        sourceAttachmentAbsolutePath(other, attachment),
        sourceAttachmentAbsolutePath(library, attachment),
        attachment.sha256,
      ).catch(() => "missing" as const);
    }
    await createExclusively(NodePath.join(libraryRoot, "history", id, name), bytes);
  }
  const bytes = await NodeFSP.readFile(NodePath.join(otherRoot, "records", `${id}.json`));
  // Written as the other Library keeps it, once it is known to be a record this Scient reads.
  decodePersistedScientSourceRecord(JSON.parse(bytes.toString("utf8")));
  if (!(await createExclusively(recordPath, bytes))) return "it is here now";
  return { sourceId: id, highlights, missingPdfs, highlightsKept };
}

/**
 * Settles a join that stopped part way: a part that never finished names what it meant to add,
 * and what of that is here in any form (live, in the Trash, deleted) is what it added. Decided
 * before any later join adds anything, so no source is ever counted for two joins. Where the
 * other Library's folder can still be read, the sources it added are put in their collections.
 */
async function settleStopped(
  libraryRoot: string,
  joinId: string,
  actor: ScientSourceActor,
): Promise<void> {
  const header = await readHeader(libraryRoot, joinId).catch(() => null);
  if (header?.state !== "running") return;
  const directory = joinDirectory(libraryRoot, joinId);
  const library = scientLibraryLocation(libraryRoot);
  const source = await openScientLibraryJoinSource(library, header.other.folder).catch(() => null);
  const decisions =
    source?.outcome === "ready" && source.other.libraryId === header.other.libraryId
      ? await otherDecisions(source.root).catch(() => null)
      : null;
  await withScientLibraryLock(libraryRoot, async () => {
    for (const part of await readParts(directory)) {
      if (part.state === "done") continue;
      const added: Arrived[] = [];
      for (const planned of part.sources) {
        const name = `${planned.sourceId}.json`;
        const anywhere = await Promise.all(
          ["records", "trash", "deleted"].map((folder) =>
            exists(NodePath.join(libraryRoot, folder, name)),
          ),
        );
        if (!anywhere.some(Boolean)) continue;
        const record = await readScientSourceRecord(library, planned.sourceId);
        // Only a source still exactly as planned is organised: a changed one is the person's.
        const collections =
          decisions && record && fingerprintOf(record) === planned.fingerprint
            ? await organise({
                library,
                sourceId: planned.sourceId,
                decisions,
                collections: header.collections,
                present: (sourceId) =>
                  exists(NodePath.join(libraryRoot, "records", `${sourceId}.json`)),
                actor,
              })
            : [];
        added.push({
          sourceId: planned.sourceId,
          collections: [...collections],
          highlights: [],
          missingPdfs: 0,
          highlightsKept: false,
        });
      }
      const here = new Set(added.map((entry) => entry.sourceId));
      await atomicWriteJson(
        partPath(directory, part.number),
        {
          ...part,
          state: "done",
          added,
          skipped: part.sources
            .filter((planned) => !here.has(planned.sourceId))
            .map((planned) => ({ sourceId: planned.sourceId, why: "the join stopped" })),
        } satisfies JoinPart,
        MAX_PART_BYTES,
      );
    }
    await atomicWriteJson(
      NodePath.join(directory, HEADER_FILE),
      { ...header, state: "stopped", finishedAt: new Date().toISOString() } satisfies JoinHeader,
      MAX_HEADER_BYTES,
    );
  });
}

/** Every join this Library records that is still marked as running. */
async function unfinishedJoins(libraryRoot: string): Promise<ReadonlyArray<string>> {
  const names = await NodeFSP.readdir(NodePath.join(libraryRoot, JOINS_DIRECTORY)).catch(
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return [] as string[];
      throw error;
    },
  );
  const unfinished: string[] = [];
  for (const joinId of names) {
    if ((await readHeader(libraryRoot, joinId).catch(() => null))?.state === "running") {
      unfinished.push(joinId);
    }
  }
  return unfinished;
}

/** Runs holding the join's lifetime lock, or answers `busy` when a join or an Undo holds it. */
async function oneAtATime<A>(libraryRoot: string, run: () => Promise<A>): Promise<A | "busy"> {
  let held = false;
  try {
    return await withScientFileLock(
      lifetimeLock(libraryRoot),
      () => {
        held = true;
        return run();
      },
      { timeoutMs: 0 },
    );
  } catch (error) {
    if (error instanceof ScientLibraryBusyError && !held) return "busy";
    throw error;
  }
}

export type ScientLibraryJoinResult =
  | {
      readonly outcome: "joined";
      readonly joinId: string;
      readonly added: number;
      /** Planned but not added: it appeared or was removed here meanwhile, or could not be read. */
      readonly skipped: number;
      readonly different: number;
      readonly removedHere: number;
      readonly removedThere: number;
      readonly identical: number;
      /** PDFs the added sources name that the other Library's folder did not hold. */
      readonly missingPdfs: number;
    }
  | { readonly outcome: "stopped"; readonly joinId: string; readonly added: number }
  /** Another join, or an Undo of one, is running in this Library. */
  | { readonly outcome: "busy" }
  | { readonly outcome: "not-a-library" | "damaged" | "same-library" };

/**
 * Adds the sources another Library has that are certainly new here, each whole, and records
 * everything else it found as differences without changing anything that exists here. It can
 * be run again with the same folder: what is already here is no longer new.
 */
export async function joinScientLibrary(input: {
  readonly library: ScientLibraryLocation;
  /** A backup folder, or a Library a restore moved aside. */
  readonly folder: string;
  readonly actor: ScientSourceActor;
  /** `done` counts the sources dealt with, added or not; `added` those that are in now. */
  readonly onProgress?: (progress: {
    readonly done: number;
    readonly total: number;
    readonly added: number;
  }) => void;
  /** Called once the join has its record, before it adds anything. */
  readonly onStarted?: (joinId: string) => void;
  /** Asked between parts; true stops the join where it is. */
  readonly shouldStop?: () => boolean;
  /** Tests only: stops after this many sources of a part, as a killed process would. */
  readonly faults?: { readonly stopAfter?: number; readonly beforeOrganise?: () => void };
}): Promise<ScientLibraryJoinResult> {
  const source = await openScientLibraryJoinSource(input.library, input.folder);
  if (source.outcome !== "ready") return source;
  const libraryRoot = await NodeFSP.realpath(input.library.root);
  const library = scientLibraryLocation(libraryRoot);
  const joined = await oneAtATime(libraryRoot, async (): Promise<ScientLibraryJoinResult> => {
    // Holding the lifetime lock: any join still marked running stopped part way.
    for (const joinId of await unfinishedJoins(libraryRoot)) {
      await settleStopped(libraryRoot, joinId, input.actor);
    }
    const compared = await compareScientLibraries(library, source.root);
    const decisions = await otherDecisions(source.root);
    const joinId = `join_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const directory = joinDirectory(libraryRoot, joinId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const writeHeader = (header: JoinHeader) =>
      atomicWriteJson(NodePath.join(directory, HEADER_FILE), header, MAX_HEADER_BYTES);
    let header: JoinHeader = {
      formatVersion: 1,
      joinId,
      startedAt: new Date().toISOString(),
      by: input.actor,
      other: source.other,
      state: "running",
      planned: compared.fresh.length,
      identical: compared.identical,
      removedThere: compared.removedThere,
      different: compared.different,
      removedHere: compared.removedHere,
      collections: [],
    };
    await writeHeader(header);
    input.onStarted?.(joinId);
    header = {
      ...header,
      collections: await ensureCollections({
        library,
        otherRoot: source.root,
        fresh: new Set(compared.fresh.map((record) => record.sourceId)),
        actor: input.actor,
      }),
    };
    await writeHeader(header);

    let added = 0;
    let skipped = 0;
    let missingPdfs = 0;
    let done = 0;
    for (
      let start = 0, number = 1;
      start < compared.fresh.length;
      start += PART_SIZE, number += 1
    ) {
      if (input.shouldStop?.()) return { outcome: "stopped", joinId, added };
      const records = compared.fresh.slice(start, start + PART_SIZE);
      const part: JoinPart = {
        formatVersion: 1,
        number,
        sources: records.map((record) => ({
          sourceId: record.sourceId,
          fingerprint: fingerprintOf(record),
        })),
        state: "pending",
        added: [],
        skipped: [],
      };
      // Written first: whatever happens next, the join's record names what it may have added.
      await atomicWriteJson(partPath(directory, number), part, MAX_PART_BYTES);
      const settled = await withScientLibraryLock(libraryRoot, async () => {
        // Under the lock, against the Library as it is now: an import, a merge or a removal
        // since the join first looked means the source is no longer certainly new.
        const state = await localState(library);
        const partAdded: Arrived[] = [];
        const partSkipped: Array<{ sourceId: string; why: string }> = [];
        for (const [index, record] of records.entries()) {
          if (input.faults?.stopAfter === index) throw new Error("Stopped (test fault).");
          const id = record.sourceId;
          const arrived =
            standingOf(record, state).kind !== "fresh"
              ? "it is no longer new here"
              : await addSource({ libraryRoot, otherRoot: source.root, record }).catch(
                  (error: unknown) =>
                    error instanceof Error && error.message
                      ? error.message
                      : "it could not be read",
                );
          if (typeof arrived === "string") partSkipped.push({ sourceId: id, why: arrived });
          else {
            input.faults?.beforeOrganise?.();
            const collections = await organise({
              library,
              sourceId: id,
              decisions,
              collections: header.collections,
              present: (sourceId) =>
                exists(NodePath.join(libraryRoot, "records", `${sourceId}.json`)),
              actor: input.actor,
            });
            partAdded.push({ ...arrived, collections: [...collections] });
            added += 1;
            missingPdfs += arrived.missingPdfs;
          }
          done += 1;
          input.onProgress?.({ done, total: compared.fresh.length, added });
        }
        return { partAdded, partSkipped };
      });
      await atomicWriteJson(
        partPath(directory, number),
        { ...part, state: "done", added: settled.partAdded, skipped: settled.partSkipped },
        MAX_PART_BYTES,
      );
      skipped += settled.partSkipped.length;
    }
    await writeHeader({ ...header, state: "done", finishedAt: new Date().toISOString() });
    return {
      outcome: "joined",
      joinId,
      added,
      skipped,
      different: compared.different.length,
      removedHere: compared.removedHere.length,
      removedThere: compared.removedThere,
      identical: compared.identical,
      missingPdfs,
    };
  });
  return joined === "busy" ? { outcome: "busy" } : joined;
}

/** Source IDs a project on this computer has pinned, linked or resolved to, as the Library records. */
async function usedByProjects(libraryRoot: string): Promise<ReadonlySet<string>> {
  const folder = NodePath.join(libraryRoot, "projects");
  const used = new Set<string>();
  for (const name of await NodeFSP.readdir(folder).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const map: unknown = await NodeFSP.readFile(NodePath.join(folder, name), "utf8").then(
      (text) => JSON.parse(text) as unknown,
      () => null,
    );
    const sources =
      typeof map === "object" && map !== null && "sources" in map && Array.isArray(map.sources)
        ? (map.sources as ReadonlyArray<unknown>)
        : [];
    for (const entry of sources) {
      if (typeof entry === "object" && entry !== null && "sourceId" in entry) {
        if (typeof entry.sourceId === "string") used.add(entry.sourceId);
      }
    }
  }
  return used;
}

export type ScientLibraryJoinUndo =
  | {
      readonly outcome: "undone";
      /** Sources the join added that were still as it left them: now in the Trash. */
      readonly trashed: number;
      /** Sources the join added that were changed or used since, and collections in use: left. */
      readonly left: number;
    }
  /** `running`: that join, another one, or another Undo is under way. */
  | { readonly outcome: "not-found" | "already-undone" | "running" };

/**
 * Takes a join back as far as nothing has happened since: a source it added goes to the Trash
 * only if its record is as the join left it, no project uses it, it is in no other collection,
 * and the highlights that came with it are untouched. A collection the join made goes once
 * nothing is in or under it. In the Trash the sources are removed here, so no join adds them again.
 */
export async function undoScientLibraryJoin(input: {
  readonly library: ScientLibraryLocation;
  readonly joinId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientLibraryJoinUndo> {
  const libraryRoot = await NodeFSP.realpath(input.library.root);
  const library = scientLibraryLocation(libraryRoot);
  const undone = await oneAtATime(libraryRoot, async (): Promise<ScientLibraryJoinUndo> => {
    await settleStopped(libraryRoot, input.joinId, input.actor);
    const header = await readHeader(libraryRoot, input.joinId);
    if (!header) return { outcome: "not-found" };
    if (header.state === "undone") return { outcome: "already-undone" };
    const directory = joinDirectory(libraryRoot, input.joinId);
    let trashed = 0;
    let left = 0;
    for (const part of await readParts(directory)) {
      const planned = new Map(part.sources.map((entry) => [entry.sourceId, entry.fingerprint]));
      // One hold of the lock for the part: nothing changes between the look and the removal.
      await withScientLibraryLock(libraryRoot, async () => {
        const used = await usedByProjects(libraryRoot);
        const organization = await readScientSourcesOrganization(library);
        for (const arrived of part.added) {
          const { sourceId } = arrived;
          const record = await readScientSourceRecord(library, sourceId);
          const placed = new Set(arrived.collections);
          const untouched =
            record !== null &&
            fingerprintOf(record) === planned.get(sourceId) &&
            !used.has(sourceId) &&
            organization.collections.every(
              (collection) =>
                !collection.sourceIds.includes(sourceId) || placed.has(collection.collectionId),
            ) &&
            (
              await Promise.all(
                arrived.highlights.map(async ({ sha256, hash }) => {
                  const now = await fileBytes(annotationPath(libraryRoot, sha256));
                  return (now ? hashOfBytes(now) : null) === hash;
                }),
              )
            ).every(Boolean);
          const removed = untouched
            ? await removeScientSource({
                root: library,
                sourceId,
                expectedRevision: record.revision,
                actor: input.actor,
              })
            : null;
          if (removed?.outcome === "removed") trashed += 1;
          else left += 1;
        }
      });
    }
    // Children first; a collection goes only when nothing here is in it and nothing is under it.
    const created = header.collections.filter((entry) => entry.created).toReversed();
    for (const { collectionId } of created) {
      const present = new Set((await listScientSourceRecords(library)).map((r) => r.sourceId));
      const organization = await readScientSourcesOrganization(library, present);
      const collection = organization.collections.find(
        (entry) => entry.collectionId === collectionId,
      );
      if (!collection) continue;
      const inUse =
        collection.sourceIds.some((sourceId) => present.has(sourceId)) ||
        organization.collections.some((entry) => entry.parentCollectionId === collectionId);
      if (inUse) left += 1;
      else {
        await deleteScientSourceCollection({
          root: library,
          collectionId,
          actor: input.actor,
        }).catch(() => undefined);
      }
    }
    await atomicWriteJson(
      NodePath.join(directory, HEADER_FILE),
      {
        ...header,
        state: "undone",
        undone: { at: new Date().toISOString(), by: input.actor, trashed, left },
      } satisfies JoinHeader,
      MAX_HEADER_BYTES,
    );
    return { outcome: "undone", trashed, left };
  });
  return undone === "busy" ? { outcome: "running" } : undone;
}

/** One join as "Recent changes" and the differences view show it. */
export interface ScientLibraryJoinRecord {
  readonly joinId: string;
  readonly at: string;
  readonly by: ScientSourceActor;
  readonly other: typeof Other.Type;
  /** `stopped`: it did not finish; what it added is in the Library and it can be undone. */
  readonly state: "done" | "stopped" | "undone";
  readonly added: number;
  /** With the added sources whose PDF was already here with other highlights. */
  readonly different: ReadonlyArray<ScientLibraryJoinDifference>;
  readonly removedHere: number;
  readonly removedThere: number;
  /** PDFs the added sources name that the other Library's folder did not hold. */
  readonly missingPdfs: number;
  /** After Undo: what stayed because it was changed or used since. */
  readonly left: number;
}

/**
 * The joins this Library records, newest first; reads only. `running` names joins under way
 * in this process: any other unfinished one stopped part way.
 */
export async function listScientLibraryJoins(
  library: ScientLibraryLocation,
  running: ReadonlySet<string> = new Set(),
): Promise<ReadonlyArray<ScientLibraryJoinRecord>> {
  const libraryRoot = await NodeFSP.realpath(library.root);
  const root = NodePath.join(libraryRoot, JOINS_DIRECTORY);
  const names = await NodeFSP.readdir(root).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [] as string[];
    throw error;
  });
  const joins: ScientLibraryJoinRecord[] = [];
  for (const joinId of names) {
    if (running.has(joinId)) continue;
    const header = await readHeader(libraryRoot, joinId).catch(() => null);
    if (!header) continue;
    const parts = await readParts(joinDirectory(libraryRoot, joinId)).catch(() => []);
    let added = 0;
    const arrived: Arrived[] = [];
    for (const part of parts) {
      if (part.state === "done") {
        added += part.added.length;
        arrived.push(...part.added);
        continue;
      }
      // A part that never finished: what of it is here is what it added.
      for (const planned of part.sources) {
        const path = NodePath.join(libraryRoot, "records", `${planned.sourceId}.json`);
        if (await exists(path)) added += 1;
      }
    }
    joins.push({
      joinId,
      at: header.finishedAt ?? header.startedAt,
      by: header.by,
      other: header.other,
      state: header.state === "running" ? "stopped" : header.state,
      added,
      different: [
        ...header.different,
        ...arrived
          .filter((entry) => entry.highlightsKept)
          .map((entry) => ({
            otherSourceId: entry.sourceId,
            sourceId: entry.sourceId,
            relation: "same-id" as const,
            parts: ["highlights" as const],
          })),
      ],
      removedHere: header.removedHere.length,
      removedThere: header.removedThere,
      missingPdfs: arrived.reduce((sum, entry) => sum + entry.missingPdfs, 0),
      left: header.undone?.left ?? 0,
    });
  }
  return joins.toSorted((left, right) => right.at.localeCompare(left.at));
}
