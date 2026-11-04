import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Event pruning deletes the events that legacy handoff sources referred to, so each
 * source keeps its own copy of the event text. A source whose event is already gone is
 * left as it is: no copy can be made, and reads report it as unreadable. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_events'`;
  if (events.length === 0) return;
  yield* sql`
    UPDATE scient_handoff_legacy_sources
    SET payload_json = (
      SELECT event.payload_json FROM orchestration_events AS event
      WHERE event.event_id = scient_handoff_legacy_sources.event_id)
    WHERE payload_json IS NULL AND event_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM orchestration_events AS event
        WHERE event.event_id = scient_handoff_legacy_sources.event_id)
  `;
});
