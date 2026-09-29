import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { runScientMigrations } from "../scientMigrator.ts";
import Migration016 from "./016_PreserveLegacyForkSessions.ts";

const NOW = "2026-09-27T12:00:00.000Z";

it.effect(
  "upgrades completed legacy forks once using the saved provider binding, before resume",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Exercise the real runner's upgrade from a database that already ran 15.
      yield* sql`ALTER TABLE scient_context_handoffs DROP COLUMN continuity_basis`;
      yield* sql`ALTER TABLE scient_context_handoffs DROP COLUMN legacy_revert_sequence`;
      yield* sql`DELETE FROM scient_schema_migrations WHERE migration_id >= 16`;
      for (const [thread, status, rebind, cursor, instance] of [
        ["completed", "inline", 1, '{"threadId":"saved"}', "codex-main"],
        ["ambiguous", "pending", 0, '{"threadId":"saved"}', "codex-main"],
        ["superseded", "superseded", 1, '{"threadId":"saved"}', "codex-main"],
        ["malformed", "inline", 1, "invalid-json", "codex-main"],
        ["unidentified", "inline", 1, '{"unexpected":"value"}', "codex-main"],
        ["missing-instance", "inline", 1, '{"threadId":"saved"}', null],
        ["missing-binding", "inline", 1, null, "codex-main"],
      ] as const) {
        yield* sql`
        INSERT INTO scient_context_handoffs (
          handoff_id, thread_id, delivery_status, rebind_pending, created_at, updated_at
        ) VALUES (${"legacy:" + thread}, ${thread}, ${status}, ${rebind}, ${NOW}, ${NOW})
      `;
        if (cursor !== null)
          yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode,
          status, last_seen_at, resume_cursor_json
        ) VALUES (${thread}, 'codex', ${instance}, 'codex', 'full-access', 'stopped', ${NOW}, ${cursor})
      `;
      }
      yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json
      ) VALUES (42, 'pre-upgrade-undo', 'thread', 'completed', 1, 'thread.reverted', ${NOW}, 'user', '{}', '{}')
    `;
      yield* runScientMigrations(sql);
      const rows = yield* sql`
      SELECT thread_id, native_thread_key, continuity_basis, legacy_revert_sequence
      FROM scient_context_handoffs ORDER BY thread_id
    `;
      assert.deepEqual(
        rows.find((row) => row.thread_id === "completed"),
        {
          thread_id: "completed",
          native_thread_key: "codex@codex-main:saved",
          continuity_basis: "legacy_assumed",
          legacy_revert_sequence: 42,
        },
      );
      for (const thread of ["ambiguous", "superseded"]) {
        assert.strictEqual(
          rows.find((row) => row.thread_id === thread)?.continuity_basis,
          "delivery",
        );
      }
      for (const thread of ["malformed", "unidentified", "missing-instance", "missing-binding"]) {
        assert.isNull(rows.find((row) => row.thread_id === thread)?.native_thread_key);
      }
      // A failed resume writes a new binding. Neither restart nor a repeated
      // migration body may adopt that replacement as the original delivery.
      yield* sql`UPDATE provider_session_runtime SET resume_cursor_json = '{"threadId":"replacement"}'`;
      yield* runScientMigrations(sql);
      yield* Migration016;
      assert.deepEqual(
        yield* sql`
      SELECT thread_id, native_thread_key, continuity_basis, legacy_revert_sequence
      FROM scient_context_handoffs ORDER BY thread_id
    `,
        rows,
      );
      assert.deepEqual(yield* sql`SELECT * FROM scient_native_turn_sources`, []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
