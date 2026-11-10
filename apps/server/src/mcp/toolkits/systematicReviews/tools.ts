import {
  ScientPrismaCounts,
  ScientReviewDecision,
  ScientReviewStage,
  ScientSourceActor,
  ScientSystematicReviewAction,
  ScientSystematicReviewChangeResult,
  ScientSystematicReviewSummary,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ScientOperation } from "../../ScientOperationTool.ts";
import { ScientSourcesToolError } from "../sources/tools.ts";

const dependencies = [AgentInvocationContext.AgentInvocationContext, WorkspaceBindingResolver];
const Id = Schema.String.check(Schema.isNonEmpty());
const NullableText = Schema.NullOr(Schema.String);

const ReviewRecord = Schema.Struct({
  sourceId: Id,
  title: NullableText,
  creator: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  containerTitle: NullableText,
  abstract: NullableText,
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
    }),
  ),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ScientSystematicReviewsTool = Tool.make("scient_sources_systematic_reviews", {
  description:
    "Read this project's systematic reviews. Without reviewId, list them with PRISMA counts. With reviewId, read one: its logged searches, exclusion reasons, " +
    "PRISMA counts and a Mermaid PRISMA flow diagram, possible duplicate pairs, and the next records awaiting a decision at stage (title-abstract by default) " +
    "with their abstracts. includeDecisions lists the decisions in force at that stage.",
  parameters: Schema.Struct({
    reviewId: Schema.optionalKey(Id),
    stage: Schema.optionalKey(ScientReviewStage),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
    includeDecisions: Schema.optionalKey(Schema.Boolean),
  }),
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

const ScientSystematicReviewUpdateTool = Tool.make("scient_sources_systematic_review_update", {
  description:
    "Change a systematic review when the user asks. create-review with a title in use returns that review. Records are Library sources: import or add them first, then log-search with their sourceIds or a collectionId " +
    "(database, exact query, date searched, and the database's resultCount); the same database, query and date replaces that search. add-sources adds records found another way. " +
    "Library imports already merge exact duplicates; mark-duplicate removes a remaining one (keep duplicateOf), mark-distinct dismisses a possible pair. " +
    "screen records include, exclude or maybe at title-abstract, then full-text for records included there; give an exclusion reason at full text. " +
    "record-retrieval marks a report sought, retrieved or not-retrieved; a report not retrieved is not assessed, and a full-text decision records it as retrieved. " +
    "Decisions are credited to the agent and the latest one counts; clear-decision reopens a record. skippedSourceIds lists ids that were not applied.",
  parameters: Schema.Struct({ change: ScientSystematicReviewAction }),
  success: ScientSystematicReviewChangeResult,
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

export const ScientSystematicReviewsToolkit = Toolkit.make(
  ScientSystematicReviewsTool,
  ScientSystematicReviewUpdateTool,
);
