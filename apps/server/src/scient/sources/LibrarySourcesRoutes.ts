import {
  citationKeyValidationMessage,
  scientSourceSummaryFromRecord,
  sourceMetadataDiagnostics,
  takenCitationKeys,
  type ScientSourceActor,
  type ScientSourceEditableMetadata,
  type ScientSourceRecord,
  type ScientSourcesBulkRequestChange,
  type ScientSourcesOrganizeAction,
  type ScientSystematicReviewAction,
} from "@scientfactory/scient-sources";
import {
  readScientSourceCategories,
  scientSourceCategorySummaryFor,
} from "@scientfactory/scient-sources/categories-store";
import { readScientSourcesOrganization } from "@scientfactory/scient-sources/collections";
import {
  mergeScientLibrarySources,
  undoScientLibraryMerge,
} from "@scientfactory/scient-sources/library-merge";
import { moveScientProjectBackIntoProject } from "@scientfactory/scient-sources/library-move";
import {
  changeScientLibraryReview,
  listScientLibraryReviewRecords,
  listScientLibraryReviews,
  readScientLibraryReview,
  readScientLibraryReviewRecord,
  type ScientLibraryReviewRecord,
} from "@scientfactory/scient-sources/library-reviews";
import {
  listScientProjectPinnedWorks,
  pinScientLibrarySource,
  renameScientProjectPinKey,
  setScientProjectPinNote,
  unpinScientLibrarySource,
  type ScientProjectPin,
} from "@scientfactory/scient-sources/project-pins";
import {
  deleteScientSourcesPermanently,
  inspectScientLibrarySources,
  listScientSourceRecords,
  listScientSourceRevisions,
  listScientSourceTrash,
  readScientSourceRecord,
  restoreScientSource,
  revertScientSource,
  sourceAttachmentAbsolutePath,
  updateScientSourceMetadata,
} from "@scientfactory/scient-sources/store";
import type {
  ScientSourcesLibraryOrganizeAction,
  ScientSourcesScope,
  ScientSystematicReviewRecord,
} from "@t3tools/contracts";

import { exportBibliography } from "./BibliographyFileAdapter.ts";
import { resolveJournalIcon } from "./JournalIconResolver.ts";
import { renameCitationKeyInProject, scanCitationKeyRenameDocuments } from "./LibraryCitation.ts";
import {
  alsoPinnedIn,
  listProjectPinnedWorks,
  projectPinsByLibraryId,
  refreshProjectAfterLibraryChange,
  resolveLibrarySourceId,
  syncProjectBibliography,
} from "./LibraryProjectSources.ts";
import {
  bulkUpdateSources,
  normalizeSourceRecordForRead,
  organizeSources,
  refreshScientSourceMetadata,
  removeSource,
} from "./ScientSourcesCoordinator.ts";
import type { ResolveSourceIdentifier } from "./SourceIdentifierResolver.ts";
import { scheduleSourceCategorization } from "./SourceCategories.ts";
import { scheduleSourceFullTextIndexing } from "./SourceFullText.ts";
import type { ScientSourcesLibraryStore } from "./SourcesBackend.ts";

type Store = ScientSourcesLibraryStore;

const ACTOR: ScientSourceActor = "user";
const SNAPSHOT_LABEL = "From this review's snapshot" as const;

/**
 * Library routes serve any connected client, so personal notes never leave the library. A
 * route record's `note` is this project's note on its pin instead, which the panel edits.
 */
function routeRecord(
  record: ScientSourceRecord,
  pin: Pick<ScientProjectPin, "citationKey" | "note"> | undefined,
): ScientSourceRecord {
  const { note: _personal, ...rest } = record;
  return {
    ...rest,
    ...(pin ? { citationKey: pin.citationKey } : {}),
    ...(pin?.note ? { note: pin.note } : {}),
  };
}

/** A library ID, or a project source ID of this project resolved to one; unresolved IDs stay. */
async function libraryIdOf(store: Store, sourceId: string): Promise<string> {
  return (await resolveLibrarySourceId(store, sourceId)) ?? sourceId;
}

async function pinOf(store: Store, sourceId: string): Promise<ScientProjectPin | undefined> {
  return (await projectPinsByLibraryId(store)).get(sourceId);
}

async function requireRecord(store: Store, sourceId: string): Promise<ScientSourceRecord> {
  const record = store.exists ? await readScientSourceRecord(store.library, sourceId) : null;
  if (!record) throw new Error("The source was not found in the Library.");
  return record;
}

