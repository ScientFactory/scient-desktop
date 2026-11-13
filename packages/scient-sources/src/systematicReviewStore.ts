// @effect-diagnostics nodeBuiltinImport:off -- Reviews share the project store's filesystem boundary.
// @effect-diagnostics globalDate:off -- Portable project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { readScientSourcesOrganization } from "./collections.ts";
import type { ScientSourceActor } from "./model.ts";
import { assertScientProjectDirectory } from "./projectFiles.ts";
import {
  listScientSourceRecords,
  SCIENT_SOURCES_DIRECTORY,
  scientSourceStoreInternals,
} from "./store.ts";
import {
  scientPrismaCounts,
  scientPrismaMermaid,
  scientReviewDecisions,
  scientReviewPossibleDuplicates,
  scientReviewRecordIds,
  scientReviewRetrievalOutcomes,
  scientReviewScreeningIds,
  ScientSystematicReview,
  SCIENT_REVIEW_DEFAULT_EXCLUSION_REASONS,
  type ScientReviewRetrieval,
  type ScientReviewScreening,
  type ScientSystematicReviewAction,
  type ScientSystematicReviewChangeResult,
  type ScientSystematicReviewDetail,
  type ScientSystematicReviewList,
  type ScientSystematicReviewSummary,
} from "./systematicReview.ts";

const SCIENT_SOURCE_REVIEWS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/reviews`;

const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const {
  sourceStorePaths,
  snapshot,
  readBoundedJson,
  atomicWriteJson,
  atomicCreateJson,
  withOperationLock,
  assertSafeIdentifier,
} = scientSourceStoreInternals;
const validateReview = Schema.decodeSync(ScientSystematicReview);

/** Where a project keeps its reviews: `.scient/sources/reviews` today, `.scient/library/reviews` after the move. */
interface ReviewFolder {
  readonly root: string;
  readonly directory: string;
  /** Files with this suffix sit beside the reviews and are not reviews. */
  readonly siblingSuffix?: string;
}

function v1Folder(root: string): ReviewFolder {
  return { root, directory: SCIENT_SOURCE_REVIEWS_DIRECTORY };
}

function reviewsDirectory(folder: ReviewFolder): string {
  return NodePath.join(folder.root, folder.directory);
}

function reviewPath(folder: ReviewFolder, reviewId: string): string {
  assertSafeIdentifier(reviewId, "Review ID");
  return NodePath.join(reviewsDirectory(folder), `${reviewId}.json`);
}

/** Every directory from the project root down is checked, so a symlinked ancestor is refused. */
async function reviewsDirectoryExists(folder: ReviewFolder): Promise<boolean> {
  try {
    await assertScientProjectDirectory(folder.root, reviewsDirectory(folder));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** A review is stored under its own ID; a file naming another review is damaged, never followed. */
async function readReviewEntry(folder: ReviewFolder, fileName: string) {
  const review = await readBoundedJson(
    NodePath.join(reviewsDirectory(folder), fileName),
    MAX_REVIEW_BYTES,
    ScientSystematicReview,
  );
  if (`${review.reviewId}.json` !== fileName) {
    throw new Error(`${fileName} holds a different review.`);
  }
  return review;
}

async function readReviewFile(folder: ReviewFolder, reviewId: string) {
  const filePath = reviewPath(folder, reviewId);
  if (!(await reviewsDirectoryExists(folder))) return null;
  if ((await snapshot(filePath)) === "missing") return null;
  return readReviewEntry(folder, `${reviewId}.json`);
}

async function readAllReviews(folder: ReviewFolder) {
  if (!(await reviewsDirectoryExists(folder))) return { reviews: [], issues: [] };
  const reviews: ScientSystematicReview[] = [];
  const issues: string[] = [];
  for (const entry of await NodeFSP.readdir(reviewsDirectory(folder), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (folder.siblingSuffix && entry.name.endsWith(folder.siblingSuffix)) continue;
    try {
      reviews.push(await readReviewEntry(folder, entry.name));
    } catch {
      issues.push(`${folder.directory}/${entry.name} could not be read.`);
    }
  }
  return { reviews, issues };
}

function summary(
  review: ScientSystematicReview,
  presentSourceIds: ReadonlySet<string>,
): ScientSystematicReviewSummary {
  return {
    reviewId: review.reviewId,
    title: review.title,
    ...(review.question ? { question: review.question } : {}),
    updatedAt: review.updatedAt,
    updatedBy: review.updatedBy,
    searchCount: review.searches.length,
    prisma: scientPrismaCounts(review, presentSourceIds),
  };
}

/** Live reviews, newest change first. A file that cannot be read is reported, not fatal. */
export async function listScientSystematicReviews(
  root: string,
): Promise<ScientSystematicReviewList> {
  const paths = await sourceStorePaths(root);
  const [{ reviews, issues }, records] = await Promise.all([
    readAllReviews(v1Folder(paths.root)),
    listScientSourceRecords(paths.root),
  ]);
  const present = new Set(records.map((record) => record.sourceId));
  return reviewList(reviews, issues, () => present);
}

function reviewList(
  reviews: ReadonlyArray<ScientSystematicReview>,
  issues: ReadonlyArray<string>,
  presentFor: (review: ScientSystematicReview) => ReadonlySet<string>,
): ScientSystematicReviewList {
  return {
    reviews: reviews
      .filter((review) => review.deletedAt === undefined)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((review) => summary(review, presentFor(review))),
    issues,
  };
}

export async function readScientSystematicReview(
  root: string,
  reviewId: string,
): Promise<ScientSystematicReviewDetail | null> {
  const paths = await sourceStorePaths(root);
  const review = await readReviewFile(v1Folder(paths.root), reviewId);
  if (!review || review.deletedAt !== undefined) return null;
  const records = await listScientSourceRecords(paths.root);
  const present = new Set(records.map((record) => record.sourceId));
  return reviewDetail(review, present, scientReviewPossibleDuplicates(review, records));
}

function reviewDetail(
  review: ScientSystematicReview,
  present: ReadonlySet<string>,
  possibleDuplicates: ScientSystematicReviewDetail["possibleDuplicates"],
): ScientSystematicReviewDetail {
  const prisma = scientPrismaCounts(review, present);
  return {
    review,
    prisma,
    mermaid: scientPrismaMermaid(prisma),
    possibleDuplicates,
    screeningSourceIds: scientReviewScreeningIds(review, present),
  };
}

function recordedRetrieval(review: ScientSystematicReview) {
  return new Map((review.retrieval ?? []).map((entry) => [entry.sourceId, entry.outcome]));
}

function newId(prefix: string): string {
  return `${prefix}_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
}

