/**
 * A fork's inherited history: a frozen, ordered list of the items it shows
 * from the conversations it was forked from.
 *
 * SCIENT-OWNED. A fork does not copy history. When it is accepted, the
 * planner's retained prefix is written here as one row per item, naming the
 * conversation that stores the item (`scient_fork_history`). Membership and
 * order are therefore fixed at fork time: a later rollback, deletion or new
 * turn of the original never changes what the fork shows. Rows point at the
 * item's owner, so a fork of a fork lists its parent's rows directly and every
 * read goes one level deep. Items that were still in flight at the cut, and
 * plans, are copied into the fork instead; their rows point at those copies.
 *
 * Inherited items are presented exactly like the copies they replace:
 * provider and run references cleared, `inheritedFrom` naming the original.
 */
import {
  TurnItemId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { decodeTurnItemRow } from "./projectionRowJson.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface ForkHistoryEntry {
  /** The conversation that stores the item. */
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
  readonly type: OrchestrationV2TurnItem["type"];
  /** A message that started a turn, and whether the user wrote it: history windows count these. */
  readonly turnStart: boolean;
  readonly userTurn: boolean;
}

/** The history entry for an item, by the projection store's turn-start rule. */
export function forkHistoryEntry(
  sourceThreadId: ThreadId,
  sourceItemId: TurnItemId,
  item: OrchestrationV2TurnItem,
): ForkHistoryEntry {
  const turnStart =
    item.type === "user_message" &&
    (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn");
  return {
    sourceThreadId,
    sourceItemId,
    type: item.type,
    turnStart,
    userTurn: turnStart && item.createdBy === "user",
  };
}

export class ForkHistoryReadError extends Schema.TaggedError<ForkHistoryReadError>()(
  "ForkHistoryReadError",
  { threadId: ThreadId, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Items still changing at the cut are copied, never shared. */
function isInFlightTurnItem(item: OrchestrationV2TurnItem): boolean {
  return (
    ["idle", "pending", "running", "waiting"].includes(item.status) ||
    ("streaming" in item && item.streaming === true)
  );
}

const SETTLED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** Runs whose items the source may still change, even items already completed. */
export function openRunIds(runs: ReadonlyArray<OrchestrationV2Run>): ReadonlySet<string> {
  return new Set(runs.filter((run) => !SETTLED_RUN_STATUSES.has(run.status)).map((run) => run.id));
}

/**
 * Retained items a fork owns as copies: anything the source may still change
 * (in-flight work, or any item of a run that has not settled), and history the
 * fork can act on.
 */
export function isCopiedForkItem(
  item: OrchestrationV2TurnItem,
  openRuns: ReadonlySet<string>,
): boolean {
  return (
    isInFlightTurnItem(item) ||
    (item.runId !== null && openRuns.has(item.runId)) ||
    item.type === "proposed_plan" ||
    item.type === "todo_list" ||
    item.type === "handoff"
  );
}

/**
 * The frozen-history fields every inherited or copied item carries: no run,
 * node or provider authority, and the original it stands for. Matches what a
 * copied item has always looked like, so history readers treat both alike.
 */
export function frozenHistoryFields(item: OrchestrationV2TurnItem) {
  return {
    runId: null,
    nodeId: null as OrchestrationV2TurnItem["nodeId"],
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    status: ["idle", "pending", "running", "waiting"].includes(item.status)
      ? ("interrupted" as const)
      : item.status,
    inheritedFrom: item.inheritedFrom ?? {
      threadId: item.threadId,
      itemId: item.id,
      runId: item.runId,
      status: item.status,
    },
  };
}

/** An item of another conversation, as the fork shows it at `position`. */
export function presentInheritedItem(
  item: OrchestrationV2TurnItem,
  position: number,
): OrchestrationV2TurnItem {
  const frozen = { ...item, ...frozenHistoryFields(item), ordinal: position };
  if (frozen.type !== "fork") return frozen as OrchestrationV2TurnItem;
  const { providerThreadId: _providerThreadId, ...fork } = frozen;
  return fork as OrchestrationV2TurnItem;
}

/** Records the fork's inherited history, in order, in the caller's transaction. */
export const writeForkHistory = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  entries: ReadonlyArray<ForkHistoryEntry>,
) =>
  entries.length === 0
    ? Effect.void
    : sql`
        INSERT INTO scient_fork_history
          (thread_id, position, source_thread_id, source_item_id, item_type, turn_start, user_turn)
        SELECT ${threadId}, CAST(key AS INTEGER), json_extract(value, '$[0]'),
          json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
          json_extract(value, '$[4]')
        FROM json_each(${encodeJson(
          entries.map((entry) => [
            entry.sourceThreadId,
            entry.sourceItemId,
            entry.type,
            entry.turnStart ? 1 : 0,
            entry.userTurn ? 1 : 0,
          ]),
        )})
      `.pipe(Effect.asVoid);

export interface ForkHistoryIndexRow extends ForkHistoryEntry {
  readonly position: number;
}

/**
 * The fork's inherited history without payloads, in order; empty for any other
 * thread. Reads only the history list, so it costs the same however large the
 * shown items are.
 */
export const readForkHistoryIndex = Effect.fn("ForkHistory.readIndex")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<{
    readonly position: number;
    readonly source_thread_id: string;
    readonly source_item_id: string;
    readonly item_type: OrchestrationV2TurnItem["type"];
    readonly turn_start: number;
    readonly user_turn: number;
  }>`
    SELECT position, source_thread_id, source_item_id, item_type, turn_start, user_turn
    FROM scient_fork_history
    WHERE thread_id = ${threadId}
    ORDER BY position
  `;
  return rows.map((row): ForkHistoryIndexRow => ({
    position: row.position,
    sourceThreadId: ThreadId.make(row.source_thread_id),
    sourceItemId: TurnItemId.make(row.source_item_id),
    type: row.item_type,
    turnStart: row.turn_start === 1,
    userTurn: row.user_turn === 1,
  }));
});

