// @effect-diagnostics nodeBuiltinImport:off -- Review conflicts are files in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { resolveScientProjectSources } from "./libraryInstanceMap.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import {
  publishScientReviewSnapshotAt,
  readScientReviewSnapshotAt,
  removeScientReviewSnapshotAt,
  scientReviewNamedIds,
  scientReviewSnapshotText,
  scientReviewWorkFromRecord,
  type ScientReviewWork,
} from "./libraryReviews.ts";
import { registerScientLibraryInstance, type ScientLibraryLocation } from "./libraryRoot.ts";
import { scientLibraryMoveInternals } from "./libraryMove.ts";
import type { ScientSourceActor } from "./model.ts";
import { assertScientProjectDirectory } from "./projectFiles.ts";
import { listScientSourceRecords, scientSourceStoreInternals } from "./store.ts";
import {
  assertSafeIdentifier,
  atomicWriteJson,
  ensureDirectory,
  isNodeError,
} from "./storeFiles.ts";
import {
  pairReviewSearches,
  ScientReviewCombineReport,
  scientReviewDecisions,
  scientReviewRecordIds,
  ScientSystematicReview,
  type ScientReviewScreening,
  type ScientReviewSearch,
  type ScientReviewStage,
  type ScientReviewVersionDifferences,
  type ScientReviewVersionSummary,
} from "./systematicReview.ts";

const REVIEWS_DIRECTORY = ".scient/library/reviews";
const CONFLICTS_DIRECTORY = ".scient/library/conflicts/reviews";
const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const STAGES: ReadonlyArray<ScientReviewStage> = ["title-abstract", "full-text"];
const decodeReview = Schema.decodeUnknownSync(ScientSystematicReview);
const validateReview = Schema.decodeSync(ScientSystematicReview);
const CONFLICT_FILE = /^([0-9a-f]{12})\.json$/u;
const isConflictId = (value: string) => /^[0-9a-f]{12}$/u.test(value);
/** Rows of differences between two versions served at a time. */
const DIFFERENCES_PAGE = 100;
/** Combine's report, beside the review's conflict files; the conflict listing never offers it. */
const COMBINE_REPORT_FILE = "combined.json";
const decodeCombineReportFile = Schema.decodeUnknownSync(
  Schema.Struct({
    formatVersion: Schema.Literal(1),
    combinedAt: Schema.String,
    report: ScientReviewCombineReport,
  }),
);

/** The note on the entry that reopens a record two copies decided differently. */
export const SCIENT_REVIEW_COMBINED_NOTE = "Decided differently in two copies";

export interface ScientReviewConflict {
  readonly conflictId: string;
  readonly review: ScientSystematicReview;
}

async function projectRootFor(projectRoot: string): Promise<string> {
  const root = await NodeFSP.realpath(projectRoot);
  await readScientProjectIdentity(root);
  return root;
}

const conflictFolder = (root: string, reviewId: string) => {
  assertSafeIdentifier(reviewId, "Review ID");
  return NodePath.join(root, ...CONFLICTS_DIRECTORY.split("/"), reviewId);
};
const reviewFile = (root: string, reviewId: string) =>
  NodePath.join(root, ...REVIEWS_DIRECTORY.split("/"), `${reviewId}.json`);

const conflictFile = (root: string, reviewId: string, conflictId: string) =>
  NodePath.join(conflictFolder(root, reviewId), `${conflictId}.json`);
const inForceSnapshotAt = (root: string, reviewId: string) => ({
  projectRoot: root,
  directory: REVIEWS_DIRECTORY,
  name: reviewId,
  reviewId,
});
const conflictSnapshotAt = (root: string, reviewId: string, conflictId: string) => ({
  projectRoot: root,
  directory: `${CONFLICTS_DIRECTORY}/${reviewId}`,
  name: conflictId,
  reviewId,
});

