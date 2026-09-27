import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import Migration017 from "./017_ImportContextTransfers.ts";

const NOW = "2026-09-28T12:00:00.000Z";

it.layer(SqlitePersistenceMemory)("Scient migration 17: import context transfers", (it) => {
  /** The table exactly as migration 14 created it, with fork rows in every state. */
  const restoreForkOnlyTable = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE scient_context_transfers`;
    yield* sql`
      CREATE TABLE scient_context_transfers (
        thread_id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'fork',
        source_thread_id TEXT NOT NULL,
        source_point_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        resolution_json TEXT,
        fidelity TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    yield* sql`
      INSERT INTO scient_context_transfers VALUES
        ('fork-pending', 'fork', 'origin-1', '{"threadId":"origin-1","turnId":null,"turnCount":0}',
          'pending', NULL, NULL, NULL, ${NOW}, ${NOW}),
        ('fork-consumed', 'fork', 'origin-2', '{"threadId":"origin-2","turnId":"t","turnCount":2}',
          'consumed', '{"type":"portable_context","handoffId":"h"}', 'portable', NULL, ${NOW}, ${NOW}),
        ('fork-native', 'fork', 'origin-3', '{}', 'resolved_native',
          '{"type":"native_fork","providerThreadRef":"k"}', 'native', 'Native fork unavailable: x',
          ${NOW}, ${NOW})
    `;
    return yield* sql<Record<string, unknown>>`
      SELECT * FROM scient_context_transfers ORDER BY thread_id
    `;
  });

  it.effect("rebuilds the table, keeping every fork row exactly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const before = yield* restoreForkOnlyTable;
      yield* Migration017;
      const after = yield* sql<Record<string, unknown>>`
        SELECT thread_id, type, source_thread_id, source_point_json, status, resolution_json,
          fidelity, error, created_at, updated_at
        FROM scient_context_transfers ORDER BY thread_id
      `;
      assert.deepStrictEqual(after, before);
      const added = yield* sql<{
        readonly inherited_turn_ids_json: string;
        readonly origin_json: string | null;
      }>`SELECT inherited_turn_ids_json, origin_json FROM scient_context_transfers`;
      assert.isTrue(added.every((row) => row.inherited_turn_ids_json === "[]"));
      assert.isTrue(added.every((row) => row.origin_json === null));
      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(scient_context_transfers)
      `;
      assert.strictEqual(columns.find((column) => column.name === "source_thread_id")?.notnull, 0);

      // Idempotent: a second run changes nothing.
      yield* Migration017;
      assert.strictEqual(
        (yield* sql`SELECT thread_id FROM scient_context_transfers`).length,
        before.length,
      );
    }),
  );

  it.effect("keeps forks and imports apart", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* restoreForkOnlyTable;
      yield* Migration017;
      yield* sql`
        INSERT INTO scient_context_transfers (thread_id, type, source_thread_id, status, origin_json,
          created_at, updated_at)
        VALUES ('import-1', 'import', NULL, 'pending', '{}', ${NOW}, ${NOW})
      `;
      const refused = [
        // A fork always names its local source.
        sql`INSERT INTO scient_context_transfers (thread_id, type, source_thread_id, status,
          created_at, updated_at) VALUES ('fork-x', 'fork', NULL, 'pending', ${NOW}, ${NOW})`,
        // An import never does: external ids cannot pose as local thread ids.
        sql`INSERT INTO scient_context_transfers (thread_id, type, source_thread_id, status,
          origin_json, created_at, updated_at)
          VALUES ('import-x', 'import', 'external-thread', 'pending', '{}', ${NOW}, ${NOW})`,
        // An import records its provenance.
        sql`INSERT INTO scient_context_transfers (thread_id, type, source_thread_id, status,
          created_at, updated_at) VALUES ('import-y', 'import', NULL, 'pending', ${NOW}, ${NOW})`,
      ];
      for (const statement of refused) {
        const result = yield* Effect.result(statement);
        assert.strictEqual(result._tag, "Failure");
      }
    }),
  );
});