/** Projected rows for the given index rows, read and presented as the fork shows them. */
export const readForkHistoryRows = Effect.fn("ForkHistory.readRows")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  index: ReadonlyArray<ForkHistoryIndexRow>,
) {
  if (index.length === 0) return [];
  const first = index[0]!.position;
  const last = index.at(-1)!.position;
  // Windows and full reads are one run of positions: read them by range.
  const payloads =
    last - first + 1 === index.length
      ? (yield* sql<{ readonly payload_json: string | null }>`
          SELECT item.payload_json
          FROM scient_fork_history AS history
          LEFT JOIN orchestration_v2_projection_turn_items AS item
            ON item.turn_item_id = history.source_item_id
          WHERE history.thread_id = ${threadId}
            AND history.position BETWEEN ${first} AND ${last}
          ORDER BY history.position
        `).map((row) => row.payload_json)
      : yield* sql<{ readonly turn_item_id: string; readonly payload_json: string }>`
          SELECT turn_item_id, payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id IN (SELECT value FROM json_each(${encodeJson(
            index.map((row) => row.sourceItemId),
          )}))
        `.pipe(
          Effect.map((rows) => {
            const byId = new Map(rows.map((row) => [row.turn_item_id, row.payload_json]));
            return index.map((row) => byId.get(row.sourceItemId) ?? null);
          }),
        );
  const missing = payloads.findIndex((payload) => payload === null);
  if (missing >= 0)
    return yield* new ForkHistoryReadError({
      threadId,
      detail: `Inherited history item ${index[missing]!.sourceItemId} is missing.`,
    });
  const items = yield* Effect.forEach(payloads, (payload) => decodeTurnItemRow(payload!));
  return index.map(
    (row, at) =>
      ({
        visibility: "inherited" as const,
        sourceThreadId: row.sourceThreadId,
        sourceItemId: row.sourceItemId,
        // The fork's own copies are already frozen; only shared items are presented.
        item:
          row.sourceThreadId === threadId
            ? items[at]!
            : presentInheritedItem(items[at]!, row.position),
      }) satisfies Omit<OrchestrationV2ProjectedTurnItem, "position">,
  );
});

/**
 * Which inherited rows a history window shows, by the projection store's
 * window rule (`readCanonicalProjection`): rows at or before the anchor, from
 * the oldest of the last `userTurnLimit + 2` user turns among the last
 * `maxRawTurns + 2` turn starts, or the last `rowLimit` rows when no user turn
 * is in range.
 */
