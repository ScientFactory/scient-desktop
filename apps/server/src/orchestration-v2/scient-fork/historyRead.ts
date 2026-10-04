/** Durable history paging, independent of the bounded UI activity window. */
import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export interface HistoryReadQuery {
  readonly threadId: ThreadId;
  readonly view?: "messages" | "activity" | undefined;
  readonly itemId?: string | undefined;
  readonly afterPosition?: number | undefined;
  readonly limit?: number | undefined;
}

const HistoryItem = Schema.Struct({
  position: Schema.Number,
  itemId: Schema.String,
  type: Schema.Literals([
    "user_message",
    "assistant_message",
    "system_message",
    "reasoning",
    "proposed_plan",
    "activity",
  ]),
  status: Schema.Literals(["running", "completed"]),
  title: Schema.NullOr(Schema.String),
  activityKind: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(MessageId),
  turnId: Schema.NullOr(TurnId),
  text: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const decodeHistoryItems = Schema.decodeUnknownEffect(Schema.Array(HistoryItem));
export interface HistoryPage {
  readonly items: ReadonlyArray<typeof HistoryItem.Type>;
  readonly itemCount: number;
  readonly hasMore: boolean;
}

export const readHistoryPage = Effect.fn("readScientHistoryPage")(function* (
  sql: SqlClient.SqlClient,
  input: HistoryReadQuery,
) {
  const limit = input.limit ?? 50;
  const timeline = sql`WITH timeline AS (
    SELECT message_id AS itemId,
      CASE role WHEN 'user' THEN 'user_message' WHEN 'assistant' THEN 'assistant_message'
        WHEN 'system' THEN 'system_message' ELSE 'reasoning' END AS type,
      CASE is_streaming WHEN 1 THEN 'running' ELSE 'completed' END AS status,
      NULL AS title, NULL AS activityKind, message_id AS messageId, turn_id AS turnId,
      text, created_at AS createdAt, updated_at AS updatedAt, 0 AS source, 0 AS ordering
    FROM projection_thread_messages WHERE thread_id = ${input.threadId}
    UNION ALL
    SELECT plan_id, 'proposed_plan', 'completed', NULL, NULL, NULL, turn_id,
      plan_markdown, created_at, updated_at, 1, 0
    FROM projection_thread_proposed_plans WHERE thread_id = ${input.threadId}
    UNION ALL
    SELECT activity_id, 'activity', 'completed', summary, kind, NULL, turn_id,
      kind || ': ' || summary || CASE WHEN payload_json IS NULL OR payload_json = 'null' THEN ''
        ELSE char(10) || CASE WHEN json_type(payload_json) = 'text' THEN json_extract(payload_json, '$') ELSE payload_json END END,
      created_at, created_at, 2, sequence
    FROM projection_thread_activities WHERE thread_id = ${input.threadId}
  ), numbered AS (
    SELECT ROW_NUMBER() OVER (ORDER BY createdAt, source, ordering, itemId) - 1 AS position, * FROM timeline
  )`;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const count = yield* sql<{
        readonly count: number;
      }>`${timeline} SELECT COUNT(*) AS count FROM timeline`;
      const rows = yield* sql`${timeline}
      SELECT position, itemId, type, status, title, activityKind, messageId, turnId, text, createdAt, updatedAt
      FROM numbered WHERE ${
        input.itemId === undefined
          ? sql`position > ${input.afterPosition ?? -1} AND (${input.view === "activity"} OR type IN ('user_message', 'assistant_message', 'proposed_plan'))`
          : sql`itemId = ${input.itemId}`
      }
      ORDER BY position LIMIT ${limit + 1}`;
      const items = yield* decodeHistoryItems(rows);
      return {
        items: items.slice(0, limit),
        itemCount: count[0]?.count ?? 0,
        hasMore: items.length > limit,
      } satisfies HistoryPage;
    }),
  );
});
