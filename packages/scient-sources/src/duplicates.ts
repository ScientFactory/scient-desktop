import type {
  ScientSourceCandidate,
  ScientSourceDuplicateAssessment,
  ScientSourceRecord,
} from "./model.ts";
import { normalizePersistentIdentifier, sourceMetadataKey } from "./normalize.ts";

export function assessSourceDuplicate(input: {
  readonly candidate: ScientSourceCandidate;
  readonly existing: ReadonlyArray<ScientSourceRecord>;
  readonly pdfSha256?: string;
}): ScientSourceDuplicateAssessment {
  const originMatches = input.existing.filter((record) =>
    record.externalReferences.some(
      (reference) =>
        reference.system === input.candidate.externalReference.system &&
        reference.libraryId === input.candidate.externalReference.libraryId &&
        reference.itemKey === input.candidate.externalReference.itemKey,
    ),
  );
  if (originMatches.length > 0) {
    return {
      kind: "same-origin",
      matchingSourceIds: originMatches.map((record) => record.sourceId),
      reason: "This Zotero item was already imported.",
    };
  }

  const candidateIdentifiers = new Set(
    input.candidate.identifiers.map((identifier) =>
      normalizePersistentIdentifier(identifier.scheme, identifier.value),
    ),
  );
  const identifierMatches = input.existing.filter((record) =>
    record.identifiers.some((identifier) =>
      candidateIdentifiers.has(normalizePersistentIdentifier(identifier.scheme, identifier.value)),
    ),
  );
  if (candidateIdentifiers.size > 0 && identifierMatches.length > 0) {
    return {
      kind: "same-identifier",
      matchingSourceIds: identifierMatches.map((record) => record.sourceId),
      reason: "A source with the same persistent identifier already exists.",
    };
  }

  if (input.pdfSha256) {
    const pdfMatches = input.existing.filter((record) =>
      record.attachments.some((attachment) => attachment.sha256 === input.pdfSha256),
    );
    if (pdfMatches.length > 0) {
      return {
        kind: "same-pdf",
        matchingSourceIds: pdfMatches.map((record) => record.sourceId),
        reason: "The same PDF content already exists in this project.",
      };
    }
  }

  const metadataKey = sourceMetadataKey(input.candidate);
  if (metadataKey !== null) {
    const metadataMatches = input.existing.filter(
      (record) => sourceMetadataKey(record) === metadataKey,
    );
    if (metadataMatches.length > 0) {
      return {
        kind: "possible-metadata-match",
        matchingSourceIds: metadataMatches.map((record) => record.sourceId),
        reason: "Title, lead creator, and year match an existing source.",
      };
    }
  }

  return { kind: "new", matchingSourceIds: [], reason: "No existing source match was found." };
}