async function readText(filePath: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

/** A review file's content, or null when it is missing or does not decode. */
function reviewOrNull(text: string | null): ScientSystematicReview | null {
  try {
    return text ? decodeReview(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** Other versions of a review that a join kept, as "This review has another version" lists them. */
export async function listScientReviewConflicts(input: {
  readonly projectRoot: string;
  readonly reviewId: string;
}): Promise<ReadonlyArray<ScientReviewConflict>> {
  const root = await projectRootFor(input.projectRoot);
  const folder = conflictFolder(root, input.reviewId);
  let names: string[];
  try {
    names = await NodeFSP.readdir(folder);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const conflicts: ScientReviewConflict[] = [];
  for (const name of names.toSorted()) {
    const conflictId = CONFLICT_FILE.exec(name)?.[1];
    if (!conflictId) continue;
    const text = await readText(NodePath.join(folder, name));
    if (!text) continue;
    try {
      const review = decodeReview(JSON.parse(text));
      if (review.reviewId === input.reviewId) conflicts.push({ conflictId, review });
    } catch {
      // A conflict file that does not decode is not offered; it stays for a person to look at.
    }
  }
  return conflicts;
}

const pairKey = (left: string, right: string) =>
  left < right ? `${left}\0${right}` : `${right}\0${left}`;

function unionBy<A>(items: ReadonlyArray<A>, key: (item: A) => string): A[] {
  const seen = new Map<string, A>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}

/**
 * The pairs whose duplicate decisions close a cycle, as versions that each kept another record of
 * it can make when united: every record of it would then be left out of screening.
 */
function cyclePairs(duplicates: ScientSystematicReview["duplicates"]): ReadonlyArray<string> {
  const next = new Map<string, string[]>();
  for (const entry of duplicates) {
    next.set(entry.sourceId, [...(next.get(entry.sourceId) ?? []), entry.duplicateOf]);
  }
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const stack = [from];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(next.get(at) ?? []));
    }
    return false;
  };
  return duplicates
    .filter((entry) => reaches(entry.duplicateOf, entry.sourceId))
    .map((entry) => pairKey(entry.sourceId, entry.duplicateOf));
}

export type { ScientReviewCombineReport } from "./systematicReview.ts";

const searchDetails = ({ sourceIds: _ids, ...details }: ScientReviewSearch) => details;

/** "Combine": the whole review reconciled, membership united, no decision picked for anyone. */
export function combineScientReviews(input: {
  readonly existing: ScientSystematicReview;
  readonly incoming: ScientSystematicReview;
  readonly actor: ScientSourceActor;
  readonly now: string;
}): { readonly review: ScientSystematicReview; readonly report: ScientReviewCombineReport } {
  const { existing, incoming } = input;
  const differingSearches: Array<ScientReviewCombineReport["differingSearches"][number]> = [];
  // A search both copies logged is one search with the records of both, under this copy's ID;
  // kept twice it would count its records twice among those identified.
  const searches = pairReviewSearches(existing.searches, incoming.searches).flatMap(
    ({ here: search, other }) => {
      if (!search) return other ? [other] : [];
      if (!other) return [search];
      if (searchContent(other) !== searchContent(search)) {
        differingSearches.push({ searchId: search.searchId, incoming: searchDetails(other) });
      }
      return [{ ...search, sourceIds: [...new Set([...search.sourceIds, ...other.sourceIds])] }];
    },
  );

  const duplicatePairs = (review: ScientSystematicReview) =>
    new Set(review.duplicates.map((entry) => pairKey(entry.sourceId, entry.duplicateOf)));
  const distinctPairs = (review: ScientSystematicReview) =>
    new Set(review.distinctPairs.map(([left, right]) => pairKey(left, right)));
  const [existingDuplicates, incomingDuplicates] = [
    duplicatePairs(existing),
    duplicatePairs(incoming),
  ];
  const [existingDistinct, incomingDistinct] = [distinctPairs(existing), distinctPairs(incoming)];
  const conflicting = [...existingDuplicates, ...incomingDuplicates].filter(
    (key) =>
      (existingDuplicates.has(key) && incomingDistinct.has(key)) ||
      (incomingDuplicates.has(key) && existingDistinct.has(key)),
  );
  const united = unionBy(
    [...existing.duplicates, ...incoming.duplicates],
    (entry) => `${entry.sourceId}\0${entry.duplicateOf}`,
  ).filter((entry) => !conflicting.includes(pairKey(entry.sourceId, entry.duplicateOf)));
  const undecided = new Set([...conflicting, ...cyclePairs(united)]);
  const duplicates = united.filter(
    (entry) => !undecided.has(pairKey(entry.sourceId, entry.duplicateOf)),
  );
  const distinct = unionBy(
    [...existing.distinctPairs, ...incoming.distinctPairs],
    ([left, right]) => pairKey(left, right),
  ).filter(([left, right]) => !undecided.has(pairKey(left, right)));

  const screening: ScientReviewScreening[] = unionBy(
    [...existing.screening, ...incoming.screening],
    (entry) => JSON.stringify(entry),
  ).toSorted((left, right) => left.decidedAt.localeCompare(right.decidedAt));
  const reopened: Array<ScientReviewCombineReport["reopened"][number]> = [];
  for (const stage of STAGES) {
    const mine = scientReviewDecisions(existing, stage);
    const theirs = scientReviewDecisions(incoming, stage);
    for (const [sourceId, decision] of mine) {
      const other = theirs.get(sourceId);
      if (!other || other.decision === decision.decision) continue;
      screening.push({
        sourceId,
        stage,
        decision: decision.decision,
        cleared: true,
        note: SCIENT_REVIEW_COMBINED_NOTE,
        decidedAt: input.now,
        decidedBy: input.actor,
      });
      reopened.push({ sourceId, stage });
    }
  }
  const retrieval = unionBy(
    [...(existing.retrieval ?? []), ...(incoming.retrieval ?? [])],
    (entry) => JSON.stringify(entry),
  ).toSorted((left, right) => left.recordedAt.localeCompare(right.recordedAt));

  const review = validateReview({
    ...existing,
    createdAt: existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt,
    updatedAt: input.now,
    updatedBy: input.actor,
    searches,
    otherSourceIds: [...new Set([...existing.otherSourceIds, ...incoming.otherSourceIds])],
    duplicates,
    distinctPairs: distinct,
    screening,
    ...(retrieval.length > 0 ? { retrieval } : {}),
    exclusionReasons: [
      ...new Set([...existing.exclusionReasons, ...incoming.exclusionReasons]),
    ].slice(0, 50),
  });
  return {
    review,
    report: {
      undecidedPairs: [...undecided].map(
        (key) => key.split("\0") as unknown as readonly [string, string],
      ),
      differingSearches,
      reopened,
    },
  };
}

async function backUp(
  library: ScientLibraryLocation,
  instanceId: string,
  reviewId: string,
  label: string,
  files: ReadonlyArray<{ readonly name: string; readonly text: string | null }>,
): Promise<void> {
  const libraryRoot = await NodeFSP.realpath(library.root);
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const directory = NodePath.join(
    scientLibraryMoveInternals.migrationDirectory(libraryRoot, instanceId),
    "reviews",
    reviewId,
    // Two versions set aside in the same millisecond keep both.
    `${stamp}-${label}-${NodeCrypto.randomUUID().slice(0, 8)}`,
  );
  // Inside the Library's lock, so a backup copies both files of the version or neither; written
  // aside and renamed, so a stop between the files leaves a `.partial` folder, never half a version.
  await withScientLibraryLock(libraryRoot, async () => {
    const partial = `${directory}.partial`;
    await ensureDirectory(partial);
    for (const file of files) {
      if (file.text === null) continue;
      await NodeFSP.writeFile(NodePath.join(partial, file.name), file.text, {
        flag: "wx",
        flush: true,
      });
    }
    await NodeFSP.rename(partial, directory);
  });
}

async function publishChecked(filePath: string, text: string, maximumBytes: number): Promise<void> {
  await atomicWriteJson(filePath, JSON.parse(text), maximumBytes);
  if ((await readText(filePath)) !== text)
    throw new Error("The review could not be saved. Try again.");
}

// Two versions can share an `updatedAt`, so the version in force is named by its file's content.
const revisionOf = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * The pick for a review a join kept two versions of: keep this version, use the other, or
 * combine. The version not kept goes to this checkout's backup first, so the pick can be undone
 * by hand; the conflict files go only after the result is read back.
 */
export async function resolveScientReviewConflict(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly reviewId: string;
  readonly conflictId: string;
  readonly pick: "keep" | "use-other" | "combine";
  readonly actor: ScientSourceActor;
  /** `currentRevision` of the version in force that the pick was made against. */
  readonly expectedRevision?: string;
}): Promise<
  | { readonly outcome: "resolved"; readonly report: ScientReviewCombineReport | null }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "version-changed" }
