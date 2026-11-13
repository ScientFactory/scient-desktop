import type { ScientSourceRecord } from "./model.ts";
import { normalizePersistentIdentifier, sourceMetadataKey } from "./normalize.ts";
import {
  scientLibraryFactsProblem,
  scientLibraryIdentityFacts,
  scientSourceIdentifiersConflict,
  scientSourcePdfIsEvidence,
  scientSourceTitleKey,
  workLevelIdentifierKey,
  type ScientLibraryIdentityFacts,
  type ScientLibraryIdentityProblem,
} from "./sourceIdentity.ts";

/** Matches strong enough to merge on their own once corroborated, strongest first. */
type ScientLibraryDuplicateKind = "same-zotero-item" | "same-identifier" | "same-pdf";
/** Matches listed for a person or an agent to decide; never merged automatically. */
export type ScientLibraryPossibleDuplicateKind =
  | "possible-item-match"
  | "possible-identifier-match"
  | "possible-pdf-match"
  | "possible-metadata-match"
  | "possible-container-match";

/** `conflicting-group`: the pair agrees itself but is linked to copies that disagree. */
export type ScientLibraryDuplicateReason = ScientLibraryIdentityProblem | "conflicting-group";

const KIND_STRENGTH: Record<ScientLibraryDuplicateKind, number> = {
  "same-zotero-item": 0,
  "same-identifier": 1,
  "same-pdf": 2,
};
const POSSIBLE_KIND: Record<ScientLibraryDuplicateKind, ScientLibraryPossibleDuplicateKind> = {
  "same-zotero-item": "possible-item-match",
  "same-identifier": "possible-identifier-match",
  "same-pdf": "possible-pdf-match",
};
const LISTING_ORDER: ReadonlyArray<ScientLibraryPossibleDuplicateKind> = [
  "possible-item-match",
  "possible-identifier-match",
  "possible-pdf-match",
  "possible-metadata-match",
  "possible-container-match",
];

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
  /** Present on a strong match that was not merged. */
  readonly reason?: ScientLibraryDuplicateReason;
}

