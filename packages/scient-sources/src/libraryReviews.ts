// @effect-diagnostics nodeBuiltinImport:off -- Reviews and their snapshots are files in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { readScientSourcesOrganization } from "./collections.ts";
import {
  resolveScientProjectSources,
  scientSourceTypeFromSnapshot,
  type ScientProjectSourceResolution,
} from "./libraryInstanceMap.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import {
  ScientSourceAbstractSection,
  ScientSourceCreator,
  ScientSourceIdentifier,
  type ScientSourceActor,
  type ScientSourceRecord,
} from "./model.ts";
import { assertScientProjectDirectory } from "./projectFiles.ts";
import { listScientSourceRecords, scientSourceStoreInternals } from "./store.ts";
import { assertSafeIdentifier, atomicWriteJson, snapshot } from "./storeFiles.ts";
import {
  scientReviewPossibleDuplicates,
  scientReviewRecordIds,
  type ScientSystematicReview,
  type ScientSystematicReviewAction,
  type ScientSystematicReviewChangeResult,
  type ScientSystematicReviewDetail,
  type ScientSystematicReviewList,
} from "./systematicReview.ts";
import {
  scientSystematicReviewStoreInternals,
  type ScientReviewFolder,
} from "./systematicReviewStore.ts";

const LIBRARY_REVIEWS_DIRECTORY = ".scient/library/reviews";
const SNAPSHOT_SUFFIX = ".works.json";
const SHARD_DIRECTORY_SUFFIX = ".works";
const SHARD_THRESHOLD_BYTES = 32 * 1024 * 1024;
const MAX_REVIEW_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());
const NullableText = Schema.NullOr(Schema.String);
const {
  changeReviewIn,
  readReviewFile,
  readAllReviews,
  reviewList,
  reviewDetail,
  reviewsDirectory,
  reviewsDirectoryExists,
} = scientSystematicReviewStoreInternals;

/** What screening and counting read about one review record. No notes, tags, PDFs or full text. */
export const ScientReviewWork = Schema.Struct({
  // Plain text, so a type a newer Scient adds never hides the whole file.
  type: NonEmptyString,
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator).pipe(Schema.check(Schema.isMaxLength(256))),
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: Schema.Array(ScientSourceIdentifier).pipe(Schema.check(Schema.isMaxLength(256))),
  containerTitle: NullableText,
  abstract: NullableText,
  abstractSections: Schema.Array(ScientSourceAbstractSection).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  capturedAt: NonEmptyString,
  /** The library record's revision when captured; it stands in for it when the ID is unresolved. */
  capturedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientReviewWork = typeof ScientReviewWork.Type;

const SnapshotFileHeader = Schema.Struct({
  formatVersion: Schema.Literal(1),
  reviewId: NonEmptyString,
  records: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeSnapshotHeader = Schema.decodeUnknownSync(SnapshotFileHeader);
const decodeWork = Schema.decodeUnknownSync(ScientReviewWork);

type JsonObject = Readonly<Record<string, unknown>>;

interface StoredWork {
  readonly work: ScientReviewWork;
  /** Fields a newer Scient wrote, kept on every rewrite. */
  readonly extra: JsonObject;
}

interface SnapshotDocument {
  readonly entries: ReadonlyMap<string, StoredWork>;
  readonly extra: JsonObject;
  /** The file's bytes as read, or null when there is no file. */
  readonly text: string | null;
}

const EMPTY_DOCUMENT: SnapshotDocument = { entries: new Map(), extra: {}, text: null };
const WORK_FIELDS = Object.keys(ScientReviewWork.fields);
const FILE_FIELDS = Object.keys(SnapshotFileHeader.fields);

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function extraFields(value: unknown, known: ReadonlyArray<string>): JsonObject {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)));
}

function sortedExtra(extra: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.keys(extra)
      .toSorted()
      .map((key) => [key, extra[key]]),
  );
}

