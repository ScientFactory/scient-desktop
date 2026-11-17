/** SCIENT-OWNED. A handoff's run of inherited fork positions is stored as one range that
 * readers expand through the fork's own history list, instead of one row per item. A range
 * row stands for exactly the per-item rows it replaces: inherited, no run status, no kept
 * body. Those rows are fully determined by the fork's history, which is never rewritten. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface HandoffHistoryRow {
  readonly source_id: string;
  readonly position: number;
  readonly view_thread_id: string;
  readonly source_thread_id: string;
  readonly source_item_id: string;
  readonly fork_position: number | null;
  readonly run_status: string | null;
  readonly body_id: string | null;
}

interface HandoffHistoryRange {
  readonly source_id: string;
  readonly position: number;
  readonly item_count: number;
  readonly view_thread_id: string;
  readonly fork_position: number;
}

const inRange = (row: HandoffHistoryRow) =>
  row.fork_position !== null &&
  row.run_status === null &&
  row.body_id === null &&
  row.source_thread_id !== row.view_thread_id;

/** Splits rows ordered by source and position into ranges and the rows that stay per item. */
export const splitHandoffHistory = (rows: ReadonlyArray<HandoffHistoryRow>) => {
  const items: Array<HandoffHistoryRow> = [];
  const ranges: Array<{ first: HandoffHistoryRow; rows: Array<HandoffHistoryRow> }> = [];
  let open: (typeof ranges)[number] | undefined;
  for (const row of rows) {
    if (!inRange(row)) {
      items.push(row);
      open = undefined;
      continue;
    }
    const last = open?.rows.at(-1);
    if (
      open !== undefined &&
      last !== undefined &&
      last.source_id === row.source_id &&
      last.view_thread_id === row.view_thread_id &&
      last.position + 1 === row.position &&
      last.fork_position! + 1 === row.fork_position
    ) {
      open.rows.push(row);
      continue;
    }
    open = { first: row, rows: [row] };
    ranges.push(open);
  }
  return {
    items,
    ranges: ranges.map(
      ({ first, rows: members }): HandoffHistoryRange & { readonly rows: typeof members } => ({
        source_id: first.source_id,
        position: first.position,
        item_count: members.length,
        view_thread_id: first.view_thread_id,
        fork_position: first.fork_position!,
        rows: members,
      }),
    ),
  };
};

/**
 * Every row of a source, ranges expanded, with scient_handoff_history's columns. `positions`
 * limits the result to [first, last]. Range starts are found by the greatest start at or
 * before `first`, so a single-position read stays an index seek.
 */
export const handoffHistoryRowsSql = (
  sql: SqlClient.SqlClient,
  sourceId: Statement.Fragment,
  positions?: readonly [first: number, last: number],
) => sql`
  SELECT source_id, position, view_thread_id, source_thread_id, source_item_id, fork_position,
    run_status, body_id
  FROM scient_handoff_history WHERE source_id = ${sourceId}
    ${positions === undefined ? sql`` : sql`AND position BETWEEN ${positions[0]} AND ${positions[1]}`}
  UNION ALL
  SELECT span.source_id, span.position + fork.position - span.fork_position, span.view_thread_id,
    fork.source_thread_id, fork.source_item_id, fork.position, NULL, NULL
  FROM scient_handoff_history_ranges AS span
  JOIN scient_fork_history AS fork ON fork.thread_id = span.view_thread_id
    AND fork.position BETWEEN span.fork_position AND span.fork_position + span.item_count - 1
    ${
      positions === undefined
        ? sql``
        : sql`AND fork.position BETWEEN span.fork_position + ${positions[0]} - span.position
            AND span.fork_position + ${positions[1]} - span.position`
    }
  WHERE span.source_id = ${sourceId}
    ${
      positions === undefined
        ? sql``
        : sql`AND span.position BETWEEN COALESCE((SELECT MAX(position) FROM scient_handoff_history_ranges
            WHERE source_id = ${sourceId} AND position <= ${positions[0]}), ${positions[0]}) AND ${positions[1]}`
    }
`;

