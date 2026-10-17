/** SCIENT-OWNED: history membership can be planned without reading its bodies. */
import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  ContextHandoffId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { hasHistoricalContext } from "./context/historicalItems.ts";

export interface ContextHistoryCandidate {
  readonly sourceOnly: true;
  readonly id: OrchestrationV2TurnItem["id"];
  readonly threadId: OrchestrationV2TurnItem["threadId"];
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly nodeId: OrchestrationV2TurnItem["nodeId"];
  readonly type: OrchestrationV2TurnItem["type"];
  readonly messageId?: MessageId;
  readonly inputIntent?: string;
  readonly partialSnapshot: boolean;
  readonly forkPosition?: number;
}
export type ContextHandoffItem = OrchestrationV2TurnItem | ContextHistoryCandidate;
export const isContextHistoryItem = (item: ContextHandoffItem) =>
  "sourceOnly" in item || hasHistoricalContext(item);
export const contextHistoryCandidate = (
  item: OrchestrationV2TurnItem,
): ContextHistoryCandidate => ({
  sourceOnly: true,
  id: item.id,
  threadId: item.threadId,
  runId: item.runId,
  nodeId: item.nodeId,
  type: item.type,
  ...(item.type === "user_message" || item.type === "assistant_message"
    ? { messageId: item.messageId }
    : {}),
  ...(item.type === "user_message" ? { inputIntent: item.inputIntent } : {}),
  partialSnapshot: item.status === "interrupted" || item.inheritedFrom?.status === "running",
});

export const makeContextHistorySource = (
  id: ContextHandoffId,
  items: ReadonlyArray<ContextHandoffItem>,
  runs: ReadonlyArray<OrchestrationV2Run> = [],
) => {
  const eligible = items.filter(isContextHistoryItem);
  const statuses = new Map(runs.map((run) => [run.id, run.status]));
  return {
    id,
    itemCount: eligible.length,
    partialSnapshot: eligible.some((item) =>
      "sourceOnly" in item
        ? item.partialSnapshot
        : item.status === "interrupted" || item.inheritedFrom?.status === "running",
    ),
    entries: eligible.map((item) => ({
      threadId: item.threadId,
      itemId: item.id,
      ...("sourceOnly" in item && item.forkPosition !== undefined
        ? { forkPosition: item.forkPosition }
        : {}),
      ...(item.runId === null || statuses.get(item.runId) === undefined
        ? {}
        : { runStatus: statuses.get(item.runId)! }),
    })),
  };
};

