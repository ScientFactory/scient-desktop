/** SCIENT-OWNED. Immutable handoff membership uses the existing history owners.
 * Bodies are kept only before their owner rewrites them. Legacy payloads remain
 * lossless; routine reads return a reference before SQLite creates JS strings. */
import {
  ContextHandoffId,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ContextHandoffJson,
  ThreadId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  historyCost,
  historyMessageCost,
  historySelectionOrder,
  historySelectionContext,
} from "@t3tools/provider-core/server/handoffBudget";
import { historicalMessage } from "../ScientHistoricalContext.ts";
import { presentInheritedItem } from "./ForkHistory.ts";
import { decodeTurnItemRow } from "./projectionRowJson.ts";
import { handoffMetadataSql } from "./ContextHistorySql.ts";
import { readJsonStringFieldPage } from "./JsonStringFieldPage.ts";

const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJson),
);
const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ContextHandoffJson));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2HistoricalMessage),
);

const indexLegacyContextHistory = Effect.fn("ContextHistory.indexLegacy")(function* (
  sql: SqlClient.SqlClient,
  sourceId: ContextHandoffId,
) {
  const source = yield* sql<{ readonly messages_indexed: number }>`
    SELECT messages_indexed FROM scient_handoff_legacy_sources WHERE source_id = ${sourceId}`;
  if (source[0]?.messages_indexed !== 0) return;
  yield* sql`
    INSERT OR REPLACE INTO scient_handoff_legacy_messages
      (source_id, position, item_id, role, text_bytes, metadata_json, payload_json)
    SELECT source.source_id, CAST(message.key AS INTEGER),
      CASE WHEN message.type = 'object' THEN COALESCE(json_extract(message.value, '$.itemId'), '') ELSE '' END,
      CASE WHEN message.type = 'object' THEN COALESCE(json_extract(message.value, '$.role'), '') ELSE '' END,
      CASE WHEN message.type = 'object' THEN COALESCE(octet_length(json_extract(message.value, '$.text')), 0) ELSE 0 END,
      CASE WHEN message.type = 'object' AND json_type(message.value, '$.text') = 'text'
        THEN json_set(message.value, '$.text', '') ELSE 'null' END,
      CASE WHEN message.type = 'object' THEN message.value ELSE 'null' END
    FROM scient_handoff_legacy_sources AS source
    LEFT JOIN orchestration_events AS event ON event.event_id = source.event_id
    JOIN json_each(COALESCE(source.payload_json, event.payload_json), '$.history.messages') AS message
    WHERE source.source_id = ${sourceId}
  `;
  yield* sql`UPDATE scient_handoff_legacy_sources SET messages_indexed = 1 WHERE source_id = ${sourceId}`;
});

const LegacySourceShape = Schema.Struct({
  bytes: Schema.Number,
  summaryText: Schema.Number,
  historyNull: Schema.Number,
  messagesArray: Schema.Number,
  count: Schema.Number,
});
const decodeLegacySourceShape = Schema.decodeUnknownOption(
  Schema.fromJsonString(LegacySourceShape),
);

/** Archived bodies are write-once, so a parsed shape is recorded against the body's
 * byte length (read from the record header without loading the body) and startup
 * checks it without re-parsing. Bodies that are not valid JSON are never recorded. */
const legacySourceShape = Effect.fn("ContextHistory.legacyShape")(function* (
  sql: SqlClient.SqlClient,
  sourceId: ContextHandoffId,
) {
  const bytes = sql`CASE WHEN source.payload_json IS NOT NULL THEN octet_length(source.payload_json)
    ELSE octet_length(event.payload_json) END`;
  const cached = yield* sql<{ readonly shape: string | null; readonly bytes: number | null }>`
    SELECT source.shape_json AS shape, ${bytes} AS bytes
    FROM scient_handoff_legacy_sources AS source
    LEFT JOIN orchestration_events AS event ON event.event_id = source.event_id
    WHERE source.source_id = ${sourceId}`;
  if (cached[0] === undefined || cached[0].bytes === null) return undefined;
  const recorded = cached[0].shape === null ? undefined : decodeLegacySourceShape(cached[0].shape);
  if (recorded?._tag === "Some" && recorded.value.bytes === cached[0].bytes) return recorded.value;
  const parsed = yield* sql<{ readonly shape: string | null }>`
    SELECT CASE WHEN json_valid(body) THEN json_object('bytes', bytes,
      'summaryText', COALESCE(json_type(body, '$.summaryText') = 'text', 0),
      'historyNull', json_type(body, '$.history') IS NULL,
      'messagesArray', COALESCE(json_type(body, '$.history.messages') = 'array', 0),
      'count', COALESCE(json_array_length(body, '$.history.messages'), 0)) END AS shape
    FROM (SELECT COALESCE(source.payload_json, event.payload_json) AS body, ${bytes} AS bytes
      FROM scient_handoff_legacy_sources AS source
      LEFT JOIN orchestration_events AS event ON event.event_id = source.event_id
      WHERE source.source_id = ${sourceId})`;
  const shape = parsed[0]?.shape ?? null;
  if (shape === null) return undefined;
  yield* sql`UPDATE scient_handoff_legacy_sources SET shape_json = ${shape} WHERE source_id = ${sourceId}`;
  const decoded = decodeLegacySourceShape(shape);
  return decoded._tag === "Some" ? decoded.value : undefined;
});

