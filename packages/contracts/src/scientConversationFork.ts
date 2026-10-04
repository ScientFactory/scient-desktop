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

export const ThreadForkCommand = Schema.Struct({
  type: Schema.Literal("thread.fork"),
  commandId: CommandId,
  originThreadId: ThreadId,
  newThreadId: ThreadId,
  // Exactly one source message identifies the public fork point. Assistant
  // responses retain that response. User messages retain only the completed
  // transcript before the message; the client stages the selected message as
  // an unsent composer draft in the destination thread.
  sourceAssistantMessageId: Schema.optional(MessageId),
  sourceUserMessageId: Schema.optional(MessageId),
  // The running turn itself: retain every completed turn plus that turn's
  // latest state (reasoning, tool work and text produced so far).
  sourceRunningTurnId: Schema.optional(TurnId),
  sourceRunningRunId: Schema.optional(RunId),
  workspaceMode: OrchestrationForkWorkspaceMode,
  // Explicit destination title chosen by the user. When absent, the server
  // allocates the automatic collision-safe title at commit time.
  titleOverride: Schema.optional(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter(
    (command) =>
      [
        command.sourceAssistantMessageId,
        command.sourceUserMessageId,
        command.sourceRunningTurnId,
        command.sourceRunningRunId,
      ].filter((source) => source !== undefined).length === 1 ||
      "exactly one fork source must be specified",
  ),
);
export type ThreadForkCommand = typeof ThreadForkCommand.Type;

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
  /** Scient fork receipt: exact retained attachment ownership. */
  forkAttachmentIdMap: Schema.optional(Schema.Record(ChatAttachmentId, ChatAttachmentId)),
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
