import { workLevelIdentifierKey } from "./duplicates.ts";
import type { ScientSourceIdentifier, ScientSourceRecord } from "./model.ts";
import { normalizePersistentIdentifier, sourceMetadataKey } from "./normalize.ts";

/** Matches strong enough to merge on their own, strongest first. */
type ScientLibraryDuplicateKind = "same-zotero-item" | "same-identifier" | "same-pdf";
/** Matches listed for a person or an agent to decide; never merged automatically. */
type ScientLibraryPossibleDuplicateKind = "possible-metadata-match" | "possible-container-match";

const KIND_STRENGTH: Record<ScientLibraryDuplicateKind, number> = {
  "same-zotero-item": 0,
  "same-identifier": 1,
  "same-pdf": 2,
};

interface ScientLibraryDuplicateGroup {
  readonly survivorId: string;
  /** Merged into the survivor in this order, each with the strongest match that joined it. */
  readonly losers: ReadonlyArray<{
    readonly sourceId: string;
    readonly kind: ScientLibraryDuplicateKind;
  }>;
}

export interface ScientLibraryPossibleDuplicate {
  readonly sourceIds: readonly [string, string];
  readonly kind: ScientLibraryPossibleDuplicateKind;
}

interface ScientLibraryDuplicateAssessment {
  readonly groups: ReadonlyArray<ScientLibraryDuplicateGroup>;
  /** Pairs named by their survivors, so a pair never names a source this pass merges away. */
  readonly possibleDuplicates: ReadonlyArray<ScientLibraryPossibleDuplicate>;
}

function identifierKey(identifier: ScientSourceIdentifier): string {
  return (
    workLevelIdentifierKey(identifier.scheme, identifier.value) ??
    normalizePersistentIdentifier(identifier.scheme, identifier.value)
  );
}

function identifierKeysByScheme(record: ScientSourceRecord): Map<string, Set<string>> {
  const byScheme = new Map<string, Set<string>>();
  for (const identifier of record.identifiers) {
    const key = identifierKey(identifier);
    const scheme = key.slice(0, key.indexOf(":"));
    const keys = byScheme.get(scheme) ?? new Set<string>();
    keys.add(key);
    byScheme.set(scheme, keys);
  }
  return byScheme;
}

/** Both name a scheme (DOI, ISBN, …) and share none of its values. */
function scientLibraryIdentifiersConflict(
  left: ScientSourceRecord,
  right: ScientSourceRecord,
): boolean {
  const rightKeys = identifierKeysByScheme(right);
  for (const [scheme, keys] of identifierKeysByScheme(left)) {
    const other = rightKeys.get(scheme);
    if (other && ![...keys].some((key) => other.has(key))) return true;
  }
  return false;
}

