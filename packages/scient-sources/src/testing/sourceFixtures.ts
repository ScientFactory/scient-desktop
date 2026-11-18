import type { ScientSourceCandidate } from "../model.ts";

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