type Change = {
  readonly review: ScientSystematicReview | null;
  readonly result: ScientSystematicReviewChangeResult;
};

function applyChange(input: {
  readonly review: ScientSystematicReview | null;
  readonly change: ScientSystematicReviewAction;
  readonly actor: ScientSourceActor;
  readonly now: string;
  readonly present: ReadonlySet<string>;
  readonly collectionMembers: ReadonlyArray<string> | null;
}): Change {
  const { change, actor, now, present } = input;
  const notFound: Change = { review: null, result: { outcome: "not-found", reviewId: null } };
  if (change.action === "create-review") {
    const review: ScientSystematicReview = {
      formatVersion: 1,
      reviewId: newId("review"),
      title: change.title.trim(),
      ...(change.question?.trim() ? { question: change.question.trim() } : {}),
      createdAt: now,
      updatedAt: now,
      updatedBy: actor,
      searches: [],
      otherSourceIds: [],
      duplicates: [],
      distinctPairs: [],
      screening: [],
      retrieval: [],
      exclusionReasons: [...SCIENT_REVIEW_DEFAULT_EXCLUSION_REASONS],
    };
    return { review, result: { outcome: "created", reviewId: review.reviewId } };
  }
  const current = input.review;
  if (!current) return notFound;
  if (change.action === "restore-review") {
    if (current.deletedAt === undefined) {
      return { review: null, result: { outcome: "unchanged", reviewId: current.reviewId } };
    }
    const { deletedAt: _deletedAt, ...live } = current;
    return {
      review: { ...live, updatedAt: now, updatedBy: actor },
      result: { outcome: "restored", reviewId: current.reviewId },
    };
  }
  if (current.deletedAt !== undefined) return notFound;
  const touched = (
    review: ScientSystematicReview,
    extra: Partial<ScientSystematicReviewChangeResult> = {},
  ): Change => ({
    review: { ...review, updatedAt: now, updatedBy: actor },
    result: { outcome: "updated", reviewId: review.reviewId, ...extra },
  });
  const unchanged = (extra: Partial<ScientSystematicReviewChangeResult> = {}): Change => ({
    review: null,
    result: { outcome: "unchanged", reviewId: current.reviewId, ...extra },
  });
  const known = (sourceIds: ReadonlyArray<string>) => {
    const unique = [...new Set(sourceIds)];
    return {
      kept: unique.filter((sourceId) => present.has(sourceId)),
      skipped: unique.filter((sourceId) => !present.has(sourceId)),
    };
  };
  const skippedField = (skipped: ReadonlyArray<string>) =>
    skipped.length > 0 ? { skippedSourceIds: skipped } : {};

  switch (change.action) {
    case "update-review": {
      const next: ScientSystematicReview = {
        ...current,
        ...(change.title ? { title: change.title.trim() } : {}),
        ...(change.exclusionReasons
          ? {
              exclusionReasons: [
                ...new Set(change.exclusionReasons.map((reason) => reason.trim())),
              ],
            }
          : {}),
      };
      const withQuestion =
        change.question === undefined
          ? next
          : change.question.trim()
            ? { ...next, question: change.question.trim() }
            : (({ question: _question, ...rest }) => rest)(next);
      return JSON.stringify(withQuestion) === JSON.stringify(current)
        ? unchanged()
        : touched(withQuestion);
    }
    case "delete-review":
      return {
        review: { ...current, deletedAt: now, updatedAt: now, updatedBy: actor },
        result: { outcome: "deleted", reviewId: current.reviewId },
      };
    case "log-search": {
      const { kept, skipped } = known([
        ...(change.sourceIds ?? []),
        ...(input.collectionMembers ?? []),
      ]);
      if (change.collectionId && input.collectionMembers === null) {
        return unchanged({ message: "The collection was not found." });
      }
      // The same database, query and date is the same search; logging it again replaces it.
      const same = current.searches.find(
        (search) =>
          search.database.toLocaleLowerCase() === change.database.trim().toLocaleLowerCase() &&
          search.query.trim() === change.query.trim() &&
          search.searchedOn === change.searchedOn.trim(),
      );
      const searchId = same?.searchId ?? newId("search");
      return touched(
        {
          ...current,
          searches: [
            ...current.searches.filter((search) => search.searchId !== searchId),
            {
              searchId,
              database: change.database.trim(),
              query: change.query,
              searchedOn: change.searchedOn.trim(),
              ...(change.resultCount !== undefined ? { resultCount: change.resultCount } : {}),
              ...(change.notes?.trim() ? { notes: change.notes.trim() } : {}),
              sourceIds: kept,
              loggedAt: now,
              loggedBy: actor,
            },
          ],
        },
        { searchId, ...skippedField(skipped) },
      );
    }
    case "remove-search": {
      if (!current.searches.some((search) => search.searchId === change.searchId)) {
        return unchanged({ message: "The search was not found in this review." });
      }
      return touched({
        ...current,
        searches: current.searches.filter((search) => search.searchId !== change.searchId),
      });
    }
    case "add-sources": {
      const { kept, skipped } = known(change.sourceIds);
      const existing = new Set(scientReviewRecordIds(current));
      const added = kept.filter((sourceId) => !existing.has(sourceId));
      if (added.length === 0) return unchanged(skippedField(skipped));
      return touched(
        { ...current, otherSourceIds: [...current.otherSourceIds, ...added] },
        skippedField(skipped),
      );
    }
    case "remove-sources": {
      const removed = new Set(change.sourceIds);
      const next = {
        ...current,
        otherSourceIds: current.otherSourceIds.filter((sourceId) => !removed.has(sourceId)),
        searches: current.searches.map((search) => ({
          ...search,
          sourceIds: search.sourceIds.filter((sourceId) => !removed.has(sourceId)),
        })),
      };
      return JSON.stringify(next) === JSON.stringify(current) ? unchanged() : touched(next);
    }
    case "mark-duplicate": {
      const records = new Set(scientReviewRecordIds(current));
      if (
        change.sourceId === change.duplicateOf ||
        !records.has(change.sourceId) ||
        !records.has(change.duplicateOf)
      ) {
        return unchanged({ message: "Both sources must be different records in this review." });
      }
      if (current.duplicates.some((entry) => entry.sourceId === change.duplicateOf)) {
        return unchanged({ message: "Keep a record that is not itself marked as a duplicate." });
      }
      return touched({
        ...current,
        duplicates: [
          ...current.duplicates.filter((entry) => entry.sourceId !== change.sourceId),
          {
            sourceId: change.sourceId,
            duplicateOf: change.duplicateOf,
            decidedAt: now,
            decidedBy: actor,
          },
        ],
      });
    }
    case "unmark-duplicate": {
      if (!current.duplicates.some((entry) => entry.sourceId === change.sourceId))
        return unchanged();
      return touched({
        ...current,
        duplicates: current.duplicates.filter((entry) => entry.sourceId !== change.sourceId),
      });
    }
    case "mark-distinct": {
      const key = [...change.sourceIds].toSorted().join("\0");
      if (current.distinctPairs.some((pair) => [...pair].toSorted().join("\0") === key)) {
        return unchanged();
      }
      return touched({ ...current, distinctPairs: [...current.distinctPairs, change.sourceIds] });
    }
    case "screen": {
      const eligible = new Set(
        change.stage === "title-abstract"
          ? scientReviewScreeningIds(current, present)
          : scientReviewRetrievalOutcomes(current, present).keys(),
      );
      const inForce = scientReviewDecisions(current, change.stage);
      const skipped: string[] = [];
      const entries = change.decisions.flatMap((entry) => {
        if (!eligible.has(entry.sourceId)) {
          skipped.push(entry.sourceId);
          return [];
        }
        const previous = inForce.get(entry.sourceId);
        const reason = entry.reason?.trim();
        const note = entry.note?.trim();
        if (
          previous &&
          previous.decision === entry.decision &&
          previous.reason === reason &&
          previous.note === note
        ) {
          return [];
        }
        return [
          {
            sourceId: entry.sourceId,
            stage: change.stage,
            decision: entry.decision,
            ...(reason ? { reason } : {}),
            ...(note ? { note } : {}),
            decidedAt: now,
            decidedBy: actor,
          },
        ];
      });
      const extra = {
        ...skippedField(skipped),
        ...(skipped.length > 0
          ? {
              message:
                change.stage === "full-text"
                  ? "Skipped sources are not included at title and abstract screening."
                  : "Skipped sources are not records being screened in this review.",
            }
          : {}),
      };
      if (entries.length === 0) return unchanged(extra);
      // Assessing a report means it was retrieved, whatever was recorded before.
      const recorded = recordedRetrieval(current);
      const retrieved =
        change.stage === "full-text"
          ? entries
              .filter((entry) => (recorded.get(entry.sourceId) ?? "retrieved") !== "retrieved")
              .map((entry) => ({
                sourceId: entry.sourceId,
                outcome: "retrieved" as const,
                recordedAt: now,
                recordedBy: actor,
              }))
          : [];
      return touched(
        {
          ...current,
          screening: [...current.screening, ...entries],
          ...(retrieved.length > 0
            ? { retrieval: [...(current.retrieval ?? []), ...retrieved] }
            : {}),
        },
        extra,
      );
    }
    case "record-retrieval": {
      const outcomes = scientReviewRetrievalOutcomes(current, present);
      const fullText = scientReviewDecisions(current, "full-text");
      const skipped: string[] = [];
      const recorded: ScientReviewRetrieval[] = [];
      const cleared: ScientReviewScreening[] = [];
      for (const report of change.reports) {
        const outcome = outcomes.get(report.sourceId);
        const note = report.note?.trim();
        if (outcome === undefined) {
          skipped.push(report.sourceId);
          continue;
        }
        if (outcome === report.outcome && !note) continue;
        recorded.push({
          sourceId: report.sourceId,
          outcome: report.outcome,
          ...(note ? { note } : {}),
          recordedAt: now,
          recordedBy: actor,
        });
        // A report that was not retrieved was not assessed, so its full-text decision is reopened.
        const decision = fullText.get(report.sourceId);
        if (report.outcome !== "retrieved" && decision) {
          cleared.push({ ...decision, cleared: true, decidedAt: now, decidedBy: actor });
        }
      }
      const extra =
        skipped.length > 0
          ? {
              ...skippedField(skipped),
              message: "Skipped sources are not included at title and abstract screening.",
            }
          : {};
      if (recorded.length === 0) return unchanged(extra);
      return touched(
        {
          ...current,
          screening: [...current.screening, ...cleared],
          retrieval: [...(current.retrieval ?? []), ...recorded],
        },
        extra,
      );
    }
    case "clear-decision": {
      const previous = scientReviewDecisions(current, change.stage).get(change.sourceId);
      if (!previous) return unchanged();
      return touched({
        ...current,
        screening: [
          ...current.screening,
          {
            sourceId: change.sourceId,
            stage: change.stage,
            decision: previous.decision,
            cleared: true,
            decidedAt: now,
            decidedBy: actor,
          },
        ],
      });
    }
  }
}

