/** SCIENT-OWNED. Events the upstream prune pass keeps for Scient readers; `event` is the candidate.
 * V1 import events (`migration:v1:*`) are the baseline V1 source reconciliation compares V2 edits
 * against, and the markers that stop a repeated history import from writing an entity twice.
 * Without them an unedited item gains a duplicate "Recovered V1 version". */
import type * as SqlClient from "effect/sql/SqlClient";

export const retainedForScient = (sql: SqlClient.SqlClient) =>
  sql`event.event_id LIKE 'migration:v1:%'`;
