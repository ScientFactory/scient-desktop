// @effect-diagnostics nodeBuiltinImport:off -- A join copies another Library's files into the personal library.
// @effect-diagnostics globalDate:off -- Joins carry interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import * as Schema from "effect/Schema";

import {
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
import { withScientLibraryLock } from "./libraryLock.ts";
import { markScientLibrarySourcesDistinct } from "./libraryMerge.ts";
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
  atomicCreateJson,
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
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
/** Sources added under one hold of the Library's lock, so other changes get their turn. */
const PART_SIZE = 100;
const REPLACED_MARK = ".replaced-";

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
  collections: Schema.optionalKey(
    Schema.Struct({
      created: Schema.Array(Schema.String),
      extended: Schema.Array(
        Schema.Struct({ collectionId: Schema.String, sourceIds: Schema.Array(Schema.String) }),
      ),
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

/** Written before its sources are added, so a join that stops still says what it may have added. */
const JoinPart = Schema.Struct({
  formatVersion: Schema.Literal(1),
  number: Schema.Int,
  sources: Schema.Array(Schema.Struct({ sourceId: Schema.String, fingerprint: Schema.String })),
  state: Schema.Literals(["pending", "done"]),
  added: Schema.Array(Schema.String),
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
  /** Not a finished backup, and not a Library this Scient's restore moved aside. */
  | { readonly outcome: "not-a-library" }
  /** A backup whose files do not match its own list. */
  | { readonly outcome: "damaged" }
  /** It is this Library's own copy with nothing else in it to add (the same folder). */
  | { readonly outcome: "same-library" };

/**
 * Accepts only folders nothing can be writing: a finished backup (checked against its
 * checksums), or a Library a restore of this one moved aside. Reads only.
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
  // A Library that a restore moved aside sits beside this one under the restore's name.
  const replaced =
    NodePath.dirname(chosen) === NodePath.dirname(libraryRoot) &&
    NodePath.basename(chosen).startsWith(`${NodePath.basename(libraryRoot)}${REPLACED_MARK}`);
  if (!replaced) return { outcome: "not-a-library" };
  const manifest = await readScientLibraryManifest(chosen).catch(() => null);
  if (!manifest) return { outcome: "not-a-library" };
  return {
    outcome: "ready",
    root: chosen,
    other: { libraryId: manifest.libraryId, kind: "replaced", folder: chosen },
  };
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

/**
 * What the other Library holds, against this one; reads only. A source is `fresh` only when
 * nothing here could be it: no record, merge, Trash entry or deletion under its ID or under the
 * project ID a rebuilt copy came from, and no match by the import's own duplicate rule.
 */
export async function compareScientLibraries(
  library: ScientLibraryLocation,
  otherRoot: string,
): Promise<ScientLibraryComparison> {
  const libraryRoot = await NodeFSP.realpath(library.root);
  const other = scientLibraryLocation(otherRoot);
  const [ours, aliases, trashed, deleted, assessor, theirs, theirTrash, theirDeleted] =
    await Promise.all([
      listScientSourceRecords(library),
      readScientLibraryAliases(library),
      readScientSourceTrashEntries(library),
      readScientSourceTombstones(library),
      readScientSourceIntakeAssessor(library),
      listScientSourceRecords(other),
      readScientSourcesRemovedByPerson(other),
      readScientSourceTombstones(other),
    ]);
  const live = new Map(ours.map((record) => [record.sourceId, record]));
  const rebuiltHere = new Map(
    ours.flatMap((record) =>
      record.hydratedFromProjectSourceId ? [[record.hydratedFromProjectSourceId, record]] : [],
    ),
  );
  const removed = new Map<string, "trash" | "deleted">();
  // The Trash copy is whole, so it says more than the marker of a deletion that stopped half way.
  for (const entry of deleted) removed.set(entry.sourceId, "deleted");
  for (const entry of trashed) removed.set(entry.sourceId, "trash");
  const removedRebuilt = new Map<string, "trash" | "deleted">();
  for (const [entries, state] of [
    [deleted, "deleted"],
    [trashed, "trash"],
  ] as const) {
    for (const entry of entries) {
      const from = entry.record.hydratedFromProjectSourceId;
      if (from) removedRebuilt.set(from, state);
    }
  }

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
  const note = (
    record: ScientSourceRecord,
    against: ScientSourceRecord | null,
    relation: ScientLibraryJoinDifference["relation"],
    parts: ReadonlyArray<ScientLibraryJoinPart>,
  ) => {
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
  };

  for (const record of theirs) {
    const id = record.sourceId;
    const same = live.get(id);
    if (same) {
      note(record, same, "same-id", await differs(record, same));
      continue;
    }
    const survivor = live.get(resolveScientLibraryAlias(aliases, id));
    if (survivor) {
      note(record, survivor, "merged-here", await lacks(record, survivor, false));
      continue;
    }
    const gone = removed.get(id) ?? removed.get(resolveScientLibraryAlias(aliases, id));
    if (gone) {
      removedHere.push({ otherSourceId: id, state: gone });
      continue;
    }
    // A copy Scient rebuilt from a project stands for the source the project named.
    const from = record.hydratedFromProjectSourceId;
    const original = from ? live.get(resolveScientLibraryAlias(aliases, from)) : undefined;
    if (original) {
      note(record, original, "rebuilt-there", await lacks(record, original, false));
      continue;
    }
    const originalGone = from
      ? (removed.get(from) ?? removed.get(resolveScientLibraryAlias(aliases, from)))
      : undefined;
    const rebuiltGone = removedRebuilt.get(id);
    if (originalGone ?? rebuiltGone) {
      removedHere.push({ otherSourceId: id, state: (originalGone ?? rebuiltGone)! });
      continue;
    }
    const copy = rebuiltHere.get(id);
    if (copy) {
      note(record, copy, "rebuilt-here", await lacks(record, copy, true));
      continue;
    }
    const assessed = assessor.assess(candidateOf(record), record.attachments[0]?.sha256);
    if (assessed.kind === "new") {
      fresh.push(record);
      continue;
    }
    const sure =
      assessed.kind !== "possible-metadata-match" && assessed.matchingSourceIds.length === 1;
    const match = live.get(assessed.matchingSourceIds[0] ?? "") ?? null;
    note(
      record,
      match,
      sure && match ? "same-paper" : "possibly-same",
      match ? await lacks(record, match, true) : [],
    );
  }
  const goneThere = new Set(
    [...theirTrash, ...theirDeleted].map((entry) => entry.sourceId).filter((id) => live.has(id)),
  );
  return { fresh, different, removedHere, identical, removedThere: goneThere.size };
}

const joinDirectory = (libraryRoot: string, joinId: string) => {
  assertSafeIdentifier(joinId, "Join ID");
  return NodePath.join(libraryRoot, JOINS_DIRECTORY, joinId);
};
const partPath = (directory: string, number: number) =>
  NodePath.join(directory, `part-${String(number).padStart(5, "0")}.json`);

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

/** Copies a PDF by its hash, checking the bytes; a file already here is left. False when the other Library lacks it. */
async function copyPdf(from: string, to: string, sha256: string): Promise<boolean> {
  if (await exists(to)) return true;
  if (!(await exists(from))) return false;
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
    return true;
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

/**
 * Adds one source as the other Library has it: PDFs, highlights and earlier versions first,
 * the record last, created only if no file has its name. Caller holds the Library's lock.
 */
async function addSource(input: {
  readonly libraryRoot: string;
  readonly otherRoot: string;
  readonly record: ScientSourceRecord;
}): Promise<"added" | string> {
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
  for (const attachment of record.attachments) {
    await copyPdf(
      sourceAttachmentAbsolutePath(other, attachment),
      sourceAttachmentAbsolutePath(library, attachment),
      attachment.sha256,
    );
    const highlights = await fileBytes(annotationPath(otherRoot, attachment.sha256));
    const ours = annotationPath(libraryRoot, attachment.sha256);
    // Highlights on a PDF this Library already has stay as they are here.
    if (highlights && !(await exists(ours))) {
      await NodeFSP.mkdir(NodePath.dirname(ours), { recursive: true });
      await NodeFSP.writeFile(ours, highlights, { flag: "wx", mode: 0o600 }).catch(
        (error: unknown) => {
          if (!isNodeError(error, "EEXIST")) throw error;
        },
      );
    }
  }
  const history = NodePath.join(otherRoot, "history", id);
  for (const name of await NodeFSP.readdir(history).catch(() => [] as string[])) {
    if (!/^\d+\.json$/u.test(name)) continue;
    const version: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(history, name), "utf8"),
    );
    await atomicCreateJson(
      NodePath.join(libraryRoot, "history", id, name),
      version,
      MAX_RECORD_BYTES,
    );
  }
  const raw: unknown = JSON.parse(
    await NodeFSP.readFile(NodePath.join(otherRoot, "records", `${id}.json`), "utf8"),
  );
  // Written as the other Library keeps it, once it is known to be a record this Scient reads.
  decodePersistedScientSourceRecord(raw);
  return (await atomicCreateJson(recordPath, raw, MAX_RECORD_BYTES)) ? "added" : "it is here now";
}

/**
 * Settles a join that stopped part way: a part that never finished names what it meant to add,
 * and what of that is here in any form (live, in the Trash, deleted) is what it added. Decided
 * before any later join adds anything, so no source is ever counted for two joins.
 */
async function settleStopped(libraryRoot: string, joinId: string): Promise<void> {
  const header = await readHeader(libraryRoot, joinId).catch(() => null);
  if (header?.state !== "running") return;
  const directory = joinDirectory(libraryRoot, joinId);
  await withScientLibraryLock(libraryRoot, async () => {
    for (const part of await readParts(directory)) {
      if (part.state === "done") continue;
      const added: string[] = [];
      for (const planned of part.sources) {
        const name = `${planned.sourceId}.json`;
        const anywhere = await Promise.all(
          ["records", "trash", "deleted"].map((folder) =>
            exists(NodePath.join(libraryRoot, folder, name)),
          ),
        );
        if (anywhere.some(Boolean)) added.push(planned.sourceId);
      }
      const here = new Set(added);
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
    }
  | { readonly outcome: "stopped"; readonly joinId: string; readonly added: number }
  | { readonly outcome: "not-a-library" | "damaged" | "same-library" };

/**
 * Adds the sources another Library has that are certainly new here, each whole, and records
 * everything else it found as differences without changing anything that exists here. It can
 * be run again with the same folder: what is already here is no longer new. One join runs in a
 * Library at a time; the caller sees to that.
 */
export async function joinScientLibrary(input: {
  readonly library: ScientLibraryLocation;
  /** A backup folder, or a Library a restore moved aside. */
  readonly folder: string;
  readonly actor: ScientSourceActor;
  readonly onProgress?: (progress: { readonly done: number; readonly total: number }) => void;
  /** Asked between parts; true stops the join where it is. */
  readonly shouldStop?: () => boolean;
  /** Tests only: stops after this many sources of a part, as a killed process would. */
  readonly faults?: { readonly stopAfter?: number };
}): Promise<ScientLibraryJoinResult> {
  const source = await openScientLibraryJoinSource(input.library, input.folder);
  if (source.outcome !== "ready") return source;
  const libraryRoot = await NodeFSP.realpath(input.library.root);
  const library = scientLibraryLocation(libraryRoot);
  // One join at a time in a Library: any other that is marked running stopped part way.
  for (const joinId of await unfinishedJoins(libraryRoot)) await settleStopped(libraryRoot, joinId);
  const compared = await compareScientLibraries(library, source.root);
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
  };
  await writeHeader(header);

  const added: string[] = [];
  let skipped = 0;
  let done = 0;
  for (let start = 0, number = 1; start < compared.fresh.length; start += PART_SIZE, number += 1) {
    if (input.shouldStop?.()) return { outcome: "stopped", joinId, added: added.length };
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
      // Merged or removed here since the join looked: no longer new.
      const aliases = await readScientLibraryAliases(library);
      const partAdded: string[] = [];
      const partSkipped: Array<{ sourceId: string; why: string }> = [];
      for (const [index, record] of records.entries()) {
        if (input.faults?.stopAfter === index) throw new Error("Stopped (test fault).");
        const id = record.sourceId;
        const outcome =
          resolveScientLibraryAlias(aliases, id) !== id
            ? "it was merged here"
            : await addSource({ libraryRoot, otherRoot: source.root, record }).catch(
                (error: unknown) =>
                  error instanceof Error && error.message ? error.message : "it could not be read",
              );
        if (outcome === "added") partAdded.push(id);
        else partSkipped.push({ sourceId: id, why: outcome });
        done += 1;
        input.onProgress?.({ done, total: compared.fresh.length });
      }
      return { partAdded, partSkipped };
    });
    await atomicWriteJson(
      partPath(directory, number),
      { ...part, state: "done", added: settled.partAdded, skipped: settled.partSkipped },
      MAX_PART_BYTES,
    );
    added.push(...settled.partAdded);
    skipped += settled.partSkipped.length;
  }

  const collections = await placeInCollections({
    library,
    otherRoot: source.root,
    added: new Set(added),
    actor: input.actor,
  });
  await keepApart({ library, otherRoot: source.root, added: new Set(added), actor: input.actor });
  header = {
    ...header,
    state: "done",
    finishedAt: new Date().toISOString(),
    ...(collections.created.length + collections.extended.length > 0 ? { collections } : {}),
  };
  await writeHeader(header);
  return {
    outcome: "joined",
    joinId,
    added: added.length,
    skipped,
    different: compared.different.length,
    removedHere: compared.removedHere.length,
    removedThere: compared.removedThere,
    identical: compared.identical,
  };
}

/**
 * Puts the added sources where the other Library had them: into its collections, matched here
 * by name under the same parent, and made here when there is none. Only added sources are
 * placed; membership of sources this Library already had is not touched.
 */
async function placeInCollections(input: {
  readonly library: ScientLibraryLocation;
  readonly otherRoot: string;
  readonly added: ReadonlySet<string>;
  readonly actor: ScientSourceActor;
}): Promise<NonNullable<JoinHeader["collections"]>> {
  const created: string[] = [];
  const extended: Array<{ collectionId: string; sourceIds: ReadonlyArray<string> }> = [];
  if (input.added.size === 0) return { created, extended };
  const theirs = await readScientSourcesOrganization(scientLibraryLocation(input.otherRoot));
  const names = new Map(theirs.collections.map((entry) => [entry.collectionId, entry.name]));
  /** The other Library's collection ID → this Library's, for parents made or found here. */
  const here = new Map<string, string>();
  const ensure = async (
    collection: (typeof theirs.collections)[number],
    members: ReadonlyArray<string>,
  ): Promise<string | null> => {
    const parentName = collection.parentCollectionId
      ? names.get(collection.parentCollectionId)
      : undefined;
    let parentId: string | undefined;
    if (collection.parentCollectionId && parentName) {
      parentId =
        here.get(collection.parentCollectionId) ??
        (
          await createScientSourceCollection({
            root: input.library,
            name: parentName,
            actor: input.actor,
          }).then((change) => {
            if (change.outcome === "created" && change.collection) {
              created.push(change.collection.collectionId);
            }
            return change;
          })
        ).collection?.collectionId;
      if (parentId) here.set(collection.parentCollectionId, parentId);
    }
    const change = await createScientSourceCollection({
      root: input.library,
      name: collection.name,
      sourceIds: members,
      ...(parentId ? { parentCollectionId: parentId } : {}),
      actor: input.actor,
    });
    if (!change.collection) return null;
    if (change.outcome === "created") created.push(change.collection.collectionId);
    else if ("addedSourceIds" in change && change.addedSourceIds.length > 0) {
      extended.push({
        collectionId: change.collection.collectionId,
        sourceIds: change.addedSourceIds,
      });
    }
    return change.collection.collectionId;
  };
  // Parents first, so a child made here finds its parent.
  const ordered = theirs.collections.toSorted(
    (left, right) =>
      Number(Boolean(left.parentCollectionId)) - Number(Boolean(right.parentCollectionId)),
  );
  for (const collection of ordered) {
    const members = collection.sourceIds.filter((sourceId) => input.added.has(sourceId));
    if (members.length === 0) continue;
    const id = await ensure(collection, members);
    if (id) here.set(collection.collectionId, id);
  }
  return { created, extended };
}

/** "Not duplicates" decisions of the other Library about a source this join added. */
async function keepApart(input: {
  readonly library: ScientLibraryLocation;
  readonly otherRoot: string;
  readonly added: ReadonlySet<string>;
  readonly actor: ScientSourceActor;
}): Promise<void> {
  if (input.added.size === 0) return;
  const present = new Set((await listScientSourceRecords(input.library)).map((r) => r.sourceId));
  for (const pair of await readScientLibraryDistinctPairs(input.otherRoot).catch(() => [])) {
    const [first, second] = pair.sourceIds;
    if (!input.added.has(first) && !input.added.has(second)) continue;
    if (!present.has(first) || !present.has(second)) continue;
    await markScientLibrarySourcesDistinct({
      library: input.library,
      sourceIds: [first, second],
      reason: pair.reason,
      actor: input.actor,
    });
  }
}

export type ScientLibraryJoinUndo =
  | {
      readonly outcome: "undone";
      /** Sources the join added that were still as it left them: now in the Trash. */
      readonly trashed: number;
      /** Sources the join added that changed since, and collections still in use: left. */
      readonly left: number;
    }
  | { readonly outcome: "not-found" | "already-undone" };

/**
 * Takes a join back as far as nothing has changed since: each source it added goes to the
 * Trash only if it is exactly as the join left it; one that was edited, read, starred, given a
 * PDF or merged stays. A collection the join made is deleted once nothing here is in it.
 * In the Trash the sources count as removed here, so a later join does not add them again.
 */
export async function undoScientLibraryJoin(input: {
  readonly library: ScientLibraryLocation;
  readonly joinId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientLibraryJoinUndo> {
  const libraryRoot = await NodeFSP.realpath(input.library.root);
  const library = scientLibraryLocation(libraryRoot);
  await settleStopped(libraryRoot, input.joinId);
  const header = await readHeader(libraryRoot, input.joinId);
  if (!header) return { outcome: "not-found" };
  if (header.state === "undone") return { outcome: "already-undone" };
  const directory = joinDirectory(libraryRoot, input.joinId);
  let trashed = 0;
  let left = 0;
  for (const part of await readParts(directory)) {
    const planned = new Map(part.sources.map((entry) => [entry.sourceId, entry.fingerprint]));
    for (const sourceId of part.added) {
      const record = await readScientSourceRecord(library, sourceId);
      // Gone, merged away or changed in any way since: it is the person's now.
      if (!record || fingerprintOf(record) !== planned.get(sourceId)) {
        left += 1;
        continue;
      }
      const removed = await removeScientSource({
        root: library,
        sourceId,
        expectedRevision: record.revision,
        actor: input.actor,
      });
      if (removed.outcome === "removed") trashed += 1;
      else left += 1;
    }
  }
  const present = new Set((await listScientSourceRecords(library)).map((r) => r.sourceId));
  const organization = await readScientSourcesOrganization(library, present);
  // Children first, so a parent the join made is empty when its turn comes.
  for (const collectionId of (header.collections?.created ?? []).toReversed()) {
    const collection = organization.collections.find(
      (entry) => entry.collectionId === collectionId,
    );
    if (!collection) continue;
    const inUse =
      collection.sourceIds.some((sourceId) => present.has(sourceId)) ||
      organization.collections.some(
        (entry) =>
          entry.parentCollectionId === collectionId &&
          !(header.collections?.created ?? []).includes(entry.collectionId),
      );
    if (inUse) left += 1;
    else {
      await deleteScientSourceCollection({ root: library, collectionId, actor: input.actor }).catch(
        () => undefined,
      );
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
  readonly different: ReadonlyArray<ScientLibraryJoinDifference>;
  readonly removedHere: number;
  readonly removedThere: number;
  /** After Undo: what stayed because it changed since. */
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
    for (const part of parts) {
      if (part.state === "done") added += part.added.length;
      else {
        // A part that never finished: what of it is here is what it added.
        for (const planned of part.sources) {
          const path = NodePath.join(libraryRoot, "records", `${planned.sourceId}.json`);
          if (await exists(path)) added += 1;
        }
      }
    }
    joins.push({
      joinId,
      at: header.finishedAt ?? header.startedAt,
      by: header.by,
      other: header.other,
      state: header.state === "running" ? "stopped" : header.state,
      added,
      different: header.different,
      removedHere: header.removedHere.length,
      removedThere: header.removedThere,
      left: header.undone?.left ?? 0,
    });
  }
  return joins.toSorted((left, right) => right.at.localeCompare(left.at));
}