// The change has landed; a snapshot that fails to refresh is refreshed by the next write.
const afterChange = (store: Store, sourceIds: ReadonlyArray<string>) =>
  refreshProjectAfterLibraryChange(store, sourceIds, ACTOR).catch(() => undefined);

const reach = (store: Store, sourceId: string) => alsoPinnedIn(store, sourceId).catch(() => ({}));

/** This project's pins, or the whole library, with the totals the scope filter shows. */
export async function libraryOverview(
  store: Store,
  input: { readonly scope: ScientSourcesScope; readonly background: boolean },
) {
  const inspected = store.exists
    ? await inspectScientLibrarySources(store.library)
    : { records: [], activeOperation: null };
  const works = await listProjectPinnedWorks(store, ACTOR);
  const pins = await projectPinsByLibraryId(store);
  const listed =
    input.scope === "project"
      ? works.map((work) => ({
          record: work.record,
          pinned: true,
          projectNote: work.projectNote,
          fromSnapshot: work.from === "snapshot",
        }))
      : inspected.records.map((record) => {
          const pin = pins.get(record.sourceId);
          return {
            record: pin ? { ...record, citationKey: pin.citationKey } : record,
            pinned: pin !== undefined,
            projectNote: pin ? (pin.note ?? null) : undefined,
            fromSnapshot: false,
          };
        });
  const categories = store.exists
    ? await readScientSourceCategories(store.library).catch(() => ({}))
    : {};
  const organization = store.exists
    ? await readScientSourcesOrganization(
        store.library,
        new Set(inspected.records.map((record) => record.sourceId)),
      )
    : null;
  // Indexing and categorizing write library caches, so only a caller that may change it starts them.
  if (input.background && store.exists) {
    void scheduleSourceFullTextIndexing(store.library);
    void scheduleSourceCategorization(store.library);
  }
  return {
    projectState: "initialized" as const,
    issues: [],
    activeOperation: inspected.activeOperation,
    ...("unreadableRecords" in inspected && inspected.unreadableRecords
      ? { unreadableRecords: inspected.unreadableRecords }
      : {}),
    ...("trashedCount" in inspected && inspected.trashedCount !== undefined
      ? { trashedCount: inspected.trashedCount }
      : {}),
    records: listed.map(({ record, pinned, projectNote, fromSnapshot }) => {
      const summary = scientSourceSummaryFromRecord(record);
      const category = scientSourceCategorySummaryFor(record, categories);
      return {
        ...summary,
        ...(category ? { categories: category } : {}),
        pinned,
        ...(projectNote !== undefined ? { projectNote } : {}),
        ...(fromSnapshot ? { fromSnapshot: true as const } : {}),
      };
    }),
    recordDiagnostics: listed.map(({ record }) => ({
      sourceId: record.sourceId,
      diagnostics: sourceMetadataDiagnostics(record),
    })),
    ...(organization ? { organization } : {}),
    scopes: {
      listed: input.scope,
      project: works.length,
      library: inspected.records.length,
    },
  };
}

/** A library record, a project source ID this project pins, or a review's own record. */
export async function librarySourceDetail(
  store: Store,
  input: { readonly sourceId: string; readonly reviewId?: string },
) {
  if (input.reviewId) {
    const entry = await readScientLibraryReviewRecord({
      ...reviewAccess(store),
      projectRoot: store.root,
      reviewId: input.reviewId,
      sourceId: input.sourceId,
    });
    if (!entry?.record) throw new Error("The source was not found in this review.");
    return {
      ...normalizeSourceRecordForRead(routeRecord(entry.record, undefined)),
      ...(entry.from === "snapshot" ? { label: SNAPSHOT_LABEL } : {}),
    };
  }
  const sourceId = await libraryIdOf(store, input.sourceId);
  const record = store.exists ? await readScientSourceRecord(store.library, sourceId) : null;
  if (record) {
    const pin = await pinOf(store, sourceId);
    return {
      ...normalizeSourceRecordForRead(routeRecord(record, pin)),
      pinned: pin !== undefined,
    };
  }
  const snapshot = (
    await listScientProjectPinnedWorks({
      projectRoot: store.root,
      library: store.exists ? store.library : null,
    })
  ).find((work) => work.from === "snapshot" && work.projectSourceId === input.sourceId);
  if (!snapshot) throw new Error("The source was not found in the Library.");
  return {
    ...routeRecord(snapshot.record, {
      citationKey: snapshot.citationKey,
      ...(snapshot.projectNote ? { note: snapshot.projectNote } : {}),
    }),
    pinned: true,
    fromSnapshot: true as const,
  };
}