interface ScientLibraryDuplicateAssessment {
  readonly groups: ReadonlyArray<ScientLibraryDuplicateGroup>;
  /** Pairs named by their survivors, so a pair never names a source this pass merges away. */
  readonly possibleDuplicates: ReadonlyArray<ScientLibraryPossibleDuplicate>;
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

const compareIds = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

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

/** The Zotero items and work-level identifiers a record names, each with its kind of match. */
const strongKeyCache = new WeakMap<ScientSourceRecord, Map<string, ScientLibraryDuplicateKind>>();

function strongKeys(record: ScientSourceRecord): Map<string, ScientLibraryDuplicateKind> {
  const cached = strongKeyCache.get(record);
  if (cached) return cached;
  const keys = new Map<string, ScientLibraryDuplicateKind>();
  strongKeyCache.set(record, keys);
  for (const reference of record.externalReferences) {
    keys.set(
      `item\0${reference.system}\0${reference.libraryId}\0${reference.itemKey}`,
      "same-zotero-item",
    );
  }
  for (const identifier of record.identifiers) {
    const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
    if (key) keys.set(`id\0${key}`, "same-identifier");
  }
  return keys;
}

interface StrongPair {
  readonly left: ScientSourceRecord;
  readonly right: ScientSourceRecord;
  kind: ScientLibraryDuplicateKind;
}

/**
 * The merge order of a set, outward from its survivor: each next loser is the most preferred one
 * linked to a record already merged, with the strongest such link, so its receipt names evidence
 * the survivor holds by then (it gains each loser's identifiers, items and PDFs).
 */
function outwardFrom(
  ordered: ReadonlyArray<ScientSourceRecord>,
  corroborated: ReadonlyMap<string, ReadonlyArray<StrongPair>>,
): ScientLibraryDuplicateGroup["losers"] {
  const merged = new Set([ordered[0]!.sourceId]);
  const losers: Array<ScientLibraryDuplicateGroup["losers"][number]> = [];
  while (merged.size < ordered.length) {
    let next: ScientLibraryDuplicateGroup["losers"][number] | undefined;
    for (const record of ordered) {
      if (merged.has(record.sourceId)) continue;
      for (const edge of corroborated.get(record.sourceId) ?? []) {
        const other = edge.left.sourceId === record.sourceId ? edge.right : edge.left;
        if (!merged.has(other.sourceId)) continue;
        if (!next || KIND_STRENGTH[edge.kind] < KIND_STRENGTH[next.kind]) {
          next = { sourceId: record.sourceId, kind: edge.kind };
        }
      }
      if (next) break;
    }
    // A set is connected by its corroborated links, so some loser always touches the merged part.
    if (!next) break;
    merged.add(next.sourceId);
    losers.push(next);
  }
  return losers;
}

/**
 * A merge set is connected by links (shared item, identifier or PDF) whose records corroborate
 * and are not kept apart, and every two members must corroborate too; a failing set merges
 * nothing. Every other linked pair is listed with its reason; distinct pairs never are.
 */
export function assessScientLibraryDuplicates(input: {
  readonly records: ReadonlyArray<ScientSourceRecord>;
  readonly isDistinct: (left: string, right: string) => boolean;
  /** Pairs no automatic pass merges though they agree: an undone merge, an unreadable receipt. */
  readonly keptApart: (left: string, right: string) => ScientLibraryIdentityProblem | null;
}): ScientLibraryDuplicateAssessment {
  const records = input.records.toSorted((left, right) =>
    compareIds(left.sourceId, right.sourceId),
  );
  const factsCache = new Map<string, ScientLibraryIdentityFacts>();
  const factsOf = (record: ScientSourceRecord) => {
    let facts = factsCache.get(record.sourceId);
    if (!facts) {
      facts = scientLibraryIdentityFacts(record);
      factsCache.set(record.sourceId, facts);
    }
    return facts;
  };
  const problemOf = (left: ScientSourceRecord, right: ScientSourceRecord) =>
    input.isDistinct(left.sourceId, right.sourceId)
      ? ("distinct" as const)
      : (input.keptApart(left.sourceId, right.sourceId) ??
        scientLibraryFactsProblem(factsOf(left), factsOf(right)));

  const links = new Map<string, StrongPair>();
  const link = (
    left: ScientSourceRecord,
    right: ScientSourceRecord,
    kind: ScientLibraryDuplicateKind,
  ) => {
    const key = pairKey(left.sourceId, right.sourceId);
    const existing = links.get(key);
    if (!existing) {
      const [first, second] = left.sourceId < right.sourceId ? [left, right] : [right, left];
      links.set(key, { left: first, right: second, kind });
    } else if (KIND_STRENGTH[kind] < KIND_STRENGTH[existing.kind]) {
      existing.kind = kind;
    }
  };
  const strongBuckets = new Map<string, ScientSourceRecord[]>();
  for (const record of records) {
    for (const key of strongKeys(record).keys()) {
      const bucket = strongBuckets.get(key) ?? [];
      bucket.push(record);
      strongBuckets.set(key, bucket);
    }
  }
  for (const [key, bucket] of strongBuckets) {
    if (bucket.length < 2) continue;
    const kind = strongKeys(bucket[0]!).get(key)!;
    for (const [index, left] of bucket.entries()) {
      for (const right of bucket.slice(index + 1)) link(left, right, kind);
    }
  }
  for (const bucket of buckets(records, (record) =>
    record.attachments.map((attachment) => attachment.sha256),
  )) {
    for (const [index, left] of bucket.entries()) {
      for (const right of bucket.slice(index + 1)) {
        if (scientSourcePdfIsEvidence(left, right)) link(left, right, "same-pdf");
      }
    }
  }

  const problems = new Map<string, ScientLibraryIdentityProblem | "distinct" | null>();
  const parent = new Map<string, string>();
  const find = (sourceId: string): string => {
    let root = sourceId;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(sourceId, root);
    return root;
  };
  const corroborated = new Map<string, Array<StrongPair>>();
  for (const [key, pair] of links) {
    const problem = problemOf(pair.left, pair.right);
    problems.set(key, problem);
    if (problem !== null) continue;
    const left = find(pair.left.sourceId);
    const right = find(pair.right.sourceId);
    if (left !== right) parent.set(right, left);
    for (const sourceId of [pair.left.sourceId, pair.right.sourceId]) {
      const edges = corroborated.get(sourceId) ?? [];
      edges.push(pair);
      corroborated.set(sourceId, edges);
    }
  }
  const sets = new Map<string, ScientSourceRecord[]>();
  for (const record of records) {
    if (!corroborated.has(record.sourceId)) continue;
    const root = find(record.sourceId);
    const set = sets.get(root) ?? [];
    set.push(record);
    sets.set(root, set);
  }

  const groups: ScientLibraryDuplicateGroup[] = [];
  const survivorOf = new Map<string, string>();
  for (const members of sets.values()) {
    const whole = members.every((left, index) =>
      members.slice(index + 1).every((right) => {
        const key = pairKey(left.sourceId, right.sourceId);
        const problem = problems.has(key) ? problems.get(key) : problemOf(left, right);
        return problem === null;
      }),
    );
    if (!whole) continue;
    const ordered = members.toSorted(compareScientLibrarySurvivors);
    const survivor = ordered[0]!;
    for (const member of ordered) survivorOf.set(member.sourceId, survivor.sourceId);
    groups.push({ survivorId: survivor.sourceId, losers: outwardFrom(ordered, corroborated) });
  }

  const strongPairs: Array<{
    readonly left: string;
    readonly right: string;
    readonly kind: ScientLibraryDuplicateKind;
    readonly reason: ScientLibraryDuplicateReason;
  }> = [];
  for (const [key, pair] of links) {
    const problem = problems.get(key)!;
    if (problem === "distinct") continue;
    if (problem === null && survivorOf.has(pair.left.sourceId)) continue;
    strongPairs.push({
      left: pair.left.sourceId,
      right: pair.right.sourceId,
      kind: pair.kind,
      reason: problem ?? "conflicting-group",
    });
  }

  const possibleDuplicates: ScientLibraryPossibleDuplicate[] = [];
  const listed = new Set<string>();
  const addPair = (
    left: string,
    right: string,
    kind: ScientLibraryPossibleDuplicateKind,
    reason?: ScientLibraryDuplicateReason,
  ) => {
    const leftId = survivorOf.get(left) ?? left;
    const rightId = survivorOf.get(right) ?? right;
    const key = pairKey(leftId, rightId);
    if (leftId === rightId || listed.has(key) || input.isDistinct(leftId, rightId)) return;
    listed.add(key);
    possibleDuplicates.push({
      sourceIds: leftId < rightId ? [leftId, rightId] : [rightId, leftId],
      kind,
      ...(reason ? { reason } : {}),
    });
  };
  for (const pair of strongPairs.toSorted(
    (left, right) => KIND_STRENGTH[left.kind] - KIND_STRENGTH[right.kind],
  )) {
    addPair(pair.left, pair.right, POSSIBLE_KIND[pair.kind], pair.reason);
  }
  const addPossible = (
    bucket: ReadonlyArray<ScientSourceRecord>,
    kind: ScientLibraryPossibleDuplicateKind,
    excluded?: (left: ScientSourceRecord, right: ScientSourceRecord) => boolean,
  ) => {
    for (const [index, left] of bucket.entries()) {
      for (const right of bucket.slice(index + 1)) {
        if (excluded?.(left, right)) continue;
        addPair(left.sourceId, right.sourceId, kind);
      }
    }
  };
  for (const bucket of buckets(records, (record) => {
    const key = sourceMetadataKey(record);
    return key ? [key] : [];
  })) {
    addPossible(bucket, "possible-metadata-match");
  }
  for (const bucket of buckets(records, (record) => {
    const title = scientSourceTitleKey(record);
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
    addPossible(bucket, "possible-container-match", (left, right) =>
      scientSourceIdentifiersConflict(left.identifiers, right.identifiers),
    );
  }

  return {
    groups,
    possibleDuplicates: possibleDuplicates.toSorted(
      (left, right) =>
        LISTING_ORDER.indexOf(left.kind) - LISTING_ORDER.indexOf(right.kind) ||
        compareIds(left.sourceIds[0], right.sourceIds[0]) ||
        compareIds(left.sourceIds[1], right.sourceIds[1]),
    ),
  };
}
