// @effect-diagnostics nodeBuiltinImport:off -- Review conflicts are files in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { resolveScientProjectSources } from "./libraryInstanceMap.ts";
import {
  decodeScientReviewSnapshotText,
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
  scientReviewDecisions,
  ScientSystematicReview,
  type ScientReviewScreening,
  type ScientReviewSearch,
  type ScientReviewStage,
} from "./systematicReview.ts";

const REVIEWS_DIRECTORY = ".scient/library/reviews";
const CONFLICTS_DIRECTORY = ".scient/library/conflicts/reviews";
const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const STAGES: ReadonlyArray<ScientReviewStage> = ["title-abstract", "full-text"];
const decodeReview = Schema.decodeUnknownSync(ScientSystematicReview);
const validateReview = Schema.decodeSync(ScientSystematicReview);
const CONFLICT_FILE = /^([0-9a-f]{12})\.json$/u;

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
const snapshotFile = (root: string, reviewId: string) =>
  NodePath.join(root, ...REVIEWS_DIRECTORY.split("/"), `${reviewId}.works.json`);

async function readText(filePath: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
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

export interface ScientReviewCombineReport {
  /** Pairs one version marks duplicate and the other distinct; left undecided. */
  readonly undecidedPairs: ReadonlyArray<readonly [string, string]>;
  /** Searches in both versions whose details differ; the existing details are kept. */
  readonly differingSearches: ReadonlyArray<{
    readonly searchId: string;
    readonly incoming: Omit<ScientReviewSearch, "sourceIds">;
  }>;
  /** Records reopened because the two versions' latest decisions differ. */
  readonly reopened: ReadonlyArray<{
    readonly sourceId: string;
    readonly stage: ScientReviewStage;
  }>;
}

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
  const searches = existing.searches.map((search) => {
    const other = incoming.searches.find((entry) => entry.searchId === search.searchId);
    if (!other) return search;
    if (JSON.stringify(searchDetails(other)) !== JSON.stringify(searchDetails(search))) {
      differingSearches.push({ searchId: search.searchId, incoming: searchDetails(other) });
    }
    return { ...search, sourceIds: [...new Set([...search.sourceIds, ...other.sourceIds])] };
  });
  for (const search of incoming.searches) {
    if (!existing.searches.some((entry) => entry.searchId === search.searchId)) {
      searches.push(search);
    }
  }

  const duplicatePairs = (review: ScientSystematicReview) =>
    new Set(review.duplicates.map((entry) => pairKey(entry.sourceId, entry.duplicateOf)));
  const distinctPairs = (review: ScientSystematicReview) =>
    new Set(review.distinctPairs.map(([left, right]) => pairKey(left, right)));
  const [existingDuplicates, incomingDuplicates] = [
    duplicatePairs(existing),
    duplicatePairs(incoming),
  ];
  const [existingDistinct, incomingDistinct] = [distinctPairs(existing), distinctPairs(incoming)];
  const undecided = new Set(
    [...existingDuplicates, ...incomingDuplicates].filter(
      (key) =>
        (existingDuplicates.has(key) && incomingDistinct.has(key)) ||
        (incomingDuplicates.has(key) && existingDistinct.has(key)),
    ),
  );
  const duplicates = unionBy(
    [...existing.duplicates, ...incoming.duplicates],
    (entry) => `${entry.sourceId}\0${entry.duplicateOf}`,
  ).filter((entry) => !undecided.has(pairKey(entry.sourceId, entry.duplicateOf)));
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
  const directory = NodePath.join(
    scientLibraryMoveInternals.migrationDirectory(libraryRoot, instanceId),
    "reviews",
    reviewId,
    `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${label}`,
  );
  await ensureDirectory(directory);
  for (const file of files) {
    if (file.text === null) continue;
    await NodeFSP.writeFile(NodePath.join(directory, file.name), file.text, { flag: "wx" });
  }
}

async function publishChecked(filePath: string, text: string, maximumBytes: number): Promise<void> {
  await atomicWriteJson(filePath, JSON.parse(text), maximumBytes);
  if ((await readText(filePath)) !== text)
    throw new Error("The review could not be saved. Try again.");
}

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
}): Promise<
  | { readonly outcome: "resolved"; readonly report: ScientReviewCombineReport | null }
  | { readonly outcome: "not-found" }
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
    if (!/^[0-9a-f]{12}$/u.test(input.conflictId)) return { outcome: "not-found" };
    const conflictReviewPath = NodePath.join(folder, `${input.conflictId}.json`);
    const conflictSnapshotPath = NodePath.join(folder, `${input.conflictId}.works.json`);
    const incomingText = await readText(conflictReviewPath);
    const existingText = await readText(reviewFile(root, input.reviewId));
    if (!incomingText || !existingText) return { outcome: "not-found" };
    const incoming = decodeReview(JSON.parse(incomingText));
    const existing = decodeReview(JSON.parse(existingText));
    const incomingSnapshotText = await readText(conflictSnapshotPath);
    const existingSnapshotText = await readText(snapshotFile(root, input.reviewId));
    const snapshotOf = (text: string | null) =>
      (text && decodeScientReviewSnapshotText(text, input.reviewId)) || new Map();

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
        entries = new Map([
          ...snapshotOf(incomingSnapshotText),
          ...snapshotOf(existingSnapshotText),
        ]);
      } else {
        next = incoming;
        entries = new Map([
          ...snapshotOf(existingSnapshotText),
          ...snapshotOf(incomingSnapshotText),
        ]);
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
      await publishChecked(
        snapshotFile(root, input.reviewId),
        scientReviewSnapshotText(input.reviewId, kept),
        MAX_SNAPSHOT_BYTES,
      );
      await publishChecked(
        reviewFile(root, input.reviewId),
        `${JSON.stringify(next, null, 2)}\n`,
        MAX_REVIEW_BYTES,
      );
    }
    await NodeFSP.rm(conflictReviewPath, { force: true });
    await NodeFSP.rm(conflictSnapshotPath, { force: true });
    await NodeFSP.rmdir(folder).catch(() => undefined);
    return { outcome: "resolved", report };
  });
}
