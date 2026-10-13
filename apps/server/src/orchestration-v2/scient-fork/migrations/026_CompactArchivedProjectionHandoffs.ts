import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Migration 25 archived each legacy projection body once. Replace the projection
 * copy with the metadata routine reads already derive, so startup no longer
 * parses the body on every scan. A row is rewritten only when its archive holds
 * the identical body; malformed and unarchived rows stay untouched. The SQL is a
 * frozen copy of `handoffMetadataSql` at the time of this migration. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projection =
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_context_handoffs'`;
  if (projection.length === 0) return;
  yield* sql`
    UPDATE orchestration_v2_projection_context_handoffs
    SET payload_json = CASE
      WHEN json_type(payload_json, '$.history') = 'object' THEN
        json_set(json_remove(payload_json, '$.history.messages', '$.summaryText'),
          '$.summaryText', '', '$.history.messages', json('[]'),
          '$.historySource', json_object('id', 'legacy-projection:' || context_handoff_id,
            'itemCount', COALESCE(json_array_length(payload_json, '$.history.messages'), 0)))
      ELSE json_set(payload_json, '$.summaryText', '', '$.historySource',
        json_object('id', 'legacy-projection:' || context_handoff_id,
          'itemCount', 0, 'summaryOnly', json('true')))
      END
    WHERE CASE WHEN json_valid(payload_json) THEN
      json_type(payload_json, '$.historySource') IS NULL AND (
        json_type(payload_json, '$.history') = 'object'
        OR (json_type(payload_json, '$.history') IS NULL
          AND json_type(payload_json, '$.summaryText') = 'text'))
      ELSE 0 END
      AND EXISTS (
        SELECT 1 FROM scient_handoff_legacy_sources AS source
        WHERE source.source_id = 'legacy-projection:' || orchestration_v2_projection_context_handoffs.context_handoff_id
          AND source.payload_json = orchestration_v2_projection_context_handoffs.payload_json)
  `;
});
