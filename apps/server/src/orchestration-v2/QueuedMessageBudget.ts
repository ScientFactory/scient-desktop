import {
  OrchestrationV2ConversationMessageJson,
  SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD,
  SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

export class QueuedMessageBudgetError extends Schema.TaggedError<QueuedMessageBudgetError>()(
  "QueuedMessageBudgetError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const encodeMessage = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);

/** Called inside ThreadCommandExecutor, before accepting any admission or edit. */
export const ensureQueuedMessageBudget = Effect.fn("ensureQueuedMessageBudget")(function* (input: {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">;
  readonly message: OrchestrationV2ConversationMessage;
}) {
  const pending = input.projection.runs.filter((run) => run.status === "queued");
  const replacesExisting = pending.some((run) => run.userMessageId === input.message.id);
  if (pending.length + (replacesExisting ? 0 : 1) > SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD)
    return yield* new QueuedMessageBudgetError({ message: "The queue already holds 20 messages." });

  const ids = new Set(pending.map((run) => run.userMessageId));
  const messages = [
    ...input.projection.messages.filter(
      (message) => ids.has(message.id) && message.id !== input.message.id,
    ),
    input.message,
  ];
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const owner = toSafeThreadAttachmentSegment(input.projection.thread.id);
  let total = 0;
  for (const message of messages) {
    const serialized = yield* encodeMessage(message).pipe(
      Effect.mapError(
        (cause) =>
          new QueuedMessageBudgetError({
            message: "The queued message could not be measured.",
            cause,
          }),
      ),
    );
    total += new TextEncoder().encode(serialized).byteLength;
    // Count each reference, as the protected queue document does. Metadata
    // cannot establish disk usage: a stored attachment may have changed size.
    for (const attachment of message.attachments) {
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (path === null || parseThreadSegmentFromAttachmentId(attachment.id) !== owner)
        return yield* new QueuedMessageBudgetError({
          message: "Queued attachments must belong to this thread.",
        });
      const info = yield* fs.stat(path).pipe(
        Effect.mapError(
          (cause) =>
            new QueuedMessageBudgetError({
              message: `Queued attachment '${attachment.name}' is unavailable.`,
              cause,
            }),
        ),
      );
      total += Number(info.size);
    }
    if (total > SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD)
      return yield* new QueuedMessageBudgetError({
        message: "The queue is full. Remove an attachment or another queued message first.",
      });
  }
});
