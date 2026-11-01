import { ContextHandoffId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ScientOperation } from "../../ScientOperationTool.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";

/** Upstream's thread reader omits handoff summaries; this reads only those. */
export const HANDOFF_SUMMARY_PAGE_CHARS = 20_000;

export const ScientHandoffSummaryReadInput = Schema.Struct({
  threadId: ThreadId,
  contextHandoffId: ContextHandoffId,
  textOffset: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "Start at this UTF-16 code unit offset. Omit for the start; pass the previous nextTextOffset to continue.",
    }),
  ),
});
export type ScientHandoffSummaryReadInput = typeof ScientHandoffSummaryReadInput.Type;

export const ScientHandoffSummaryReadResult = Schema.Struct({
  text: Schema.String,
  nextTextOffset: Schema.NullOr(NonNegativeInt),
});

export class ScientHandoffSummaryReadToolError extends Schema.TaggedError<ScientHandoffSummaryReadToolError>()(
  "ScientHandoffSummaryReadToolError",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "thread_outside_project",
      "orchestration_error",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty()),
  },
) {}

export const ScientHandoffSummaryReadTool = Tool.make("scient_handoff_summary_read", {
  description:
    "Read a saved context-handoff summary that was too long to include in your context, using the threadId and contextHandoffId it names. Continue with textOffset=nextTextOffset until nextTextOffset is null. Read-only.",
  parameters: ScientHandoffSummaryReadInput,
  success: ScientHandoffSummaryReadResult,
  failure: ScientHandoffSummaryReadToolError,
  dependencies: [AgentInvocationContext.AgentInvocationContext, ProjectionStoreV2],
})
  .annotate(Tool.Title, "Read a saved handoff summary")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, {
    id: "threads.handoff-summary.read",
    family: "threads",
    scope: "thread",
    requiredCapabilities: ["threads:read"],
    approval: "session-grant",
    documentation: "docs/internals/context-handoffs.md",
  });

export const ScientThreadsToolkit = Toolkit.make(ScientHandoffSummaryReadTool);
