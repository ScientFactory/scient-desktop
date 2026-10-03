import * as Schema from "effect/Schema";
import { CheckpointRef, CommandId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";

/** Durable provisioning data for a frozen conversation, separate from native provider forks. */
export const ScientConversationFork = Schema.Struct({
  commandId: CommandId,
  sourceThreadId: ThreadId,
  workspaceMode: Schema.Literals(["local", "new-worktree"]),
  status: Schema.Literals(["pending", "ready", "failed", "abandoned"]),
  cwd: TrimmedNonEmptyString,
  checkpointRef: Schema.NullOr(CheckpointRef),
  checkpointOid: Schema.NullOr(Schema.String),
  attachmentCopies: Schema.Array(Schema.Struct({ source: ChatAttachment, target: ChatAttachment })),
  error: Schema.NullOr(Schema.String),
});
export type ScientConversationFork = typeof ScientConversationFork.Type;
