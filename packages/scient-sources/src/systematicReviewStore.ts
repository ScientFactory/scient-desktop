// @effect-diagnostics nodeBuiltinImport:off -- Reviews share the project store's filesystem boundary.
// @effect-diagnostics globalDate:off -- Portable project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { readScientSourcesOrganization } from "./collections.ts";
import type { ScientSourceActor, ScientSourceRecord } from "./model.ts";
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
  scientReviewScreeningIds,
  ScientSystematicReview,
  SCIENT_REVIEW_DEFAULT_EXCLUSION_REASONS,
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

function reviewsDirectory(root: string): string {
  return NodePath.join(root, SCIENT_SOURCE_REVIEWS_DIRECTORY);
}

function reviewPath(root: string, reviewId: string): string {
  assertSafeIdentifier(reviewId, "Review ID");
  return NodePath.join(reviewsDirectory(root), `${reviewId}.json`);
}

/** Every directory from the project root down is checked, so a symlinked ancestor is refused. */
async function reviewsDirectoryExists(root: string): Promise<boolean> {
  try {
    await assertScientProjectDirectory(root, reviewsDirectory(root));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** A review is stored under its own ID; a file naming another review is damaged, never followed. */
async function readReviewEntry(root: string, fileName: string) {
  const review = await readBoundedJson(
    NodePath.join(reviewsDirectory(root), fileName),
    MAX_REVIEW_BYTES,
    ScientSystematicReview,
  );
  if (`${review.reviewId}.json` !== fileName) {
    throw new Error(`${fileName} holds a different review.`);
  }
  return review;
}

async function readReviewFile(root: string, reviewId: string) {
  const filePath = reviewPath(root, reviewId);
  if (!(await reviewsDirectoryExists(root))) return null;
  if ((await snapshot(filePath)) === "missing") return null;
  return readReviewEntry(root, `${reviewId}.json`);
}

async function readAllReviews(root: string) {
  if (!(await reviewsDirectoryExists(root))) return { reviews: [], issues: [] };
  const reviews: ScientSystematicReview[] = [];
  const issues: string[] = [];
  for (const entry of await NodeFSP.readdir(reviewsDirectory(root), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      reviews.push(await readReviewEntry(root, entry.name));
    } catch {
      issues.push(`${SCIENT_SOURCE_REVIEWS_DIRECTORY}/${entry.name} could not be read.`);
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
    readAllReviews(paths.root),
    listScientSourceRecords(paths.root),
  ]);
  const present = new Set(records.map((record) => record.sourceId));
  return {
    reviews: reviews
      .filter((review) => review.deletedAt === undefined)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((review) => summary(review, present)),
    issues,
  };
}

export async function readScientSystematicReview(
  root: string,
  reviewId: string,
): Promise<ScientSystematicReviewDetail | null> {
  const paths = await sourceStorePaths(root);
  const review = await readReviewFile(paths.root, reviewId);
  if (!review || review.deletedAt !== undefined) return null;
  const records = await listScientSourceRecords(paths.root);
  const present = new Set(records.map((record) => record.sourceId));
  const prisma = scientPrismaCounts(review, present);
  return {
    review,
    prisma,
    mermaid: scientPrismaMermaid(prisma),
    possibleDuplicates: scientReviewPossibleDuplicates(review, records),
    screeningSourceIds: scientReviewScreeningIds(review, present),
  };
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
  readonly records: ReadonlyArray<ScientSourceRecord>;
  readonly collectionMembers: ReadonlyArray<string> | null;
}): Change {
  const { change, actor, now } = input;
  const present = new Set(input.records.map((record) => record.sourceId));
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
          : scientReviewScreeningIds(current, present).filter(
              (sourceId) =>
                scientReviewDecisions(current, "title-abstract").get(sourceId)?.decision ===
                "include",
            ),
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
      return touched({ ...current, screening: [...current.screening, ...entries] }, extra);
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

/** The single entry point for review changes from HTTP and agent tools. */
export async function changeScientSystematicReview(input: {
  readonly root: string;
  readonly change: ScientSystematicReviewAction;
  readonly actor: ScientSourceActor;
}): Promise<ScientSystematicReviewChangeResult> {
  const paths = await sourceStorePaths(input.root);
  return withOperationLock(`${paths.root}:reviews-write`, async () => {
    const { change } = input;
    if (change.action === "create-review") {
      const existing = (await readAllReviews(paths.root)).reviews.find(
        (entry) =>
          entry.deletedAt === undefined &&
          entry.title.trim().toLocaleLowerCase() === change.title.trim().toLocaleLowerCase(),
      );
      if (existing) return { outcome: "unchanged", reviewId: existing.reviewId };
    }
    const review =
      change.action === "create-review" ? null : await readReviewFile(paths.root, change.reviewId);
    const records = await listScientSourceRecords(paths.root);
    const collectionMembers =
      change.action === "log-search" && change.collectionId
        ? ((
            await readScientSourcesOrganization(
              paths.root,
              new Set(records.map((record) => record.sourceId)),
            )
          ).collections.find((collection) => collection.collectionId === change.collectionId)
            ?.sourceIds ?? null)
        : [];
    const applied = applyChange({
      review,
      change,
      actor: input.actor,
      now: new Date().toISOString(),
      records,
      collectionMembers,
    });
    if (applied.review) {
      await assertScientProjectDirectory(paths.root, reviewsDirectory(paths.root), {
        create: true,
      });
      const next = validateReview(applied.review);
      if (change.action === "create-review") {
        if (
          !(await atomicCreateJson(reviewPath(paths.root, next.reviewId), next, MAX_REVIEW_BYTES))
        ) {
          throw new Error("The new review could not be saved. Try again.");
        }
      } else {
        // The destination is the file that was read and validated, never an ID from its contents.
        await atomicWriteJson(reviewPath(paths.root, change.reviewId), next, MAX_REVIEW_BYTES);
      }
    }
    return applied.result;
  });
}
