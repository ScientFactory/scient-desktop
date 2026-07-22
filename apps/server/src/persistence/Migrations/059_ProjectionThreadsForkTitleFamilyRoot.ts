// FILE: 059_ProjectionThreadsForkTitleFamilyRoot.ts
// Purpose: Freeze fork-title family identity so later ancestor renames cannot renumber descendants.
// Layer: Server persistence migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import reconcileForkTitleSequence from "./057_ProjectionThreadsForkTitleSequence.ts";
import { columnExists } from "./schemaHelpers.ts";

interface ForkTitleEventRow {
  readonly sequence: number;
  readonly eventType: "thread.created" | "thread.meta-updated";
  readonly threadId: string;
  readonly title: string | null;
  readonly projectId: string | null;
  readonly forkSourceThreadId: string | null;
  readonly sidechatSourceThreadId: string | null;
  readonly forkTitleFamilyRootId: string | null;
  readonly forkTitleBase: string | null;
  readonly forkTitleOrdinal: number | null;
  readonly currentProjectionTitle: string | null;
}

interface EventThreadState {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly createdTitle: string;
  readonly forkSourceThreadId: string | null;
  currentTitle: string;
  hasChangedTitle: boolean;
  automaticBase: string | null;
  automaticOrdinal: number | null;
  familyRootId: string | null;
}

interface ProjectionThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly forkSourceThreadId: string | null;
  readonly sidechatSourceThreadId: string | null;
  readonly forkTitleFamilyRootId: string | null;
  readonly forkTitleBase: string | null;
  readonly forkTitleOrdinal: number | null;
}

function isAutomaticFork(input: {
  readonly forkSourceThreadId: string | null;
  readonly sidechatSourceThreadId: string | null;
  readonly forkTitleBase: string | null;
  readonly forkTitleOrdinal: number | null;
}): boolean {
  return (
    input.forkSourceThreadId !== null &&
    input.sidechatSourceThreadId === null &&
    input.forkTitleBase !== null &&
    Number.isSafeInteger(input.forkTitleOrdinal) &&
    (input.forkTitleOrdinal ?? 0) >= 2
  );
}

function isGeneratedTitle(title: string, base: string): boolean {
  if (!title.startsWith(`${base} (`) || !title.endsWith(")")) {
    return false;
  }
  const ordinalText = title.slice(base.length + 2, -1);
  const ordinal = Number(ordinalText);
  return Number.isSafeInteger(ordinal) && ordinal >= 2 && String(ordinal) === ordinalText;
}

function inferGeneratedForkSeries(input: {
  readonly title: string;
  readonly forkSourceThreadId: string | null;
  readonly sidechatSourceThreadId: string | null;
  readonly statesByThreadId: ReadonlyMap<string, EventThreadState>;
}): { readonly base: string; readonly ordinal: number } | null {
  if (!input.forkSourceThreadId || input.sidechatSourceThreadId) {
    return null;
  }
  const source = input.statesByThreadId.get(input.forkSourceThreadId);
  if (!source) {
    return null;
  }
  const base = source.automaticBase ?? source.currentTitle;
  if (!input.title.startsWith(`${base} (`) || !input.title.endsWith(")")) {
    return null;
  }
  const ordinalText = input.title.slice(base.length + 2, -1);
  const ordinal = Number(ordinalText);
  return Number.isSafeInteger(ordinal) && ordinal >= 2 && String(ordinal) === ordinalText
    ? { base, ordinal }
    : null;
}

function inferLegacyForkSeries(input: {
  readonly title: string;
  readonly forkSourceThreadId: string | null;
  readonly sidechatSourceThreadId: string | null;
  readonly statesByThreadId: ReadonlyMap<string, EventThreadState>;
}): { readonly base: string } | null {
  if (!input.forkSourceThreadId || input.sidechatSourceThreadId) {
    return null;
  }
  const source = input.statesByThreadId.get(input.forkSourceThreadId);
  if (!source || input.title !== source.currentTitle) {
    return null;
  }
  return { base: source.automaticBase ?? source.currentTitle };
}

