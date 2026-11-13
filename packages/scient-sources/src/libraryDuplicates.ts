import { workLevelIdentifierKey } from "./duplicates.ts";
import type { ScientSourceIdentifier, ScientSourceRecord } from "./model.ts";
import { normalizePersistentIdentifier, sourceMetadataKey } from "./normalize.ts";

/** Matches strong enough to merge on their own once corroborated, strongest first. */
type ScientLibraryDuplicateKind = "same-zotero-item" | "same-identifier" | "same-pdf";
/** Matches listed for a person or an agent to decide; never merged automatically. */
export type ScientLibraryPossibleDuplicateKind =
  | "possible-item-match"
  | "possible-identifier-match"
  | "possible-pdf-match"
  | "possible-metadata-match"
  | "possible-container-match";

/**
 * Why a strong match was only listed. Missing titles and unknown types are no corroboration;
 * `conflicting-group` agrees itself but links copies that disagree (or were kept apart).
 */
export type ScientLibraryIdentityProblem =
  | "merge-undone"
  | "title-missing"
  | "titles-differ"
  | "type-unknown"
  | "preprint-and-published"
  | "types-differ"
  | "arxiv-versions-differ"
  | "identifiers-conflict";
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

function identifierKey(identifier: ScientSourceIdentifier): string {
  return (
    workLevelIdentifierKey(identifier.scheme, identifier.value) ??
    normalizePersistentIdentifier(identifier.scheme, identifier.value)
  );
}

function identifierKeysByScheme(
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
): Map<string, Set<string>> {
  const byScheme = new Map<string, Set<string>>();
  for (const identifier of identifiers) {
    const key = identifierKey(identifier);
    const scheme = key.slice(0, key.indexOf(":"));
    const keys = byScheme.get(scheme) ?? new Set<string>();
    keys.add(key);
    byScheme.set(scheme, keys);
  }
  return byScheme;
}

/** Both name a scheme (DOI, ISBN, …) and share none of its values. */
function keysConflict(
  left: ReadonlyMap<string, ReadonlySet<string>>,
  right: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  for (const [scheme, keys] of left) {
    const other = right.get(scheme);
    if (other && ![...keys].some((key) => other.has(key))) return true;
  }
  return false;
}

function scientLibraryIdentifiersConflict(
  left: ScientSourceRecord,
  right: ScientSourceRecord,
): boolean {
  return keysConflict(
    identifierKeysByScheme(left.identifiers),
    identifierKeysByScheme(right.identifiers),
  );
}

/** The explicit arXiv versions a record names, by base ID ("2101.00001" → {"v2"}). */
function arxivVersions(identifiers: ReadonlyArray<ScientSourceIdentifier>) {
  const versions = new Map<string, Set<string>>();
  for (const identifier of identifiers) {
    if (identifier.scheme.trim().toLowerCase() !== "arxiv") continue;
    const base = normalizePersistentIdentifier("arxiv", identifier.value);
    const version = /v(\d+)$/u.exec(
      identifier.value
        .trim()
        .toLowerCase()
        .replace(/\.pdf$/u, ""),
    )?.[1];
    if (!version) continue;
    const set = versions.get(base) ?? new Set<string>();
    set.add(version);
    versions.set(base, set);
  }
  return versions;
}

