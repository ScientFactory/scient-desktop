/** Scient's reservation recovery reads publication facts, never the transcript. */
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { AttachmentReservationOwner } from "./AttachmentFileUse.ts";

export const commandPublicationProven = Effect.fn("AttachmentPublication.commandProof")(function* (
  sql: SqlClient.SqlClient,
  owner: Extract<AttachmentReservationOwner, { kind: "command" }>,
  resultSequence: number,
) {
  const target = owner.target;
  const rows = yield* sql<{ readonly proven: number }>`
    SELECT EXISTS (
      SELECT 1 FROM orchestration_events INDEXED BY idx_orch_events_command_id
      WHERE command_id = ${owner.commandId} AND sequence = ${resultSequence}
        AND application_event_version = 2 AND aggregate_kind = 'thread'
    ) AND EXISTS (
      SELECT 1 FROM orchestration_events INDEXED BY idx_orch_events_command_id
      WHERE command_id = ${owner.commandId} AND sequence <= ${resultSequence}
        AND application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${owner.threadId}
        AND ${
          target.type === "question"
            ? sql`event_type = 'turn-item.updated' AND json_extract(payload_json, '$.type') = 'user_input_request'
            AND json_extract(payload_json, '$.requestId') = ${target.requestId} AND json_extract(payload_json, '$.status') = 'completed'`
            : sql`event_type = 'message.updated' AND ${
                target.type === "message"
                  ? sql`json_extract(payload_json, '$.id') = ${target.messageId}`
                  : target.type === "run"
                    ? sql`json_extract(payload_json, '$.runId') = ${target.runId}`
                    : sql`json_extract(payload_json, '$.role') = 'user'`
              }`
        }
    ) AS proven
  `;
  return rows[0]?.proven === 1;
});

export const attachmentPublicationProven = Effect.fn("AttachmentPublication.fileProof")(function* (
  sql: SqlClient.SqlClient,
  owner: Exclude<AttachmentReservationOwner, { kind: "command" }>,
  attachment: ChatAttachment,
) {
  const rows = yield* sql<{ readonly proven: number }>`
    SELECT EXISTS (
      SELECT 1 FROM orchestration_events AS event, json_each(event.payload_json, '$.attachments') AS file
      WHERE event.stream_id = ${owner.threadId} AND event.application_event_version = 2
        AND event.aggregate_kind = 'thread'
        AND ${
          owner.kind === "message-publication"
            ? sql`event.event_type = 'message.updated' AND json_extract(event.payload_json, '$.id') = ${owner.messageId}
            AND json_extract(event.payload_json, '$.role') = 'user'`
            : sql`((event.event_type = 'message.updated' AND json_extract(event.payload_json, '$.role') = 'assistant')
            OR (event.event_type = 'turn-item.updated' AND json_extract(event.payload_json, '$.type') = 'assistant_message'))`
        }
        AND lower(json_extract(file.value, '$.id')) = ${attachment.id.toLowerCase()}
        AND json_extract(file.value, '$.type') = ${attachment.type}
        AND lower(json_extract(file.value, '$.mimeType')) = ${attachment.mimeType.toLowerCase()}
        AND json_extract(file.value, '$.sizeBytes') = ${attachment.sizeBytes}
    ) AS proven
  `;
  return rows[0]?.proven === 1;
});
