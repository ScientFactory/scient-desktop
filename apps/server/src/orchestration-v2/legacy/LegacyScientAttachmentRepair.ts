import {
  ChatAttachment,
  EventId,
  MessageId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import type { EventSinkV2Shape } from "../EventSink.ts";

const REPAIR_EVENT_PREFIX = "migration:v1:attachment-repair";
const decodeProjectedMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeProjectedTurnItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const encodeAttachments = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(Schema.Array(ChatAttachment))),
);

export class LegacyScientAttachmentRepairError extends Schema.TaggedError<LegacyScientAttachmentRepairError>()(
  "LegacyScientAttachmentRepairError",
  {
    messageId: MessageId,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot repair imported attachments for ${this.messageId}: ${this.reason}`;
  }
}

export interface LegacyScientAttachmentRepairRow {
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly updatedAt: DateTime.Utc;
}

/**
 * Repairs only imported message identities whose source attachments were
 * malformed on an earlier attempt. New events update the existing projection
 * rows without rewriting the original import events or their event IDs.
 */
export const repairLegacyImportedAttachments = Effect.fn(
  "LegacyScientAttachmentRepair.repairLegacyImportedAttachments",
)(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly eventSink: EventSinkV2Shape;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<LegacyScientAttachmentRepairRow>;
}) {
  for (const source of input.messages) {
    const turnItemId = TurnItemId.make(`migration:v1:turn-item:${source.messageId}`);
    const messageRows = yield* input.sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_messages
      WHERE thread_id = ${input.threadId} AND message_id = ${source.messageId}
      LIMIT 1
    `;
    const messageJson = messageRows[0]?.payload_json;
    const message = messageJson === undefined ? Option.none() : decodeProjectedMessage(messageJson);
    if (Option.isNone(message)) {
      return yield* new LegacyScientAttachmentRepairError({
        messageId: source.messageId,
        reason: "it has no readable projection",
      });
    }
    if (message.value.id !== source.messageId || message.value.threadId !== input.threadId) {
      return yield* new LegacyScientAttachmentRepairError({
        messageId: source.messageId,
        reason: "its projection identity does not match",
      });
    }

    const events: OrchestrationV2DomainEvent[] = [];
    if (encodeAttachments(message.value.attachments) !== encodeAttachments(source.attachments)) {
      const repairId = yield* randomUuidV4;
      events.push({
        id: EventId.make(`${REPAIR_EVENT_PREFIX}:${source.messageId}:${repairId}:message`),
        type: "message.updated",
        threadId: input.threadId,
        occurredAt: source.updatedAt,
        payload: { ...message.value, attachments: source.attachments },
      });
    }

    if (source.role === "user") {
      const turnItemRows = yield* input.sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${input.threadId} AND turn_item_id = ${turnItemId}
        LIMIT 1
      `;
      const turnItemJson = turnItemRows[0]?.payload_json;
      const turnItem =
        turnItemJson === undefined ? Option.none() : decodeProjectedTurnItem(turnItemJson);
      if (Option.isNone(turnItem)) {
        return yield* new LegacyScientAttachmentRepairError({
          messageId: source.messageId,
          reason: "its user turn item is not readable",
        });
      }
      if (
        turnItem.value.type !== "user_message" ||
        turnItem.value.id !== turnItemId ||
        turnItem.value.messageId !== source.messageId ||
        turnItem.value.threadId !== input.threadId
      ) {
        return yield* new LegacyScientAttachmentRepairError({
          messageId: source.messageId,
          reason: "its user turn item identity does not match",
        });
      }
      if (encodeAttachments(turnItem.value.attachments) !== encodeAttachments(source.attachments)) {
        const repairId = yield* randomUuidV4;
        events.push({
          id: EventId.make(`${REPAIR_EVENT_PREFIX}:${source.messageId}:${repairId}:turn-item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          occurredAt: source.updatedAt,
          payload: { ...turnItem.value, attachments: source.attachments },
        });
      }
    }

    if (events.length > 0) {
      // At most one message and its paired history row are written per batch.
      yield* input.eventSink.write({ events });
      yield* Effect.yieldNow;
    }
  }
});
