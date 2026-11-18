import type { ScientSourceCandidate } from "../model.ts";

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