const codeUnitOrder = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function encodeWork(work: ScientReviewWork, extra: JsonObject) {
  return {
    type: work.type,
    title: work.title,
    creators: work.creators.map((creator) => ({
      creatorType: creator.creatorType,
      givenName: creator.givenName,
      familyName: creator.familyName,
      literalName: creator.literalName,
    })),
    issuedYear: work.issuedYear,
    identifiers: work.identifiers.map((identifier) => ({
      scheme: identifier.scheme,
      value: identifier.value,
    })),
    containerTitle: work.containerTitle,
    abstract: work.abstract,
    abstractSections: work.abstractSections.map((section) => ({
      title: section.title,
      paragraphs: section.paragraphs,
    })),
    capturedAt: work.capturedAt,
    capturedRevision: work.capturedRevision,
    ...sortedExtra(extra),
  };
}

/** Keys in code-unit order and fields in a fixed order, so equal content is equal bytes. */
function encodeSnapshot(reviewId: string, document: Pick<SnapshotDocument, "entries" | "extra">) {
  return {
    formatVersion: 1,
    reviewId,
    records: Object.fromEntries(
      [...document.entries]
        .toSorted(([left], [right]) => codeUnitOrder(left, right))
        .map(([sourceId, { work, extra }]) => [sourceId, encodeWork(work, extra)]),
    ),
    ...sortedExtra(document.extra),
  };
}

function libraryFolder(root: string): ScientReviewFolder {
  return { root, directory: LIBRARY_REVIEWS_DIRECTORY, siblingSuffix: SNAPSHOT_SUFFIX };
}

function snapshotPath(folder: ScientReviewFolder, reviewId: string): string {
  assertSafeIdentifier(reviewId, "Review ID");
  return NodePath.join(reviewsDirectory(folder), `${reviewId}${SNAPSHOT_SUFFIX}`);
}

function shardDirectory(folder: ScientReviewFolder, reviewId: string): string {
  assertSafeIdentifier(reviewId, "Review ID");
  return NodePath.join(reviewsDirectory(folder), `${reviewId}${SHARD_DIRECTORY_SUFFIX}`);
}

/** One hex digit of the ID's SHA-256: sixteen shards whatever form the project's IDs take. */
function shardOf(sourceId: string): string {
  return NodeCrypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 1);
}

const formatJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

type SnapshotRead = SnapshotDocument | { readonly broken: true };

async function readSnapshotDocument(filePath: string, reviewId: string): Promise<SnapshotRead> {
  const state = await snapshot(filePath);
  if (state === "missing") return EMPTY_DOCUMENT;
  if (state !== "file") throw new Error("The review snapshot is not a safe regular file.");
  const stats = await NodeFSP.lstat(filePath);
  if (stats.size > MAX_REVIEW_SNAPSHOT_BYTES) {
    throw new Error("The review snapshot exceeds the safe size limit.");
  }
  const text = await NodeFSP.readFile(filePath, "utf8");
  try {
    const value: unknown = JSON.parse(text);
    const header = decodeSnapshotHeader(value);
    if (header.reviewId !== reviewId) return { broken: true };
    return {
      entries: new Map(
        Object.entries(header.records).map(([sourceId, raw]) => [
          sourceId,
          { work: decodeWork(raw), extra: extraFields(raw, WORK_FIELDS) },
        ]),
      ),
      extra: extraFields(value, FILE_FIELDS),
      text,
    };
  } catch {
    return { broken: true };
  }
}

/**
 * A review's snapshot: one file, or sixteen shard files once one file would pass 32 MiB. A crash
 * while sharding can leave both; shard entries win and the next write removes the single file.
 */
interface SnapshotState {
  readonly single: SnapshotDocument;
  readonly shards: ReadonlyMap<string, SnapshotDocument> | null;
  readonly entries: ReadonlyMap<string, StoredWork>;
}