> {
  const root = await projectRootFor(input.projectRoot);
  const { projectId } = await readScientProjectIdentity(root);
  const { instanceId } = await registerScientLibraryInstance({
    library: input.library,
    projectId,
    projectRoot: root,
  });
  return scientSourceStoreInternals.withOperationLock(`${root}:reviews-write`, async () => {
    const folder = conflictFolder(root, input.reviewId);
    if (!isConflictId(input.conflictId)) return { outcome: "not-found" };
    const conflictReviewPath = conflictFile(root, input.reviewId, input.conflictId);
    const conflictSnapshot = conflictSnapshotAt(root, input.reviewId, input.conflictId);
    const inForceSnapshot = inForceSnapshotAt(root, input.reviewId);
    const incomingText = await readText(conflictReviewPath);
    const existingText = await readText(reviewFile(root, input.reviewId));
    if (!incomingText || !existingText) return { outcome: "not-found" };
    if (
      input.expectedRevision !== undefined &&
      revisionOf(existingText) !== input.expectedRevision
    ) {
      return { outcome: "version-changed" };
    }
    const incoming = decodeReview(JSON.parse(incomingText));
    const existing = decodeReview(JSON.parse(existingText));
    // Either version's snapshot may be sharded: read as every reader does, file and shards.
    const incomingEntries = await readScientReviewSnapshotAt(conflictSnapshot);
    const existingEntries = await readScientReviewSnapshotAt(inForceSnapshot);
    const textOf = (entries: ReadonlyMap<string, ScientReviewWork>) =>
      entries.size > 0 ? scientReviewSnapshotText(input.reviewId, entries) : null;
    const incomingSnapshotText = textOf(incomingEntries);
    const existingSnapshotText = textOf(existingEntries);

    let report: ScientReviewCombineReport | null = null;
    let next: ScientSystematicReview | null = null;
    let entries: Map<string, ScientReviewWork> | null = null;
    if (input.pick === "keep") {
      await backUp(input.library, instanceId, input.reviewId, "other", [
        { name: "review.json", text: incomingText },
        { name: "review.works.json", text: incomingSnapshotText },
      ]);
    } else {
      await backUp(input.library, instanceId, input.reviewId, "this", [
        { name: "review.json", text: existingText },
        { name: "review.works.json", text: existingSnapshotText },
      ]);
      if (input.pick === "combine") {
        const combined = combineScientReviews({
          existing,
          incoming,
          actor: input.actor,
          now: new Date().toISOString(),
        });
        await backUp(input.library, instanceId, input.reviewId, "other", [
          { name: "review.json", text: incomingText },
          { name: "review.works.json", text: incomingSnapshotText },
        ]);
        next = combined.review;
        report = combined.report;
        entries = new Map([...incomingEntries, ...existingEntries]);
      } else {
        next = incoming;
        entries = new Map([...existingEntries, ...incomingEntries]);
      }
    }
    if (next && entries) {
      // Members neither snapshot covers come from this computer's library, where it has them.
      const missing = scientReviewNamedIds(next).filter((id) => !entries!.has(id));
      if (missing.length > 0) {
        const resolutions = await resolveScientProjectSources({
          library: input.library,
          projectRoot: root,
          mode: "write",
          sources: missing.map((projectSourceId) => ({ projectSourceId, work: null })),
        });
        const records = new Map(
          (await listScientSourceRecords(input.library)).map((record) => [record.sourceId, record]),
        );
        for (const resolution of resolutions) {
          const record =
            resolution.kind === "resolved" ? records.get(resolution.sourceId) : undefined;
          if (record) {
            entries.set(
              resolution.projectSourceId,
              scientReviewWorkFromRecord(record, record.updatedAt ?? record.importedAt),
            );
          }
        }
      }
      const named = new Set(scientReviewNamedIds(next));
      const kept = new Map([...entries].filter(([sourceId]) => named.has(sourceId)));
      await assertScientProjectDirectory(root, NodePath.dirname(reviewFile(root, input.reviewId)));
      // Section 4's order: the snapshot first, read back, then the review that names its records.
      // Joined into what is there, so a crash before the review is written loses no entry.
      await publishScientReviewSnapshotAt(inForceSnapshot, kept);
      await publishChecked(
        reviewFile(root, input.reviewId),
        `${JSON.stringify(next, null, 2)}\n`,
        MAX_REVIEW_BYTES,
      );
    }
    await NodeFSP.rm(conflictReviewPath, { force: true });
    await removeScientReviewSnapshotAt(conflictSnapshot);
    const worthKeeping =
      report !== null &&
      report.undecidedPairs.length + report.differingSearches.length + report.reopened.length > 0;
    if (worthKeeping) {
      await atomicWriteJson(
        NodePath.join(folder, COMBINE_REPORT_FILE),
        { formatVersion: 1, combinedAt: new Date().toISOString(), report },
        MAX_REVIEW_BYTES,
      );
    }
    await NodeFSP.rmdir(folder).catch(() => undefined);
    return { outcome: "resolved", report };
  });
}