function titleKey(record: Pick<ScientSourceRecord, "title">): string {
  return (record.title ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The record a merge keeps: the most recent registry check, otherwise the oldest import. The ID
 * breaks ties so every computer picks the same one.
 */
export function compareScientLibrarySurvivors(
  left: ScientSourceRecord,
  right: ScientSourceRecord,
): number {
  const leftChecked = left.verification?.checkedAt ?? "";
  const rightChecked = right.verification?.checkedAt ?? "";
  return (
    rightChecked.localeCompare(leftChecked) ||
    left.importedAt.localeCompare(right.importedAt) ||
    left.sourceId.localeCompare(right.sourceId)
  );
}

export function pairKey(left: string, right: string): string {
  return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

function buckets(
  records: ReadonlyArray<ScientSourceRecord>,
  keysOf: (record: ScientSourceRecord) => Iterable<string>,
): ReadonlyArray<ReadonlyArray<ScientSourceRecord>> {
  const byKey = new Map<string, ScientSourceRecord[]>();
  for (const record of records) {
    for (const key of new Set(keysOf(record))) {
      const bucket = byKey.get(key);
      if (bucket) bucket.push(record);
      else byKey.set(key, [record]);
    }
  }
  return [...byKey.values()].filter((bucket) => bucket.length > 1);
}

/**
 * Library-wide duplicates, design order: same Zotero item, a shared work-level identifier, or the
 * same PDF with matching titles and no conflicting identifiers merge. Title, lead author and year
 * are only possible; so is an ISBN or ISSN shared by one title or two whole books, unless their
 * DOIs differ. A pair `isDistinct` names never lands in one group, even through a third record.
 */
export function assessScientLibraryDuplicates(input: {
  readonly records: ReadonlyArray<ScientSourceRecord>;
  readonly isDistinct: (left: string, right: string) => boolean;
  /** Distinct pairs by source, so joining two groups checks only the pairs that touch them. */
  readonly distinctNeighbors: ReadonlyMap<string, ReadonlySet<string>>;
}): ScientLibraryDuplicateAssessment {
  const groupOf = new Map<string, string[]>();
  const joinedBy = new Map<string, ScientLibraryDuplicateKind>();
  const group = (sourceId: string) => groupOf.get(sourceId) ?? [sourceId];

  const unite = (left: string, right: string, kind: ScientLibraryDuplicateKind) => {
    const leftGroup = group(left);
    const rightGroup = group(right);
    if (leftGroup === rightGroup) return;
    const [smaller, larger] =
      leftGroup.length <= rightGroup.length ? [leftGroup, rightGroup] : [rightGroup, leftGroup];
    const largerSet = new Set(larger);
    for (const member of smaller) {
      for (const neighbor of input.distinctNeighbors.get(member) ?? []) {
        if (largerSet.has(neighbor)) return;
      }
    }
    const merged = [...larger, ...smaller];
    for (const member of merged) groupOf.set(member, merged);
    for (const sourceId of [left, right]) {
      const previous = joinedBy.get(sourceId);
      if (previous === undefined || KIND_STRENGTH[kind] < KIND_STRENGTH[previous]) {
        joinedBy.set(sourceId, kind);
      }
    }
  };

  for (const bucket of buckets(input.records, (record) =>
    record.externalReferences.map(
      (reference) => `${reference.system}\0${reference.libraryId}\0${reference.itemKey}`,
    ),
  )) {
    for (const record of bucket.slice(1)) {
      unite(bucket[0]!.sourceId, record.sourceId, "same-zotero-item");
    }
  }
  for (const bucket of buckets(input.records, (record) =>
    record.identifiers.flatMap((identifier) => {
      const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
      return key ? [key] : [];
    }),
  )) {
    for (const record of bucket.slice(1)) {
      unite(bucket[0]!.sourceId, record.sourceId, "same-identifier");
    }
  }
  for (const bucket of buckets(input.records, (record) =>
    record.attachments.map((attachment) => attachment.sha256),
  )) {
    for (const [index, left] of bucket.entries()) {
      for (const right of bucket.slice(index + 1)) {
        const title = titleKey(left);
        if (title && title === titleKey(right) && !scientLibraryIdentifiersConflict(left, right)) {
          unite(left.sourceId, right.sourceId, "same-pdf");
        }
      }
    }
  }

  const byId = new Map(input.records.map((record) => [record.sourceId, record]));
  const groups: ScientLibraryDuplicateGroup[] = [];
  const survivorOf = new Map<string, string>();
  for (const members of new Set(groupOf.values())) {
    const ordered = members
      .map((sourceId) => byId.get(sourceId)!)
      .toSorted(compareScientLibrarySurvivors);
    const survivor = ordered[0]!;
    for (const member of ordered) survivorOf.set(member.sourceId, survivor.sourceId);
    groups.push({
      survivorId: survivor.sourceId,
      losers: ordered.slice(1).map((record) => ({
        sourceId: record.sourceId,
        kind: joinedBy.get(record.sourceId) ?? "same-identifier",
      })),
    });
  }

  const possibleDuplicates: ScientLibraryPossibleDuplicate[] = [];
  const listed = new Set<string>();
  const addPossible = (
    bucket: ReadonlyArray<ScientSourceRecord>,
    kind: ScientLibraryPossibleDuplicateKind,
    excluded?: (left: ScientSourceRecord, right: ScientSourceRecord) => boolean,
  ) => {
    for (const [index, left] of bucket.entries()) {
      for (const right of bucket.slice(index + 1)) {
        const leftId = survivorOf.get(left.sourceId) ?? left.sourceId;
        const rightId = survivorOf.get(right.sourceId) ?? right.sourceId;
        const key = pairKey(leftId, rightId);
        if (leftId === rightId || listed.has(key) || input.isDistinct(leftId, rightId)) continue;
        if (excluded?.(left, right)) continue;
        listed.add(key);
        possibleDuplicates.push({
          sourceIds: leftId < rightId ? [leftId, rightId] : [rightId, leftId],
          kind,
        });
      }
    }
  };
  for (const bucket of buckets(input.records, (record) => {
    const key = sourceMetadataKey(record);
    return key ? [key] : [];
  })) {
    addPossible(bucket, "possible-metadata-match");
  }
  for (const bucket of buckets(input.records, (record) => {
    const title = titleKey(record);
    return record.identifiers.flatMap((identifier) => {
      const scheme = identifier.scheme.trim().toLowerCase();
      if (scheme !== "isbn" && scheme !== "issn") return [];
      const container = normalizePersistentIdentifier(scheme, identifier.value);
      return [
        ...(title ? [`${container}\0${title}`] : []),
        // An ISSN names a whole journal; only two whole-book records share an ISBN as one work.
        ...(scheme === "isbn" && record.type === "book" ? [`${container}\0\0book`] : []),
      ];
    });
  })) {
    addPossible(bucket, "possible-container-match", scientLibraryIdentifiersConflict);
  }

  return { groups, possibleDuplicates };
}
