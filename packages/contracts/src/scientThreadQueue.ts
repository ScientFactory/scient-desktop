import * as Schema from "effect/Schema";
import { SelectedScientSkillNames } from "./scientSkillSelection.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";

import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  UploadChatAttachment,
  ChatAttachment,
} from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import { SourceProposedPlanReference } from "./scientConversationView.ts";

/**
 * Server-owned waiting payloads. Admission consumes an item atomically with its
 * orchestration message and command receipt. Images remain self-contained until
 * admission; editing reserves a hidden, non-deliverable slot.
 * See docs/internals/scient-thread-queue.md for lifecycle and migration rules.
 */

export const SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD = 20;
// Queue documents contain base64 data URLs, so an item-count cap alone could
// still let a busy thread consume gigabytes of local disk.
export const SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD = 64 * 1024 * 1024;

export const ScientThreadQueueItemId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^qitem_[A-Za-z0-9-]+$/),
);
export type ScientThreadQueueItemId = typeof ScientThreadQueueItemId.Type;

export const ScientThreadQueueItem = Schema.Struct({
  messageId: Schema.optional(MessageId),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  // Versioned client edit snapshot. The server preserves this bounded opaque
  // JSON alongside delivery text; it never interprets it as agent authority.
  composerSnapshot: Schema.optional(Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024))),
  selectedScientSkillNames: Schema.optional(SelectedScientSkillNames),
  context: Schema.optional(OrchestrationMessageContext),
  queueItemId: ScientThreadQueueItemId,
  threadId: Schema.optional(ThreadId),
  editToken: Schema.optional(Schema.String),
  steerRequested: Schema.optional(Schema.Boolean),
  sendRequested: Schema.optional(Schema.Boolean),
  state: Schema.optional(Schema.Literals(["waiting", "editing"])),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  attachments: Schema.Array(Schema.Union([UploadChatAttachment, ChatAttachment])).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScientThreadQueueItem = typeof ScientThreadQueueItem.Type;

export const ScientThreadQueueSnapshot = Schema.Struct({
  /** Native run projections own this queue; modern clients use their V2 controls. */
  nativeQueue: Schema.optional(Schema.Boolean),
  unchanged: Schema.optional(Schema.Boolean),
  threadId: ThreadId,
  revision: Schema.optional(Schema.Number),
  paused: Schema.optional(Schema.NullOr(Schema.String)),
  awaitingCompletion: Schema.optional(Schema.Boolean),
  items: Schema.Array(ScientThreadQueueItem).check(
    Schema.isMaxLength(SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD),
  ),
});
export type ScientThreadQueueSnapshot = typeof ScientThreadQueueSnapshot.Type;

export const ScientThreadQueueListRequest = Schema.Struct({
  knownRevision: Schema.optional(Schema.Number),
  threadId: ThreadId,
});
export type ScientThreadQueueListRequest = typeof ScientThreadQueueListRequest.Type;

export const ScientThreadQueueControlRequest = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["edit", "extract", "resume", "steer", "stash", "send"]),
  expectedUpdatedAt: Schema.optional(IsoDateTime),
  queueItemId: Schema.optional(ScientThreadQueueItemId),
  editToken: Schema.optional(Schema.String),
});
export type ScientThreadQueueControlRequest = typeof ScientThreadQueueControlRequest.Type;
