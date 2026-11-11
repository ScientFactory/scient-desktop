import {
  scientReviewDecisions,
  scientReviewPendingIds,
  type ScientReviewStage,
  type ScientSourceRecord,
  type ScientSystematicReviewAction,
} from "@scientfactory/scient-sources";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";
import * as Effect from "effect/Effect";

import {
  changeSystematicReview,
  getSystematicReview,
  listSystematicReviews,
} from "../../../scient/sources/ScientSourcesCoordinator.ts";
import {
  changeScientLibraryReview,
  listScientLibraryReviewRecords,
  listScientLibraryReviews,
  readScientLibraryReview,
  type ScientLibraryReviewRecord,
} from "@scientfactory/scient-sources/library-reviews";
import {
  changeLibraryReviewConflict,
  libraryReviewConflicts,
} from "../../../scient/sources/LibrarySourcesRoutes.ts";
import type { ScientSourcesLibraryStore } from "../../../scient/sources/SourcesBackend.ts";
import { resolveScientSourcesStore } from "../sources/handlers.ts";
import { ScientSourcesToolError } from "../sources/tools.ts";
import {
  ScientSystematicReviewsLibraryToolkit,
  ScientSystematicReviewsToolkit,
  type ScientSystematicReviewLibraryAction,
} from "./tools.ts";

const MAX_ABSTRACT_CHARACTERS = 4_000;

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    // Store errors can name host paths; keep them out of model-visible output.
    catch: () =>
      new ScientSourcesToolError({
        code: "operation-failed",
        message: "The systematic review operation could not be completed.",
      }),
  });

function reviewRecord(
  sourceId: string,
  record: ScientSourceRecord | undefined | null,
  from?: ScientLibraryReviewRecord["from"],
) {
  const creator = record?.creators[0];
  const abstract = record?.abstract ?? null;
  return {
    sourceId,
    title: record?.title ?? null,
    creator: creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? null,
    issuedYear: record?.issuedYear ?? null,
    containerTitle: record?.containerTitle ?? null,
    abstract:
      abstract && abstract.length > MAX_ABSTRACT_CHARACTERS
        ? `${abstract.slice(0, MAX_ABSTRACT_CHARACTERS)}…`
        : abstract,
    ...(from === "snapshot"
      ? { label: "From this review's snapshot" as const }
      : from === "missing"
        ? { label: "Details missing" as const }
        : {}),
  };
}

/** A read on a computer with no library serves every record from the review's snapshot. */
const reviewAccess = (store: ScientSourcesLibraryStore) =>
  store.exists
    ? { library: store.library, mode: store.access }
    : { library: null, mode: "read" as const };

/**
 * Library mode: the review's own records, keyed by the project source ID it stores, from the
 * library or the review's snapshot. Read access writes nothing.
 */
const libraryReviewView = Effect.fn("ScientSystematicReviewsToolkit.libraryView")(function* (
  store: ScientSourcesLibraryStore,
  reviewId: string,
) {
  const input = { ...reviewAccess(store), projectRoot: store.root, reviewId };
  const detail = yield* attempt(() => readScientLibraryReview(input));
  const records = detail ? yield* attempt(() => listScientLibraryReviewRecords(input)) : null;
  const conflicts = detail
    ? yield* attempt(() => libraryReviewConflicts(store, { reviewId }))
    : null;
  return {
    detail,
    conflicts,
    present: new Set(
      (records ?? []).flatMap((entry) => (entry.removed ? [] : [entry.projectSourceId])),
    ),
    // Review screens show bibliographic fields only; the personal note stays off them.
    record: (sourceId: string) => {
      const entry = records?.find((candidate) => candidate.projectSourceId === sourceId);
      return reviewRecord(sourceId, entry?.record, entry?.from ?? "missing");
    },
  };
});

const projectReviewView = Effect.fn("ScientSystematicReviewsToolkit.projectView")(function* (
  root: string,
  reviewId: string,
) {
  const { detail } = yield* attempt(() => getSystematicReview({ root, reviewId }));
  const records = detail ? yield* attempt(() => listScientSourceRecords(root)) : [];
  const byId = new Map(records.map((record) => [record.sourceId, record]));
  return {
    detail,
    conflicts: null,
    present: new Set(byId.keys()),
    record: (sourceId: string) => reviewRecord(sourceId, byId.get(sourceId)),
  };
});

