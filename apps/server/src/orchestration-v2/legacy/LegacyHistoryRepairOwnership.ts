/** Historical repair guards reread persisted ownership inside the native event transaction. */
import type { MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

export const readLegacyCitationRepairSource = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageId: MessageId,
) => sql<{ text: string }>`
  SELECT text FROM projection_thread_messages
  WHERE thread_id = ${threadId} AND message_id = ${messageId} AND role = 'assistant'
    AND EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports
      WHERE thread_id = ${threadId})`;

export const readLegacyQuestionInsertionOwner = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  itemId: TurnItemId,
  activityId: string,
) => sql<{ turn_id: string | null; ordinal: number }>`
  SELECT activity.turn_id, position.ordinal FROM projection_thread_activities AS activity
  JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = activity.thread_id
  JOIN orchestration_v2_turn_item_positions AS position
    ON position.thread_id = activity.thread_id AND position.turn_item_id = ${itemId}
  WHERE activity.thread_id = ${threadId} AND activity.activity_id = ${activityId}
    AND activity.kind = 'user-input.answer-submitted'`;
