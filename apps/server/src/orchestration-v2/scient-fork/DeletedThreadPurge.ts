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
 * A handoff reads its source's items by reference until a body is frozen, and nothing records
 * when its reader no longer needs them, so a thread such a reference names keeps its content.
 */
export const scientKeepsDeletedThread = (sql: SqlClient.SqlClient) => sql`
  AND NOT EXISTS (
    SELECT 1 FROM scient_handoff_history AS handoff
    WHERE handoff.source_thread_id = thread.thread_id AND handoff.body_id IS NULL
  )
`;