const encodeRuns = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.NullOr(RunId))));
const decodeCandidateHeaders = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: TurnItemId,
      type: Schema.String,
      status: Schema.Literals([
        "idle",
        "pending",
        "running",
        "waiting",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ]),
      run_id: Schema.NullOr(RunId),
      node_id: Schema.NullOr(NodeId),
      message_id: Schema.NullOr(MessageId),
    }),
  ),
);
export const readContextHistoryCandidates = Effect.fn("ContextHistory.readCandidates")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  runIds?: ReadonlyArray<RunId | null>,
) {
  const rows = yield* sql<{
    readonly id: string;
    readonly run_id: string | null;
    readonly node_id: string | null;
    readonly type: OrchestrationV2TurnItem["type"];
    readonly message_id: string | null;
    readonly input_intent: string | null;
    readonly status: string;
    readonly inherited_status: string | null;
    readonly portable: number;
    readonly authority: number;
    readonly inherited_run: string | null;
    readonly imported_activity: number;
    readonly answered: number;
    readonly response_mode: string | null;
    readonly fork_position: number | null;
  }>`
    WITH shown AS (
      SELECT COALESCE(frozen.item_json, item.payload_json) AS body,
        history.position AS ordinal, 0 AS cohort, history.source_thread_id <> ${threadId} AS inherited,
        history.position AS fork_position
      FROM scient_fork_history AS history
      LEFT JOIN scient_fork_frozen_items AS frozen ON frozen.thread_id = history.thread_id AND frozen.position = history.position
      LEFT JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = history.source_item_id
      WHERE history.thread_id = ${threadId} AND ${runIds === undefined || runIds.includes(null) ? 1 : 0} = 1
      UNION ALL
      SELECT payload_json, ordinal, 1, 0, NULL FROM orchestration_v2_projection_turn_items AS item
      WHERE item.thread_id = ${threadId}
        ${runIds === undefined ? sql`` : sql`AND (run_id IN (SELECT value FROM json_each(${encodeRuns(runIds)})) OR (${runIds.includes(null) ? 1 : 0} = 1 AND run_id IS NULL))`}
        AND NOT EXISTS (SELECT 1 FROM scient_fork_history WHERE thread_id = ${threadId} AND source_item_id = item.turn_item_id)
    )
    SELECT fork_position, json_extract(body, '$.id') AS id, json_extract(body, '$.type') AS type,
      CASE WHEN inherited THEN NULL ELSE json_extract(body, '$.runId') END AS run_id,
      CASE WHEN inherited THEN NULL ELSE json_extract(body, '$.nodeId') END AS node_id,
      json_extract(body, '$.messageId') AS message_id, json_extract(body, '$.inputIntent') AS input_intent,
      CASE WHEN inherited AND json_extract(body, '$.status') IN ('idle','pending','running','waiting')
        THEN 'interrupted' ELSE json_extract(body, '$.status') END AS status,
      CASE WHEN inherited THEN json_extract(body, '$.status') ELSE json_extract(body, '$.inheritedFrom.status') END AS inherited_status,
      (inherited OR json_type(body, '$.historyTurnId') IS NOT NULL OR json_type(body, '$.inheritedFrom') IS NOT NULL
        OR json_extract(body, '$.id') LIKE 'migration:v1:history:%'
        OR json_extract(body, '$.id') LIKE 'server:conversation-import:%:item:%') AS portable,
      (NOT inherited AND (json_type(body, '$.runId') NOT IN ('null') OR json_type(body, '$.nodeId') NOT IN ('null')
        OR json_type(body, '$.providerThreadId') NOT IN ('null') OR json_type(body, '$.providerTurnId') NOT IN ('null')
        OR json_type(body, '$.nativeItemRef') NOT IN ('null'))) AS authority,
      CASE WHEN inherited THEN json_extract(body, '$.runId') ELSE json_extract(body, '$.inheritedFrom.runId') END AS inherited_run,
      (json_type(body, '$.input.kind') = 'text' AND json_type(body, '$.input.summary') = 'text'
        AND json_type(body, '$.input.tone') = 'text' AND json_type(body, '$.input.payload') IS NOT NULL) AS imported_activity,
      json_type(body, '$.questionAnswer') = 'object' AS answered, json_extract(body, '$.responseMode') AS response_mode
    FROM shown ORDER BY cohort, ordinal, id
  `;
  // Eligibility cannot silently discard malformed rows (for example a missing
  // type/id after corruption). Preserve the normal fenced read-failure path.
  yield* decodeCandidateHeaders(rows);
  const generic = new Set([
    "user_message",
    "assistant_message",
    "command_execution",
    "error",
    "run_interrupt_result",
    "file_change",
    "proposed_plan",
  ]);
  return rows
    .filter(
      (row) =>
        generic.has(row.type) ||
        (row.type === "reasoning" && !row.authority && row.portable === 1) ||
        (row.type === "dynamic_tool" &&
          !row.authority &&
          ((row.portable === 1 && row.imported_activity === 1) || row.inherited_run !== null)) ||
        (row.type === "user_input_request" &&
          row.status === "completed" &&
          row.answered === 1 &&
          row.response_mode !== "message"),
    )
    .map((row): ContextHistoryCandidate => ({
      sourceOnly: true,
      id: TurnItemId.make(row.id),
      threadId,
      runId: row.run_id === null ? null : RunId.make(row.run_id),
      nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
      type: row.type,
      ...(row.message_id === null ? {} : { messageId: MessageId.make(row.message_id) }),
      ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
      partialSnapshot: row.status === "interrupted" || row.inherited_status === "running",
      ...(row.fork_position === null ? {} : { forkPosition: row.fork_position }),
    }));
});
