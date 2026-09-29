import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { runScientMigrations } from "../scientMigrator.ts";
import Migration017 from "./017_ForkAcceptedTurn.ts";

it.effect("upgrades fork receipts without inventing a carrying turn for old deliveries", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE scient_context_handoffs DROP COLUMN accepted_turn_id`;
    yield* sql`DELETE FROM scient_schema_migrations WHERE migration_id >= 17`;
    yield* sql`INSERT INTO scient_context_handoffs
      (handoff_id, thread_id, delivery_status, created_at, updated_at, turn_id)
      VALUES ('old', 'fork', 'inline', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z', 'confirmed')`;
    yield* runScientMigrations(sql);
    assert.deepEqual(
      yield* sql`SELECT handoff_id, turn_id, accepted_turn_id FROM scient_context_handoffs`,
      [{ handoff_id: "old", turn_id: "confirmed", accepted_turn_id: null }],
    );
    yield* sql`UPDATE scient_context_handoffs SET accepted_turn_id = 'receipt' WHERE handoff_id = 'old'`;
    yield* Migration017;
    assert.deepEqual(yield* sql`SELECT accepted_turn_id FROM scient_context_handoffs`, [
      { accepted_turn_id: "receipt" },
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