const EMPTY_STATE: SnapshotState = { single: EMPTY_DOCUMENT, shards: null, entries: new Map() };

function mergedEntries(documents: Iterable<SnapshotDocument>): ReadonlyMap<string, StoredWork> {
  const entries = new Map<string, StoredWork>();
  for (const document of documents) {
    for (const [sourceId, stored] of document.entries) entries.set(sourceId, stored);
  }
  return entries;
}

/**
 * Reads the snapshot. A file that does not decode is read as empty; with `write` it is also set
 * aside as `<name>.broken-<time>`, and the caller rebuilds what this computer's library resolves.
 */
async function readSnapshotState(
  folder: ScientReviewFolder,
  reviewId: string,
  mode: Mode,
): Promise<SnapshotState> {
  if (!(await reviewsDirectoryExists(folder))) return EMPTY_STATE;
  const readOrSetAside = async (filePath: string) => {
    const read = await readSnapshotDocument(filePath, reviewId);
    if (!("broken" in read)) return read;
    if (mode === "write") {
      const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      await NodeFSP.rename(filePath, `${filePath}.broken-${stamp}`);
    }
    return EMPTY_DOCUMENT;
  };
  const single = await readOrSetAside(snapshotPath(folder, reviewId));
  const directory = shardDirectory(folder, reviewId);
  const directoryState = await snapshot(directory);
  if (directoryState === "missing") return { single, shards: null, entries: single.entries };
  if (directoryState !== "directory") {
    throw new Error("The review snapshot folder is not a safe directory.");
  }
  const shards = new Map<string, SnapshotDocument>();
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const shard = /^([0-9a-f])\.json$/u.exec(entry.name)?.[1];
    if (!entry.isFile() || !shard) continue;
    shards.set(shard, await readOrSetAside(NodePath.join(directory, entry.name)));
  }
  return { single, shards, entries: mergedEntries([single, ...shards.values()]) };
}

const NOT_SAVED = "The review's record snapshot could not be saved. Try again.";

async function writeSnapshotDocument(
  filePath: string,
  reviewId: string,
  encoded: unknown,
): Promise<SnapshotDocument> {
  await atomicWriteJson(filePath, encoded, MAX_REVIEW_SNAPSHOT_BYTES);
  const published = await readSnapshotDocument(filePath, reviewId);
  if ("broken" in published) throw new Error(NOT_SAVED);
  return published;
}

function assertPublished(
  entries: ReadonlyMap<string, StoredWork>,
  required: ReadonlyArray<string>,
): void {
  if (required.some((sourceId) => !entries.has(sourceId))) throw new Error(NOT_SAVED);
}

/**
 * Publishes the entries, each file through a synced temporary file renamed over the old one, and
 * reads every written file back. Writes only files whose bytes change; returns `current` when
 * none did. Entries are only added or refreshed, so a crash between shard files loses nothing.
 */
