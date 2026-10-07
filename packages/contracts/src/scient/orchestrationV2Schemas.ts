/**
 * Scient's own orchestration V2 wire schemas: the execution policy captured
 * with native work, Droid's held steer, subagent presentation, Scient
 * notification kinds, thread filing, and the server-only commands Scient
 * adds. orchestrationV2.ts re-exports them under the same names and places
 * the union members at their original positions.
 *
 * @module orchestrationV2Schemas
 */
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  ThreadSectionId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ChatAttachment } from "../chatAttachment.ts";
import { OrchestrationMessageContext } from "../composerContext.ts";
import { ModelSelection } from "../modelSelection.ts";
import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "../providerPolicy.ts";
import { SelectedScientSkillNames } from "../scientSkillSelection.ts";

/** The immutable execution settings of an already-started native generation. */
export const OrchestrationV2ProviderRuntimePolicy = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  cwd: Schema.NullOr(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type OrchestrationV2ProviderRuntimePolicy = typeof OrchestrationV2ProviderRuntimePolicy.Type;

// SCIENT-FORK:START — one durable intent; native readiness is deliberately absent.
export const OrchestrationV2DroidHeldSteer = Schema.Struct({
  revision: CommandId,
  messageId: MessageId,
  sourceAttemptId: RunAttemptId,
  sourceRootNodeId: NodeId,
  sourceProviderTurnId: ProviderTurnId,
  sourceProviderSessionId: ProviderSessionId,
  modelSelection: ModelSelection,
  runtimePolicy: OrchestrationV2ProviderRuntimePolicy,
  phase: Schema.Literals(["held", "pre_admission"]),
  /** Describes an uncertain claim after crash; cannot recreate a live lease. */
  admissionLease: Schema.optional(Schema.String),
});
export type OrchestrationV2DroidHeldSteer = typeof OrchestrationV2DroidHeldSteer.Type;
// SCIENT-FORK:END

/** Observed display metadata. These fields never grant execution or continuation authority. */
export const OrchestrationV2SubagentPresentation = Schema.Struct({
  kind: Schema.Literals(["subagent", "subagent_batch", "workflow", "workflow_agent"]),
  role: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  workflowId: Schema.optional(NodeId),
  workflowName: Schema.optional(Schema.String),
  agentIndex: Schema.optional(NonNegativeInt),
  phaseIndex: Schema.optional(NonNegativeInt),
  phaseTitle: Schema.optional(Schema.String),
  attempt: Schema.optional(NonNegativeInt),
  activationCount: Schema.optional(PositiveInt),
  firstSeenAt: Schema.optional(IsoDateTime),
  phases: Schema.optional(
    Schema.Array(
      Schema.Struct({
        index: NonNegativeInt,
        title: Schema.String,
      }),
    ).check(Schema.isMaxLength(64)),
  ),
  usage: Schema.optional(
    Schema.Struct({
      totalTokens: Schema.optional(NonNegativeInt),
      inputTokens: Schema.optional(NonNegativeInt),
      cachedInputTokens: Schema.optional(NonNegativeInt),
      outputTokens: Schema.optional(NonNegativeInt),
      reasoningOutputTokens: Schema.optional(NonNegativeInt),
      toolUses: Schema.optional(NonNegativeInt),
      durationMs: Schema.optional(NonNegativeInt),
    }).check(
      Schema.makeFilter(
        (usage) =>
          Object.values(usage).some((count) => count !== undefined) ||
          "Usage must include an observed count.",
      ),
    ),
  ),
  lastToolName: Schema.optional(Schema.String),
  outputFile: Schema.optional(Schema.String),
  runHandles: Schema.optional(
    Schema.Struct({
      runId: Schema.optional(Schema.String),
      scriptPath: Schema.optional(Schema.String),
      transcriptDir: Schema.optional(Schema.String),
      sessionUrl: Schema.optional(Schema.String.check(Schema.isPattern(/^https?:\/\//))),
    }),
  ),
});
export type OrchestrationV2SubagentPresentation = typeof OrchestrationV2SubagentPresentation.Type;

/** Scient members of `OrchestrationV2NotificationSource`, after the shared kinds. */
export const ScientNotificationSources = [
  Schema.Struct({
    kind: Schema.Literal("provider_work"),
    workId: TrimmedNonEmptyString,
    providerThreadId: ProviderThreadId,
    providerSessionId: ProviderSessionId,
    modelSelection: ModelSelection,
    runtimePolicy: OrchestrationV2ProviderRuntimePolicy,
  }),
  // SCIENT-FORK: a persisted, successful-but-cut-short provider response.
  Schema.Struct({
    kind: Schema.Literal("output_truncated"),
    stopReason: Schema.String,
  }),
] as const;

export const ThreadSectionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.section.set"),
  commandId: CommandId,
  threadId: ThreadId,
  sectionId: Schema.NullOr(ThreadSectionId),
});

/** Scient members of the server-only command union, ahead of the shared ones. */
export const ScientInternalCommands = [
  // SCIENT: revision checked internal admission, never an RPC command or replay authority.
  Schema.Struct({
    type: Schema.Literal("droid-steer.admission"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    revision: CommandId,
    operation: Schema.Literals(["claim", "defer", "complete", "drop"]),
    lease: Schema.optional(Schema.String),
  }),
  /** Adopt buffered native work from the exact live session; never send a user prompt. */
  Schema.Struct({
    type: Schema.Literal("provider-work.admit"),
    commandId: CommandId,
    threadId: ThreadId,
    messageId: MessageId,
    providerThreadId: ProviderThreadId,
    providerSessionId: ProviderSessionId,
    providerInstanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    workId: TrimmedNonEmptyString,
    modelSelection: ModelSelection,
    runtimePolicy: OrchestrationV2ProviderRuntimePolicy,
    detail: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("legacy-queue.reorder"),
    commandId: CommandId,
    threadId: ThreadId,
    queueItemIds: Schema.Array(TrimmedNonEmptyString),
  }),
  /** Migration admission creates held work and never executes a provider. */
  Schema.Struct({
    type: Schema.Literal("legacy-queue.import"),
    commandId: CommandId,
    threadId: ThreadId,
    queueItemId: TrimmedNonEmptyString,
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    context: Schema.optional(OrchestrationMessageContext),
    composerSnapshot: Schema.optional(Schema.String),
    selectedScientSkillNames: Schema.optional(SelectedScientSkillNames),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    titleSeed: Schema.optional(TrimmedNonEmptyString),
    sourceProposedPlan: Schema.optional(Schema.Struct({ threadId: ThreadId, planId: PlanId })),
    createdAt: Schema.DateTimeUtc,
  }),
  /** Server-owned receipt after provider rollback and file restoration succeed. */
  Schema.Struct({
    type: Schema.Literal("checkpoint.rollback.complete"),
    commandId: CommandId,
    threadId: ThreadId,
    requestId: CommandId,
  }),
] as const;
