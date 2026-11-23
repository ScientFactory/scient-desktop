import {
  ScientPrismaCounts,
  ScientReviewCombineReport,
  ScientReviewDecision,
  ScientReviewStage,
  ScientReviewVersionDifferences,
  ScientReviewVersionSummary,
  ScientSourceActor,
  ScientSystematicReviewAction,
  ScientSystematicReviewChangeResult,
  ScientSystematicReviewSummary,
} from "@scientfactory/scient-sources";
import { ScientSourceLibraryMatch } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ScientOperation } from "../../ScientOperationTool.ts";
import { ScientSourcesToolError } from "../sources/tools.ts";

const dependencies = [AgentInvocationContext.AgentInvocationContext, WorkspaceBindingResolver];
const Id = Schema.String.check(Schema.isNonEmpty());
const NullableText = Schema.NullOr(Schema.String);

/** Combine's report on a review, until someone dismisses it. */
const CombineReport = Schema.Struct({ ...ScientReviewCombineReport.fields, combinedAt: Id });

const ReviewRecord = Schema.Struct({
  sourceId: Id,
  title: NullableText,
  creator: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  containerTitle: NullableText,
  abstract: NullableText,
  /** Library mode: a record this library lacks, served from the review's snapshot or missing. */
  label: Schema.optionalKey(Schema.Literals(["From this review's snapshot", "Details missing"])),
  /** A snapshot record with Library near-matches; repaired with the organize tool's link-pin. */
  libraryMatch: Schema.optionalKey(ScientSourceLibraryMatch),
});

export const ScientSystematicReviewsReadResult = Schema.Struct({
  reviews: Schema.optionalKey(Schema.Array(ScientSystematicReviewSummary)),
  review: Schema.optionalKey(
    Schema.Struct({
      reviewId: Id,
      title: Schema.String,
      question: Schema.optionalKey(Schema.String),
      searches: Schema.Array(
        Schema.Struct({
          searchId: Id,
          database: Schema.String,
          query: Schema.String,
          searchedOn: Schema.String,
          resultCount: Schema.optionalKey(Schema.Int),
          recordCount: Schema.Int,
          loggedBy: ScientSourceActor,
        }),
      ),
      exclusionReasons: Schema.Array(Schema.String),
      prisma: ScientPrismaCounts,
      prismaMermaid: Schema.String,
      possibleDuplicates: Schema.Array(Schema.Tuple([ReviewRecord, ReviewRecord])).pipe(
        Schema.check(Schema.isMaxLength(50)),
      ),
      stage: ScientReviewStage,
      pending: Schema.Array(ReviewRecord).pipe(Schema.check(Schema.isMaxLength(25))),
      pendingTotal: Schema.Int,
      decisions: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            sourceId: Id,
            decision: ScientReviewDecision,
            reason: Schema.optionalKey(Schema.String),
            decidedBy: ScientSourceActor,
          }),
        ).pipe(Schema.check(Schema.isMaxLength(1_000))),
      ),
      /** Library mode: other versions of this review from a copy of the project, to pick from. */
      conflicts: Schema.optionalKey(Schema.Array(ScientReviewVersionSummary)),
      combineReport: Schema.optionalKey(CombineReport),
    }),
  ),
  /** Library mode, with differencesOf: what differs from that version, in place of the review. */
  differences: Schema.optionalKey(ScientReviewVersionDifferences),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
});

const READ_DESCRIPTION =
  "Read systematic reviews: without reviewId, list them with PRISMA counts; with it, its searches, exclusion reasons, PRISMA counts and Mermaid flow diagram, possible duplicate pairs and the next records awaiting a decision at stage (default title-abstract). includeDecisions lists decisions in force.";
const readParameters = {
  reviewId: Schema.optionalKey(Id),
  stage: Schema.optionalKey(ScientReviewStage),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
  includeDecisions: Schema.optionalKey(Schema.Boolean),
};

