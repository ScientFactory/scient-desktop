// @effect-diagnostics nodeBuiltinImport:off -- Merges write the personal library's files.
// @effect-diagnostics globalDate:off -- Library files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { scientSourceCollectionsInternals } from "./collections.ts";
import {
  readLibraryAliasesAt,
  resolveScientLibraryAlias,
  writeLibraryAliasesAt,
} from "./libraryAliases.ts";
import {
  assessScientLibraryDuplicates,
  compareScientLibrarySurvivors,
  pairKey,
  scientLibraryJoiningLink,
  type ScientLibraryPossibleDuplicate,
} from "./libraryDuplicates.ts";
import {
  readScientLibraryDistinctPairs,
  readScientLibraryMergeReceipts,
  SCIENT_LIBRARY_MAX_DISTINCT_PAIRS_BYTES,
  SCIENT_LIBRARY_MAX_MERGE_BYTES,
  SCIENT_LIBRARY_MERGES_DIRECTORY,
  scientLibraryDistinctPairsPath,
  scientLibraryExclusionsFrom,
  type ScientLibraryDamagedReceipt,
  type ScientLibraryDistinctPair,
} from "./libraryExclusions.ts";
import { ScientLibraryMerge } from "./libraryMergeReceipt.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import {
  ScientSourceActor,
  ScientSourceExternalReference,
  ScientSourceIdentifier,
  ScientSourceZoteroSync,
  scientSourceReadingState,
  type ScientSourceRecord,
} from "./model.ts";
import { normalizePersistentIdentifier } from "./normalize.ts";
import { scientSourceTagKey } from "./organize.ts";
import { workLevelIdentifierKey } from "./sourceIdentity.ts";
import { scientSourceStoreInternals } from "./store.ts";

const {
  sourceStorePaths,
  withStoreLock,
  readSourceRecordFromPaths,
  readScientSourceRecordIfPresent,
  listScientSourceRecordsFromPaths,
  persistSourceRevision,
  moveRecordToTrash,
  restoreTrashedRecord,
  readTrashEntry,
  zoteroSyncPath,
  maxRecordBytes,
  snapshot,
  readBoundedJson,
  atomicWriteJson,
  assertSafeIdentifier,
} = scientSourceStoreInternals;
const { rewriteLibraryCollections } = scientSourceCollectionsInternals;
type StorePaths = Awaited<ReturnType<typeof sourceStorePaths>>;

const MERGES_DIRECTORY = SCIENT_LIBRARY_MERGES_DIRECTORY;
const PENDING_MERGES_DIRECTORY = "pending";
const MAX_MERGE_BYTES = SCIENT_LIBRARY_MAX_MERGE_BYTES;

export { ScientLibraryMerge };
type MergeKind = ScientLibraryMerge["kind"];

export type { ScientLibraryDistinctPair };

/** Bibliographic fields: an empty one takes the loser's value, a different one is reported. */
const REPORTED_FIELDS = [
  "type",
  "customType",
  "title",
  "creators",
  "issuedRaw",
  "issuedYear",
  "abstract",
  "containerTitle",
  "publisher",
  "volume",
  "issue",
  "pages",
  "language",
  "url",
] as const;
/**
 * Filled when empty, never reported: keys are unique so they always differ, and the survivor is
 * the record with the latest registry check.
 */
const SILENT_FIELDS = ["citationKey", "verification", "editorialStatus"] as const;

type MutableRecord = Record<string, unknown>;

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function identifierKey(identifier: ScientSourceIdentifier): string {
  return (
    workLevelIdentifierKey(identifier.scheme, identifier.value) ??
    normalizePersistentIdentifier(identifier.scheme, identifier.value)
  );
}

const referenceKey = (reference: ScientSourceExternalReference) =>
  `${reference.system}\0${reference.libraryId}\0${reference.itemKey}`;

function noteSection(record: ScientSourceRecord, labels: ReadonlyMap<string, string> | undefined) {
  const label = labels?.get(record.sourceId) ?? record.citationKey ?? record.sourceId;
  return `From ${label}:\n${record.note!.trim()}`;
}

interface MergePlan {
  readonly next: ScientSourceRecord;
  readonly changes: ScientLibraryMerge["changes"];
  readonly added: ScientLibraryMerge["added"];
  readonly conflicts: ScientLibraryMerge["conflicts"];
}