export async function libraryAttachmentMaterial(
  store: Store,
  input: { readonly sourceId: string; readonly attachmentId: string },
) {
  const record = await requireRecord(store, await libraryIdOf(store, input.sourceId));
  const attachment = record.attachments.find(
    (candidate) => candidate.attachmentId === input.attachmentId,
  );
  if (!attachment) throw new Error("The source attachment was not found in the Library.");
  return {
    absolutePath: sourceAttachmentAbsolutePath(store.library, attachment),
    attachment,
    folder: store.library.root,
  };
}

export async function libraryJournalIconMaterial(
  store: Store,
  input: { readonly sourceId: string; readonly cacheRoot: string },
) {
  if (!store.exists) return null;
  const record = await readScientSourceRecord(
    store.library,
    await libraryIdOf(store, input.sourceId),
  );
  return record ? resolveJournalIcon({ record, cacheRoot: input.cacheRoot }) : null;
}

/**
 * A new citationKey on a source pinned here renames this project's pin and documents only; the
 * record's preferred key changes only for a source not pinned here.
 */
export async function updateLibrarySourceMetadata(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly metadata: ScientSourceEditableMetadata;
    readonly allowPossibleMetadataMatch?: boolean;
  },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  const pins = await projectPinsByLibraryId(store);
  const pin = pins.get(sourceId);
  const current = await requireRecord(store, sourceId);
  const requestedKey = input.metadata.citationKey?.trim();
  const renamesPin =
    pin !== undefined && requestedKey !== undefined && requestedKey !== pin.citationKey;
  const keyMessage = renamesPin
    ? citationKeyValidationMessage(
        requestedKey,
        takenCitationKeys([...pins.values()], pin.sourceId),
      )
    : requestedKey && pin === undefined && requestedKey !== current.citationKey
      ? citationKeyValidationMessage(
          requestedKey,
          takenCitationKeys(await listScientSourceRecords(store.library), sourceId),
        )
      : null;
  if (keyMessage) throw new Error(keyMessage);
  const { citationKey: _projectKey, ...withoutKey } = input.metadata;
  // Found before the key changes, so a scan failure leaves the old key in place.
  const scan = renamesPin ? await scanCitationKeyRenameDocuments(store.root) : null;
  const result = await updateScientSourceMetadata({
    root: store.library,
    sourceId,
    expectedRevision: input.expectedRevision,
    metadata: pin !== undefined ? withoutKey : input.metadata,
    allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
    actor: ACTOR,
  });
  const accepted = result.outcome === "updated" || result.outcome === "unchanged";
  const renamed =
    renamesPin && accepted && requestedKey && scan
      ? (await renameScientProjectPinKey({
          projectRoot: store.root,
          citationKey: pin.citationKey,
          to: requestedKey,
        }).then((outcome) => outcome.outcome === "renamed"))
        ? await renameCitationKeyInProject(store.root, pin.citationKey, requestedKey, scan)
        : null
      : null;
  if (result.outcome === "updated" || renamed) await afterChange(store, [sourceId]);
  const keptPin = pin ? { ...pin, citationKey: renamed ? requestedKey! : pin.citationKey } : pin;
  return {
    outcome: renamed && result.outcome === "unchanged" ? ("updated" as const) : result.outcome,
    record: routeRecord(result.record, keptPin),
    duplicate: result.duplicate,
    validationIssues: result.validationIssues,
    ...(renamed ? { citationKeyRenamedIn: renamed.renamedIn } : {}),
    ...(renamed && renamed.skipped.length > 0 ? { citationKeyRenameSkipped: renamed.skipped } : {}),
    ...(await reach(store, sourceId)),
  };
}

/** The panel's note here is this project's note on the pin; a source not pinned has none. */
export async function updateLibraryProjectNote(
  store: Store,
  input: { readonly sourceId: string; readonly note: string | null },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  const pins = await projectPinsByLibraryId(store);
  const pin =
    pins.get(sourceId) ??
    (await listScientProjectPinnedWorks({ projectRoot: store.root, library: store.library }))
      .filter((work) => work.projectSourceId === input.sourceId)
      .map((work) => ({ citationKey: work.citationKey }))[0];
  if (!pin) throw new Error("Pin this source in the project to give it a project note.");
  const updated = await setScientProjectPinNote({
    projectRoot: store.root,
    citationKey: pin.citationKey,
    note: input.note,
  });
  if (updated.outcome === "not-pinned") throw new Error("The source is no longer pinned here.");
  return {
    outcome: updated.outcome,
    record: await librarySourceDetail(store, { sourceId: input.sourceId }),
  };
}