async function publishSnapshot(
  folder: ScientReviewFolder,
  reviewId: string,
  current: SnapshotState,
  entries: ReadonlyMap<string, StoredWork>,
  required: ReadonlyArray<string>,
): Promise<SnapshotState> {
  if (current.shards === null) {
    const encoded = encodeSnapshot(reviewId, { entries, extra: current.single.extra });
    const text = formatJson(encoded);
    if (Buffer.byteLength(text, "utf8") <= SHARD_THRESHOLD_BYTES) {
      if (current.single.text === text) return current;
      const single = await writeSnapshotDocument(snapshotPath(folder, reviewId), reviewId, encoded);
      assertPublished(single.entries, required);
      return { single, shards: null, entries: single.entries };
    }
  }
  const groups = new Map<string, Map<string, StoredWork>>();
  for (const [sourceId, stored] of entries) {
    const shard = shardOf(sourceId);
    const group = groups.get(shard) ?? new Map<string, StoredWork>();
    group.set(sourceId, stored);
    groups.set(shard, group);
  }
  const directory = shardDirectory(folder, reviewId);
  await assertScientProjectDirectory(folder.root, directory, { create: true });
  const shards = new Map(current.shards ?? []);
  let changed = false;
  for (const shard of [...new Set([...groups.keys(), ...shards.keys()])].toSorted()) {
    const existing = shards.get(shard);
    const encoded = encodeSnapshot(reviewId, {
      entries: groups.get(shard) ?? new Map(),
      // Fields a newer Scient put on the single file go to every shard.
      extra: existing?.extra ?? current.single.extra,
    });
    if (existing?.text === formatJson(encoded)) continue;
    const filePath = NodePath.join(directory, `${shard}.json`);
    shards.set(shard, await writeSnapshotDocument(filePath, reviewId, encoded));
    changed = true;
  }
  const merged = mergedEntries(shards.values());
  assertPublished(merged, required);
  if (current.single.text !== null) {
    await NodeFSP.rm(snapshotPath(folder, reviewId), { force: true });
    changed = true;
  }
  return changed ? { single: EMPTY_DOCUMENT, shards, entries: merged } : current;
}

/** Every source ID the review names: records, duplicates, distinct pairs, screening, retrieval. */
function scientReviewNamedIds(review: ScientSystematicReview): ReadonlyArray<string> {
  return [
    ...new Set([
      ...scientReviewRecordIds(review),
      ...review.duplicates.flatMap((entry) => [entry.sourceId, entry.duplicateOf]),
      ...review.distinctPairs.flat(),
      ...review.screening.map((entry) => entry.sourceId),
      ...(review.retrieval ?? []).map((entry) => entry.sourceId),
    ]),
  ];
}

function workFromRecord(record: ScientSourceRecord, capturedAt: string): ScientReviewWork {
  return {
    type: record.type,
    title: record.title,
    creators: record.creators,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    containerTitle: record.containerTitle,
    abstract: record.abstract,
    abstractSections: record.abstractSections ?? [],
    capturedAt,
    capturedRevision: record.revision,
  };
}

const workContent = ({
  capturedAt: _at,
  capturedRevision: _revision,
  ...content
}: ScientReviewWork) =>
  JSON.stringify(encodeWork({ ...content, capturedAt: "-", capturedRevision: 1 }, {}));

/** Library values win, but a field the library lacks keeps the snapshot's (an imported abstract). */
function refreshedWork(
  existing: ScientReviewWork,
  record: ScientSourceRecord,
  now: string,
): ScientReviewWork {
  const fresh = workFromRecord(record, now);
  const next: ScientReviewWork = {
    ...fresh,
    title: fresh.title ?? existing.title,
    creators: fresh.creators.length > 0 ? fresh.creators : existing.creators,
    issuedYear: fresh.issuedYear ?? existing.issuedYear,
    identifiers: fresh.identifiers.length > 0 ? fresh.identifiers : existing.identifiers,
    containerTitle: fresh.containerTitle ?? existing.containerTitle,
    ...(fresh.abstract === null
      ? { abstract: existing.abstract, abstractSections: existing.abstractSections }
      : {}),
  };
  return workContent(next) === workContent(existing) ? existing : next;
}

async function projectRootFor(projectRoot: string): Promise<string> {
  const root = await NodeFSP.realpath(projectRoot);
  await readScientProjectIdentity(root);
  return root;
}

function withReviewsLock<A>(root: string, run: () => Promise<A>): Promise<A> {
  return scientSourceStoreInternals.withOperationLock(`${root}:reviews-write`, run);
}

type Mode = "read" | "write";

/** A read may name no library (none on this computer yet): every record then comes from the snapshot. */
type ReviewAccess =
  | { readonly library: ScientLibraryLocation; readonly mode: Mode }
  | { readonly library: null; readonly mode: "read" };

interface Resolved {
  readonly resolutions: ReadonlyMap<string, ScientProjectSourceResolution>;
  readonly records: ReadonlyMap<string, ScientSourceRecord>;
}

