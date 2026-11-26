/** SCIENT-OWNED. What T3's deleted-thread purge must also know about Scient's history owners. */
import type * as SqlClient from "effect/sql/SqlClient";

/** Whether a deleted thread still holds a Scient fork's frozen copies of what it showed. */
export const scientHoldsDeletedThreadContent = (sql: SqlClient.SqlClient) => sql`
  EXISTS (SELECT 1 FROM scient_fork_frozen_items WHERE thread_id = thread.thread_id)
`;

/** Removes one batch of a deleted fork's frozen copies (a table without rowids). */
export const purgeScientThreadContentBatch = (
  sql: SqlClient.SqlClient,
  threadId: string,
  batchSize: number,
) => sql`
  DELETE FROM scient_fork_frozen_items
  WHERE thread_id = ${threadId}
    AND position IN (
      SELECT position FROM scient_fork_frozen_items WHERE thread_id = ${threadId} LIMIT ${batchSize}
    )
  RETURNING 1 AS purged
`;

/**
 * Recursive `shown` branches: a Scient fork shows its sources' items by reference
 * (`scient_fork_history`), so a deleted source stays while a fork that shows it does.
 */
export const scientShownSources = (sql: SqlClient.SqlClient) => sql`
  UNION
  SELECT history.source_thread_id
  FROM shown
  JOIN scient_fork_history AS history ON history.thread_id = shown.thread_id
`;

/** Recursive `candidate` branches: deleting a Scient fork can release the sources it showed. */
export const scientCandidateSources = (sql: SqlClient.SqlClient) => sql`
  UNION
  SELECT history.source_thread_id
  FROM candidate
  JOIN scient_fork_history AS history ON history.thread_id = candidate.thread_id
`;

/**
 * Non-recursive `shown` seeds. A saved handoff reads an item without a frozen body from its source
 * thread, or from a fork view's frozen copy (`view_thread_id`, `fork_position`); a range reads its
 * view's fork membership, frozen copies and inherited sources. Nothing records when a handoff's
 * reader is done, so these threads stay, and the recursion keeps what a view shows.
 */
export const scientHandoffShownThreads = (sql: SqlClient.SqlClient) => sql`
  UNION
  SELECT source_thread_id FROM scient_handoff_history WHERE body_id IS NULL
  UNION
  SELECT view_thread_id FROM scient_handoff_history
  WHERE body_id IS NULL AND fork_position IS NOT NULL
  UNION
  SELECT view_thread_id FROM scient_handoff_history_ranges
`;
