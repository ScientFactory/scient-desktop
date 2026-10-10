/**
 * Preserve completed legacy deliveries against the saved, pre-resume session.
 * This is an upgrade assumption, not proof that the provider received history.
 * Capture it during database startup, before a failed resume can replace the
 * binding. Never adopt a session observed later during turn preparation.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { nativeThreadKey } from "../context/nativeThreadKey.ts";

const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_context_handoffs)`).map(
      (row) => row.name,
    ),
  );
  if (!columns.has("continuity_basis"))
    yield* sql`ALTER TABLE scient_context_handoffs ADD COLUMN continuity_basis TEXT NOT NULL DEFAULT 'delivery'`;
  if (!columns.has("legacy_revert_sequence"))
    yield* sql`ALTER TABLE scient_context_handoffs ADD COLUMN legacy_revert_sequence INTEGER`;

  // Standalone Scient schema checks may run before T3 creates runtime tables.
  const runtimeColumns = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(provider_session_runtime)`).map(
      (row) => row.name,
    ),
  );
  if (!runtimeColumns.has("resume_cursor_json") || !runtimeColumns.has("provider_instance_id"))
    return;

  const rows = yield* sql<{
    readonly handoff_id: string;
    readonly thread_id: string;
    readonly provider_name: string | null;
    readonly provider_instance_id: string | null;
    readonly resume_cursor_json: string | null;
  }>`
    SELECT handoff.handoff_id, handoff.thread_id,
      runtime.provider_name, runtime.provider_instance_id, runtime.resume_cursor_json
    FROM scient_context_handoffs AS handoff
    LEFT JOIN provider_session_runtime AS runtime ON runtime.thread_id = handoff.thread_id
    WHERE handoff.handoff_id = 'legacy:' || handoff.thread_id
      AND handoff.delivery_status = 'inline' AND handoff.rebind_pending = 1
      AND handoff.native_thread_key IS NULL AND handoff.continuity_basis = 'delivery'
  `;
  for (const row of rows) {
    const cursor =
      row.resume_cursor_json === null
        ? undefined
        : Option.getOrUndefined(decodeCursor(row.resume_cursor_json));
    const key =
      row.provider_name === null || row.provider_instance_id === null
        ? null
        : nativeThreadKey(row.provider_name, cursor, row.provider_instance_id);
    yield* sql`
      UPDATE scient_context_handoffs
      SET continuity_basis = 'legacy_assumed', native_thread_key = ${key}, rebind_pending = 0,
        turn_id = COALESCE(turn_id, (
          SELECT turn_id FROM projection_turns
          WHERE thread_id = ${row.thread_id}
            AND pending_message_id = scient_context_handoffs.message_id
            AND turn_id IS NOT NULL LIMIT 1
        )),
        legacy_revert_sequence = (
          SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${row.thread_id}
            AND event_type = 'thread.reverted'
        )
      WHERE handoff_id = ${row.handoff_id}
    `;
  }
});