export async function refreshLibrarySourceMetadata(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly resolveIdentifier: ResolveSourceIdentifier;
  },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  const result = await refreshScientSourceMetadata({ ...input, root: store.library, sourceId });
  if (result.outcome === "refreshed") await afterChange(store, [sourceId]);
  return {
    ...result,
    record: routeRecord(result.record, await pinOf(store, sourceId)),
    ...(await reach(store, sourceId)),
  };
}

/** Moves the library record to the trash; pins keep it in their snapshots. */
export async function removeLibrarySource(
  store: Store,
  input: { readonly sourceId: string; readonly expectedRevision: number },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  const reached = await reach(store, sourceId);
  const result = await removeSource({
    root: store.library,
    sourceId,
    expectedRevision: input.expectedRevision,
    actor: ACTOR,
  });
  return { ...result, ...reached };
}

export async function libraryTrash(store: Store) {
  return store.exists ? listScientSourceTrash(store.library) : { entries: [], issues: [] };
}

export async function restoreLibrarySource(store: Store, input: { readonly sourceId: string }) {
  const result = await restoreScientSource({
    root: store.library,
    sourceId: input.sourceId,
    actor: ACTOR,
  });
  return {
    ...result,
    record: result.record ? routeRecord(result.record, await pinOf(store, result.sourceId)) : null,
  };
}

export async function deleteLibrarySourcesPermanently(
  store: Store,
  input: { readonly sourceIds?: ReadonlyArray<string> },
) {
  return deleteScientSourcesPermanently({
    root: store.library,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
  });
}

export async function librarySourceRevisions(store: Store, input: { readonly sourceId: string }) {
  const revisions = store.exists
    ? await listScientSourceRevisions(store.library, await libraryIdOf(store, input.sourceId))
    : null;
  if (!revisions) throw new Error("The source was not found in the Library.");
  return { revisions };
}

export async function revertLibrarySource(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly toRevision: number;
  },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  await requireRecord(store, sourceId);
  const result = await revertScientSource({
    root: store.library,
    sourceId,
    expectedRevision: input.expectedRevision,
    toRevision: input.toRevision,
    actor: ACTOR,
  });
  if (result.outcome === "reverted") await afterChange(store, [sourceId]);
  return {
    ...result,
    record: routeRecord(result.record, await pinOf(store, sourceId)),
    ...(await reach(store, sourceId)),
  };
}

export async function bulkUpdateLibrarySources(
  store: Store,
  input: { readonly change: ScientSourcesBulkRequestChange },
) {
  const change =
    "sourceIds" in input.change
      ? {
          ...input.change,
          sourceIds: await Promise.all(
            input.change.sourceIds.map((sourceId) => libraryIdOf(store, sourceId)),
          ),
        }
      : input.change;
  const result = await bulkUpdateSources({ root: store.library, change, actor: ACTOR });
  // A type change, or the undo of one, changes what pin and review snapshots hold.
  if ("type" in change || "undoBatchId" in change) {
    await afterChange(
      store,
      result.sources.flatMap((entry) => (entry.outcome === "updated" ? [entry.sourceId] : [])),
    );
  }
  return result;
}

export const isLibraryOrganizeAction = (
  change: ScientSourcesOrganizeAction | ScientSourcesLibraryOrganizeAction,
): change is ScientSourcesLibraryOrganizeAction =>
  change.action === "pin" ||
  change.action === "unpin" ||
  change.action === "merge" ||
  change.action === "undo-merge" ||
  change.action === "move-back";

const pinSummary = (pin: ScientProjectPin) => ({
  citationKey: pin.citationKey,
  sourceId: pin.sourceId,
  ...(pin.note !== undefined ? { note: pin.note } : {}),
});

