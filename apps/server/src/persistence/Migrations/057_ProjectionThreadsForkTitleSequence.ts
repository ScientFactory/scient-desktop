// FILE: 057_ProjectionThreadsForkTitleSequence.ts
// Purpose: Persist automatic fork-title series metadata and preserve legacy fork order.
// Layer: Server persistence migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

interface ThreadCreatedRow {
  readonly sequence: number;
  readonly threadId: string;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly forkSourceThreadId: string | null;
  readonly sidechatSourceThreadId: string | null;
  readonly forkTitleBase: string | null;
  readonly forkTitleOrdinal: number | null;
  readonly currentProjectionTitle?: string | null;
  readonly hasHistoricalTitleChange?: number;
}

const familyRootId = (
  row: ThreadCreatedRow,
  rowsByThreadId: ReadonlyMap<string, ThreadCreatedRow>,
): string => {
  let current = row;
  const visited = new Set<string>();

  while (current.forkSourceThreadId && current.hasHistoricalTitleChange !== 1) {
    if (visited.has(current.threadId)) {
      return [...visited, current.threadId].toSorted()[0] ?? current.threadId;
    }
    visited.add(current.threadId);
    const source = rowsByThreadId.get(current.forkSourceThreadId);
    if (!source) {
      return current.forkSourceThreadId;
    }
    current = source;
  }

  return current.threadId;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "fork_title_base"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_title_base TEXT
    `;
  }
  if (!(yield* columnExists(sql, "projection_threads", "fork_title_ordinal"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_title_ordinal INTEGER
    `;
  }

  const createdRows = yield* sql<ThreadCreatedRow>`
    SELECT
      created_event.sequence,
      created_event.stream_id AS "threadId",
      json_extract(created_event.payload_json, '$.projectId') AS "projectId",
      json_extract(created_event.payload_json, '$.title') AS title,
      json_extract(created_event.payload_json, '$.forkSourceThreadId') AS "forkSourceThreadId",
      json_extract(created_event.payload_json, '$.sidechatSourceThreadId') AS "sidechatSourceThreadId",
      json_extract(created_event.payload_json, '$.forkTitleBase') AS "forkTitleBase",
      json_extract(created_event.payload_json, '$.forkTitleOrdinal') AS "forkTitleOrdinal",
      (
        SELECT projection_threads.title
        FROM projection_threads
        WHERE projection_threads.thread_id = created_event.stream_id
      ) AS "currentProjectionTitle",
      EXISTS (
        SELECT 1
        FROM orchestration_events AS renamed_event
        WHERE renamed_event.stream_id = created_event.stream_id
          AND renamed_event.sequence > created_event.sequence
          AND renamed_event.event_type = 'thread.meta-updated'
          AND json_valid(renamed_event.payload_json)
          AND json_type(renamed_event.payload_json, '$.title') = 'text'
          AND json_extract(renamed_event.payload_json, '$.title')
            <> json_extract(created_event.payload_json, '$.title')
      ) AS "hasHistoricalTitleChange"
    FROM orchestration_events AS created_event
    WHERE created_event.event_type = 'thread.created'
      AND json_valid(created_event.payload_json)
    ORDER BY created_event.sequence ASC
  `;
  const rowsByThreadId = new Map(createdRows.map((row) => [row.threadId, row]));
  const highestOrdinalBySeries = new Map<string, number>();

  for (const row of createdRows) {
    if (
      !row.projectId ||
      !row.title ||
      !row.forkSourceThreadId ||
      row.sidechatSourceThreadId ||
      row.hasHistoricalTitleChange === 1 ||
      (row.currentProjectionTitle !== null &&
        row.currentProjectionTitle !== undefined &&
        row.currentProjectionTitle !== row.title)
    ) {
      continue;
    }

    const rootId = familyRootId(row, rowsByThreadId);
    const hasStoredSeries =
      row.forkTitleBase !== null &&
      Number.isSafeInteger(row.forkTitleOrdinal) &&
      (row.forkTitleOrdinal ?? 0) >= 2;
    const forkTitleBase = hasStoredSeries ? row.forkTitleBase! : row.title;
    const seriesKey = JSON.stringify([row.projectId, rootId, forkTitleBase]);
    const highestOrdinal = highestOrdinalBySeries.get(seriesKey) ?? 1;
    const forkTitleOrdinal = hasStoredSeries ? row.forkTitleOrdinal! : highestOrdinal + 1;
    highestOrdinalBySeries.set(seriesKey, Math.max(highestOrdinal, forkTitleOrdinal));

    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(
        payload_json,
        '$.forkTitleBase',
        ${forkTitleBase},
        '$.forkTitleOrdinal',
        ${forkTitleOrdinal}
      )
      WHERE sequence = ${row.sequence}
    `;
    yield* sql`
      UPDATE projection_threads
      SET
        fork_title_base = ${forkTitleBase},
        fork_title_ordinal = ${forkTitleOrdinal}
      WHERE thread_id = ${row.threadId}
    `;
  }

  // Some older databases deliberately retain projection-only thread history when
  // their original event is unavailable. Give those forks stable metadata too so
  // a future fork cannot reuse an already-visible ordinal.
  const projectionRows = yield* sql<ThreadCreatedRow>`
    SELECT
      0 AS sequence,
      thread_id AS "threadId",
      project_id AS "projectId",
      title,
      fork_source_thread_id AS "forkSourceThreadId",
      sidechat_source_thread_id AS "sidechatSourceThreadId",
      fork_title_base AS "forkTitleBase",
      fork_title_ordinal AS "forkTitleOrdinal"
    FROM projection_threads
    ORDER BY created_at ASC, thread_id ASC
  `;
  const projectionRowsByThreadId = new Map(projectionRows.map((row) => [row.threadId, row]));
  const eventBackedThreadIds = new Set(createdRows.map((row) => row.threadId));
  const projectionHighestOrdinalBySeries = new Map<string, number>();

  for (const row of projectionRows) {
    if (
      !row.projectId ||
      !row.forkSourceThreadId ||
      row.sidechatSourceThreadId ||
      row.forkTitleBase === null ||
      !Number.isSafeInteger(row.forkTitleOrdinal) ||
      (row.forkTitleOrdinal ?? 0) < 2
    ) {
      continue;
    }
    const seriesKey = JSON.stringify([
      row.projectId,
      familyRootId(row, projectionRowsByThreadId),
      row.forkTitleBase,
    ]);
    projectionHighestOrdinalBySeries.set(
      seriesKey,
      Math.max(projectionHighestOrdinalBySeries.get(seriesKey) ?? 1, row.forkTitleOrdinal!),
    );
  }

  for (const row of projectionRows) {
    if (
      !row.projectId ||
      !row.title ||
      !row.forkSourceThreadId ||
      row.sidechatSourceThreadId ||
      eventBackedThreadIds.has(row.threadId) ||
      (row.forkTitleBase !== null &&
        Number.isSafeInteger(row.forkTitleOrdinal) &&
        (row.forkTitleOrdinal ?? 0) >= 2)
    ) {
      continue;
    }

    const rootId = familyRootId(row, projectionRowsByThreadId);
    const seriesKey = JSON.stringify([row.projectId, rootId, row.title]);
    const forkTitleOrdinal = (projectionHighestOrdinalBySeries.get(seriesKey) ?? 1) + 1;
    projectionHighestOrdinalBySeries.set(seriesKey, forkTitleOrdinal);
    yield* sql`
      UPDATE projection_threads
      SET
        fork_title_base = ${row.title},
        fork_title_ordinal = ${forkTitleOrdinal}
      WHERE thread_id = ${row.threadId}
    `;
  }
});