interface ReviewChangeContext {
  /** Source IDs this store knows: new IDs outside it are skipped, and only these are screened. */
  readonly present: ReadonlySet<string>;
  readonly collectionMembers: ReadonlyArray<string> | null;
}

interface ReviewChangeHooks {
  readonly context: (
    review: ScientSystematicReview | null,
    change: ScientSystematicReviewAction,
  ) => Promise<ReviewChangeContext>;
  /** Runs under the reviews lock before the review is written, and when nothing changed. */
  readonly beforeReviewWrite?: (input: {
    readonly previous: ScientSystematicReview | null;
    readonly next: ScientSystematicReview | null;
  }) => Promise<void>;
}

async function changeReviewIn(
  folder: ReviewFolder,
  hooks: ReviewChangeHooks,
  input: { readonly change: ScientSystematicReviewAction; readonly actor: ScientSourceActor },
): Promise<ScientSystematicReviewChangeResult> {
  return withOperationLock(`${folder.root}:reviews-write`, async () => {
    const { change } = input;
    if (change.action === "create-review") {
      const existing = (await readAllReviews(folder)).reviews.find(
        (entry) =>
          entry.deletedAt === undefined &&
          entry.title.trim().toLocaleLowerCase() === change.title.trim().toLocaleLowerCase(),
      );
      if (existing) return { outcome: "unchanged", reviewId: existing.reviewId };
    }
    const review =
      change.action === "create-review" ? null : await readReviewFile(folder, change.reviewId);
    const context = await hooks.context(review, change);
    const applied = applyChange({
      review,
      change,
      actor: input.actor,
      now: new Date().toISOString(),
      present: context.present,
      collectionMembers: context.collectionMembers,
    });
    const writesSnapshot = hooks.beforeReviewWrite !== undefined && review !== null;
    if (applied.review || writesSnapshot) {
      await assertScientProjectDirectory(folder.root, reviewsDirectory(folder), { create: true });
    }
    const next = applied.review ? validateReview(applied.review) : null;
    if (hooks.beforeReviewWrite && (review || next)) {
      await hooks.beforeReviewWrite({ previous: review, next });
    }
    if (next) {
      if (change.action === "create-review") {
        if (!(await atomicCreateJson(reviewPath(folder, next.reviewId), next, MAX_REVIEW_BYTES))) {
          throw new Error("The new review could not be saved. Try again.");
        }
      } else {
        // The destination is the file that was read and validated, never an ID from its contents.
        await atomicWriteJson(reviewPath(folder, change.reviewId), next, MAX_REVIEW_BYTES);
      }
    }
    return applied.result;
  });
}

/** The single entry point for review changes from HTTP and agent tools. */
export async function changeScientSystematicReview(input: {
  readonly root: string;
  readonly change: ScientSystematicReviewAction;
  readonly actor: ScientSourceActor;
}): Promise<ScientSystematicReviewChangeResult> {
  const paths = await sourceStorePaths(input.root);
  return changeReviewIn(
    v1Folder(paths.root),
    {
      context: async (_review, change) => {
        const records = await listScientSourceRecords(paths.root);
        const present = new Set(records.map((record) => record.sourceId));
        const collectionMembers =
          change.action === "log-search" && change.collectionId
            ? ((await readScientSourcesOrganization(paths.root, present)).collections.find(
                (collection) => collection.collectionId === change.collectionId,
              )?.sourceIds ?? null)
            : [];
        return { present, collectionMembers };
      },
    },
    input,
  );
}

/** For the personal library's review store (`libraryReviews.ts`), which shares this one's rules. */
export const scientSystematicReviewStoreInternals = {
  changeReviewIn,
  readReviewFile,
  readAllReviews,
  reviewList,
  reviewDetail,
  reviewPath,
  reviewsDirectory,
  reviewsDirectoryExists,
};
export type { ReviewFolder as ScientReviewFolder };