const reviewsReadTool = <P extends Schema.Struct.Fields>(description: string, parameters: P) =>
  Tool.make("scient_sources_systematic_reviews", {
    description,
    parameters: Schema.Struct(parameters),
    success: ScientSystematicReviewsReadResult,
    failure: ScientSourcesToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Read systematic reviews")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false)
    .annotate(ScientOperation, {
      id: "sources.systematic_reviews",
      scope: "workspace",
      requiredCapabilities: ["sources:read"],
    });

const ScientSystematicReviewsTool = reviewsReadTool(READ_DESCRIPTION, readParameters);

const UPDATE_DESCRIPTION =
  "Change a systematic review when the user asks. create-review returns a same-title reviewId. First add Library sources. log-search takes sourceIds or collectionId, database, exact query, searchedOn and resultCount. Matching database, query and date replace a search. add-sources adds other records. mark-duplicate removes a duplicate (keep duplicateOf). mark-distinct dismisses a pair. screen include, exclude or maybe at title-abstract, then full-text for included records (reason required for full-text exclusions). record-retrieval sets sought, retrieved or not-retrieved (unassessed). Full-text decisions imply retrieved. Latest decision wins, credited to the agent. clear-decision reopens. skippedSourceIds were not applied.";

/** Library mode: the pick between a review's versions from copies of the project. */
export const ScientSystematicReviewLibraryAction = Schema.Union([
  ...ScientSystematicReviewAction.members,
  Schema.Struct({
    action: Schema.Literal("resolve-conflict"),
    reviewId: Id,
    conflictId: Id,
    pick: Schema.Literals(["keep", "use-other", "combine"]),
  }),
  Schema.Struct({ action: Schema.Literal("dismiss-combine-report"), reviewId: Id }),
]);
export type ScientSystematicReviewLibraryAction = typeof ScientSystematicReviewLibraryAction.Type;

const ScientSystematicReviewLibraryChangeResult = Schema.Struct({
  ...ScientSystematicReviewChangeResult.fields,
  outcome: Schema.Literals([
    ...ScientSystematicReviewChangeResult.fields.outcome.literals,
    "resolved",
    "dismissed",
    "nothing-to-dismiss",
  ]),
  combineReport: Schema.optionalKey(CombineReport),
});

const reviewUpdateTool = <A extends Schema.Top, R extends Schema.Top>(
  description: string,
  change: A,
  success: R,
) =>
  Tool.make("scient_sources_systematic_review_update", {
    description,
    parameters: Schema.Struct({ change }),
    success,
    failure: ScientSourcesToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Update a systematic review")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false)
    .annotate(ScientOperation, {
      id: "sources.systematic_review.update",
      scope: "workspace",
      requiredCapabilities: ["sources:read", "sources:write"],
    });

const ScientSystematicReviewUpdateTool = reviewUpdateTool(
  UPDATE_DESCRIPTION,
  ScientSystematicReviewAction,
  ScientSystematicReviewChangeResult,
);

export const ScientSystematicReviewsToolkit = Toolkit.make(
  ScientSystematicReviewsTool,
  ScientSystematicReviewUpdateTool,
);

/**
 * The same tools, with what differs between a review's versions from copies of the project, and
 * the pick between them.
 */
export const ScientSystematicReviewsLibraryToolkit = Toolkit.make(
  reviewsReadTool(
    `${READ_DESCRIPTION} differencesOf: instead, what differs from that conflicts version, from offset.`,
    {
      ...readParameters,
      differencesOf: Schema.optionalKey(
        Schema.Struct({
          conflictId: Id,
          offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        }),
      ),
    },
  ),
  reviewUpdateTool(
    `${UPDATE_DESCRIPTION} For project-copy conflicts, resolve-conflict takes conflictId and the user's pick (keep, use-other or combine). dismiss-combine-report clears combineReport.`,
    ScientSystematicReviewLibraryAction,
    ScientSystematicReviewLibraryChangeResult,
  ),
);
