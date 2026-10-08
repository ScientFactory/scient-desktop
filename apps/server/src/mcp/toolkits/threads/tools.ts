import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ScientOperation } from "../../ScientOperationTool.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { LegacyV1ThreadImporter } from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

/**
 * Scient's omitted-history reader uses V2's input fields, defaults and paging
 * semantics under the Scient-owned `scient_thread_read` name and read-only
 * grant. Orchestration's `scient_thread_inspect` also returns run metadata and
 * can acknowledge a delegated result, so it retains a separate capability.
 *
 * Upstream reference: pingdotgg/t3code PR #2829 at a3fbbe45315e (2026-09-27),
 * `packages/contracts/src/orchestratorMcp.ts` (`OrchestratorMcpThreadReadInput`)
 * and `apps/server/src/mcp/OrchestratorMcpService.ts` (defaults 50 / 20,000).
 */
export const THREAD_READ_DEFAULT_LIMIT = 50;
export const THREAD_READ_DEFAULT_MAX_CHARS_PER_ITEM = 20_000;

export const ScientThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  itemId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Read one item by its itemId, ignoring view and afterPosition. Combine with textOffset to continue long text.",
    }),
  ),
  textOffset: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "With itemId, start the text window at this UTF-16 code unit offset (use the previous nextTextOffset).",
    }),
  ),
  view: Schema.optional(
    Schema.Literals(["messages", "activity"]).annotate({
      description:
        "messages (default): user messages, assistant messages and proposed plans. activity: every timeline item, including reasoning, system messages and summarized tool activity.",
    }),
  ),
  afterPosition: Schema.optional(
    NonNegativeInt.annotate({
      description: "Return items after this position. Omit to start at the beginning.",
    }),
  ),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(100)).annotate({
      description: `Maximum items to return (default ${THREAD_READ_DEFAULT_LIMIT}).`,
    }),
  ),
  // Accepted for the shipped reader's input compatibility. Run metadata is
  // available through orchestration inspection rather than this narrow reader.
  runLimit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(50)).annotate({
      description: "Accepted for compatibility and ignored; no run history is returned.",
    }),
  ),
  maxCharsPerItem: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(50_000)).annotate({
      description: `Maximum text characters per item (default ${THREAD_READ_DEFAULT_MAX_CHARS_PER_ITEM}).`,
    }),
  ),
});
export type ScientThreadReadInput = typeof ScientThreadReadInput.Type;

/** V2's thread status vocabulary: idle, or the latest run's state. */
export const ScientThreadReadStatus = Schema.Literals([
  "idle",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export const ScientThreadReadThread = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  status: ScientThreadReadStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literal("fork")),
  itemCount: NonNegativeInt,
  archived: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScientThreadReadThread = typeof ScientThreadReadThread.Type;

export const ScientThreadReadItemType = Schema.Literals([
  "user_message",
  "assistant_message",
  "proposed_plan",
  "reasoning",
  "system_message",
  "activity",
]);
export type ScientThreadReadItemType = typeof ScientThreadReadItemType.Type;

export const ScientThreadReadItem = Schema.Struct({
  position: NonNegativeInt,
  itemId: Schema.String,
  type: ScientThreadReadItemType,
  status: Schema.Literals(["running", "completed"]),
  /** The activity summary; null for messages and plans. */
  title: Schema.NullOr(Schema.String),
  activityKind: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(MessageId),
  turnId: Schema.NullOr(TurnId),
  text: Schema.String,
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.NullOr(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScientThreadReadItem = typeof ScientThreadReadItem.Type;

export const ScientThreadReadResult = Schema.Struct({
  thread: ScientThreadReadThread,
  items: Schema.Array(ScientThreadReadItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type ScientThreadReadResult = typeof ScientThreadReadResult.Type;

export class ScientThreadReadToolError extends Schema.TaggedError<ScientThreadReadToolError>()(
  "ScientThreadReadToolError",
  {
    // V2's failure vocabulary, plus an explicit project-boundary rejection.
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "thread_outside_project",
      "orchestration_error",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty()),
  },
) {}

const dependencies = [
  AgentInvocationContext.AgentInvocationContext,
  ProjectionStoreV2,
  LegacyV1ThreadImporter,
];

export const ScientThreadReadTool = Tool.make("scient_thread_read", {
  description:
    "Read durable state and a paginated timeline from a Scient thread in the calling project, including this thread. Use it to recover conversation history that was omitted from a forked or bounded transcript. The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Continue with afterPosition=nextPosition while hasMore is true. Recover long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null; offsets count UTF-16 code units. Read-only.",
  parameters: ScientThreadReadInput,
  success: ScientThreadReadResult,
  failure: ScientThreadReadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a Scient thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, {
    id: "threads.read",
    family: "threads",
    scope: "thread",
    requiredCapabilities: ["threads:read"],
    approval: "session-grant",
    documentation: "docs/internals/scient-fork-divergence.md",
  });

export const ScientThreadsToolkit = Toolkit.make(ScientThreadReadTool);
