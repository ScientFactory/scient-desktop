import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  UploadChatAttachment,
} from "./orchestration.ts";

/**
 * Scient thread queue contracts.
 *
 * The queue is a Scient-owned holding area for composer messages while a
 * thread is busy. A queued item is deliberately NOT an orchestration message:
 * it becomes one only when the user dispatches it, which reuses the existing
 * `thread.turn.start` command unchanged. Attachments therefore use the exact
 * upload wire shape that `thread.turn.start` already accepts.
 *
 * Keep this file self-contained; upstream T3 never imports it. See
 * `docs/internals/scient-thread-queue.md` for the retirement procedure once
 * T3 ships a native queue.
 */

export const SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD = 20;

export const ScientThreadQueueItemId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^qitem_[A-Za-z0-9-]+$/),
);
export type ScientThreadQueueItemId = typeof ScientThreadQueueItemId.Type;

export const ScientThreadQueueItem = Schema.Struct({
  queueItemId: ScientThreadQueueItemId,
  text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  attachments: Schema.Array(UploadChatAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScientThreadQueueItem = typeof ScientThreadQueueItem.Type;

export const ScientThreadQueueSnapshot = Schema.Struct({
  threadId: ThreadId,
  items: Schema.Array(ScientThreadQueueItem),
});
export type ScientThreadQueueSnapshot = typeof ScientThreadQueueSnapshot.Type;

export const ScientThreadQueueListRequest = Schema.Struct({
  threadId: ThreadId,
});
export type ScientThreadQueueListRequest = typeof ScientThreadQueueListRequest.Type;

export const ScientThreadQueueEnqueueRequest = Schema.Struct({
  threadId: ThreadId,
  text: ScientThreadQueueItem.fields.text,
  attachments: ScientThreadQueueItem.fields.attachments,
});
export type ScientThreadQueueEnqueueRequest = typeof ScientThreadQueueEnqueueRequest.Type;

export const ScientThreadQueueRemoveRequest = Schema.Struct({
  threadId: ThreadId,
  queueItemId: ScientThreadQueueItemId,
});
export type ScientThreadQueueRemoveRequest = typeof ScientThreadQueueRemoveRequest.Type;

export const ScientThreadQueueReorderRequest = Schema.Struct({
  threadId: ThreadId,
  queueItemIds: Schema.Array(ScientThreadQueueItemId).check(
    Schema.isMaxLength(SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD),
  ),
});
export type ScientThreadQueueReorderRequest = typeof ScientThreadQueueReorderRequest.Type;