/** Case, Unicode form, spacing and punctuation only; every word and number stays. */
function titleKey(record: { readonly title: string | null }): string {
  return (record.title ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** What identity is judged on: a library record, or a project's snapshot of a work. */
export interface ScientLibraryIdentityFields {
  readonly type: string;
  readonly title: string | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
}

interface IdentityFacts {
  readonly title: string;
  readonly type: string;
  readonly keys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly arxiv: ReadonlyMap<string, ReadonlySet<string>>;
}

function identityFacts(fields: ScientLibraryIdentityFields): IdentityFacts {
  return {
    title: titleKey(fields),
    type: fields.type,
    keys: identifierKeysByScheme(fields.identifiers),
    arxiv: arxivVersions(fields.identifiers),
  };
}

function factsProblem(
  left: IdentityFacts,
  right: IdentityFacts,
): ScientLibraryIdentityProblem | null {
  if (!left.title || !right.title) return "title-missing";
  if (left.title !== right.title) return "titles-differ";
  if (left.type === "other" || right.type === "other") return "type-unknown";
  if (left.type !== right.type) {
    return left.type === "preprint" || right.type === "preprint"
      ? "preprint-and-published"
      : "types-differ";
  }
  for (const [base, versions] of left.arxiv) {
    const other = right.arxiv.get(base);
    if (other && ![...versions].some((version) => other.has(version))) {
      return "arxiv-versions-differ";
    }
  }
  if (keysConflict(left.keys, right.keys)) return "identifiers-conflict";
  return null;
}

/**
 * Null when two records corroborate being one work: titles that agree once case, Unicode form,
 * spacing and punctuation are evened out, one known type, the same explicit arXiv version, and no
 * scheme both name without a shared value. The automatic merge pass and project resolution use it.
 */
export function scientLibraryIdentityProblem(
  left: ScientLibraryIdentityFields,
  right: ScientLibraryIdentityFields,
): ScientLibraryIdentityProblem | null {
  return factsProblem(identityFacts(left), identityFacts(right));
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

/** A book's PDF on each of its chapters is no match: one PDF counts only with one title. */
function pdfMatches(left: ScientSourceRecord, right: ScientSourceRecord): boolean {
  const title = titleKey(left);
  return (
    title !== "" &&
    title === titleKey(right) &&
    !scientLibraryIdentifiersConflict(left, right) &&
    left.attachments.some((attachment) =>
      right.attachments.some((other) => other.sha256 === attachment.sha256),
    )
  );
}

function sharedKind(left: ScientSourceRecord, right: ScientSourceRecord) {
  const theirs = strongKeys(right);
  let strongest: ScientLibraryDuplicateKind | null = null;
  for (const [key, kind] of strongKeys(left)) {
    if (!theirs.has(key)) continue;
    if (strongest === null || KIND_STRENGTH[kind] < KIND_STRENGTH[strongest]) strongest = kind;
  }
  return strongest ?? (pdfMatches(left, right) ? "same-pdf" : null);
}

/**
 * Records sharing a Zotero item, a work-level identifier or a PDF merge only as a set whose every
 * two corroborate one work, with no distinct or undone pair and no member that also agrees with a
 * copy outside it. Every other strong pair is listed with its reason; distinct pairs never are.
 */
export function assessScientLibraryDuplicates(input: {
  readonly records: ReadonlyArray<ScientSourceRecord>;
  readonly isDistinct: (left: string, right: string) => boolean;
  /** Pairs whose merge was undone: never merged automatically again, but still listed. */
  readonly wasUnmerged: (left: string, right: string) => boolean;
}): ScientLibraryDuplicateAssessment {
  const records = input.records.toSorted((left, right) =>
    compareIds(left.sourceId, right.sourceId),
  );
  const byId = new Map(records.map((record) => [record.sourceId, record]));

  const parent = new Map<string, string>();
  const find = (sourceId: string): string => {
    let root = sourceId;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(sourceId, root);
    return root;
  };
  const unite = (leftId: string, rightId: string) => {
    const left = find(leftId);
    const right = find(rightId);
    if (left !== right) parent.set(right, left);
  };
  for (const bucket of buckets(records, (record) => strongKeys(record).keys())) {
    for (const record of bucket.slice(1)) unite(bucket[0]!.sourceId, record.sourceId);
  }
  for (const bucket of buckets(records, (record) =>
    record.attachments.map((attachment) => attachment.sha256),
  )) {
    for (const [index, left] of bucket.entries()) {
      for (const right of bucket.slice(index + 1)) {
        if (pdfMatches(left, right)) unite(left.sourceId, right.sourceId);
      }
    }
  }
  const clusters = new Map<string, ScientSourceRecord[]>();
  for (const record of records) {
    if (!parent.has(record.sourceId)) continue;
    const root = find(record.sourceId);
    const cluster = clusters.get(root) ?? [];
    cluster.push(record);
    clusters.set(root, cluster);
  }

  const groups: ScientLibraryDuplicateGroup[] = [];
  const survivorOf = new Map<string, string>();
  const strongPairs: Array<{
    readonly left: string;
    readonly right: string;
    readonly kind: ScientLibraryDuplicateKind;
    readonly reason: ScientLibraryDuplicateReason;
  }> = [];
  for (const cluster of clusters.values()) {
    const facts = cluster.map(identityFacts);
    const problems = new Map<string, ScientLibraryIdentityProblem | "distinct" | null>();
    const agree = new Map<string, string[]>(cluster.map((record) => [record.sourceId, []]));
    for (const [i, left] of cluster.entries()) {
      for (const [j, right] of cluster.entries()) {
        if (j <= i) continue;
        const problem = input.isDistinct(left.sourceId, right.sourceId)
          ? "distinct"
          : input.wasUnmerged(left.sourceId, right.sourceId)
            ? "merge-undone"
            : factsProblem(facts[i]!, facts[j]!);
        problems.set(pairKey(left.sourceId, right.sourceId), problem);
        if (problem === null) {
          agree.get(left.sourceId)!.push(right.sourceId);
          agree.get(right.sourceId)!.push(left.sourceId);
        }
      }
    }
    // Sets of records that agree, directly or through one another.
    const seen = new Set<string>();
    const inGroup = new Set<string>();
    for (const record of cluster) {
      if (seen.has(record.sourceId)) continue;
      const members: string[] = [];
      const queue = [record.sourceId];
      seen.add(record.sourceId);
      while (queue.length > 0) {
        const sourceId = queue.pop()!;
        members.push(sourceId);
        for (const next of agree.get(sourceId)!) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      if (members.length < 2) continue;
      const whole = members.every((left, index) =>
        members.slice(index + 1).every((right) => problems.get(pairKey(left, right)) === null),
      );
      if (!whole) continue;
      const ordered = members
        .map((sourceId) => byId.get(sourceId)!)
        .toSorted(compareScientLibrarySurvivors);
      const survivor = ordered[0]!;
      for (const member of ordered) {
        survivorOf.set(member.sourceId, survivor.sourceId);
        inGroup.add(member.sourceId);
      }
      groups.push({
        survivorId: survivor.sourceId,
        losers: ordered.slice(1).map((loser) => {
          let kind: ScientLibraryDuplicateKind = "same-pdf";
          for (const other of ordered) {
            if (other === loser) continue;
            const shared = sharedKind(loser, other);
            if (shared && KIND_STRENGTH[shared] < KIND_STRENGTH[kind]) kind = shared;
          }
          return { sourceId: loser.sourceId, kind };
        }),
      });
    }
    for (const [i, left] of cluster.entries()) {
      for (const right of cluster.slice(i + 1)) {
        const problem = problems.get(pairKey(left.sourceId, right.sourceId));
        if (problem === "distinct") continue;
        if (problem === null && inGroup.has(left.sourceId)) continue;
        const kind = sharedKind(left, right);
        if (!kind) continue;
        strongPairs.push({
          left: left.sourceId,
          right: right.sourceId,
          kind,
          reason: problem ?? "conflicting-group",
        });
      }
    }
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