/** Collections and saved searches on the library, plus pins and merges with their Undo IDs. */
export async function organizeLibrarySources(
  store: Store,
  input: { readonly change: ScientSourcesOrganizeAction | ScientSourcesLibraryOrganizeAction },
) {
  const { change } = input;
  if (!isLibraryOrganizeAction(change)) {
    const resolved =
      "sourceIds" in change && change.sourceIds
        ? {
            ...change,
            sourceIds: await Promise.all(
              change.sourceIds.map((sourceId) => libraryIdOf(store, sourceId)),
            ),
          }
        : change;
    return organizeSources({ root: store.library, change: resolved, actor: ACTOR });
  }
  switch (change.action) {
    case "pin": {
      const pinned = await pinScientLibrarySource({
        projectRoot: store.root,
        library: store.library,
        sourceId: await libraryIdOf(store, change.sourceId),
        actor: ACTOR,
        ...(change.note !== undefined ? { note: change.note } : {}),
      });
      if (pinned.outcome === "not-found") return { outcome: "not-found" as const };
      const noted =
        pinned.outcome === "existing" && change.note !== undefined
          ? await setScientProjectPinNote({
              projectRoot: store.root,
              citationKey: pinned.pin.citationKey,
              note: change.note,
            })
          : null;
      const pin = noted && noted.outcome !== "not-pinned" ? noted.pin : pinned.pin;
      if (pinned.outcome === "pinned") await syncProjectBibliography(store, ACTOR);
      return { outcome: pinned.outcome, pin: pinSummary(pin) };
    }
    case "unpin": {
      const unpinned = await unpinScientLibrarySource({
        projectRoot: store.root,
        citationKey: change.citationKey,
      });
      if (unpinned.outcome === "not-pinned") return { outcome: "not-pinned" as const };
      await syncProjectBibliography(store, ACTOR);
      return { outcome: "unpinned" as const, pin: pinSummary(unpinned.pin) };
    }
    case "merge":
      return mergeLibrarySources(store, change);
    case "undo-merge": {
      const undone = await undoScientLibraryMerge({
        library: store.library,
        mergeId: change.mergeId,
        actor: ACTOR,
      });
      if (undone.outcome !== "undone") return { outcome: undone.outcome };
      await afterChange(store, [undone.survivor.sourceId, undone.loser.sourceId]);
      return {
        outcome: "undone" as const,
        survivorId: undone.survivor.sourceId,
        unrevertedFields: undone.unrevertedFields,
      };
    }
    case "move-back": {
      const moved = await moveScientProjectBackIntoProject({
        library: store.library,
        projectRoot: store.root,
        actor: ACTOR,
      });
      return moved.outcome === "moved-back"
        ? { outcome: moved.outcome, restoredSources: moved.restoredSources }
        : { outcome: moved.outcome };
    }
  }
}

async function mergeLibrarySources(
  store: Store,
  change: Extract<ScientSourcesLibraryOrganizeAction, { readonly action: "merge" }>,
) {
  const sourceIds = await Promise.all(
    change.sourceIds.map((sourceId) => libraryIdOf(store, sourceId)),
  );
  const requested = change.survivorId ? await libraryIdOf(store, change.survivorId) : undefined;
  const [first, ...rest] = sourceIds;
  let survivorId = requested ?? first!;
  const merges: Array<{
    readonly mergeId: string;
    readonly survivorId: string;
    readonly mergedSourceId: string;
    readonly keptDifferent: ReadonlyArray<string>;
  }> = [];
  const others = (requested ? sourceIds : rest).filter((other) => other !== survivorId);
  let notMerged: ReadonlyArray<string> = [];
  for (const [index, other] of others.entries()) {
    const merged = await mergeScientLibrarySources({
      library: store.library,
      sourceIds: [survivorId, other],
      ...(requested ? { survivorId } : {}),
      actor: ACTOR,
    }).catch((error: unknown) => {
      // Earlier merges of this request have landed: report them and their Undo IDs.
      if (merges.length > 0) return { outcome: "failed" as const };
      throw error;
    });
    if (merged.outcome === "not-found" || merged.outcome === "failed") {
      if (merges.length === 0) return { outcome: "not-found" as const };
      notMerged = others.slice(index);
      break;
    }
    if (merged.outcome === "already-merged") continue;
    survivorId = merged.merge.survivorId;
    merges.push({
      mergeId: merged.merge.mergeId,
      survivorId: merged.merge.survivorId,
      mergedSourceId: merged.merge.loserId,
      keptDifferent: merged.merge.conflicts.map((conflict) => conflict.field),
    });
  }
  if (merges.length === 0) return { outcome: "already-merged" as const, survivorId };
  await afterChange(store, [survivorId]);
  return {
    outcome: "merged" as const,
    survivorId,
    merges,
    ...(notMerged.length > 0 ? { notMerged } : {}),
    ...(await reach(store, survivorId)),
  };
}

/** A read on a computer with no library serves every review record from its snapshot. */
const reviewAccess = (store: Store) =>
  store.exists
    ? { library: store.library, mode: store.access }
    : { library: null, mode: "read" as const };