export const readSystematicReviewsForInvocation = Effect.fn("ScientSystematicReviewsToolkit.read")(
  function* (input: {
    readonly reviewId?: string;
    readonly stage?: ScientReviewStage;
    readonly limit?: number;
    readonly includeDecisions?: boolean;
  }) {
    const store = yield* resolveScientSourcesStore();
    const { root } = store;
    if (!input.reviewId) {
      const listed = yield* attempt(() =>
        store.kind === "library"
          ? listScientLibraryReviews({ ...reviewAccess(store), projectRoot: store.root })
          : listSystematicReviews(root),
      );
      return {
        reviews: listed.reviews,
        ...(listed.issues.length > 0 ? { issues: listed.issues } : {}),
      };
    }
    const reviewId = input.reviewId;
    const view =
      store.kind === "library"
        ? yield* libraryReviewView(store, reviewId)
        : yield* projectReviewView(root, reviewId);
    const { detail } = view;
    if (!detail) {
      return yield* new ScientSourcesToolError({
        code: "not-found",
        message: "The systematic review was not found in this project.",
      });
    }
    const stage = input.stage ?? "title-abstract";
    const pending = scientReviewPendingIds(detail.review, stage, view.present);
    const limit = Math.min(25, Math.max(1, input.limit ?? 10));
    const decisions = input.includeDecisions
      ? [...scientReviewDecisions(detail.review, stage).values()].slice(0, 1_000)
      : null;
    return {
      review: {
        reviewId: detail.review.reviewId,
        title: detail.review.title,
        ...(detail.review.question ? { question: detail.review.question } : {}),
        searches: detail.review.searches.map((search) => ({
          searchId: search.searchId,
          database: search.database,
          query: search.query,
          searchedOn: search.searchedOn,
          ...(search.resultCount !== undefined ? { resultCount: search.resultCount } : {}),
          recordCount: search.sourceIds.length,
          loggedBy: search.loggedBy,
        })),
        exclusionReasons: detail.review.exclusionReasons,
        prisma: detail.prisma,
        prismaMermaid: detail.mermaid,
        possibleDuplicates: detail.possibleDuplicates
          .slice(0, 50)
          .map(([left, right]) => [view.record(left), view.record(right)] as const),
        stage,
        pending: pending.slice(0, limit).map((sourceId) => view.record(sourceId)),
        pendingTotal: pending.length,
        ...(decisions
          ? {
              decisions: decisions.map((entry) => ({
                sourceId: entry.sourceId,
                decision: entry.decision,
                ...(entry.reason ? { reason: entry.reason } : {}),
                decidedBy: entry.decidedBy,
              })),
            }
          : {}),
        ...(view.conflicts && view.conflicts.versions.length > 0
          ? { conflicts: view.conflicts.versions }
          : {}),
        ...(view.conflicts?.combineReport ? { combineReport: view.conflicts.combineReport } : {}),
      },
    };
  },
);

export const updateSystematicReviewForInvocation = Effect.fn(
  "ScientSystematicReviewsToolkit.update",
)(function* (input: { readonly change: ScientSystematicReviewAction }) {
  const store = yield* resolveScientSourcesStore();
  if (store.kind === "library") {
    return yield* attempt(() =>
      changeScientLibraryReview({
        projectRoot: store.root,
        library: store.library,
        change: input.change,
        actor: "agent",
      }),
    );
  }
  return yield* attempt(() =>
    changeSystematicReview({ root: store.root, change: input.change, actor: "agent" }),
  );
});

export const ScientSystematicReviewsToolkitHandlersLive = ScientSystematicReviewsToolkit.toLayer({
  scient_sources_systematic_reviews: readSystematicReviewsForInvocation,
  scient_sources_systematic_review_update: updateSystematicReviewForInvocation,
});

/** Library mode's update: the same changes, plus the pick between a review's versions. */
export const updateLibrarySystematicReviewForInvocation = Effect.fn(
  "ScientSystematicReviewsToolkit.updateLibrary",
)(function* (input: { readonly change: ScientSystematicReviewLibraryAction }) {
  const { change } = input;
  if (change.action !== "resolve-conflict" && change.action !== "dismiss-combine-report") {
    return yield* updateSystematicReviewForInvocation({ change });
  }
  const store = yield* resolveScientSourcesStore();
  if (store.kind !== "library") {
    return yield* new ScientSourcesToolError({
      code: "not-found",
      message:
        "This project's sources are not in the Library yet, so its reviews have one version.",
    });
  }
  const result = yield* attempt(() =>
    changeLibraryReviewConflict(
      store,
      {
        reviewId: change.reviewId,
        change:
          change.action === "dismiss-combine-report"
            ? { action: "dismiss-report" }
            : { action: "resolve", conflictId: change.conflictId, pick: change.pick },
      },
      "agent",
    ),
  );
  return { ...result, reviewId: change.reviewId };
});

export const ScientSystematicReviewsLibraryToolkitHandlersLive =
  ScientSystematicReviewsLibraryToolkit.toLayer({
    scient_sources_systematic_reviews: readSystematicReviewsForInvocation,
    scient_sources_systematic_review_update: updateLibrarySystematicReviewForInvocation,
  });