function versionSummary(
  conflictId: string | null,
  review: ScientSystematicReview,
): ScientReviewVersionSummary {
  const decisions = STAGES.flatMap((stage) => [...scientReviewDecisions(review, stage).values()]);
  const lastDecidedAt = review.screening.reduce<string | null>(
    (latest, entry) => (latest === null || entry.decidedAt > latest ? entry.decidedAt : latest),
    null,
  );
  return {
    conflictId,
    title: review.title,
    updatedAt: review.updatedAt,
    updatedBy: review.updatedBy,
    ...(review.deletedAt ? { deletedAt: review.deletedAt } : {}),
    searches: review.searches.length,
    records: new Set([
      ...review.searches.flatMap((search) => search.sourceIds),
      ...review.otherSourceIds,
    ]).size,
    decisions: decisions.length,
    lastDecidedAt,
  };
}

/**
 * The version in force and each other version, for the picker; with `differencesOf`, also a page
 * of what differs from that one. Each file is read once, so the differences are those of the
 * version `currentRevision` names. Reads the project folder only.
 */
export async function readScientReviewVersions(input: {
  readonly projectRoot: string;
  readonly reviewId: string;
  readonly differencesOf?: { readonly conflictId: string; readonly offset: number };
}): Promise<{
  readonly current: ScientReviewVersionSummary | null;
  /** Names the version in force for `resolveScientReviewConflict`'s `expectedRevision`. */
  readonly currentRevision: string | null;
  readonly versions: ReadonlyArray<ScientReviewVersionSummary>;
  /** With `differencesOf`; null when either version is missing or does not decode. */
  readonly differences?: ScientReviewVersionDifferences | null;
}> {
  const root = await projectRootFor(input.projectRoot);
  const conflicts = await listScientReviewConflicts(input);
  const text = conflicts.length > 0 ? await readText(reviewFile(root, input.reviewId)) : null;
  const here = reviewOrNull(text);
  const other = conflicts.find(({ conflictId }) => conflictId === input.differencesOf?.conflictId);
  const differences = async () => {
    if (!here || !other) return null;
    // Titles come from the copies of the sources' details saved with each version.
    const [mine, theirs] = await Promise.all([
      readScientReviewSnapshotAt(inForceSnapshotAt(root, input.reviewId)),
      readScientReviewSnapshotAt(conflictSnapshotAt(root, input.reviewId, other.conflictId)),
    ]);
    return scientReviewVersionDifferences({
      here,
      other: other.review,
      titleOf: (sourceId) => (mine.get(sourceId) ?? theirs.get(sourceId))?.title ?? null,
      offset: input.differencesOf?.offset ?? 0,
    });
  };
  return {
    current: here ? versionSummary(null, here) : null,
    currentRevision: text ? revisionOf(text) : null,
    versions: conflicts.map((conflict) => versionSummary(conflict.conflictId, conflict.review)),
    ...(input.differencesOf ? { differences: await differences() } : {}),
  };
}

