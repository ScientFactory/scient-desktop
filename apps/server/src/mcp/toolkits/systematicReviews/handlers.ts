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
import { resolveScientSourcesProject } from "../sources/handlers.ts";
import { ScientSourcesToolError } from "../sources/tools.ts";
import { ScientSystematicReviewsToolkit } from "./tools.ts";

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

function reviewRecord(sourceId: string, record: ScientSourceRecord | undefined) {
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
  };
}

export const readSystematicReviewsForInvocation = Effect.fn("ScientSystematicReviewsToolkit.read")(
  function* (input: {
    readonly reviewId?: string;
    readonly stage?: ScientReviewStage;
    readonly limit?: number;
    readonly includeDecisions?: boolean;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    if (!input.reviewId) {
      const listed = yield* attempt(() => listSystematicReviews(root));
      return {
        reviews: listed.reviews,
        ...(listed.issues.length > 0 ? { issues: listed.issues } : {}),
      };
    }
    const reviewId = input.reviewId;
    const { detail } = yield* attempt(() => getSystematicReview({ root, reviewId }));
    if (!detail) {
      return yield* new ScientSourcesToolError({
        code: "not-found",
        message: "The systematic review was not found in this project.",
      });
    }
    const records = yield* attempt(() => listScientSourceRecords(root));
    const byId = new Map(records.map((record) => [record.sourceId, record]));
    const stage = input.stage ?? "title-abstract";
    const pending = scientReviewPendingIds(detail.review, stage, new Set(byId.keys()));
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
          .map(
            ([left, right]) =>
              [reviewRecord(left, byId.get(left)), reviewRecord(right, byId.get(right))] as const,
          ),
        stage,
        pending: pending
          .slice(0, limit)
          .map((sourceId) => reviewRecord(sourceId, byId.get(sourceId))),
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
      },
    };
  },
);

export const updateSystematicReviewForInvocation = Effect.fn(
  "ScientSystematicReviewsToolkit.update",
)(function* (input: { readonly change: ScientSystematicReviewAction }) {
  const { root } = yield* resolveScientSourcesProject();
  return yield* attempt(() =>
    changeSystematicReview({ root, change: input.change, actor: "agent" }),
  );
});

export const ScientSystematicReviewsToolkitHandlersLive = ScientSystematicReviewsToolkit.toLayer({
  scient_sources_systematic_reviews: readSystematicReviewsForInvocation,
  scient_sources_systematic_review_update: updateSystematicReviewForInvocation,
});