/** The field rule of the design: what the survivor looks like once the loser is merged into it. */
function planMerge(
  survivor: ScientSourceRecord,
  loser: ScientSourceRecord,
  labels: ReadonlyMap<string, string> | undefined,
): MergePlan {
  const current = survivor as unknown as MutableRecord;
  const other = loser as unknown as MutableRecord;
  const next: MutableRecord = { ...current };
  const changes: Array<ScientLibraryMerge["changes"][number]> = [];
  const conflicts: Array<ScientLibraryMerge["conflicts"][number]> = [];
  const set = (field: string, after: unknown) => {
    changes.push({
      field,
      ...(current[field] === undefined ? {} : { before: current[field] }),
      ...(after === undefined ? {} : { after }),
    });
    if (after === undefined) delete next[field];
    else next[field] = after;
  };
  const filled: string[] = [];
  for (const field of [...REPORTED_FIELDS, ...SILENT_FIELDS]) {
    const kept = current[field];
    const offered = other[field];
    if (isEmptyValue(offered) || same(kept, offered)) continue;
    if (isEmptyValue(kept)) {
      set(field, offered);
      filled.push(field);
    } else if ((REPORTED_FIELDS as ReadonlyArray<string>).includes(field)) {
      conflicts.push({ field, kept, other: offered });
    }
  }
  // Sections only describe the abstract they were parsed from.
  if (
    isEmptyValue(current.abstractSections) &&
    !isEmptyValue(loser.abstractSections) &&
    same(next.abstract, loser.abstract)
  ) {
    set("abstractSections", loser.abstractSections);
  }
  const keptNote = survivor.note?.trim() ? survivor.note : null;
  const offeredNote = loser.note?.trim() ? loser.note : null;
  if (offeredNote && keptNote?.trim() !== offeredNote.trim()) {
    set(
      "note",
      keptNote ? `${noteSection(survivor, labels)}\n\n${noteSection(loser, labels)}` : offeredNote,
    );
  }

  // Read if either was read, starred if either was; Undo puts the survivor's own values back.
  const keptState = scientSourceReadingState(survivor);
  const offeredState = scientSourceReadingState(loser);
  if (keptState && offeredState) {
    if (offeredState.readingStatus === "read" && keptState.readingStatus !== "read") {
      set("readingStatus", "read");
    }
    if (offeredState.starred && !keptState.starred) set("starred", true);
  }

  const tagKeys = new Set(survivor.tags.map(scientSourceTagKey));
  const tags = loser.tags.filter((tag) => {
    const key = scientSourceTagKey(tag);
    if (!key || tagKeys.has(key)) return false;
    tagKeys.add(key);
    return true;
  });

  const identifierKeys = new Set(survivor.identifiers.map(identifierKey));
  const identifiers: ScientSourceIdentifier[] = [];
  for (const identifier of loser.identifiers) {
    const key = identifierKey(identifier);
    if (identifierKeys.has(key)) continue;
    const scheme = key.slice(0, key.indexOf(":"));
    // A second DOI or PMID would say the record is two works; keep the survivor's and report.
    const keptOfScheme = survivor.identifiers.filter(
      (entry) =>
        workLevelIdentifierKey(entry.scheme, entry.value) !== null &&
        identifierKey(entry).startsWith(`${scheme}:`),
    );
    if (keptOfScheme.length > 0) {
      conflicts.push({ field: "identifiers", kept: keptOfScheme, other: identifier });
      continue;
    }
    identifierKeys.add(key);
    identifiers.push(identifier);
  }

  const hashes = new Set(survivor.attachments.map((attachment) => attachment.sha256));
  const attachments = loser.attachments.filter((attachment) => {
    if (hashes.has(attachment.sha256)) return false;
    hashes.add(attachment.sha256);
    return true;
  });
  const referenceKeys = new Set(survivor.externalReferences.map(referenceKey));
  const externalReferences = loser.externalReferences.filter((reference) => {
    if (referenceKeys.has(referenceKey(reference))) return false;
    referenceKeys.add(referenceKey(reference));
    return true;
  });
  const fieldProvenance = loser.fieldProvenance.filter((entry) => filled.includes(entry.field));

  next.tags = [...survivor.tags, ...tags];
  next.identifiers = [...survivor.identifiers, ...identifiers];
  next.attachments = [...survivor.attachments, ...attachments];
  next.externalReferences = [...survivor.externalReferences, ...externalReferences];
  next.fieldProvenance = [...survivor.fieldProvenance, ...fieldProvenance];
  return {
    next: next as unknown as ScientSourceRecord,
    changes,
    added: {
      tags,
      identifiers,
      attachmentSha256: attachments.map((attachment) => attachment.sha256),
      externalReferences,
      fieldProvenance,
    },
    conflicts,
  };
}

function hasAdditions(added: ScientLibraryMerge["added"]): boolean {
  return Object.values(added).some((values) => values.length > 0);
}

function mergePath(paths: StorePaths, mergeId: string): string {
  assertSafeIdentifier(mergeId, "Merge ID");
  return NodePath.join(paths.root, MERGES_DIRECTORY, `${mergeId}.json`);
}

function pendingMergePath(paths: StorePaths, mergeId: string): string {
  assertSafeIdentifier(mergeId, "Merge ID");
  return NodePath.join(paths.root, MERGES_DIRECTORY, PENDING_MERGES_DIRECTORY, `${mergeId}.json`);
}

async function libraryPaths(library: ScientLibraryLocation): Promise<StorePaths> {
  const paths = await sourceStorePaths(library);
  if (paths.owner.kind !== "library") throw new Error("Only a library merges sources.");
  return paths;
}