const decisionOf = ({
  sourceId: _sourceId,
  stage: _stage,
  cleared: _cleared,
  ...decision
}: ScientReviewScreening) => decision;

const sortedText = (values: ReadonlyArray<string>) => values.toSorted().join("\n");

/** The parts of a review compared whole: a difference in one is named, not listed. */
const NAMED_PARTS: ReadonlyArray<
  readonly [
    ScientReviewVersionDifferences["alsoDiffering"][number],
    (review: ScientSystematicReview) => string,
  ]
> = [
  ["deleted", (review) => (review.deletedAt === undefined ? "" : "deleted")],
  ["title", (review) => review.title],
  ["question", (review) => review.question ?? ""],
  ["exclusion-reasons", (review) => sortedText(review.exclusionReasons)],
  [
    "duplicates",
    (review) =>
      sortedText([
        ...review.duplicates.map((entry) => `duplicate\0${entry.sourceId}\0${entry.duplicateOf}`),
        ...review.distinctPairs.map(([left, right]) => `distinct\0${pairKey(left, right)}`),
      ]),
  ],
  [
    "retrieval",
    (review) => {
      const latest = new Map<string, string>();
      for (const entry of review.retrieval ?? []) {
        latest.set(entry.sourceId, `${entry.sourceId}\0${entry.outcome}\0${entry.note ?? ""}`);
      }
      return sortedText([...latest.values()]);
    },
  ],
];