async function resolveReviewIds(
  input: ReviewAccess & {
    readonly root: string;
    readonly sourceIds: ReadonlyArray<string>;
    readonly entries: ReadonlyMap<string, StoredWork>;
  },
): Promise<Resolved> {
  if (input.library === null) return { resolutions: new Map(), records: new Map() };
  const resolutions = await resolveScientProjectSources({
    library: input.library,
    projectRoot: input.root,
    mode: input.mode,
    sources: input.sourceIds.map((projectSourceId) => ({
      projectSourceId,
      work: input.entries.get(projectSourceId)?.work ?? null,
    })),
  });
  const records = await listScientSourceRecords(input.library);
  return {
    resolutions: new Map(resolutions.map((resolution) => [resolution.projectSourceId, resolution])),
    records: new Map(records.map((record) => [record.sourceId, record])),
  };
}

const reviewAccess = (input: ReviewAccess): ReviewAccess =>
  input.library === null
    ? { library: null, mode: "read" }
    : { library: input.library, mode: input.mode };

function libraryRecordFor(resolved: Resolved, sourceId: string): ScientSourceRecord | undefined {
  const resolution = resolved.resolutions.get(sourceId);
  return resolution?.kind === "resolved" ? resolved.records.get(resolution.sourceId) : undefined;
}

const wasRemoved = (resolution: ScientProjectSourceResolution | undefined) =>
  resolution?.kind === "unresolved" && resolution.reason === "removed";

/**
 * Every ID the review names counts, from the library, the snapshot, or with its details missing.
 * Only a record removed from this computer's library is left out, as the project store does.
 */
function presentIds(review: ScientSystematicReview, resolved: Resolved): ReadonlySet<string> {
  return new Set(
    scientReviewNamedIds(review).filter(
      (sourceId) => !wasRemoved(resolved.resolutions.get(sourceId)),
    ),
  );
}

/** Adds an entry for each named ID that has none and that this computer's library resolves. */
function filledEntries(
  review: ScientSystematicReview,
  entries: ReadonlyMap<string, StoredWork>,
  resolved: Resolved,
  now: string,
): ReadonlyMap<string, StoredWork> {
  const next = new Map(entries);
  for (const sourceId of scientReviewNamedIds(review)) {
    if (next.has(sourceId)) continue;
    const record = libraryRecordFor(resolved, sourceId);
    if (record) next.set(sourceId, { work: workFromRecord(record, now), extra: {} });
  }
  return next;
}

/**
 * The library-mode entry point for review changes. Same rules as `changeScientSystematicReview`;
 * before any write that names a new source ID, the review's record snapshot is published and read
 * back, so a review never names a record its snapshot lacks. Nothing calls this until the switch.
 */
export async function changeScientLibraryReview(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly change: ScientSystematicReviewAction;
  readonly actor: ScientSourceActor;
}): Promise<ScientSystematicReviewChangeResult> {
  const root = await projectRootFor(input.projectRoot);
  const folder = libraryFolder(root);
  let document = EMPTY_STATE;
  let resolved: Resolved = { resolutions: new Map(), records: new Map() };
  return changeReviewIn(
    folder,
    {
      context: async (review, change) => {
        const collectionMembers =
          change.action === "log-search" && change.collectionId
            ? ((await readScientSourcesOrganization(input.library)).collections.find(
                (collection) => collection.collectionId === change.collectionId,
              )?.sourceIds ?? null)
            : [];
        const incoming =
          change.action === "log-search"
            ? [...(change.sourceIds ?? []), ...(collectionMembers ?? [])]
            : change.action === "add-sources"
              ? change.sourceIds
              : [];
        if (review) document = await readSnapshotState(folder, review.reviewId, "write");
        const named = review ? scientReviewNamedIds(review) : [];
        resolved = await resolveReviewIds({
          library: input.library,
          root,
          mode: "write",
          sourceIds: [...new Set([...named, ...incoming])],
          entries: document.entries,
        });
        const present = new Set(review ? presentIds(review, resolved) : []);
        for (const sourceId of incoming) {
          if (resolved.resolutions.get(sourceId)?.kind === "resolved") present.add(sourceId);
        }
        return { present, collectionMembers };
      },
      beforeReviewWrite: async ({ previous, next }) => {
        if (!previous && next) {
          await publishSnapshot(folder, next.reviewId, EMPTY_STATE, new Map(), []);
          return;
        }
        const review = next ?? previous;
        if (!review) return;
        // Only create-review, log-search and add-sources add records; each new one needs an entry.
        const before = new Set(previous ? scientReviewRecordIds(previous) : []);
        const added = next ? scientReviewRecordIds(next).filter((id) => !before.has(id)) : [];
        await publishSnapshot(
          folder,
          review.reviewId,
          document,
          filledEntries(review, document.entries, resolved, new Date().toISOString()),
          added,
        );
      },
    },
    input,
  );
}

