import type { SqlClient } from "effect/unstable/sql/SqlClient";

/** Reuses durable turn projections, including after reconnect or a queued start.
 * The correlated thread lookup uses the existing projection_turns thread index.
 * Reverts naturally remove answers because they remove their projected turns.
 */
export function completedAnswerSql(sql: SqlClient) {
  return sql`(
    SELECT json_object(
      'turnId', answer.turn_id,
      'messageId', answer.assistant_message_id,
      'completedAt', answer.completed_at
    )
    FROM projection_turns AS answer
    JOIN projection_thread_messages AS message
      ON message.message_id = answer.assistant_message_id
      AND message.thread_id = answer.thread_id
      AND message.role = 'assistant'
      AND message.is_streaming = 0
    WHERE answer.thread_id = projection_threads.thread_id
      AND answer.state = 'completed'
      AND answer.turn_id IS NOT NULL
      AND answer.assistant_message_id IS NOT NULL
      AND answer.completed_at IS NOT NULL
    ORDER BY answer.completed_at DESC, answer.row_id DESC
    LIMIT 1
  )`;
}
