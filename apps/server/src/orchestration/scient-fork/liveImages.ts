/** Fork-only snapshots of materialized images; never edits the origin transcript. */
import {
  ChatImageAttachment,
  MessageId,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const AttachmentsJson = Schema.fromJsonString(Schema.Array(ChatImageAttachment));

export const writeForkLiveImages = Effect.fn("writeForkLiveImages")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly attachments: ReadonlyArray<ChatImageAttachment>;
    readonly createdAt: string;
  },
) {
  const json = yield* Schema.encodeEffect(AttachmentsJson)(input.attachments);
  yield* sql`INSERT OR REPLACE INTO scient_fork_live_images (thread_id, turn_id, attachments_json, captured_at)
    VALUES (${input.threadId}, ${input.turnId}, ${json}, ${input.createdAt})`;
});

export const withForkLiveImages = Effect.fn("withForkLiveImages")(function* (
  sql: SqlClient.SqlClient,
  origin: OrchestrationThread,
  turnId: TurnId | undefined,
) {
  if (turnId === undefined) return origin;
  const row = (yield* sql<{
    readonly attachments_json: string;
    readonly captured_at: string;
  }>`SELECT attachments_json, captured_at
    FROM scient_fork_live_images WHERE thread_id = ${origin.id} AND turn_id = ${turnId}`)[0];
  if (!row) return origin;
  const existingIds = new Set(
    origin.messages.flatMap((message) =>
      (message.attachments ?? []).map((attachment) => attachment.id),
    ),
  );
  const attachments = (yield* Schema.decodeEffect(AttachmentsJson)(row.attachments_json)).filter(
    (attachment) => !existingIds.has(attachment.id),
  );
  if (attachments.length === 0) return origin;
  return {
    ...origin,
    messages: [
      ...origin.messages,
      {
        id: MessageId.make(`assistant:fork-images:${turnId}`),
        role: "assistant" as const,
        text: "",
        attachments,
        turnId,
        streaming: true,
        createdAt: row.captured_at,
        updatedAt: row.captured_at,
      },
    ],
  };
});