/** One review record as a review screen shows it. */
export interface ScientLibraryReviewRecord {
  /** The ID the review stores. */
  readonly projectSourceId: string;
  /**
   * `library`: this computer's record. `snapshot`: the review's snapshot, under the project
   * source ID with `capturedRevision` as its revision. `missing`: neither, "Details missing".
   */
  readonly from: "library" | "snapshot" | "missing";
  readonly record: ScientSourceRecord | null;
  /** Where the abstract came from; the snapshot's when the library record has none. */
  readonly abstractFrom: "library" | "snapshot" | null;
  /** Removed from this computer's library: shown, but not screened or counted. */
  readonly removed: boolean;
}

function recordFromWork(projectSourceId: string, work: ScientReviewWork): ScientSourceRecord {
  return {
    formatVersion: 2,
    sourceId: projectSourceId,
    revision: work.capturedRevision,
    type: scientSourceTypeFromSnapshot(work.type),
    title: work.title,
    creators: work.creators,
    issuedRaw: work.issuedYear === null ? null : String(work.issuedYear),
    issuedYear: work.issuedYear,
    identifiers: work.identifiers,
    abstract: work.abstract,
    ...(work.abstractSections.length > 0 ? { abstractSections: work.abstractSections } : {}),
    containerTitle: work.containerTitle,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: work.capturedAt,
  };
}

function reviewRecord(
  projectSourceId: string,
  entries: ReadonlyMap<string, StoredWork>,
  resolved: Resolved,
): ScientLibraryReviewRecord {
  const work = entries.get(projectSourceId)?.work;
  const removed = wasRemoved(resolved.resolutions.get(projectSourceId));
  const library = libraryRecordFor(resolved, projectSourceId);
  if (library) {
    if (library.abstract === null && work?.abstract) {
      return {
        projectSourceId,
        from: "library",
        record: {
          ...library,
          abstract: work.abstract,
          ...(work.abstractSections.length > 0 ? { abstractSections: work.abstractSections } : {}),
        },
        abstractFrom: "snapshot",
        removed,
      };
    }
    return {
      projectSourceId,
      from: "library",
      record: library,
      abstractFrom: library.abstract === null ? null : "library",
      removed,
    };
  }
  if (work) {
    return {
      projectSourceId,
      from: "snapshot",
      record: recordFromWork(projectSourceId, work),
      abstractFrom: work.abstract === null ? null : "snapshot",
      removed,
    };
  }
  return { projectSourceId, from: "missing", record: null, abstractFrom: null, removed };
}

interface ReviewView {
  readonly review: ScientSystematicReview;
  readonly entries: ReadonlyMap<string, StoredWork>;
  readonly resolved: Resolved;
}

/**
 * Loads a live review with its snapshot and resolutions. `write` also records resolutions and
 * fills entries for named IDs that have none; `read` writes nothing at all.
 */
