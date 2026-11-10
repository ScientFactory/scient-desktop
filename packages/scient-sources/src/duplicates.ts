import type {
  ScientSourceCandidate,
  ScientSourceDuplicateAssessment,
  ScientSourceRecord,
} from "./model.ts";
import { canonicalConnectorIdentifier } from "./connectorIdentifiers.ts";
import { normalizePersistentIdentifier, sourceMetadataKey } from "./normalize.ts";

type SourceMetadata = Pick<ScientSourceRecord, "creators" | "identifiers" | "issuedYear" | "title">;

// These schemes identify one scholarly work. Container-level identifiers such
// as ISSN and ISBN are still preserved as metadata, but they must never prove
// that two articles or chapters are the same work. OpenAlex and Semantic Scholar IDs name one
// work in their catalogue.
const WORK_LEVEL_IDENTIFIER_SCHEMES = new Set(["arxiv", "doi", "pmcid", "pmid", "openalex", "s2"]);

function workLevelIdentifierKey(scheme: string, value: string): string | null {
  const normalizedScheme = scheme.trim().toLowerCase();
  if (!WORK_LEVEL_IDENTIFIER_SCHEMES.has(normalizedScheme)) return null;
  const canonical =
    normalizedScheme === "openalex" || normalizedScheme === "s2"
      ? (canonicalConnectorIdentifier(normalizedScheme, value) ?? value)
      : value;
  return normalizePersistentIdentifier(normalizedScheme, canonical);
}

export function assessSourceMetadataDuplicate(input: {
  readonly source: SourceMetadata;
  readonly existing: ReadonlyArray<ScientSourceRecord>;
}): ScientSourceDuplicateAssessment {
  const identifiers = new Set(
    input.source.identifiers.flatMap((identifier) => {
      const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
      return key ? [key] : [];
    }),
  );
  const identifierMatches = input.existing.filter((record) =>
    record.identifiers.some((identifier) => {
      const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
      return key !== null && identifiers.has(key);
    }),
  );
  if (identifiers.size > 0 && identifierMatches.length > 0) {
    return {
      kind: "same-identifier",
      matchingSourceIds: identifierMatches.map((record) => record.sourceId),
      reason: "A source with the same persistent identifier already exists.",
    };
  }

  const metadataKey = sourceMetadataKey(input.source);
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

export function assessSourceDuplicate(input: {
  readonly candidate: ScientSourceCandidate;
  readonly existing: ReadonlyArray<ScientSourceRecord>;
  readonly pdfSha256?: string;
  /** The ID the store derives from the candidate's source key; a record with it is the same import. */
  readonly sourceId?: string;
}): ScientSourceDuplicateAssessment {
  const originMatches = input.existing.filter((record) =>
    input.candidate.externalReferences.some((candidateReference) =>
      record.externalReferences.some(
        (reference) =>
          reference.system === candidateReference.system &&
          reference.libraryId === candidateReference.libraryId &&
          reference.itemKey === candidateReference.itemKey,
      ),
    ),
  );
  if (originMatches.length > 0) {
    return {
      kind: "same-origin",
      matchingSourceIds: originMatches.map((record) => record.sourceId),
      reason: "This source was already imported from the same origin.",
    };
  }

  const metadataDuplicate = assessSourceMetadataDuplicate({
    source: input.candidate,
    existing: input.existing,
  });
  if (metadataDuplicate.kind === "same-identifier") return metadataDuplicate;

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

  if (input.sourceId && input.existing.some((record) => record.sourceId === input.sourceId)) {
    return {
      kind: "same-origin",
      matchingSourceIds: [input.sourceId],
      reason: "This source was already imported from the same origin.",
    };
  }
  return metadataDuplicate;
}
