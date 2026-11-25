import type { ScientSourceStoreLocation } from "../libraryRoot.ts";
import type { ScientSourceCandidate } from "../model.ts";
import {
  deleteScientSourcesPermanently,
  listScientSourceTrash,
  readScientSourceTrashEntries,
  scientSourceRemovalId,
} from "../store.ts";

// Where the store keeps source history, staged operations and receipts on disk.
export const SCIENT_SOURCE_HISTORY_DIRECTORY = ".scient/sources/history";
export const SCIENT_SOURCE_OPERATIONS_DIRECTORY = ".scient/sources/operations";
export const SCIENT_SOURCE_RECEIPTS_DIRECTORY = ".scient/sources/receipts";

/** A source candidate with neutral defaults; tests pass the fields their case depends on. */
export function sourceCandidate(
  fields: Pick<ScientSourceCandidate, "sourceKey"> & Partial<ScientSourceCandidate>,
): ScientSourceCandidate {
  return {
    type: "article",
    customType: null,
    title: "",
    creators: [],
    issuedRaw: null,
    issuedYear: null,
    identifiers: [],
    abstract: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    fieldProvenance: [],
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
    ...fields,
  };
}

/** Empties the Trash as the panel does: for the listing the person was shown. */
export async function emptyScientSourceTrash(root: ScientSourceStoreLocation) {
  const { revision } = await listScientSourceTrash(root);
  return deleteScientSourcesPermanently({ root, ...(revision ? { trashRevision: revision } : {}) });
}

/** The removal ID of this source's Trash entry, as the listing names it. */
export async function trashRemovalId(
  root: ScientSourceStoreLocation,
  sourceId: string,
): Promise<string> {
  const entry = (await readScientSourceTrashEntries(root)).find(
    (candidate) => candidate.sourceId === sourceId,
  );
  if (!entry) throw new Error(`${sourceId} is not in the Trash.`);
  return scientSourceRemovalId(entry);
}

/** Deletes these trashed sources for good by their removals, as a named request does. */
export async function deleteFromTrashForGood(
  root: ScientSourceStoreLocation,
  sourceIds: ReadonlyArray<string>,
) {
  const removalIds = await Promise.all(sourceIds.map((sourceId) => trashRemovalId(root, sourceId)));
  return deleteScientSourcesPermanently({ root, removalIds });
}