/** Validate legacy message metadata before removing bodies from normal reads.
 * SQLite checks the text type; the public schema checks every other field.
 * Neither the transcript nor an oversized metadata row crosses the driver. */
export const isLegacyContextHistoryReadable = Effect.fn("ContextHistory.validateLegacy")(function* (
  sql: SqlClient.SqlClient,
  sourceId: ContextHandoffId,
  itemCount: number,
  summaryOnly: boolean,
) {
  const shape = yield* legacySourceShape(sql, sourceId);
  if (
    shape === undefined ||
    shape.summaryText !== 1 ||
    (summaryOnly ? shape.historyNull : shape.messagesArray) !== 1 ||
    shape.count !== itemCount
  )
    return false;
  if (summaryOnly) return true;
  yield* indexLegacyContextHistory(sql, sourceId).pipe(sql.withTransaction);
  const count = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
    FROM scient_handoff_legacy_messages WHERE source_id = ${sourceId}`;
  if (count[0]!.count !== itemCount) return false;
  let position = -1;
  while (true) {
    const rows = yield* sql<{ readonly position: number; readonly payload_json: string | null }>`
      WITH messages AS (
        SELECT position, metadata_json AS body FROM scient_handoff_legacy_messages
        WHERE source_id = ${sourceId} AND position > ${position}
        ORDER BY position LIMIT 128
      ), sized AS (
        SELECT *, SUM(octet_length(body)) OVER (ORDER BY position) AS batch_bytes FROM messages
      )
      SELECT position, CASE WHEN octet_length(body) <= 65536 THEN body ELSE NULL END AS payload_json
      FROM sized WHERE batch_bytes <= 262144 OR position = (SELECT MIN(position) FROM sized)
    `;
    if (rows.length === 0) return true;
    for (const row of rows) {
      if (
        row.payload_json === null ||
        (yield* Effect.exit(decodeMessage(row.payload_json)))._tag === "Failure"
      )
        return false;
    }
    position = rows.at(-1)!.position;
    yield* Effect.yieldNow;
  }
});

/** Initial membership is committed with the handoff event; status updates carry only its ID. */
const captureContextHistory = Effect.fn("ContextHistory.capture")(function* (
  sql: SqlClient.SqlClient,
  handoff: OrchestrationV2ContextHandoff,
) {
  const source = handoff.historySource;
  if (source?.entries === undefined) return;
  yield* sql`
    INSERT OR IGNORE INTO scient_handoff_history
      (source_id, position, view_thread_id, source_thread_id, source_item_id, fork_position,
        run_status, body_id)
    SELECT ${source.id}, CAST(entry.key AS INTEGER), json_extract(entry.value, '$.threadId'),
      COALESCE(history.source_thread_id, json_extract(entry.value, '$.threadId')),
      json_extract(entry.value, '$.itemId'), history.position,
      json_extract(entry.value, '$.runStatus'), NULL
    FROM json_each(${encodeJson(source.entries)}) AS entry
    LEFT JOIN scient_fork_history AS history
      ON history.thread_id = json_extract(entry.value, '$.threadId')
      AND history.source_item_id = json_extract(entry.value, '$.itemId')
      AND history.position = COALESCE(json_extract(entry.value, '$.forkPosition'), (
        SELECT MIN(position) FROM scient_fork_history
        WHERE thread_id = json_extract(entry.value, '$.threadId')
          AND source_item_id = json_extract(entry.value, '$.itemId')))
  `;
});

export const recordContextHistory = Effect.fn("ContextHistory.record")(function* (
  sql: SqlClient.SqlClient,
  event: Extract<OrchestrationV2DomainEvent, { type: "context-handoff.updated" }>,
) {
  const handoff = event.payload;
  yield* captureContextHistory(sql, handoff);
  if (handoff.historySource !== undefined) {
    yield* sql`INSERT OR IGNORE INTO scient_handoff_projection_sources (source_id) VALUES (${handoff.historySource.id})`;
    const { entries: _entries, ...source } = handoff.historySource;
    return { ...handoff, historySource: source };
  }
  const id = ContextHandoffId.make(`legacy-event:${event.id}`);
  yield* sql`
    INSERT OR IGNORE INTO scient_handoff_legacy_sources (source_id, event_id, payload_json)
    VALUES (${id},
      (SELECT event_id FROM orchestration_events WHERE event_id = ${event.id}),
      CASE WHEN EXISTS (SELECT 1 FROM orchestration_events WHERE event_id = ${event.id})
        THEN NULL ELSE ${encodeHandoff(handoff)} END)
  `;
  if (handoff.history === undefined)
    return {
      ...handoff,
      summaryText: "",
      historySource: { id, itemCount: 0, summaryOnly: true as const },
    };
  return {
    ...handoff,
    summaryText: "",
    history: { ...handoff.history, messages: [] },
    historySource: { id, itemCount: handoff.history.messages.length },
  };
});

export const freezeContextHistory = Effect.fn("ContextHistory.freeze")(function* (
  sql: SqlClient.SqlClient,
  event: OrchestrationV2DomainEvent,
) {
  if (event.type !== "turn-item.updated") return;
  const bodyId = `before:${event.id}`;
  yield* sql`
    INSERT OR IGNORE INTO scient_handoff_frozen_items (body_id, item_json)
    SELECT ${bodyId}, item.payload_json FROM orchestration_v2_projection_turn_items AS item
    WHERE item.turn_item_id = ${event.payload.id} AND item.thread_id = ${event.threadId}
      AND EXISTS (SELECT 1 FROM scient_handoff_history AS history
        WHERE history.source_thread_id = ${event.threadId} AND history.source_item_id = ${event.payload.id}
          AND history.body_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM scient_fork_frozen_items AS frozen
            WHERE frozen.thread_id = history.view_thread_id AND frozen.position = history.fork_position)
          AND EXISTS (SELECT 1 FROM scient_handoff_projection_sources AS projected WHERE projected.source_id = history.source_id))
  `;
  yield* sql`
    UPDATE scient_handoff_history SET body_id = ${bodyId}
    WHERE source_thread_id = ${event.threadId} AND source_item_id = ${event.payload.id}
      AND body_id IS NULL AND EXISTS (SELECT 1 FROM scient_handoff_frozen_items WHERE body_id = ${bodyId})
      AND EXISTS (SELECT 1 FROM scient_handoff_projection_sources AS projected WHERE projected.source_id = scient_handoff_history.source_id)
  `;
});

/** Membership and kept bodies survive rebuild. Only the replay cursor resets:
 * a source cannot freeze an item until its capture event has been replayed. */
export const resetContextHistoryProjection = (sql: SqlClient.SqlClient) =>
  sql`DELETE FROM scient_handoff_projection_sources`;

export class ContextHistoryReadError extends Schema.TaggedError<ContextHistoryReadError>()(
  "ContextHistoryReadError",
  { sourceId: ContextHandoffId, detail: Schema.String },
) {}

/** Body materialization has a separate limit from the receiving context. SQL
 * discards fields the historical formatter never uses before measuring that limit. */
const contextItemSql = (
  sql: SqlClient.SqlClient,
  payload: import("effect/sql/Statement").Fragment,
) => sql`
  CASE json_extract(${payload}, '$.type')
    WHEN 'file_change' THEN json_remove(${payload}, '$.diffStr', '$.oldStr', '$.newStr')
    WHEN 'user_message' THEN json_remove(${payload}, '$.context')
    WHEN 'assistant_message' THEN json_remove(${payload}, '$.context')
    ELSE ${payload} END
`;

const contextCandidates = Effect.fn("ContextHistory.candidates")(function* (
  sql: SqlClient.SqlClient,
  handoff: OrchestrationV2ContextHandoff,
  budget: number,
) {
  const source = handoff.historySource;
  if (source?.summaryOnly === true) return [];
  if (source === undefined)
    return (handoff.history?.messages ?? []).map((message) => ({
      itemId: message.itemId,
      role: message.role,
      bytes: Buffer.byteLength(message.text),
      read: () => Effect.succeed(message as OrchestrationV2HistoricalMessage | null),
    }));
  const legacy = yield* sql<{ readonly messages_indexed: number }>`
    SELECT messages_indexed FROM scient_handoff_legacy_sources WHERE source_id = ${source.id}
  `;
  const readLimit = Math.max(128_000, budget * 2);
  if (legacy.length > 0) {
    if (!(yield* isLegacyContextHistoryReadable(sql, source.id, source.itemCount, false)))
      return yield* new ContextHistoryReadError({
        sourceId: source.id,
        detail: "Legacy context history is malformed.",
      });
    const index = yield* sql<{
      readonly position: number;
      readonly bytes: number;
      readonly raw_bytes: number;
      readonly item_id: string;
      readonly role: string;
    }>`
      SELECT position, text_bytes AS bytes, octet_length(payload_json) AS raw_bytes, item_id, role
      FROM scient_handoff_legacy_messages WHERE source_id = ${source.id} ORDER BY position
    `;
    if (index.length !== source.itemCount)
      return yield* new ContextHistoryReadError({
        sourceId: source.id,
        detail: "Legacy context history membership is incomplete.",
      });
    return index.map((row) => ({
      itemId: row.item_id,
      role: row.role,
      bytes: row.bytes,
      read: () =>
        Effect.gen(function* () {
          if (row.raw_bytes > readLimit) return null;
          const body = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM scient_handoff_legacy_messages
          WHERE source_id = ${source.id} AND position = ${row.position}
        `;
          return yield* decodeMessage(body[0]!.payload_json);
        }),
    }));
  }
  const index = yield* sql<{
    readonly position: number;
    readonly source_item_id: string;
    readonly role: string;
    readonly view_thread_id: string;
    readonly fork_position: number | null;
    readonly run_status: OrchestrationV2HistoricalMessage["runStatus"] | null;
    readonly bytes: number | null;
  }>`
    SELECT history.position, history.source_item_id, history.view_thread_id,
      history.fork_position, history.run_status,
      CASE json_extract(COALESCE(frozen.item_json, body.item_json, item.payload_json), '$.type')
        WHEN 'user_message' THEN 'user' WHEN 'user_input_request' THEN 'user'
        ELSE 'assistant' END AS role,
      octet_length(${contextItemSql(sql, sql`COALESCE(frozen.item_json, body.item_json, item.payload_json)`)}) AS bytes
    FROM scient_handoff_history AS history
    LEFT JOIN scient_handoff_frozen_items AS body ON body.body_id = history.body_id
    LEFT JOIN scient_fork_frozen_items AS frozen
      ON frozen.thread_id = history.view_thread_id AND frozen.position = history.fork_position
    LEFT JOIN orchestration_v2_projection_turn_items AS item
      ON item.turn_item_id = history.source_item_id AND item.thread_id = history.source_thread_id
    WHERE history.source_id = ${source.id} ORDER BY history.position
  `;
  if (index.length !== source.itemCount || index.some((row) => row.bytes === null))
    return yield* new ContextHistoryReadError({
      sourceId: source.id,
      detail: "Context history membership or its frozen body is missing.",
    });
  return index.map((row) => ({
    itemId: row.source_item_id,
    role: row.role,
    // The full row includes metadata, so it is not a context-cost estimate.
    // Its bounded read is followed by the shared exact serialized-cost check.
    bytes: 0,
    read: () =>
      Effect.gen(function* () {
        if (row.bytes! > readLimit) return null;
        const body = yield* sql<{ readonly payload_json: string }>`
        SELECT ${contextItemSql(sql, sql`COALESCE(frozen.item_json, body.item_json, item.payload_json)`)} AS payload_json
        FROM scient_handoff_history AS history
        LEFT JOIN scient_handoff_frozen_items AS body ON body.body_id = history.body_id
    LEFT JOIN scient_fork_frozen_items AS frozen
      ON frozen.thread_id = history.view_thread_id AND frozen.position = history.fork_position
    LEFT JOIN orchestration_v2_projection_turn_items AS item
          ON item.turn_item_id = history.source_item_id AND item.thread_id = history.source_thread_id
        WHERE history.source_id = ${source.id} AND history.position = ${row.position}
      `;
        const original = yield* decodeTurnItemRow(body[0]!.payload_json);
        const item =
          row.fork_position === null || original.threadId === row.view_thread_id
            ? original
            : presentInheritedItem(original, row.fork_position, ThreadId.make(row.view_thread_id));
        const message = historicalMessage(item);
        return message === null
          ? null
          : { ...message, ...(row.run_status === null ? {} : { runStatus: row.run_status }) };
      }),
  }));
});

