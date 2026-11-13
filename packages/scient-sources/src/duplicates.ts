import type {
  ScientSourceCandidate,
  ScientSourceDuplicateAssessment,
  ScientSourceRecord,
} from "./model.ts";
import { sourceMetadataKey } from "./normalize.ts";
import { isbn13 } from "./identifierInput.ts";
import {
  scientSourceIntakeProblem,
  scientSourcePdfIsEvidence,
  workLevelIdentifierKey,
  type ScientLibraryIdentityProblem,
} from "./sourceIdentity.ts";

type SourceMetadata = Pick<ScientSourceRecord, "creators" | "identifiers" | "issuedYear" | "title">;

/** Ends the move's merge line when some merges kept different values; the Library offers Review. */
export const SCIENT_LIBRARY_MERGES_TO_REVIEW = "kept different values: Review.";

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

/** What intake must respect besides the records themselves; the Library's merge decisions. */
export interface ScientSourceIntakeExclusions {
  readonly isDistinct: (left: string, right: string) => boolean;
  readonly keptApart: (left: string, right: string) => ScientLibraryIdentityProblem | null;
}

type StrongMatchKind = "same-origin" | "same-identifier" | "same-pdf";

const KEPT_SEPARATE: Record<ScientLibraryIdentityProblem | "distinct", string> = {
  distinct: "they were marked as not duplicates",
  "merge-undone": "a merge of the two was undone",
  "merge-record-unreadable": "a merge record about the existing source could not be read",
  "title-missing": "one of them has no title",
  "titles-differ": "the titles differ",
  "type-unknown": "the type of one is unknown",
  "preprint-and-published": "one is a preprint and the other is not",
  "types-differ": "the types differ",
  "arxiv-versions-differ": "they name different arXiv versions",
  "identifiers-conflict": "other identifiers disagree",
};

const MATCH_PHRASE: Record<StrongMatchKind, string> = {
  "same-origin": "comes from the same Zotero item or import as",
  "same-identifier": "shares an identifier with",
  "same-pdf": "has the same PDF as",
};

/** A book's ISBNs, as ISBN-13; only a whole book is one work by its ISBN. */
function bookIsbns(source: Pick<ScientSourceRecord, "type" | "identifiers">): Set<string> {
  if (source.type !== "book") return new Set();
  return new Set(
    source.identifiers.flatMap((identifier) => {
      const isbn =
        identifier.scheme.trim().toLowerCase() === "isbn" ? isbn13(identifier.value) : null;
      return isbn ? [isbn] : [];
    }),
  );
}

/**
 * Intake's shared identity assessment: a shared item, import, identifier (a book's ISBN) or PDF
 * reuses a record only if nothing supplied contradicts it and no Library decision keeps them
 * apart; its own key's record too. Several such records, or only disagreeing ones, leave it new.
 */
