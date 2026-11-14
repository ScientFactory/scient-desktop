import type { GuestShareId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * A thread is created without a share of its own, so a share its creation event already carried
 * was copied from the thread it was made for (older forks did this) and must not open the copy.
 */
export const shareCopiedAtCreation = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  shareId: GuestShareId,
) =>
  sql<{ readonly present: number }>`
    SELECT 1 AS present FROM orchestration_events
    WHERE stream_id = ${threadId}
      AND application_event_version = 2
      AND aggregate_kind = 'thread'
      AND event_type = 'thread.created'
      AND json_extract(payload_json, '$.guestShare.id') = ${shareId}
    LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0));