export async function libraryReviews(store: Store) {
  return listScientLibraryReviews({ ...reviewAccess(store), projectRoot: store.root });
}

const reviewRecordSummary = (entry: ScientLibraryReviewRecord): ScientSystematicReviewRecord => ({
  sourceId: entry.projectSourceId,
  revision: entry.record?.revision ?? 0,
  title: entry.record?.title ?? null,
  creators: entry.record?.creators ?? [],
  issuedYear: entry.record?.issuedYear ?? null,
  containerTitle: entry.record?.containerTitle ?? null,
  ...(entry.from === "snapshot"
    ? { label: SNAPSHOT_LABEL }
    : entry.from === "missing"
      ? { label: "Details missing" as const }
      : {}),
});

/** The review and its records under the IDs it stores; records removed here are left out. */
export async function libraryReview(store: Store, input: { readonly reviewId: string }) {
  const access = { ...reviewAccess(store), projectRoot: store.root, reviewId: input.reviewId };
  const detail = await readScientLibraryReview(access);
  if (!detail) return { detail: null };
  const records = (await listScientLibraryReviewRecords(access)) ?? [];
  return {
    detail,
    records: records.filter((entry) => !entry.removed).map(reviewRecordSummary),
  };
}

export async function changeLibraryReview(
  store: Store,
  input: { readonly change: ScientSystematicReviewAction },
) {
  return changeScientLibraryReview({
    projectRoot: store.root,
    library: store.library,
    change: input.change,
    actor: ACTOR,
  });
}

/**
 * Exports this project's pinned works by default, or the named sources from the library. A
 * source pinned here is written under its project key, and the only note it carries is the
 * project's.
 */
export async function exportLibrarySources(
  store: Store,
  input: {
    readonly format: Parameters<typeof exportBibliography>[0]["format"];
    readonly sourceIds?: ReadonlyArray<string>;
    readonly includeNotes?: boolean;
  },
) {
  const works = await listProjectPinnedWorks(store, ACTOR);
  const pinnedRecords = works.map((work) =>
    routeRecord(work.record, {
      citationKey: work.citationKey,
      ...(work.projectNote ? { note: work.projectNote } : {}),
    }),
  );
  const pins = await projectPinsByLibraryId(store);
  const records = input.sourceIds
    ? [
        ...(store.exists ? await listScientSourceRecords(store.library) : []).map((record) =>
          routeRecord(record, pins.get(record.sourceId)),
        ),
        ...pinnedRecords.filter((_, index) => works[index]?.from === "snapshot"),
      ]
    : pinnedRecords;
  const sourceIds = input.sourceIds
    ? await Promise.all(
        input.sourceIds.map(async (sourceId) =>
          records.some((record) => record.sourceId === sourceId)
            ? sourceId
            : libraryIdOf(store, sourceId),
        ),
      )
    : undefined;
  return exportBibliography({
    root: store.root,
    format: input.format,
    ...(sourceIds ? { sourceIds } : {}),
    ...(input.includeNotes !== undefined ? { includeNotes: input.includeNotes } : {}),
    records,
  });
}

/** Library IDs for a Zotero request; without IDs, the records this project pins. */
export async function libraryZoteroSourceIds(
  store: Store,
  sourceIds: ReadonlyArray<string> | undefined,
): Promise<ReadonlyArray<string>> {
  if (!sourceIds) return [...(await projectPinsByLibraryId(store)).keys()];
  return Promise.all(sourceIds.map((sourceId) => libraryIdOf(store, sourceId)));
}

/**
 * A library import's store and pin target. The view decides: "This project" pins into the
 * project; the Library view (`pin: false`) brings records in unpinned. Later calls on the
 * operation need only the library, since the target is stored with it.
 */
export function libraryImportTarget(store: Store, pin: boolean | undefined) {
  return { root: store.library, ...(pin === false ? {} : { pinInto: store.root }) };
}

/** Pins what an intake route brought in, unless it came from the Library view. */
export async function pinLibraryIntake(
  store: Store,
  sourceIds: ReadonlyArray<string | null>,
): Promise<void> {
  let pinned = false;
  for (const sourceId of new Set(sourceIds)) {
    if (!sourceId) continue;
    const result = await pinScientLibrarySource({
      projectRoot: store.root,
      library: store.library,
      sourceId,
      actor: ACTOR,
    });
    pinned ||= result.outcome === "pinned";
  }
  if (pinned) await syncProjectBibliography(store, ACTOR);
}

export const refreshAfterLibraryChange = afterChange;
