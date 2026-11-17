import * as Schema from "effect/Schema";
import {
  CheckpointRef,
  CommandId,
  MessageId,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ChatAttachment, ChatAttachmentId } from "./chatAttachment.ts";

export const OrchestrationForkWorkspaceMode = Schema.Literals(["new-worktree", "local"]);
export type OrchestrationForkWorkspaceMode = typeof OrchestrationForkWorkspaceMode.Type;

/**
 * Scient's choices on T3's `thread.fork`. The boundary refines the command's source point: an
 * assistant response retains that response; a user message retains only the completed transcript
 * before it (possibly nothing), and the client stages the message as an unsent draft; a running
 * turn retains its saved work so far.
 */
export const ScientThreadForkBoundary = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("assistant-response"), messageId: MessageId }),
  Schema.Struct({ kind: Schema.Literal("user-message"), messageId: MessageId }),
  Schema.Struct({ kind: Schema.Literal("running-turn"), runId: RunId }),
]);
export type ScientThreadForkBoundary = typeof ScientThreadForkBoundary.Type;

export const ScientThreadForkOptions = Schema.Struct({
  boundary: ScientThreadForkBoundary,
  workspaceMode: OrchestrationForkWorkspaceMode,
});
export type ScientThreadForkOptions = typeof ScientThreadForkOptions.Type;

/** Waits until a fork can be opened: a new worktree first finishes its setup. */
export const AwaitForkInput = Schema.Struct({ threadId: ThreadId });
export type AwaitForkInput = typeof AwaitForkInput.Type;
export const ForkReadiness = Schema.Struct({
  /** Retained attachment ownership, so open previews keep their files. */
  forkAttachmentIdMap: Schema.Record(ChatAttachmentId, ChatAttachmentId),
});
export type ForkReadiness = typeof ForkReadiness.Type;

/** Omit both message ids to resolve the latest completed response on the server. */
export const GetForkOptionsInput = Schema.Struct({
  originThreadId: ThreadId,
  sourceAssistantMessageId: Schema.optional(MessageId),
  sourceUserMessageId: Schema.optional(MessageId),
  sourceRunningTurnId: Schema.optional(TurnId),
  sourceRunningRunId: Schema.optional(RunId),
});
export type GetForkOptionsInput = typeof GetForkOptionsInput.Type;
export const ForkOptions = Schema.Struct({
  available: Schema.Boolean,
  localAvailable: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  sourceAssistantMessageId: Schema.NullOr(MessageId),
  sourceUserMessageId: Schema.NullOr(MessageId),
  sourceRunningTurnId: Schema.optional(Schema.NullOr(TurnId)),
  sourceRunningRunId: Schema.optional(Schema.NullOr(RunId)),
  newWorktree: Schema.Boolean,
  /** Where a local fork works when that differs from the original, e.g. a removed worktree. */
  workspaceNotice: Schema.optional(Schema.String),
});
export type ForkOptions = typeof ForkOptions.Type;

export const ThreadForkAttachmentCopy = Schema.Struct({
  source: ChatAttachment,
  target: ChatAttachment,
});
export type ThreadForkAttachmentCopy = typeof ThreadForkAttachmentCopy.Type;

export const ScientConversationDispatchResult = Schema.Struct({
  submission: Schema.optional(
    Schema.Struct({
      submissionId: TrimmedNonEmptyString,
      outcome: Schema.Literals(["sent", "queued"]),
    }),
  ),
  queued: Schema.optional(Schema.Boolean),
  sequence: NonNegativeInt,
});
export type ScientConversationDispatchResult = typeof ScientConversationDispatchResult.Type;

export class OrchestrationGetSnapshotError extends Schema.TaggedError<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Durable provisioning data for a frozen conversation, separate from native provider forks. */
export const ScientConversationFork = Schema.Struct({
  commandId: CommandId,
  sourceThreadId: ThreadId,
  workspaceMode: Schema.Literals(["local", "new-worktree"]),
  status: Schema.Literals(["pending", "ready", "failed", "abandoned"]),
  cwd: TrimmedNonEmptyString,
  checkpointRef: Schema.NullOr(CheckpointRef),
  checkpointOid: Schema.NullOr(Schema.String),
  attachmentCopies: Schema.Array(ThreadForkAttachmentCopy),
  error: Schema.NullOr(Schema.String),
});
export type ScientConversationFork = typeof ScientConversationFork.Type;