export function selectForkHistoryWindow(
  index: ReadonlyArray<ForkHistoryIndexRow>,
  window: {
    readonly rowLimit: number;
    readonly userTurnLimit?: number | undefined;
    readonly anchorItemId?: TurnItemId | undefined;
    readonly maxRawTurns: number;
  },
): ReadonlyArray<ForkHistoryIndexRow> {
  if (window.rowLimit === 0) return [];
  const anchor =
    window.anchorItemId === undefined
      ? -1
      : index.findIndex((row) => row.sourceItemId === window.anchorItemId);
  const eligible = anchor < 0 ? index : index.slice(0, anchor + 1);
  const turnStarts =
    window.userTurnLimit === undefined
      ? []
      : eligible.flatMap((row, at) => (row.turnStart ? [at] : [])).slice(-(window.maxRawTurns + 2));
  const userTurns = turnStarts
    .filter((at) => eligible[at]!.userTurn)
    .slice(-((window.userTurnLimit ?? 0) + 2));
  const start =
    userTurns.length >= (window.userTurnLimit ?? 0) + 2
      ? userTurns[0]!
      : turnStarts.length >= window.maxRawTurns + 2
        ? turnStarts[0]!
        : 0;
  const fromStart = eligible.slice(start);
  return userTurns.length > 0 ? fromStart : fromStart.slice(-window.rowLimit);
}

/** Whether the thread is a fork with inherited history. */
/**
 * Whether a live conversation other than `exceptThreadId` still shows part of
 * `sourceThreadId`'s history. Its files are kept while one does.
 */
export const hasLiveForkInheritors = (
  sql: SqlClient.SqlClient,
  sourceThreadId: ThreadId,
  exceptThreadId: ThreadId,
) =>
  sql<{ readonly present: number }>`
    SELECT 1 AS present
    FROM scient_fork_history AS history
    JOIN orchestration_v2_projection_threads AS fork ON fork.thread_id = history.thread_id
    WHERE history.source_thread_id = ${sourceThreadId}
      AND history.thread_id <> ${sourceThreadId}
      AND history.thread_id <> ${exceptThreadId}
      AND fork.deleted_at IS NULL
    LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0));

/** Deleted conversations whose history this fork shows. */
export const readDeletedForkSources = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly source_thread_id: string }>`
    SELECT DISTINCT history.source_thread_id
    FROM scient_fork_history AS history
    JOIN orchestration_v2_projection_threads AS source
      ON source.thread_id = history.source_thread_id
    WHERE history.thread_id = ${threadId}
      AND history.source_thread_id <> ${threadId}
      AND source.deleted_at IS NOT NULL
  `.pipe(Effect.map((rows) => rows.map((row) => ThreadId.make(row.source_thread_id))));

/** The given attachment ids that a shared item of `sourceThreadId`, shown by a live fork, names. */
export const readLiveForkSharedAttachmentIds = (
  sql: SqlClient.SqlClient,
  sourceThreadId: ThreadId,
  attachmentIds: ReadonlyArray<string>,
) =>
  Effect.filter(attachmentIds, (id) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found
      FROM scient_fork_history AS history
      JOIN orchestration_v2_projection_threads AS fork ON fork.thread_id = history.thread_id
      JOIN orchestration_v2_projection_turn_items AS item
        ON item.turn_item_id = history.source_item_id
      WHERE history.source_thread_id = ${sourceThreadId}
        AND history.thread_id <> ${sourceThreadId}
        AND fork.deleted_at IS NULL
        AND instr(lower(item.payload_json), ${id.toLowerCase()}) > 0
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0)),
  );

/**
 * Raw messages of the fork's shared history, in history order: the messages its
 * inherited user and assistant items stand for. The fork's own copies keep
 * their own messages. Narrow to `messageIds` to read only some.
 */
export const readForkHistoryMessageRows = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageIds?: ReadonlyArray<string>,
) =>
  sql<{ readonly message_id: string; readonly payload_json: string }>`
    SELECT message.message_id, message.payload_json
    FROM scient_fork_history AS history
    JOIN orchestration_v2_projection_turn_items AS item
      ON item.turn_item_id = history.source_item_id
    JOIN orchestration_v2_projection_messages AS message
      ON message.thread_id = item.thread_id
      AND message.message_id = json_extract(item.payload_json, '$.messageId')
    WHERE history.thread_id = ${threadId}
      AND history.source_thread_id <> ${threadId}
      AND history.item_type IN ('user_message', 'assistant_message')
      ${
        messageIds === undefined
          ? sql``
          : sql`AND message.message_id IN (SELECT value FROM json_each(${encodeJson(messageIds)}))`
      }
    ORDER BY history.position
  `.pipe(
    Effect.map((rows) => {
      const seen = new Set<string>();
      return rows.filter((row) => !seen.has(row.message_id) && seen.add(row.message_id));
    }),
  );

/** An inherited message as the fork's frozen history shows it. */
export function presentInheritedMessage<
  M extends {
    readonly runId: unknown;
    readonly nodeId: unknown;
    readonly streaming: boolean;
  },
>(message: M): M {
  return { ...message, runId: null, nodeId: null, streaming: false };
}
