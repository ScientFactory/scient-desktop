/** SCIENT-OWNED: missing native telemetry must not materialize a transcript. */
import {
  ThreadId,
  RunId,
  ProviderThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { attachmentTokenAllowance } from "@t3tools/provider-core/server/handoffBudget";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { historicalMessage } from "../ScientHistoricalContext.ts";
import { decodeTurnItemRow } from "./projectionRowJson.ts";
import { presentInheritedItem } from "./ForkHistory.ts";

export interface NativeHistoryEstimate {
  readonly id: TurnItemId;
  readonly runId: RunId | null;
  readonly providerThreadId: ProviderThreadId | null;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly textBytes: number;
  readonly attachmentTokens: number;
}

export const nativeHistoryEstimate = (item: OrchestrationV2TurnItem): NativeHistoryEstimate => ({
  id: item.id,
  runId: item.runId,
  providerThreadId: item.providerThreadId ?? null,
  type: item.type,
  textBytes: Buffer.byteLength(historicalMessage(item)?.text ?? ""),
  attachmentTokens: item.type === "user_message" ? attachmentTokenAllowance(item.attachments) : 0,
});

export const readNativeHistoryEstimates = Effect.fn("NativeHistoryEstimate.read")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const body = sql`COALESCE(frozen.item_json, item.payload_json)`;
  const small = sql`CASE json_extract(${body}, '$.type')
    WHEN 'user_message' THEN json_set(json_remove(${body}, '$.context'), '$.text', '')
    WHEN 'assistant_message' THEN json_set(json_remove(${body}, '$.context'), '$.text', '')
    WHEN 'reasoning' THEN json_set(${body}, '$.text', '')
    WHEN 'command_execution' THEN json_set(${body}, '$.input', '', '$.output', '')
    WHEN 'error' THEN json_set(${body}, '$.failure.message', 'x')
    WHEN 'run_interrupt_result' THEN json_set(${body}, '$.message', '')
    WHEN 'proposed_plan' THEN json_set(${body}, '$.markdown', '')
    WHEN 'file_change' THEN json_remove(${body}, '$.diffStr', '$.oldStr', '$.newStr')
    ELSE ${body} END`;
  const rows = yield* sql<{
    readonly id: string;
    readonly position: number | null;
    readonly run_id: string | null;
    readonly provider_thread_id: string | null;
    readonly type: OrchestrationV2TurnItem["type"];
    readonly stripped_bytes: number;
    readonly small_bytes: number;
    readonly raw_bytes: number;
    readonly image_count: number;
    readonly other_count: number;
  }>`
    WITH shown AS (
      SELECT history.position, history.source_item_id AS id, ${body} AS body, ${small} AS small,
        history.source_thread_id <> ${threadId} AS inherited
      FROM scient_fork_history AS history
      LEFT JOIN scient_fork_frozen_items AS frozen ON frozen.thread_id = history.thread_id AND frozen.position = history.position
      LEFT JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = history.source_item_id
      WHERE history.thread_id = ${threadId}
      UNION ALL
      SELECT NULL, item.turn_item_id, ${body}, ${small}, 0
      FROM orchestration_v2_projection_turn_items AS item
      LEFT JOIN scient_fork_frozen_items AS frozen ON 0
      WHERE item.thread_id = ${threadId} AND NOT EXISTS (
        SELECT 1 FROM scient_fork_history WHERE thread_id = ${threadId} AND source_item_id = item.turn_item_id)
    )
    SELECT id, position, CASE WHEN inherited THEN NULL ELSE json_extract(body, '$.runId') END AS run_id,
      CASE WHEN inherited THEN NULL ELSE json_extract(body, '$.providerThreadId') END AS provider_thread_id,
      json_extract(body, '$.type') AS type, octet_length(body) AS raw_bytes, octet_length(small) AS small_bytes,
      CASE json_extract(body, '$.type')
        WHEN 'user_message' THEN octet_length(json_extract(body, '$.text'))
        WHEN 'assistant_message' THEN octet_length(json_extract(body, '$.text'))
        WHEN 'reasoning' THEN octet_length(json_extract(body, '$.text'))
        WHEN 'command_execution' THEN octet_length(json_extract(body, '$.input')) + COALESCE(octet_length(json_extract(body, '$.output')), 0)
        WHEN 'error' THEN octet_length(json_extract(body, '$.failure.message')) - 1
        WHEN 'run_interrupt_result' THEN octet_length(json_extract(body, '$.message'))
        WHEN 'proposed_plan' THEN octet_length(json_extract(body, '$.markdown')) ELSE 0 END AS stripped_bytes,
      CASE WHEN json_extract(body, '$.type') = 'user_message' THEN (
        SELECT COUNT(*) FROM json_each(body, '$.attachments') WHERE json_extract(value, '$.type') = 'image')
        ELSE 0 END AS image_count,
      CASE WHEN json_extract(body, '$.type') = 'user_message' THEN (
        SELECT COUNT(*) FROM json_each(body, '$.attachments') WHERE json_extract(value, '$.type') <> 'image')
        ELSE 0 END AS other_count
    FROM shown WHERE json_extract(body, '$.type') IN ('user_message', 'assistant_message', 'reasoning',
      'command_execution', 'error', 'run_interrupt_result', 'proposed_plan', 'file_change', 'dynamic_tool', 'user_input_request')
      AND (json_extract(body, '$.type') NOT IN ('reasoning', 'dynamic_tool') OR inherited OR json_type(body, '$.runId') = 'null')
      AND (json_extract(body, '$.type') <> 'user_input_request' OR (
        json_extract(body, '$.status') = 'completed' AND json_type(body, '$.questionAnswer') = 'object'))
  `;
  const estimates: NativeHistoryEstimate[] = [];
  for (const row of rows) {
    let textBytes = row.raw_bytes + 512;
    if (row.small_bytes <= 128_000) {
      const payload = yield* sql<{ readonly payload_json: string }>`
        SELECT ${small} AS payload_json
        FROM orchestration_v2_projection_turn_items AS item
        LEFT JOIN scient_fork_frozen_items AS frozen
          ON frozen.thread_id = ${threadId} AND frozen.position = ${row.position}
        WHERE item.turn_item_id = ${row.id}
        UNION ALL
        SELECT ${small} AS payload_json
        FROM scient_fork_frozen_items AS frozen
        LEFT JOIN orchestration_v2_projection_turn_items AS item ON 0
        WHERE frozen.thread_id = ${threadId} AND frozen.position = ${row.position}
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${row.id})
        LIMIT 1
      `;
      const original = yield* decodeTurnItemRow(payload[0]!.payload_json);
      const item =
        row.position === null || original.threadId === threadId
          ? original
          : presentInheritedItem(original, row.position, threadId);
      const message = historicalMessage(item);
      textBytes = message === null ? 0 : row.stripped_bytes + Buffer.byteLength(message.text);
    }
    estimates.push({
      id: TurnItemId.make(row.id),
      runId: row.run_id === null ? null : RunId.make(row.run_id),
      providerThreadId:
        row.provider_thread_id === null ? null : ProviderThreadId.make(row.provider_thread_id),
      type: row.type,
      textBytes,
      attachmentTokens:
        row.image_count * attachmentTokenAllowance([{ type: "image" }]) +
        row.other_count * attachmentTokenAllowance([{ type: "file" }]),
    });
    yield* Effect.yieldNow;
  }
  return estimates;
});
