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
  /** The message a user or assistant item stands for. */
  readonly messageId: string | null;
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
    messageId:
      item.type === "user_message" || item.type === "assistant_message" ? item.messageId : null,
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

/**
 * Records the fork's inherited history, in order, in the caller's transaction,
 * after its thread is created. Rows its parent fork shows in a kept version
 * keep that version too, so a fork of a fork shows what its parent showed.
 */
export const writeForkHistory = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  entries: ReadonlyArray<ForkHistoryEntry>,
) =>
  entries.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        yield* sql`
          INSERT INTO scient_fork_history
            (thread_id, position, source_thread_id, source_item_id, item_type, message_id,
              turn_start, user_turn)
          SELECT ${threadId}, CAST(key AS INTEGER), json_extract(value, '$[0]'),
            json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
            json_extract(value, '$[4]'), json_extract(value, '$[5]')
          FROM json_each(${encodeJson(
            entries.map((entry) => [
              entry.sourceThreadId,
              entry.sourceItemId,
              entry.type,
              entry.messageId,
              entry.turnStart ? 1 : 0,
              entry.userTurn ? 1 : 0,
            ]),
          )})
        `;
        yield* sql`
          INSERT OR IGNORE INTO scient_fork_frozen_items (thread_id, position, item_json, message_json)
          SELECT fork.thread_id, fork.position, kept.item_json, kept.message_json
          FROM scient_fork_history AS fork
          JOIN scient_fork_history AS parent
            ON parent.source_thread_id = fork.source_thread_id
            AND parent.source_item_id = fork.source_item_id
          JOIN scient_fork_frozen_items AS kept
            ON kept.thread_id = parent.thread_id AND kept.position = parent.position
          WHERE fork.thread_id = ${threadId}
            AND parent.thread_id = (
              SELECT json_extract(payload_json, '$.lineage.parentThreadId')
              FROM orchestration_v2_projection_threads
              WHERE thread_id = ${threadId}
            )
        `;
      });

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
    readonly message_id: string | null;
    readonly turn_start: number;
    readonly user_turn: number;
  }>`
    SELECT position, source_thread_id, source_item_id, item_type, message_id, turn_start, user_turn
    FROM scient_fork_history
    WHERE thread_id = ${threadId}
    ORDER BY position
  `;
  return rows.map((row): ForkHistoryIndexRow => ({
    position: row.position,
    sourceThreadId: ThreadId.make(row.source_thread_id),
    sourceItemId: TurnItemId.make(row.source_item_id),
    type: row.item_type,
    messageId: row.message_id,
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
  // Read the run of positions the rows span, preferring a version kept for the fork.
  const byPosition = new Map(
    (yield* sql<{ readonly position: number; readonly payload_json: string | null }>`
      SELECT history.position, COALESCE(frozen.item_json, item.payload_json) AS payload_json
      FROM scient_fork_history AS history
      LEFT JOIN scient_fork_frozen_items AS frozen
        ON frozen.thread_id = history.thread_id AND frozen.position = history.position
      LEFT JOIN orchestration_v2_projection_turn_items AS item
        ON item.turn_item_id = history.source_item_id
      WHERE history.thread_id = ${threadId}
        AND history.position BETWEEN ${first} AND ${last}
    `).map((row) => [row.position, row.payload_json] as const),
  );
  const payloads = index.map((row) => byPosition.get(row.position) ?? null);
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
 * window rule (`readCanonicalProjection`) applied to the whole conversation:
 * the inherited rows, then the fork's own rows that `following` describes.
 * The window holds rows at or before the anchor, from the oldest of the last
 * `userTurnLimit + 2` user turns among the last `maxRawTurns + 2` turn starts,
 * or the last `rowLimit` rows when no user turn is in range.
 */
export function selectForkHistoryWindow(
  index: ReadonlyArray<ForkHistoryIndexRow>,
  window: {
    readonly rowLimit: number;
    readonly userTurnLimit?: number | undefined;
    readonly anchorItemId?: TurnItemId | undefined;
    readonly maxRawTurns: number;
  },
  following: ReadonlyArray<Pick<ForkHistoryEntry, "turnStart" | "userTurn">> = [],
): ReadonlyArray<ForkHistoryIndexRow> {
  if (window.rowLimit === 0) return [];
  const anchor =
    window.anchorItemId === undefined
      ? -1
      : index.findIndex((row) => row.sourceItemId === window.anchorItemId);
  const eligible: ReadonlyArray<Pick<ForkHistoryEntry, "turnStart" | "userTurn">> =
    anchor < 0 ? [...index, ...following] : index.slice(0, anchor + 1);
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
  const first = userTurns.length > 0 ? start : Math.max(start, eligible.length - window.rowLimit);
  const shown = anchor < 0 ? index.length : anchor + 1;
  return index.slice(Math.min(first, shown), shown);
}

/** Whether the thread is a fork with inherited history. */
/**
 * The conversations of a thread's lineage (same root), with whether each is
 * deleted and whether it is a fork. Forks share files across a lineage, so file
 * release looks at all of them.
 */
export const readForkFamily = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly thread_id: string; readonly deleted: number; readonly fork: number }>`
    SELECT member.thread_id,
      member.deleted_at IS NOT NULL AS deleted,
      json_extract(member.payload_json, '$.conversationFork') IS NOT NULL AS fork
    FROM orchestration_v2_projection_threads AS member
    WHERE json_extract(member.payload_json, '$.lineage.rootThreadId') = (
      SELECT json_extract(payload_json, '$.lineage.rootThreadId')
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId}
    )
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        threadId: ThreadId.make(row.thread_id),
        deleted: row.deleted === 1,
        fork: row.fork === 1,
      })),
    ),
  );

/** The files a fork shares from its history, recorded when it was accepted. */
export const readForkSharedFileIds = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly id: string | null }>`
    SELECT json_extract(copy.value, '$.source.id') AS id
    FROM orchestration_v2_projection_threads AS thread,
      json_each(thread.payload_json, '$.conversationFork.attachmentCopies') AS copy
    WHERE thread.thread_id = ${threadId}
  `.pipe(Effect.map((rows) => rows.flatMap((row) => (row.id === null ? [] : [row.id]))));

/** Files attached to the thread's own submitted question answers. */
export const readQuestionAnswerFileIds = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly id: string | null }>`
    SELECT DISTINCT json_extract(file.value, '$.id') AS id
    FROM orchestration_v2_projection_turn_items AS item,
      json_each(item.payload_json, '$.questionAnswer.attachmentsByQuestionId') AS answer,
      json_each(answer.value) AS file
    WHERE item.thread_id = ${threadId} AND item.type = 'user_input_request'
  `.pipe(Effect.map((rows) => rows.flatMap((row) => (row.id === null ? [] : [row.id]))));

/** Shown tool items that may name a stored page or app document. */
export const readForkShownToolPayloads = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  mcpAppOutputKey: string,
) =>
  sql<{ readonly payload_json: string }>`
    SELECT COALESCE(frozen.item_json, item.payload_json) AS payload_json
    FROM scient_fork_history AS history
    JOIN orchestration_v2_projection_turn_items AS item
      ON item.turn_item_id = history.source_item_id
    LEFT JOIN scient_fork_frozen_items AS frozen
      ON frozen.thread_id = history.thread_id AND frozen.position = history.position
    WHERE history.thread_id = ${threadId}
      AND history.item_type = 'dynamic_tool'
      AND (
        COALESCE(frozen.item_json, item.payload_json) LIKE '%htmlRender%'
        OR COALESCE(frozen.item_json, item.payload_json) LIKE ${`%${mcpAppOutputKey}%`}
      )
  `.pipe(Effect.map((rows) => rows.map((row) => row.payload_json)));

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
      LEFT JOIN scient_fork_frozen_items AS frozen
        ON frozen.thread_id = history.thread_id AND frozen.position = history.position
      WHERE history.source_thread_id = ${sourceThreadId}
        AND history.thread_id <> ${sourceThreadId}
        AND fork.deleted_at IS NULL
        AND instr(lower(COALESCE(frozen.item_json, item.payload_json)), ${id.toLowerCase()}) > 0
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0)),
  );

/**
 * Raw messages of the fork's history, in history order: the messages its user
 * and assistant rows stand for, as the fork shows them (a kept version first).
 * Shared rows only, unless `includeCopies`; narrow to a run of `positions`.
 */
export const readForkHistoryMessageRows = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  options: {
    readonly positions?: readonly [first: number, last: number];
    readonly includeCopies?: boolean;
  } = {},
) =>
  sql<{ readonly message_id: string; readonly payload_json: string | null }>`
    SELECT history.message_id, COALESCE(frozen.message_json, message.payload_json) AS payload_json
    FROM scient_fork_history AS history
    LEFT JOIN scient_fork_frozen_items AS frozen
      ON frozen.thread_id = history.thread_id AND frozen.position = history.position
    LEFT JOIN orchestration_v2_projection_messages AS message
      ON message.message_id = history.message_id
    WHERE history.thread_id = ${threadId}
      AND history.message_id IS NOT NULL
      ${options.includeCopies === true ? sql`` : sql`AND history.source_thread_id <> ${threadId}`}
      ${
        options.positions === undefined
          ? sql``
          : sql`AND history.position BETWEEN ${options.positions[0]} AND ${options.positions[1]}`
      }
    ORDER BY history.position
  `.pipe(
    Effect.map((rows) => {
      const seen = new Set<string>();
      return rows.flatMap((row) =>
        row.payload_json === null || seen.has(row.message_id)
          ? []
          : (seen.add(row.message_id),
            [{ message_id: row.message_id, payload_json: row.payload_json }]),
      );
    }),
  );

/** How many distinct messages the fork's shared history shows. */
export const countForkHistoryMessages = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly count: number }>`
    SELECT COUNT(DISTINCT message_id) AS count FROM scient_fork_history
    WHERE thread_id = ${threadId} AND message_id IS NOT NULL AND source_thread_id <> ${threadId}
  `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

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