const searchContent = (search: ScientReviewSearch) =>
  JSON.stringify([
    search.database,
    search.query,
    search.searchedOn,
    search.resultCount ?? null,
    search.notes ?? "",
  ]);

/**
 * What two versions of a review do not share, by the IDs Combine joins them by: `here` is the
 * version in force. Who decided and when is shown but is not itself a difference.
 */
export function scientReviewVersionDifferences(input: {
  readonly here: ScientSystematicReview;
  readonly other: ScientSystematicReview;
  readonly titleOf: (sourceId: string) => string | null;
  readonly offset: number;
}): ScientReviewVersionDifferences {
  const { here, other, titleOf } = input;
  const bothSides = (row: { readonly here: unknown; readonly other: unknown }) =>
    row.here !== null && row.other !== null;
  const sides = (rows: ReadonlyArray<{ readonly here: unknown; readonly other: unknown }>) => ({
    differing: rows.filter(bothSides).length,
    onlyHere: rows.filter((row) => row.other === null).length,
    onlyOther: rows.filter((row) => row.here === null).length,
  });

  const decisions = STAGES.flatMap((stage) => {
    const mine = scientReviewDecisions(here, stage);
    const theirs = scientReviewDecisions(other, stage);
    return [...new Set([...mine.keys(), ...theirs.keys()])].flatMap((sourceId) => {
      const [left, right] = [mine.get(sourceId), theirs.get(sourceId)];
      const same =
        left?.decision === right?.decision &&
        left?.reason === right?.reason &&
        left?.note === right?.note;
      return same
        ? []
        : [
            {
              kind: "decision" as const,
              sourceId,
              title: titleOf(sourceId),
              stage,
              here: left ? decisionOf(left) : null,
              other: right ? decisionOf(right) : null,
            },
          ];
    });
  });

  const searchSide = (search: ScientReviewSearch | undefined, counterpart = new Set<string>()) =>
    search
      ? {
          ...searchDetails(search),
          records: search.sourceIds.length,
          recordsOnlyThisSide: search.sourceIds.filter((id) => !counterpart.has(id)).length,
        }
      : null;
  // Paired as Combine pairs them, so the list shows what Combine will act on.
  const searches = pairReviewSearches(here.searches, other.searches).flatMap((pair) => {
    const row = {
      kind: "search" as const,
      here: searchSide(pair.here, new Set(pair.other?.sourceIds)),
      other: searchSide(pair.other, new Set(pair.here?.sourceIds)),
    };
    const same =
      pair.here !== undefined &&
      pair.other !== undefined &&
      row.here?.recordsOnlyThisSide === 0 &&
      row.other?.recordsOnlyThisSide === 0 &&
      searchContent(pair.here) === searchContent(pair.other);
    return same ? [] : [row];
  });

  const [mine, theirs] = [
    new Set(scientReviewRecordIds(here)),
    new Set(scientReviewRecordIds(other)),
  ];
  const recordsOnly = (side: "here" | "other", ids: Set<string>, counterpart: Set<string>) =>
    [...ids]
      .filter((sourceId) => !counterpart.has(sourceId))
      .map((sourceId) => ({
        kind: "record" as const,
        sourceId,
        title: titleOf(sourceId),
        in: side,
      }));
  const onlyHere = recordsOnly("here", mine, theirs);
  const onlyOther = recordsOnly("other", theirs, mine);

  const rows = [
    ...decisions.filter(bothSides),
    ...searches,
    ...decisions.filter((row) => !bothSides(row)),
    ...onlyHere,
    ...onlyOther,
  ];
  const end = input.offset + DIFFERENCES_PAGE;
  return {
    decisions: sides(decisions),
    searches: sides(searches),
    records: { onlyHere: onlyHere.length, onlyOther: onlyOther.length },
    alsoDiffering: NAMED_PARTS.filter(([, text]) => text(here) !== text(other)).map(
      ([part]) => part,
    ),
    rows: rows.slice(input.offset, end),
    nextOffset: end < rows.length ? end : null,
  };
}