export function assessSourceDuplicate(input: {
  readonly candidate: ScientSourceCandidate;
  readonly existing: ReadonlyArray<ScientSourceRecord>;
  readonly pdfSha256?: string;
  /** The ID the store derives from the candidate's source key; a record with it is the same import. */
  readonly sourceId?: string;
  readonly exclusions?: ScientSourceIntakeExclusions;
}): ScientSourceDuplicateAssessment {
  const { candidate } = input;
  const ownKeys = new Set(
    candidate.identifiers.flatMap((identifier) => {
      const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
      return key ? [key] : [];
    }),
  );
  const isbns = bookIsbns(candidate);
  const matches: Array<{ readonly record: ScientSourceRecord; readonly kind: StrongMatchKind }> =
    [];
  for (const record of input.existing) {
    const kind: StrongMatchKind | null = candidate.externalReferences.some((candidateReference) =>
      record.externalReferences.some(
        (reference) =>
          reference.system === candidateReference.system &&
          reference.libraryId === candidateReference.libraryId &&
          reference.itemKey === candidateReference.itemKey,
      ),
    )
      ? "same-origin"
      : record.identifiers.some((identifier) => {
            const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
            return key !== null && ownKeys.has(key);
          }) || [...bookIsbns(record)].some((isbn) => isbns.has(isbn))
        ? "same-identifier"
        : input.pdfSha256 &&
            record.attachments.some((attachment) => attachment.sha256 === input.pdfSha256) &&
            scientSourcePdfIsEvidence(candidate, record)
          ? "same-pdf"
          : record.sourceId === input.sourceId
            ? "same-origin"
            : null;
    if (kind) matches.push({ record, kind });
  }
  const problemOf = (record: ScientSourceRecord) => {
    if (input.exclusions) {
      const own = input.sourceId ?? "";
      if (input.exclusions.isDistinct(own, record.sourceId)) return "distinct" as const;
      const apart = input.exclusions.keptApart(own, record.sourceId);
      if (apart) return apart;
    }
    return scientSourceIntakeProblem(candidate, record);
  };
  const assessed = matches.map((match) => ({ ...match, problem: problemOf(match.record) }));
  const corroborated = assessed.filter((match) => match.problem === null);
  const reused =
    corroborated.find((match) => match.record.sourceId === input.sourceId) ??
    (corroborated.length === 1 ? corroborated[0] : undefined);
  if (reused) {
    return {
      kind: reused.kind,
      matchingSourceIds: [reused.record.sourceId],
      reason:
        reused.kind === "same-origin"
          ? "This source was already imported from the same origin."
          : reused.kind === "same-identifier"
            ? "A source with the same persistent identifier already exists."
            : "The same PDF content already exists in this project.",
    };
  }
  if (assessed.length > 0) {
    const [first] = assessed;
    return {
      kind: "new",
      matchingSourceIds: assessed.map((match) => match.record.sourceId),
      reason:
        corroborated.length > 1
          ? "Kept as a separate source: it matches several existing sources, so it is not taken for any one of them."
          : `Kept as a separate source: it ${MATCH_PHRASE[first!.kind]} an existing source, but ${KEPT_SEPARATE[first!.problem!]}.`,
    };
  }
  return assessSourceMetadataDuplicate({ source: candidate, existing: input.existing });
}

function metadataMatchKeys(source: SourceMetadata): ReadonlyArray<string> {
  const metadataKey = sourceMetadataKey(source);
  return [
    ...source.identifiers.flatMap((identifier) => {
      const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
      return key ? [`id:${key}`] : [];
    }),
    ...(metadataKey === null ? [] : [`meta:${metadataKey}`]),
  ];
}

/**
 * Finds the records `assessSourceMetadataDuplicate` could match without scanning them all: the
 * candidates share an identifier or the title key, in the order the records were given.
 */
export function sourceMetadataMatchIndex(records: ReadonlyArray<ScientSourceRecord>) {
  const order = new Map(records.map((record, index) => [record.sourceId, index]));
  const current = new Map(records.map((record) => [record.sourceId, record]));
  const byKey = new Map<string, Set<string>>();
  const add = (record: ScientSourceRecord) => {
    for (const key of metadataMatchKeys(record)) {
      const ids = byKey.get(key) ?? new Set<string>();
      ids.add(record.sourceId);
      byKey.set(key, ids);
    }
  };
  for (const record of records) add(record);
  return {
    candidates(source: SourceMetadata, excludeSourceId: string): ReadonlyArray<ScientSourceRecord> {
      const ids = new Set(metadataMatchKeys(source).flatMap((key) => [...(byKey.get(key) ?? [])]));
      ids.delete(excludeSourceId);
      return [...ids]
        .toSorted((left, right) => order.get(left)! - order.get(right)!)
        .map((sourceId) => current.get(sourceId)!);
    },
    replace(record: ScientSourceRecord): void {
      const previous = current.get(record.sourceId);
      if (previous) {
        for (const key of metadataMatchKeys(previous)) byKey.get(key)?.delete(record.sourceId);
      }
      if (!order.has(record.sourceId)) order.set(record.sourceId, order.size);
      current.set(record.sourceId, record);
      add(record);
    },
  };
}