export const hasHandoffHistory = (sql: SqlClient.SqlClient, sourceId: string) =>
  sql`
    SELECT 1 FROM scient_handoff_history WHERE source_id = ${sourceId}
    UNION ALL SELECT 1 FROM scient_handoff_history_ranges WHERE source_id = ${sourceId}
    LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

/** Writes rows ordered by position, with inherited runs as ranges, in the caller's transaction. */
export const writeHandoffHistory = Effect.fn("ForkHandoffRanges.write")(function* (
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<HandoffHistoryRow>,
) {
  const { items, ranges } = splitHandoffHistory(rows);
  if (items.length > 0)
    yield* sql`
      INSERT OR IGNORE INTO scient_handoff_history
        (source_id, position, view_thread_id, source_thread_id, source_item_id, fork_position,
          run_status, body_id)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
        json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'),
        json_extract(value, '$[6]'), json_extract(value, '$[7]')
      FROM json_each(${encodeJson(
        items.map((row) => [
          row.source_id,
          row.position,
          row.view_thread_id,
          row.source_thread_id,
          row.source_item_id,
          row.fork_position,
          row.run_status,
          row.body_id,
        ]),
      )})`;
  if (ranges.length > 0) yield* insertRanges(sql, ranges);
  return { items: items.length, ranges };
});

const insertRanges = (sql: SqlClient.SqlClient, ranges: ReadonlyArray<HandoffHistoryRange>) =>
  sql`
    INSERT INTO scient_handoff_history_ranges
      (source_id, position, item_count, view_thread_id, fork_position)
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
      json_extract(value, '$[3]'), json_extract(value, '$[4]')
    FROM json_each(${encodeJson(
      ranges.map((range) => [
        range.source_id,
        range.position,
        range.item_count,
        range.view_thread_id,
        range.fork_position,
      ]),
    )})`;

/**
 * Before a handoff freezes a body for a rewritten item, ranges showing that item return to
 * per-item rows, so the kept body has a row to belong to. A fork keeps its own version of an
 * inherited item before any rewrite, so this runs only when that version is missing.
 */
export const expandRangesShowing = Effect.fn("ForkHandoffRanges.expandShowing")(function* (
  sql: SqlClient.SqlClient,
  sourceThreadId: string,
  sourceItemId: string,
) {
  const spans = yield* sql<{ readonly source_id: string; readonly position: number }>`
    SELECT DISTINCT span.source_id, span.position
    FROM scient_fork_history AS fork
    JOIN scient_handoff_history_ranges AS span ON span.view_thread_id = fork.thread_id
      AND span.fork_position <= fork.position AND fork.position < span.fork_position + span.item_count
    WHERE fork.source_thread_id = ${sourceThreadId} AND fork.source_item_id = ${sourceItemId}
      AND NOT EXISTS (SELECT 1 FROM scient_fork_frozen_items AS frozen
        WHERE frozen.thread_id = fork.thread_id AND frozen.position = fork.position)
      AND EXISTS (SELECT 1 FROM scient_handoff_projection_sources AS projected
        WHERE projected.source_id = span.source_id)`;
  for (const span of spans) {
    const [range] = yield* sql<{ readonly item_count: number }>`
      SELECT item_count FROM scient_handoff_history_ranges
      WHERE source_id = ${span.source_id} AND position = ${span.position}`;
    if (range === undefined) continue;
    yield* sql`
      INSERT INTO scient_handoff_history
        (source_id, position, view_thread_id, source_thread_id, source_item_id, fork_position,
          run_status, body_id)
      ${handoffHistoryRowsSql(sql, sql`${span.source_id}`, [
        span.position,
        span.position + range.item_count - 1,
      ])}`;
    yield* sql`
      DELETE FROM scient_handoff_history_ranges
      WHERE source_id = ${span.source_id} AND position = ${span.position}`;
  }
});

class RangeReadBackMismatch extends Schema.TaggedError<RangeReadBackMismatch>()(
  "RangeReadBackMismatch",
  { sourceId: Schema.String, position: Schema.Number },
) {}

const sameRow = (a: HandoffHistoryRow, b: HandoffHistoryRow | undefined) =>
  b !== undefined &&
  a.source_id === b.source_id &&
  a.position === b.position &&
  a.view_thread_id === b.view_thread_id &&
  a.source_thread_id === b.source_thread_id &&
  a.source_item_id === b.source_item_id &&
  a.fork_position === b.fork_position &&
  a.run_status === b.run_status &&
  a.body_id === b.body_id;

const BACKFILL_BATCH = 4096;

const convertibleRowsSql = (sql: SqlClient.SqlClient) => sql`
  FROM scient_handoff_history AS history
  JOIN scient_fork_history AS fork ON fork.thread_id = history.view_thread_id
    AND fork.position = history.fork_position
    AND fork.source_thread_id = history.source_thread_id
    AND fork.source_item_id = history.source_item_id
  WHERE history.run_status IS NULL AND history.body_id IS NULL
    AND history.source_thread_id <> history.view_thread_id`;

/**
 * Background conversion of per-item rows written before ranges existed. Each batch is one short
 * transaction over one source: candidate rows must match the fork's history, and every range must
 * read back through the readers' own expansion exactly as the rows it replaces, or the batch rolls
 * back and that source stays per item until a later pass. Progress is the tables themselves.
 */
export const convertForkHandoffHistory = Effect.fn("ForkHandoffRanges.convertAll")(function* (
  sql: SqlClient.SqlClient,
  between: Effect.Effect<void>,
  batchSize = BACKFILL_BATCH,
) {
  const counts = { ranges: 0, rows: 0, skippedSources: 0 };
  let after: readonly [string, number] = ["", -1];
  while (true) {
    const next = yield* sql<{ readonly source_id: string }>`
      SELECT history.source_id ${convertibleRowsSql(sql)}
        AND (history.source_id, history.position) > (${after[0]}, ${after[1]})
      ORDER BY history.source_id, history.position LIMIT 1`;
    if (next[0] === undefined) return counts;
    const sourceId = next[0].source_id;
    const from = sourceId === after[0] ? after[1] : -1;
    // Rows are read on the writer inside the transaction, so no freeze can land in between.
    const converted = yield* Effect.gen(function* () {
      const rows = yield* sql<HandoffHistoryRow>`
        SELECT history.source_id, history.position, history.view_thread_id,
          history.source_thread_id, history.source_item_id, history.fork_position,
          history.run_status, history.body_id
        ${convertibleRowsSql(sql)}
          AND history.source_id = ${sourceId} AND history.position > ${from}
        ORDER BY history.position LIMIT ${batchSize}`;
      let { ranges } = splitHandoffHistory(rows);
      // A full batch may cut its last range short; the next batch starts at that range instead.
      if (rows.length === batchSize && ranges.length > 1) ranges = ranges.slice(0, -1);
      if (ranges.length === 0) return undefined;
      yield* insertRanges(sql, ranges);
      for (const range of ranges) {
        yield* sql`
          DELETE FROM scient_handoff_history
          WHERE source_id = ${range.source_id}
            AND position BETWEEN ${range.position} AND ${range.position + range.item_count - 1}`;
        const back = yield* sql<HandoffHistoryRow>`
          SELECT * FROM (${handoffHistoryRowsSql(sql, sql`${range.source_id}`, [
            range.position,
            range.position + range.item_count - 1,
          ])}) ORDER BY position`;
        if (back.length !== range.rows.length)
          return yield* new RangeReadBackMismatch({ sourceId, position: range.position });
        for (const [at, row] of range.rows.entries())
          if (!sameRow(row, back[at]))
            return yield* new RangeReadBackMismatch({ sourceId, position: row.position });
      }
      return ranges;
    }).pipe(
      sql.withTransaction,
      Effect.catchCause((cause) =>
        Effect.logWarning("Fork handoff history was left as rows", { sourceId, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
    if (converted === null) {
      counts.skippedSources++;
      // Skip the rest of a source that did not verify; a later pass retries it.
      after = [sourceId, Number.MAX_SAFE_INTEGER];
    } else if (converted === undefined) {
      after = [sourceId, Number.MAX_SAFE_INTEGER];
    } else {
      counts.ranges += converted.length;
      counts.rows += converted.reduce((sum, range) => sum + range.item_count, 0);
      after = [sourceId, converted.at(-1)!.rows.at(-1)!.position];
    }
    yield* between;
  }
});