const readContextSummaryPage = Effect.fn("ContextHistory.readSummaryPage")(function* <E = never>(
  sql: SqlClient.SqlClient,
  sourceId: ContextHandoffId,
  offset: number,
  maxChars: number,
  onPage?: (text: string) => Effect.Effect<void, E>,
) {
  return yield* readJsonStringFieldPage<E | ContextHistoryReadError | SqlError>({
    field: "summaryText",
    offset,
    maxChars,
    ...(onPage === undefined ? {} : { onPage }),
    read: (byteOffset, length) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly chunk: Uint8Array }>`
        SELECT substr(CAST(COALESCE(source.payload_json, event.payload_json) AS BLOB),
          ${byteOffset + 1}, ${length}) AS chunk FROM scient_handoff_legacy_sources AS source
        LEFT JOIN orchestration_events AS event ON event.event_id = source.event_id
        WHERE source.source_id = ${sourceId}
      `;
        if (rows[0] === undefined)
          return yield* new ContextHistoryReadError({
            sourceId,
            detail: "The legacy summary source is missing.",
          });
        return rows[0].chunk;
      }),
  });
});

/** One shared allowance across all pending handoffs. Only selected whole bodies
 * remain live; omitted bodies are released before the next candidate is read. */
export const selectContextHistory = Effect.fn("ContextHistory.select")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly coverage: string;
    readonly budget: number;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
  },
) {
  let coverage = input.coverage;
  for (const handoff of input.handoffs) {
    if (handoff.historySource?.summaryOnly !== true || input.budget <= 0) continue;
    const sourceId = handoff.historySource.id;
    if (!(yield* isLegacyContextHistoryReadable(sql, sourceId, 0, true)))
      return yield* new ContextHistoryReadError({
        sourceId,
        detail: "Legacy context summary is malformed or missing.",
      });
    const summary = yield* readContextSummaryPage(sql, sourceId, 0, Math.floor(input.budget));
    if (
      summary.nextTextOffset === null &&
      historyCost([], `${coverage}\n${summary.text}`) + 512 <= input.budget
    )
      coverage += `\n${summary.text}`;
  }
  const groups = yield* Effect.forEach(input.handoffs, (handoff) =>
    contextCandidates(sql, handoff, input.budget),
  );
  const itemIdsByHandoff = new Map(
    input.handoffs.map(
      (handoff, at) =>
        [handoff.id, new Set(groups[at]!.map((candidate) => candidate.itemId))] as const,
    ),
  );
  const seen = new Set(input.alreadyDeliveredItemIds);
  const candidates = groups.flat().filter((candidate) => {
    if (seen.has(candidate.itemId)) return false;
    seen.add(candidate.itemId);
    return true;
  });
  const omittedBefore = input.handoffs.reduce(
    (sum, handoff) => sum + (handoff.history?.omittedItems ?? 0),
    0,
  );
  let remaining =
    input.budget -
    historyCost(
      [],
      historySelectionContext(coverage, candidates.length, omittedBefore + candidates.length),
    );
  const selected = new Map<number, OrchestrationV2HistoricalMessage>();
  for (const at of historySelectionOrder(candidates)) {
    const candidate = candidates[at]!;
    if (candidate.bytes > remaining || remaining <= 0) continue;
    const message = yield* candidate.read();
    if (message === null) continue;
    const cost = historyMessageCost(message);
    if (cost > remaining) continue;
    selected.set(at, message);
    remaining -= cost;
    yield* Effect.yieldNow;
  }
  const messages = [...selected].sort(([a], [b]) => a - b).map(([, message]) => message);
  const omittedItemIds = candidates
    .filter((_, at) => !selected.has(at))
    .map((candidate) => candidate.itemId);
  return {
    messages,
    itemIdsByHandoff,
    omittedItemIds,
    omittedItems: omittedBefore + candidates.length - messages.length,
    context: historySelectionContext(
      coverage,
      messages.length,
      omittedBefore + candidates.length - messages.length,
    ),
  };
});