async function loadReview(
  input: ReviewAccess & { readonly projectRoot: string; readonly reviewId: string },
): Promise<ReviewView | null> {
  const root = await projectRootFor(input.projectRoot);
  const folder = libraryFolder(root);
  const load = async (): Promise<ReviewView | null> => {
    const review = await readReviewFile(folder, input.reviewId);
    if (!review || review.deletedAt !== undefined) return null;
    const document = await readSnapshotState(folder, review.reviewId, input.mode);
    const resolved = await resolveReviewIds({
      ...reviewAccess(input),
      root,
      sourceIds: scientReviewNamedIds(review),
      entries: document.entries,
    });
    if (input.mode === "read") return { review, entries: document.entries, resolved };
    const published = await publishSnapshot(
      folder,
      review.reviewId,
      document,
      filledEntries(review, document.entries, resolved, new Date().toISOString()),
      [],
    );
    return { review, entries: published.entries, resolved };
  };
  return input.mode === "write" ? withReviewsLock(root, load) : load();
}

/** Pairs by title, plus pairs whose IDs now resolve to one library record (after a merge). */
function possibleDuplicates(
  view: ReviewView,
  records: ReadonlyArray<ScientLibraryReviewRecord>,
): ScientSystematicReviewDetail["possibleDuplicates"] {
  const { review, resolved } = view;
  const byTitle = scientReviewPossibleDuplicates(
    review,
    records.flatMap(({ projectSourceId, record }) =>
      record
        ? [
            {
              sourceId: projectSourceId,
              title: record.title,
              creators: record.creators,
              issuedYear: record.issuedYear,
            },
          ]
        : [],
    ),
  );
  const pairKey = (pair: readonly [string, string]) => [...pair].toSorted().join("\0");
  const seen = new Set([...byTitle, ...review.distinctPairs].map(pairKey));
  const marked = new Set(review.duplicates.map((entry) => entry.sourceId));
  const byTarget = new Map<string, string[]>();
  for (const sourceId of scientReviewRecordIds(review)) {
    const resolution = resolved.resolutions.get(sourceId);
    if (resolution?.kind !== "resolved" || marked.has(sourceId)) continue;
    byTarget.set(resolution.sourceId, [...(byTarget.get(resolution.sourceId) ?? []), sourceId]);
  }
  const shared: Array<readonly [string, string]> = [];
  for (const group of byTarget.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const pair = [group[left]!, group[right]!] as const;
        if (!seen.has(pairKey(pair))) shared.push(pair);
      }
    }
  }
  return [...byTitle, ...shared];
}

function recordsOf(view: ReviewView): ReadonlyArray<ScientLibraryReviewRecord> {
  return scientReviewRecordIds(view.review).map((sourceId) =>
    reviewRecord(sourceId, view.entries, view.resolved),
  );
}

/** A review with PRISMA counts; records served from the snapshot are screened and counted. */
export async function readScientLibraryReview(
  input: ReviewAccess & { readonly projectRoot: string; readonly reviewId: string },
): Promise<ScientSystematicReviewDetail | null> {
  const view = await loadReview(input);
  if (!view) return null;
  return reviewDetail(
    view.review,
    presentIds(view.review, view.resolved),
    possibleDuplicates(view, recordsOf(view)),
  );
}

/** The review's records in the order they entered it. */
export async function listScientLibraryReviewRecords(
  input: ReviewAccess & { readonly projectRoot: string; readonly reviewId: string },
): Promise<ReadonlyArray<ScientLibraryReviewRecord> | null> {
  const view = await loadReview(input);
  return view ? recordsOf(view) : null;
}