async function copyZoteroBase(paths: StorePaths, fromId: string, toId: string): Promise<boolean> {
  const from = zoteroSyncPath(paths, fromId);
  const to = zoteroSyncPath(paths, toId);
  if ((await snapshot(from)) !== "file" || (await snapshot(to)) !== "missing") return false;
  const base = await readBoundedJson(from, maxRecordBytes, ScientSourceZoteroSync).catch(
    () => null,
  );
  if (!base) return false;
  await atomicWriteJson(to, { ...base, sourceId: toId }, maxRecordBytes);
  return true;
}

/**
 * Writes the survivor's merge revision and moves the loser to the trash, after a pending merge
 * file that lets the next library write finish an interrupted merge. Caller holds the lock.
 */
async function mergeRecords(input: {
  readonly paths: StorePaths;
  readonly survivor: ScientSourceRecord;
  readonly loser: ScientSourceRecord;
  readonly kind: MergeKind;
  readonly actor: ScientSourceActor;
  readonly labels: ReadonlyMap<string, string> | undefined;
}): Promise<{ readonly merge: ScientLibraryMerge; readonly survivor: ScientSourceRecord }> {
  const { paths, survivor, loser, actor } = input;
  const plan = planMerge(survivor, loser, input.labels);
  const mergedAt = new Date().toISOString();
  const changed = plan.changes.length > 0 || hasAdditions(plan.added);
  const next: ScientSourceRecord = changed
    ? { ...plan.next, revision: survivor.revision + 1, updatedAt: mergedAt, updatedBy: actor }
    : survivor;
  const gainsZotero =
    plan.added.externalReferences.some((reference) => reference.system === "zotero") &&
    !survivor.externalReferences.some((reference) => reference.system === "zotero");
  const merge: ScientLibraryMerge = {
    formatVersion: 1,
    mergeId: `merge_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
    survivorId: survivor.sourceId,
    loserId: loser.sourceId,
    kind: input.kind,
    state: "pending",
    mergedAt,
    mergedBy: actor,
    survivorRevision: next.revision,
    loserRevision: loser.revision,
    changes: plan.changes,
    added: plan.added,
    conflicts: plan.conflicts,
    zoteroBaseCopied: false,
    collectionIds: [],
    addedToCollectionIds: [],
  };
  const pendingPath = pendingMergePath(paths, merge.mergeId);
  await atomicWriteJson(pendingPath, merge, MAX_MERGE_BYTES);
  try {
    if (changed) await persistSourceRevision(paths, survivor, next);
  } catch (cause) {
    await NodeFSP.rm(pendingPath, { force: true });
    throw cause;
  }
  const zoteroBaseCopied =
    gainsZotero && (await copyZoteroBase(paths, loser.sourceId, survivor.sourceId));
  const recorded = zoteroBaseCopied ? { ...merge, zoteroBaseCopied } : merge;
  if (zoteroBaseCopied) await atomicWriteJson(pendingPath, recorded, MAX_MERGE_BYTES);
  await moveRecordToTrash(paths, loser, actor, {
    sourceId: survivor.sourceId,
    mergeId: merge.mergeId,
  });
  return { merge: recorded, survivor: next };
}

/** Moves collection membership, writes the aliases and publishes the merge files. */
async function finishMerges(
  paths: StorePaths,
  pending: ReadonlyArray<ScientLibraryMerge>,
): Promise<ReadonlyArray<ScientLibraryMerge>> {
  if (pending.length === 0) return [];
  const moved = await rewriteLibraryCollections(
    paths,
    (collections, now) => {
      const result = new Map<string, ScientLibraryMerge>();
      let next = collections;
      for (const merge of pending) {
        // A receipt that already names collections was interrupted after they were rewritten.
        const collectionIds = new Set(merge.collectionIds);
        const added = new Set(merge.addedToCollectionIds);
        next = next.map((collection) => {
          if (!collection.sourceIds.includes(merge.loserId)) return collection;
          collectionIds.add(collection.collectionId);
          const hasSurvivor = collection.sourceIds.includes(merge.survivorId);
          if (!hasSurvivor) added.add(collection.collectionId);
          return {
            ...collection,
            sourceIds: hasSurvivor
              ? collection.sourceIds.filter((sourceId) => sourceId !== merge.loserId)
              : collection.sourceIds.map((sourceId) =>
                  sourceId === merge.loserId ? merge.survivorId : sourceId,
                ),
            updatedAt: now,
            updatedBy: merge.mergedBy,
          };
        });
        result.set(merge.mergeId, {
          ...merge,
          collectionIds: [...collectionIds],
          addedToCollectionIds: [...added],
        });
      }
      return { collections: next, result };
    },
    // Undo reads the membership from the receipt, so it lands before the collections change.
    async (planned) => {
      for (const merge of pending) {
        const next = planned.get(merge.mergeId)!;
        if (
          next.collectionIds.length > merge.collectionIds.length ||
          next.addedToCollectionIds.length > merge.addedToCollectionIds.length
        ) {
          await atomicWriteJson(pendingMergePath(paths, merge.mergeId), next, MAX_MERGE_BYTES);
        }
      }
    },
  );

  const aliases = await readLibraryAliasesAt(paths.root);
  for (const merge of pending) {
    aliases.set(merge.loserId, {
      sourceId: merge.loserId,
      survivorId: merge.survivorId,
      mergeId: merge.mergeId,
      mergedAt: merge.mergedAt,
    });
  }
  await writeLibraryAliasesAt(paths.root, aliases);

  const finished: ScientLibraryMerge[] = [];
  for (const merge of pending) {
    const done: ScientLibraryMerge = { ...(moved.get(merge.mergeId) ?? merge), state: "done" };
    await atomicWriteJson(mergePath(paths, merge.mergeId), done, MAX_MERGE_BYTES);
    await NodeFSP.rm(pendingMergePath(paths, merge.mergeId), { force: true });
    finished.push(done);
  }
  return finished;
}

/**
 * Finishes merges a crash interrupted. One whose survivor revision landed is completed; one that
 * stopped before it, or whose records changed since, is dropped, and the next pass finds the pair
 * again. Caller holds the lock.
 */
async function settlePendingMerges(paths: StorePaths): Promise<void> {
  const directory = NodePath.join(paths.root, MERGES_DIRECTORY, PENDING_MERGES_DIRECTORY);
  if ((await snapshot(directory)) !== "directory") return;
  const finishing: ScientLibraryMerge[] = [];
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = NodePath.join(directory, entry.name);
    const merge = await readBoundedJson(filePath, MAX_MERGE_BYTES, ScientLibraryMerge).catch(
      () => null,
    );
    if (!merge) continue;
    const trashed = await readTrashEntry(paths, merge.loserId).catch(() => null);
    const trashedByMerge = trashed?.mergedInto?.mergeId === merge.mergeId;
    // The trash entry lands before the record goes, so it does not prove the loser left.
    const loser = await readScientSourceRecordIfPresent(paths, merge.loserId);
    if (!loser && trashedByMerge) {
      finishing.push(merge);
      continue;
    }
    const survivor = await readScientSourceRecordIfPresent(paths, merge.survivorId);
    if (loser?.revision === merge.loserRevision && survivor?.revision === merge.survivorRevision) {
      await moveRecordToTrash(paths, loser, merge.mergedBy, {
        sourceId: merge.survivorId,
        mergeId: merge.mergeId,
      });
      finishing.push(merge);
      continue;
    }
    // Edited since: the loser stays as it is now, so the entry holding its old revision goes.
    if (loser && trashedByMerge) {
      await NodeFSP.rm(NodePath.join(paths.trash, `${merge.loserId}.json`), { force: true });
    }
    await NodeFSP.rm(filePath, { force: true });
  }
  await finishMerges(paths, finishing);
}

/** Every receipt and the exclusions they and the distinct pairs hold. Caller lists `live`. */
async function readExclusions(paths: StorePaths, live: ReadonlySet<string>) {
  const [distinctPairs, { receipts, damaged }, aliases] = await Promise.all([
    readScientLibraryDistinctPairs(paths.root),
    readScientLibraryMergeReceipts(paths.root),
    readLibraryAliasesAt(paths.root),
  ]);
  return {
    receipts,
    aliases,
    exclusions: scientLibraryExclusionsFrom({ distinctPairs, receipts, damaged, aliases, live }),
  };
}

async function changeDistinctPairs<A>(
  library: ScientLibraryLocation,
  sourceIds: readonly [string, string],
  change: (
    pairs: ReadonlyArray<ScientLibraryDistinctPair>,
    key: string,
    resolved: readonly [string, string],
    keyOf: (pair: ScientLibraryDistinctPair) => string,
  ) => { readonly pairs: ReadonlyArray<ScientLibraryDistinctPair> | null; readonly result: A },
): Promise<A> {
  const paths = await libraryPaths(library);
  for (const sourceId of sourceIds) assertSafeIdentifier(sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const aliases = await readLibraryAliasesAt(paths.root);
    const resolved = sourceIds.map((sourceId) => resolveScientLibraryAlias(aliases, sourceId)) as [
      string,
      string,
    ];
    if (resolved[0] === resolved[1]) throw new Error("A source cannot be distinct from itself.");
    const keyOf = (pair: ScientLibraryDistinctPair) =>
      pairKey(
        resolveScientLibraryAlias(aliases, pair.sourceIds[0]),
        resolveScientLibraryAlias(aliases, pair.sourceIds[1]),
      );
    const { pairs, result } = change(
      await readScientLibraryDistinctPairs(paths.root),
      pairKey(...resolved),
      resolved,
      keyOf,
    );
    if (pairs) {
      await atomicWriteJson(
        scientLibraryDistinctPairsPath(paths.root),
        { formatVersion: 1, pairs },
        SCIENT_LIBRARY_MAX_DISTINCT_PAIRS_BYTES,
      );
    }
    return result;
  });
}

/** Keeps two sources apart: the bulk pass never merges them and lists them as no duplicate. */
export function markScientLibrarySourcesDistinct(input: {
  readonly library: ScientLibraryLocation;
  readonly sourceIds: readonly [string, string];
  readonly reason?: ScientLibraryDistinctPair["reason"];
  readonly actor?: ScientSourceActor;
}): Promise<{ readonly outcome: "marked" | "unchanged" }> {
  return changeDistinctPairs<{ readonly outcome: "marked" | "unchanged" }>(
    input.library,
    input.sourceIds,
    (pairs, key, resolved, keyOf) => {
      if (pairs.some((pair) => keyOf(pair) === key))
        return { pairs: null, result: { outcome: "unchanged" } };
      const sourceIds = resolved.toSorted() as unknown as readonly [string, string];
      return {
        pairs: [
          ...pairs,
          {
            sourceIds,
            reason: input.reason ?? "marked-distinct",
            markedAt: new Date().toISOString(),
            markedBy: input.actor ?? "user",
          },
        ],
        result: { outcome: "marked" },
      };
    },
  );
}

export function clearScientLibrarySourcesDistinct(input: {
  readonly library: ScientLibraryLocation;
  readonly sourceIds: readonly [string, string];
}): Promise<{ readonly outcome: "cleared" | "not-found" }> {
  return changeDistinctPairs<{ readonly outcome: "cleared" | "not-found" }>(
    input.library,
    input.sourceIds,
    (pairs, key, _resolved, keyOf) => {
      const kept = pairs.filter((pair) => keyOf(pair) !== key);
      return kept.length === pairs.length
        ? { pairs: null, result: { outcome: "not-found" } }
        : { pairs: kept, result: { outcome: "cleared" } };
    },
  );
}

export type ScientLibraryMergeResult =
  | {
      readonly outcome: "merged";
      readonly merge: ScientLibraryMerge;
      readonly survivor: ScientSourceRecord;
    }
  | { readonly outcome: "already-merged"; readonly survivorId: string }
  | { readonly outcome: "not-found"; readonly sourceId: string };

/**
 * Merges two library sources on request, for the Merge action on possible duplicates. The
 * survivor follows the design's rule unless the caller names one of the two.
 */
export async function mergeScientLibrarySources(input: {
  readonly library: ScientLibraryLocation;
  readonly sourceIds: readonly [string, string];
  readonly survivorId?: string;
  readonly actor?: ScientSourceActor;
  /** Names for the line heading each joined personal note, usually the source's project. */
  readonly noteLabels?: ReadonlyMap<string, string>;
}): Promise<ScientLibraryMergeResult> {
  const paths = await libraryPaths(input.library);
  for (const sourceId of input.sourceIds) assertSafeIdentifier(sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    await settlePendingMerges(paths);
    const aliases = await readLibraryAliasesAt(paths.root);
    const [leftId, rightId] = input.sourceIds.map((sourceId) =>
      resolveScientLibraryAlias(aliases, sourceId),
    ) as [string, string];
    if (leftId === rightId) return { outcome: "already-merged", survivorId: leftId };
    const records: ScientSourceRecord[] = [];
    for (const sourceId of [leftId, rightId]) {
      const record = await readScientSourceRecordIfPresent(paths, sourceId);
      if (!record) return { outcome: "not-found", sourceId };
      records.push(record);
    }
    const requested = input.survivorId
      ? resolveScientLibraryAlias(aliases, input.survivorId)
      : undefined;
    const [survivor, loser] =
      requested === rightId
        ? [records[1]!, records[0]!]
        : requested === leftId
          ? [records[0]!, records[1]!]
          : (records.toSorted(compareScientLibrarySurvivors) as [
              ScientSourceRecord,
              ScientSourceRecord,
            ]);
    const merged = await mergeRecords({
      paths,
      survivor,
      loser,
      kind: "requested",
      actor: input.actor ?? "user",
      labels: input.noteLabels,
    });
    const [merge] = await finishMerges(paths, [merged.merge]);
    return { outcome: "merged", merge: merge!, survivor: merged.survivor };
  });
}

export interface ScientLibraryDuplicateMergeResult {
  /** "Merged N duplicates." */
  readonly mergedCount: number;
  /** "K kept different values": merges whose report lists at least one field. */
  readonly keptDifferentCount: number;
  readonly merges: ReadonlyArray<ScientLibraryMerge>;
  /** Pairs that failed to merge, for example a merged record over the size limit. */
  readonly failures: ReadonlyArray<{
    readonly survivorId: string;
    readonly loserId: string;
    readonly message: string;
  }>;
  /** What is left for a person or agent to decide, after this pass's merges. */
  readonly possibleDuplicates: ReadonlyArray<ScientLibraryPossibleDuplicate>;
  /** Receipts that could not be read; the records they name were not merged automatically. */
  readonly damagedReceipts: ReadonlyArray<ScientLibraryDamagedReceipt>;
}

/** The library-wide pass: merges every automatic duplicate group into its survivor. */
export async function mergeScientLibraryDuplicates(input: {
  readonly library: ScientLibraryLocation;
  readonly actor?: ScientSourceActor;
  readonly noteLabels?: ReadonlyMap<string, string>;
}): Promise<ScientLibraryDuplicateMergeResult> {
  const paths = await libraryPaths(input.library);
  const actor = input.actor ?? "user";
  return withStoreLock(paths, "source-write", async () => {
    await settlePendingMerges(paths);
    const records = await listScientSourceRecordsFromPaths(paths);
    const { exclusions } = await readExclusions(
      paths,
      new Set(records.map((record) => record.sourceId)),
    );
    const assessment = assessScientLibraryDuplicates({ records, ...exclusions });
    const byId = new Map(records.map((record) => [record.sourceId, record]));
    const pending: ScientLibraryMerge[] = [];
    const failures: Array<ScientLibraryDuplicateMergeResult["failures"][number]> = [];
    for (const group of assessment.groups) {
      let survivor = byId.get(group.survivorId)!;
      const joined = new Set([group.survivorId]);
      for (const { sourceId, links } of group.losers) {
        // Only evidence a successful merge moved to the survivor can join the next loser.
        const kind = scientLibraryJoiningLink(links, joined);
        if (!kind) {
          failures.push({
            survivorId: survivor.sourceId,
            loserId: sourceId,
            message: "Not merged: the source linking it to this one could not be merged.",
          });
          continue;
        }
        try {
          const merged = await mergeRecords({
            paths,
            survivor,
            loser: byId.get(sourceId)!,
            kind,
            actor,
            labels: input.noteLabels,
          });
          pending.push(merged.merge);
          survivor = merged.survivor;
          joined.add(sourceId);
        } catch (cause) {
          // The survivor's revision may have landed before the failure.
          survivor = (await readScientSourceRecordIfPresent(paths, survivor.sourceId)) ?? survivor;
          failures.push({
            survivorId: survivor.sourceId,
            loserId: sourceId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
    const merges = await finishMerges(paths, pending);
    return {
      mergedCount: merges.length,
      keptDifferentCount: merges.filter((merge) => merge.conflicts.length > 0).length,
      merges,
      failures,
      possibleDuplicates: assessment.possibleDuplicates,
      damagedReceipts: exclusions.damaged,
    };
  });
}

/** Reverts what the merge set where the survivor still holds it; later edits stay and are named. */
function revertMerge(
  current: ScientSourceRecord,
  merge: ScientLibraryMerge,
): { readonly next: ScientSourceRecord; readonly unrevertedFields: ReadonlyArray<string> } {
  const record = current as unknown as MutableRecord;
  const next: MutableRecord = { ...record };
  const unreverted = new Set<string>();
  for (const change of merge.changes) {
    const value = record[change.field];
    if (same(value, change.after)) {
      if (change.before === undefined) delete next[change.field];
      else next[change.field] = change.before;
    } else if (!same(value, change.before)) {
      unreverted.add(change.field);
    }
  }
  const tags = new Set(merge.added.tags);
  const identifiers = new Set(merge.added.identifiers.map(identifierKey));
  const hashes = new Set(merge.added.attachmentSha256);
  const references = new Set(merge.added.externalReferences.map(referenceKey));
  const provenance = new Set(merge.added.fieldProvenance.map((entry) => JSON.stringify(entry)));
  next.tags = current.tags.filter((tag) => !tags.has(tag));
  next.identifiers = current.identifiers.filter(
    (identifier) => !identifiers.has(identifierKey(identifier)),
  );
  next.attachments = current.attachments.filter((attachment) => !hashes.has(attachment.sha256));
  next.externalReferences = current.externalReferences.filter(
    (reference) => !references.has(referenceKey(reference)),
  );
  next.fieldProvenance = current.fieldProvenance.filter(
    (entry) => !provenance.has(JSON.stringify(entry)),
  );
  return {
    next: next as unknown as ScientSourceRecord,
    unrevertedFields: [...unreverted].toSorted(),
  };
}

export type ScientLibraryMergeUndoResult =
  | {
      readonly outcome: "undone";
      readonly survivor: ScientSourceRecord;
      readonly loser: ScientSourceRecord;
      /** Fields edited on the survivor after the merge, kept as they are. */
      readonly unrevertedFields: ReadonlyArray<string>;
    }
  | { readonly outcome: "not-found" | "already-undone" }
  /** Merged on into another source or removed since: undo that first, or restore it. */
  | { readonly outcome: "survivor-missing" }
  /** The trash was emptied, so the merged source is gone for good. */
  | { readonly outcome: "loser-missing" };

/**
 * Undoes one merge: restores the merged source, reverts the survivor's merge revision while
 * keeping later edits, puts collection membership back and tombstones the alias.
 */
export async function undoScientLibraryMerge(input: {
  readonly library: ScientLibraryLocation;
  readonly mergeId: string;
  readonly actor?: ScientSourceActor;
}): Promise<ScientLibraryMergeUndoResult> {
  const paths = await libraryPaths(input.library);
  const filePath = mergePath(paths, input.mergeId);
  const actor = input.actor ?? "user";
  return withStoreLock(paths, "source-write", async () => {
    await settlePendingMerges(paths);
    if ((await snapshot(filePath)) === "missing") return { outcome: "not-found" };
    const merge = await readBoundedJson(filePath, MAX_MERGE_BYTES, ScientLibraryMerge);
    if (merge.state === "undone") return { outcome: "already-undone" };
    const current = await readScientSourceRecordIfPresent(paths, merge.survivorId);
    if (!current) return { outcome: "survivor-missing" };
    const liveLoser = await readScientSourceRecordIfPresent(paths, merge.loserId);
    const trashed = liveLoser ? null : await readTrashEntry(paths, merge.loserId);
    if (!liveLoser && trashed?.mergedInto?.mergeId !== merge.mergeId) {
      return { outcome: "loser-missing" };
    }

    const now = new Date().toISOString();
    const { next, unrevertedFields } = revertMerge(current, merge);
    let survivor = current;
    if (!same(next, current)) {
      survivor = { ...next, revision: current.revision + 1, updatedAt: now, updatedBy: actor };
      await persistSourceRevision(paths, current, survivor);
    }
    if (
      merge.zoteroBaseCopied &&
      !survivor.externalReferences.some((reference) => reference.system === "zotero")
    ) {
      await NodeFSP.rm(zoteroSyncPath(paths, merge.survivorId), { force: true });
    }
    const loser =
      liveLoser ??
      (await restoreTrashedRecord(
        paths,
        trashed!,
        await listScientSourceRecordsFromPaths(paths),
        actor,
      )) ??
      (await readSourceRecordFromPaths(paths, merge.loserId));

    await rewriteLibraryCollections(paths, (collections, collectionNow) => ({
      collections: collections.map((collection) => {
        if (!merge.collectionIds.includes(collection.collectionId)) return collection;
        const withoutSurvivor = merge.addedToCollectionIds.includes(collection.collectionId)
          ? collection.sourceIds.filter((sourceId) => sourceId !== merge.survivorId)
          : collection.sourceIds;
        const sourceIds = withoutSurvivor.includes(merge.loserId)
          ? withoutSurvivor
          : [...withoutSurvivor, merge.loserId];
        return same(sourceIds, collection.sourceIds)
          ? collection
          : { ...collection, sourceIds, updatedAt: collectionNow, updatedBy: actor };
      }),
      result: undefined,
    }));

    const aliases = await readLibraryAliasesAt(paths.root);
    const alias = aliases.get(merge.loserId);
    if (alias?.mergeId === merge.mergeId && alias.undoneAt === undefined) {
      aliases.set(merge.loserId, { ...alias, undoneAt: now });
      await writeLibraryAliasesAt(paths.root, aliases);
    }
    await atomicWriteJson(
      filePath,
      { ...merge, state: "undone", undoneAt: now, undoneBy: actor },
      MAX_MERGE_BYTES,
    );
    return { outcome: "undone", survivor, loser, unrevertedFields };
  });
}

export type ScientLibraryMergeUndoState =
  | "available"
  | "undone"
  /** Merged on into another source or removed since: Undo answers `survivor-missing`. */
  | "kept-source-gone"
  /** The trash was emptied: Undo answers `loser-missing`. */
  | "merged-source-gone";

interface ScientLibraryListedMerge {
  readonly merge: ScientLibraryMerge;
  /** The merged-away record: in the trash, live after an Undo, or null once the trash was emptied. */
  readonly merged: ScientSourceRecord | null;
  readonly undo: ScientLibraryMergeUndoState;
}

/** Undo's own checks, without its lock: the answer can change before an Undo applies. */
async function mergeUndoState(
  paths: StorePaths,
  merge: ScientLibraryMerge,
  live: ReadonlyMap<string, ScientSourceRecord>,
  trashed: ReadonlySet<string>,
): Promise<{
  readonly undo: ScientLibraryMergeUndoState;
  readonly merged: ScientSourceRecord | null;
}> {
  const liveLoser = live.get(merge.loserId);
  const entry =
    liveLoser || !trashed.has(`${merge.loserId}.json`)
      ? null
      : await readTrashEntry(paths, merge.loserId).catch(() => null);
  const inTrash = entry?.mergedInto?.mergeId === merge.mergeId ? entry.record : null;
  const merged = liveLoser ?? inTrash ?? entry?.record ?? null;
  if (merge.state === "undone") return { undo: "undone", merged };
  if (!live.has(merge.survivorId)) return { undo: "kept-source-gone", merged };
  if (!liveLoser && !inTrash) return { undo: "merged-source-gone", merged };
  return { undo: "available", merged };
}

async function trashFileNames(paths: StorePaths): Promise<ReadonlySet<string>> {
  return new Set(
    (await snapshot(paths.trash)) === "directory"
      ? (await NodeFSP.readdir(paths.trash, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name)
      : [],
  );
}

interface ScientLibraryDuplicatesListing {
  /** The live records the pairs were assessed on, so a caller builds rows without listing again. */
  readonly records: ReadonlyArray<ScientSourceRecord>;
  /** Changes whenever either whole list changes; a page asked under another one restarts. */
  readonly revision: string;
  /** The page asked for named an older revision, so both lists start again from the top. */
  readonly restarted: boolean;
  readonly pairOffset: number;
  /** This page, each with the source a merge keeps by the design's rule. */
  readonly possibleDuplicates: ReadonlyArray<
    ScientLibraryPossibleDuplicate & { readonly survivorId: string }
  >;
  readonly pairsTotal: number;
  readonly mergeOffset: number;
  /** This page of the merges asked for, newest first. */
  readonly merges: ReadonlyArray<ScientLibraryListedMerge>;
  readonly mergesTotal: number;
  /** Receipts that could not be read; no automatic pass merges the records they name. */
  readonly damagedReceipts: ReadonlyArray<ScientLibraryDamagedReceipt>;
}

/**
 * A page of each list the duplicates screen shows; reads only. Pairs by kind then IDs, merges
 * newest first (undoable ones, or with `merges: "all"` every receipt). Another `revision` than
 * the current one restarts both pages at the top, so a list that changed skips nothing.
 */
export async function readScientLibraryDuplicates(input: {
  readonly library: ScientLibraryLocation;
  readonly pairOffset?: number;
  readonly pairLimit: number;
  readonly mergeOffset?: number;
  readonly mergeLimit: number;
  readonly merges?: "undoable" | "all";
  readonly revision?: string;
}): Promise<ScientLibraryDuplicatesListing> {
  const paths = await libraryPaths(input.library);
  const records = await listScientSourceRecordsFromPaths(paths);
  const byId = new Map(records.map((record) => [record.sourceId, record]));
  const { receipts, exclusions } = await readExclusions(paths, new Set(byId.keys()));
  const assessment = assessScientLibraryDuplicates({ records, ...exclusions });
  const possibleDuplicates = assessment.possibleDuplicates.map((pair) => {
    const [left, right] = pair.sourceIds.map((sourceId) => byId.get(sourceId)!);
    return {
      ...pair,
      survivorId: (compareScientLibrarySurvivors(left!, right!) <= 0 ? left! : right!).sourceId,
    };
  });
  const trashed = await trashFileNames(paths);
  const listed: ScientLibraryListedMerge[] = [];
  for (const merge of receipts) {
    if (merge.state === "pending") continue;
    const { undo, merged } = await mergeUndoState(paths, merge, byId, trashed);
    if (input.merges === "all" || (undo === "available" && merged)) {
      listed.push({ merge, merged, undo });
    }
  }
  listed.sort(
    (left, right) =>
      right.merge.mergedAt.localeCompare(left.merge.mergedAt) ||
      (left.merge.mergeId < right.merge.mergeId ? -1 : 1),
  );
  const revision = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        possibleDuplicates.map((pair) => [pair.sourceIds, pair.kind, pair.reason ?? null]),
        listed.map(({ merge, undo }) => [merge.mergeId, undo]),
        exclusions.damaged.map((receipt) => receipt.mergeId),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  const restarted = input.revision !== undefined && input.revision !== revision;
  const page = <A>(items: ReadonlyArray<A>, offset: number | undefined, limit: number) => {
    const start = restarted ? 0 : Math.max(0, offset ?? 0);
    return { start, items: items.slice(start, start + Math.max(0, limit)) };
  };
  const pairs = page(possibleDuplicates, input.pairOffset, input.pairLimit);
  const merges = page(listed, input.mergeOffset, input.mergeLimit);
  return {
    records,
    revision,
    restarted,
    pairOffset: pairs.start,
    possibleDuplicates: pairs.items,
    pairsTotal: possibleDuplicates.length,
    mergeOffset: merges.start,
    merges: merges.items,
    mergesTotal: listed.length,
    damagedReceipts: exclusions.damaged,
  };
}

export interface ScientLibraryMergeReceipt {
  readonly merge: ScientLibraryMerge;
  /** The merged-away source: live, in the trash, or null once the trash was emptied. */
  readonly merged: ScientSourceRecord | null;
  /** The kept source if it is still in the Library. */
  readonly kept: ScientSourceRecord | null;
  readonly undo: ScientLibraryMergeUndoState;
}

/**
 * One merge's receipt by ID, also once undone or no longer undoable. Reads only; Undo checks
 * again under its lock when it runs.
 */
export async function readScientLibraryMergeReceipt(input: {
  readonly library: ScientLibraryLocation;
  readonly mergeId: string;
}): Promise<ScientLibraryMergeReceipt | null> {
  const paths = await libraryPaths(input.library);
  const filePath = mergePath(paths, input.mergeId);
  if ((await snapshot(filePath)) !== "file") return null;
  const merge = await readBoundedJson(filePath, MAX_MERGE_BYTES, ScientLibraryMerge);
  const live = new Map<string, ScientSourceRecord>();
  for (const sourceId of [merge.survivorId, merge.loserId]) {
    const record = await readScientSourceRecordIfPresent(paths, sourceId);
    if (record) live.set(sourceId, record);
  }
  const { undo, merged } = await mergeUndoState(paths, merge, live, await trashFileNames(paths));
  return { merge, merged, kept: live.get(merge.survivorId) ?? null, undo };
}