/** The requesting thread must own the handoff or retain its frozen timeline identity.
 * An inherited summary is read from that frozen version, never a moving parent. */
export const readContextHandoffSummary = Effect.fn("ContextHistory.readHandoffSummary")(function* <
  E = never,
>(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  handoffId: ContextHandoffId,
  offset: number,
  maxChars: number,
  consume?: (text: string) => Effect.Effect<void, E>,
) {
  const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT ${handoffMetadataSql(sql, sql`context.payload_json`, sql`'legacy-projection:' || context.context_handoff_id`)} AS payload_json
          FROM orchestration_v2_projection_context_handoffs AS context
          WHERE context.context_handoff_id = ${handoffId} AND (context.thread_id = ${threadId} OR EXISTS (
            SELECT 1 FROM scient_fork_history AS history
            LEFT JOIN scient_fork_frozen_items AS frozen ON frozen.thread_id = history.thread_id AND frozen.position = history.position
            LEFT JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = history.source_item_id
            WHERE history.thread_id = ${threadId} AND history.item_type = 'handoff'
AND json_extract(COALESCE(frozen.item_json, item.payload_json), '$.contextHandoffId') = ${handoffId}
          )) LIMIT 1
        `;
  if (rows[0] === undefined) return null;
  const handoff = yield* decodeHandoff(rows[0].payload_json);
  if (consume !== undefined && maxChars <= 0)
    return yield* new ContextHistoryReadError({
      sourceId: handoffId,
      detail: "Streaming pages must have positive length.",
    });
  if (handoff.threadId !== threadId) {
    const inherited = yield* sql<{ readonly position: number; readonly bytes: number }>`
    SELECT history.position, octet_length(json_extract(COALESCE(frozen.item_json, item.payload_json), '$.summary')) AS bytes
    FROM scient_fork_history AS history
    LEFT JOIN scient_fork_frozen_items AS frozen ON frozen.thread_id = history.thread_id AND frozen.position = history.position
    LEFT JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = history.source_item_id
    WHERE history.thread_id = ${threadId} AND history.item_type = 'handoff'
      AND json_extract(COALESCE(frozen.item_json, item.payload_json), '$.contextHandoffId') = ${handoffId}
      AND json_type(COALESCE(frozen.item_json, item.payload_json), '$.summary') = 'text'
    ORDER BY history.position LIMIT 1
  `;
    if (inherited[0] !== undefined) {
      const saved = inherited[0];
      return {
        handoff,
        textBytes: saved.bytes,
        ...(yield* readJsonStringFieldPage<E | ContextHistoryReadError | SqlError>({
          field: "summary",
          offset,
          maxChars,
          ...(consume === undefined ? {} : { onPage: consume }),
          read: (byteOffset, length) =>
            sql<{ readonly chunk: Uint8Array }>`
          SELECT substr(CAST(COALESCE(frozen.item_json, item.payload_json) AS BLOB), ${byteOffset + 1}, ${length}) AS chunk
          FROM scient_fork_history AS history
          LEFT JOIN scient_fork_frozen_items AS frozen ON frozen.thread_id = history.thread_id AND frozen.position = history.position
          LEFT JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = history.source_item_id
          WHERE history.thread_id = ${threadId} AND history.position = ${saved.position}`.pipe(
              Effect.map((parts) => parts[0]!.chunk),
            ),
        })),
      };
    }
  }
  const source = handoff.historySource;
  const legacy =
    source === undefined
      ? []
      : yield* sql`
          SELECT 1 FROM scient_handoff_legacy_sources WHERE source_id = ${source.id}
        `;
  if (source !== undefined && legacy.length > 0)
    return {
      handoff,
      textBytes: (yield* sql<{ readonly bytes: number }>`
      SELECT octet_length(json_extract(COALESCE(source.payload_json, event.payload_json), '$.summaryText')) AS bytes
      FROM scient_handoff_legacy_sources AS source
      LEFT JOIN orchestration_events AS event ON event.event_id = source.event_id
      WHERE source.source_id = ${source.id}`)[0]!.bytes,
      ...(yield* readContextSummaryPage(sql, source.id, offset, maxChars, consume)),
    };
  const text = handoff.summaryText || handoff.history?.coverage || "";
  if (consume !== undefined) {
    for (let at = offset; at < text.length; at += maxChars)
      yield* consume(text.slice(at, at + maxChars));
  }
  return {
    handoff,
    textBytes: Buffer.byteLength(text),
    text: text.slice(offset, offset + maxChars),
    nextTextOffset: text.length > offset + maxChars ? offset + maxChars : null,
  };
});