/** Combine's report for a review, until someone dismisses it. */
export async function readScientReviewCombineReport(input: {
  readonly projectRoot: string;
  readonly reviewId: string;
}): Promise<(ScientReviewCombineReport & { readonly combinedAt: string }) | null> {
  const root = await projectRootFor(input.projectRoot);
  const text = await readText(
    NodePath.join(conflictFolder(root, input.reviewId), COMBINE_REPORT_FILE),
  );
  if (!text) return null;
  try {
    const saved = decodeCombineReportFile(JSON.parse(text));
    return { ...saved.report, combinedAt: saved.combinedAt };
  } catch {
    return null;
  }
}

export async function dismissScientReviewCombineReport(input: {
  readonly projectRoot: string;
  readonly reviewId: string;
}): Promise<"dismissed" | "nothing-to-dismiss"> {
  const root = await projectRootFor(input.projectRoot);
  const folder = conflictFolder(root, input.reviewId);
  return scientSourceStoreInternals.withOperationLock(`${root}:reviews-write`, async () => {
    const filePath = NodePath.join(folder, COMBINE_REPORT_FILE);
    if ((await readText(filePath)) === null) return "nothing-to-dismiss";
    await NodeFSP.rm(filePath, { force: true });
    await NodeFSP.rmdir(folder).catch(() => undefined);
    return "dismissed";
  });
}