/** One record a review names, for the screening panel; null when the review does not name it. */
export async function readScientLibraryReviewRecord(
  input: ReviewAccess & {
    readonly projectRoot: string;
    readonly reviewId: string;
    readonly sourceId: string;
  },
): Promise<ScientLibraryReviewRecord | null> {
  const view = await loadReview(input);
  if (!view || !scientReviewNamedIds(view.review).includes(input.sourceId)) return null;
  return reviewRecord(input.sourceId, view.entries, view.resolved);
}

/**
 * Live reviews, newest change first. With `write`, a snapshot whose review was never created
 * (a crash between the two) is removed.
 */
export async function listScientLibraryReviews(
  input: ReviewAccess & { readonly projectRoot: string },
): Promise<ScientSystematicReviewList> {
  const root = await projectRootFor(input.projectRoot);
  const folder = libraryFolder(root);
  const list = async () => {
    const { reviews, issues } = await readAllReviews(folder);
    const present = new Map<string, ReadonlySet<string>>();
    for (const review of reviews) {
      if (review.deletedAt !== undefined) continue;
      const document = await readSnapshotState(folder, review.reviewId, "read");
      const resolved = await resolveReviewIds({
        ...reviewAccess(input),
        root,
        sourceIds: scientReviewNamedIds(review),
        entries: document.entries,
      });
      present.set(review.reviewId, presentIds(review, resolved));
    }
    if (input.mode === "write") await removeOrphanSnapshots(folder, reviews);
    return reviewList(reviews, issues, (review) => present.get(review.reviewId) ?? new Set());
  };
  return input.mode === "write" ? withReviewsLock(root, list) : list();
}

async function removeOrphanSnapshots(
  folder: ScientReviewFolder,
  reviews: ReadonlyArray<ScientSystematicReview>,
): Promise<void> {
  if (!(await reviewsDirectoryExists(folder))) return;
  const reviewIds = new Set(reviews.map((review) => review.reviewId));
  const directory = reviewsDirectory(folder);
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const suffix = entry.isFile()
      ? SNAPSHOT_SUFFIX
      : entry.isDirectory()
        ? SHARD_DIRECTORY_SUFFIX
        : null;
    if (!suffix || !entry.name.endsWith(suffix)) continue;
    const reviewId = entry.name.slice(0, -suffix.length);
    if (reviewIds.has(reviewId)) continue;
    // A review file that exists but does not decode is not proof the review was never created.
    if ((await snapshot(NodePath.join(directory, `${reviewId}.json`))) !== "missing") continue;
    await NodeFSP.rm(NodePath.join(directory, entry.name), { recursive: true, force: true });
  }
}

/**
 * Refreshes the review's snapshot from this computer's library. A field the library lacks keeps
 * the snapshot's value; entries the review no longer names are dropped. Writes nothing when
 * nothing changed.
 */
export async function refreshScientLibraryReviewSnapshot(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly reviewId: string;
}): Promise<{ readonly changed: boolean } | null> {
  const root = await projectRootFor(input.projectRoot);
  const folder = libraryFolder(root);
  return withReviewsLock(root, async () => {
    const review = await readReviewFile(folder, input.reviewId);
    if (!review) return null;
    const document = await readSnapshotState(folder, review.reviewId, "write");
    const named = scientReviewNamedIds(review);
    const resolved = await resolveReviewIds({
      library: input.library,
      root,
      mode: "write",
      sourceIds: named,
      entries: document.entries,
    });
    const now = new Date().toISOString();
    const entries = new Map<string, StoredWork>();
    for (const sourceId of named) {
      const stored = document.entries.get(sourceId);
      const record = libraryRecordFor(resolved, sourceId);
      if (stored && record) {
        const work = refreshedWork(stored.work, record, now);
        entries.set(sourceId, work === stored.work ? stored : { ...stored, work });
      } else if (stored) {
        entries.set(sourceId, stored);
      } else if (record) {
        entries.set(sourceId, { work: workFromRecord(record, now), extra: {} });
      }
    }
    const published = await publishSnapshot(folder, review.reviewId, document, entries, []);
    return { changed: published !== document };
  });
}
