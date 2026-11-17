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

class RangeSourceNotConverted extends Schema.TaggedError<RangeSourceNotConverted>()(
  "RangeSourceNotConverted",
  { sourceId: Schema.String, reason: Schema.String },
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

const BACKFILL_PAGE = 4096;

type ClassifiedRow = HandoffHistoryRow & { readonly matches: number };

/** A source's per-item rows from `from` on, each marked by whether the fork's history holds it. */
const classifiedRows = (
  sql: SqlClient.SqlClient,
  sourceId: string,
  from: number,
  limit: number | undefined,
) => sql<ClassifiedRow>`
  SELECT history.source_id, history.position, history.view_thread_id, history.source_thread_id,
    history.source_item_id, history.fork_position, history.run_status, history.body_id,
    fork.thread_id IS NOT NULL AS matches
  FROM scient_handoff_history AS history
  LEFT JOIN scient_fork_history AS fork ON fork.thread_id = history.view_thread_id
    AND fork.position = history.fork_position
    AND fork.source_thread_id = history.source_thread_id
    AND fork.source_item_id = history.source_item_id
  WHERE history.source_id = ${sourceId} AND history.position > ${from}
  ORDER BY history.position ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}`;

/** A row shaped like an inherited position that the fork's history does not hold as stored. */
const malformed = (row: ClassifiedRow) => inRange(row) && row.matches === 0;

/** Whether any per-item row of a source sits inside one of its ranges: one seek per range. */
const overlapsRanges = (sql: SqlClient.SqlClient, sourceId: string) =>
  sql`
    SELECT 1 FROM scient_handoff_history_ranges AS span
    JOIN scient_handoff_history AS history ON history.source_id = span.source_id
      AND history.position BETWEEN span.position AND span.position + span.item_count - 1
    WHERE span.source_id = ${sourceId} LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

/** Converts per-item rows written before ranges. A source qualifies only if every page of it is well
 * formed, then switches in short batches that each read back row for row or roll back; the first
 * batch that does not stops that source. A source that does not qualify stays exactly as it is. */
export const convertForkHandoffHistory = Effect.fn("ForkHandoffRanges.convertAll")(function* (
  sql: SqlClient.SqlClient,
  between: Effect.Effect<void>,
  batchSize = BACKFILL_PAGE,
) {
  const counts = { ranges: 0, rows: 0, skippedSources: 0 };
  let after = "";
  while (true) {
    const next = yield* sql<{ readonly source_id: string }>`
      SELECT source_id FROM scient_handoff_history WHERE source_id > ${after}
      ORDER BY source_id LIMIT 1`;
    if (next[0] === undefined) return counts;
    const sourceId = next[0].source_id;
    after = sourceId;
    let candidates = 0;
    let wellFormed = !(yield* overlapsRanges(sql, sourceId));
    for (let from = -1; wellFormed;) {
      const page = yield* classifiedRows(sql, sourceId, from, batchSize);
      for (const row of page) {
        if (malformed(row)) wellFormed = false;
        else if (inRange(row)) candidates++;
      }
      yield* between;
      if (page.length < batchSize) break;
      from = page.at(-1)!.position;
    }
    if (!wellFormed) {
      counts.skippedSources++;
      yield* Effect.logWarning("Fork handoff history was left as rows", {
        sourceId,
        reason: "a row does not match the fork's history or overlaps a range",
      });
      continue;
    }
    if (candidates === 0) continue;
    for (let from = -1; ;) {
      const batch = yield* Effect.gen(function* () {
        const rows = yield* classifiedRows(sql, sourceId, from, batchSize);
        if (rows.some(malformed))
          return yield* new RangeSourceNotConverted({
            sourceId,
            reason: "changed while converting",
          });
        let { ranges } = splitHandoffHistory(rows.filter(inRange));
        // A full batch may cut its last range short; the next batch starts at that range instead.
        if (rows.length === batchSize && ranges.length > 1) ranges = ranges.slice(0, -1);
        const end =
          rows.length < batchSize
            ? Number.MAX_SAFE_INTEGER
            : (ranges.at(-1)?.rows.at(-1)?.position ?? rows.at(-1)!.position);
        if (ranges.length === 0) return { ranges, end };
        const window = sql<HandoffHistoryRow>`
          SELECT * FROM (${handoffHistoryRowsSql(sql, sql`${sourceId}`, [
            ranges[0]!.position,
            ranges.at(-1)!.rows.at(-1)!.position,
          ])}) ORDER BY position`;
        const before = yield* window;
        yield* insertRanges(sql, ranges);
        for (const range of ranges)
          yield* sql`
            DELETE FROM scient_handoff_history
            WHERE source_id = ${sourceId}
              AND position BETWEEN ${range.position} AND ${range.position + range.item_count - 1}`;
        const back = yield* window;
        if (back.length !== before.length || before.some((row, at) => !sameRow(row, back[at])))
          return yield* new RangeSourceNotConverted({ sourceId, reason: "read back differently" });
        return { ranges, end };
      }).pipe(
        sql.withTransaction,
        Effect.catchCause((cause) =>
          Effect.logWarning("Fork handoff history was left as rows", { sourceId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      yield* between;
      if (batch === null) {
        counts.skippedSources++;
        break;
      }
      counts.ranges += batch.ranges.length;
      counts.rows += batch.ranges.reduce((sum, range) => sum + range.item_count, 0);
      if (batch.end === Number.MAX_SAFE_INTEGER) break;
      from = batch.end;
    }
  }
});