function resolveEventFamilyRoot(input: {
  readonly sourceThreadId: string;
  readonly forkTitleBase: string;
  readonly statesByThreadId: ReadonlyMap<string, EventThreadState>;
}): string {
  const source = input.statesByThreadId.get(input.sourceThreadId);
  if (!source) {
    return input.sourceThreadId;
  }
  if (source.automaticBase === input.forkTitleBase && source.familyRootId) {
    return source.familyRootId;
  }
  if (
    !source.hasChangedTitle &&
    source.forkSourceThreadId &&
    isGeneratedTitle(source.createdTitle, input.forkTitleBase)
  ) {
    return resolveEventFamilyRoot({
      sourceThreadId: source.forkSourceThreadId,
      forkTitleBase: input.forkTitleBase,
      statesByThreadId: input.statesByThreadId,
    });
  }
  return source.threadId;
}

function resolveProjectionOnlyFamilyRoot(
  row: ProjectionThreadRow,
  rowsByThreadId: ReadonlyMap<string, ProjectionThreadRow>,
): string {
  let current = row;
  const visited = new Set<string>();
  while (current.forkSourceThreadId) {
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
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "fork_title_family_root_id"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_title_family_root_id TEXT
    `;
  }

  // Some development databases completed an earlier migration 058 that
  // cleared automatic metadata even for a no-op title update. Re-run the
  // corrected, idempotent legacy allocator first; the event-sequential pass
  // below then repairs generated suffixes against their source family.
  yield* reconcileForkTitleSequence;

  const eventRows = yield* sql<ForkTitleEventRow>`
    SELECT
      sequence,
      event_type AS "eventType",
      stream_id AS "threadId",
      json_extract(payload_json, '$.title') AS title,
      json_extract(payload_json, '$.projectId') AS "projectId",
      json_extract(payload_json, '$.forkSourceThreadId') AS "forkSourceThreadId",
      json_extract(payload_json, '$.sidechatSourceThreadId') AS "sidechatSourceThreadId",
      json_extract(payload_json, '$.forkTitleFamilyRootId') AS "forkTitleFamilyRootId",
      json_extract(payload_json, '$.forkTitleBase') AS "forkTitleBase",
      json_extract(payload_json, '$.forkTitleOrdinal') AS "forkTitleOrdinal",
      (
        SELECT projection_threads.title
        FROM projection_threads
        WHERE projection_threads.thread_id = orchestration_events.stream_id
      ) AS "currentProjectionTitle"
    FROM orchestration_events
    WHERE event_type IN ('thread.created', 'thread.meta-updated')
      AND json_valid(payload_json)
    ORDER BY sequence ASC
  `;
  const statesByThreadId = new Map<string, EventThreadState>();
  const eventBackedThreadIds = new Set<string>();
  const highestOrdinalBySeries = new Map<string, number>();
  const finalEventTitleByThreadId = new Map<string, string>();
  for (const row of eventRows) {
    if (row.title !== null) {
      finalEventTitleByThreadId.set(row.threadId, row.title);
    }
  }

  for (const row of eventRows) {
    if (row.eventType === "thread.meta-updated") {
      const state = statesByThreadId.get(row.threadId);
      if (state && row.title !== null && row.title !== state.currentTitle) {
        state.currentTitle = row.title;
        state.hasChangedTitle = true;
        state.automaticBase = null;
        state.automaticOrdinal = null;
        state.familyRootId = null;
      }
      continue;
    }

    if (row.title === null) {
      continue;
    }
    eventBackedThreadIds.add(row.threadId);
    const inferredSeries = inferGeneratedForkSeries({
      title: row.title,
      forkSourceThreadId: row.forkSourceThreadId,
      sidechatSourceThreadId: row.sidechatSourceThreadId,
      statesByThreadId,
    });
    const hasUnrecordedProjectionRename =
      row.currentProjectionTitle !== null &&
      row.currentProjectionTitle !== finalEventTitleByThreadId.get(row.threadId);
    const legacySeries = hasUnrecordedProjectionRename
      ? null
      : inferLegacyForkSeries({
          title: row.title,
          forkSourceThreadId: row.forkSourceThreadId,
          sidechatSourceThreadId: row.sidechatSourceThreadId,
          statesByThreadId,
        });
    const automatic = isAutomaticFork(row) || inferredSeries !== null || legacySeries !== null;
    const automaticBase =
      legacySeries?.base ?? inferredSeries?.base ?? (automatic ? row.forkTitleBase : null);
    const familyRootId = automatic
      ? ((legacySeries === null ? row.forkTitleFamilyRootId : null) ??
        resolveEventFamilyRoot({
          sourceThreadId: row.forkSourceThreadId!,
          forkTitleBase: automaticBase!,
          statesByThreadId,
        }))
      : null;
    const seriesKey = automatic
      ? JSON.stringify([row.projectId, familyRootId, automaticBase])
      : null;
    const highestOrdinal = seriesKey ? (highestOrdinalBySeries.get(seriesKey) ?? 1) : 1;
    const automaticOrdinal = legacySeries
      ? highestOrdinal + 1
      : (inferredSeries?.ordinal ?? (automatic ? row.forkTitleOrdinal : null));
    if (seriesKey && automaticOrdinal !== null) {
      highestOrdinalBySeries.set(seriesKey, Math.max(highestOrdinal, automaticOrdinal));
    }
    statesByThreadId.set(row.threadId, {
      threadId: row.threadId,
      projectId: row.projectId,
      createdTitle: row.title,
      forkSourceThreadId: row.forkSourceThreadId,
      currentTitle: row.title,
      hasChangedTitle: false,
      automaticBase,
      automaticOrdinal,
      familyRootId,
    });

    if (familyRootId) {
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(
          payload_json,
          '$.forkTitleFamilyRootId',
          ${familyRootId},
          '$.forkTitleBase',
          ${automaticBase},
          '$.forkTitleOrdinal',
          ${automaticOrdinal}
        )
        WHERE sequence = ${row.sequence}
      `;
    }
  }

  for (const state of statesByThreadId.values()) {
    yield* sql`
      UPDATE projection_threads
      SET
        fork_title_family_root_id = ${state.familyRootId},
        fork_title_base = ${state.automaticBase},
        fork_title_ordinal = ${state.automaticOrdinal}
      WHERE thread_id = ${state.threadId}
    `;
  }

  // Projection-only legacy rows have no event timeline from which to distinguish
  // rename timing. Freeze them deterministically at their topmost known fork
  // ancestor. This avoids runtime regrouping and ordinal reuse if titles change.
  const projectionRows = yield* sql<ProjectionThreadRow>`
    SELECT
      thread_id AS "threadId",
      project_id AS "projectId",
      title,
      fork_source_thread_id AS "forkSourceThreadId",
      sidechat_source_thread_id AS "sidechatSourceThreadId",
      fork_title_family_root_id AS "forkTitleFamilyRootId",
      fork_title_base AS "forkTitleBase",
      fork_title_ordinal AS "forkTitleOrdinal"
    FROM projection_threads
    ORDER BY created_at ASC, thread_id ASC
  `;
  const projectionRowsByThreadId = new Map(
    projectionRows.map((row) => [row.threadId, row] as const),
  );
  for (const row of projectionRows) {
    if (eventBackedThreadIds.has(row.threadId) || !isAutomaticFork(row)) {
      continue;
    }
    const familyRootId =
      row.forkTitleFamilyRootId ?? resolveProjectionOnlyFamilyRoot(row, projectionRowsByThreadId);
    yield* sql`
      UPDATE projection_threads
      SET fork_title_family_root_id = ${familyRootId}
      WHERE thread_id = ${row.threadId}
    `;
  }
});
