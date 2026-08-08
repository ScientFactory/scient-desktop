import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ensureScientForkSchema } from "./schema.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("Scient fork schema", (it) => {
  it.effect("upgrades Claude's prototype lineage rows without losing them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE scient_thread_lineage (
          thread_id TEXT PRIMARY KEY,
          forked_from_thread_id TEXT,
          fork_point_turn_count INTEGER,
          workspace_mode TEXT,
          fidelity_mode TEXT,
          created_at TEXT
        )
      `;
      yield* sql`
        INSERT INTO scient_thread_lineage (
          thread_id,
          forked_from_thread_id,
          fork_point_turn_count,
          workspace_mode,
          fidelity_mode,
          created_at
        ) VALUES (
          'claude-fork',
          'origin-thread',
          3,
          'local',
          'chat-only',
          '2026-08-08T00:00:00.000Z'
        )
      `;

      yield* ensureScientForkSchema(sql);
      yield* ensureScientForkSchema(sql);

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly forked_from_thread_id: string;
        readonly provider_mode: string;
        readonly provider_bootstrap_status: string;
        readonly attachment_copies_json: string;
        readonly fidelity_mode: string;
        readonly status: string;
        readonly attempt_count: number;
        readonly updated_at: string;
      }>`
        SELECT
          thread_id,
          forked_from_thread_id,
          provider_mode,
          provider_bootstrap_status,
          attachment_copies_json,
          fidelity_mode,
          status,
          attempt_count,
          updated_at
        FROM scient_thread_lineage
      `;
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(rows[0], {
        thread_id: "claude-fork",
        forked_from_thread_id: "origin-thread",
        provider_mode: "transcript-bootstrap",
        provider_bootstrap_status: "pending",
        attachment_copies_json: "[]",
        fidelity_mode: "transcript-bootstrap",
        status: "pending",
        attempt_count: 0,
        updated_at: "2026-08-08T00:00:00.000Z",
      });

      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM scient_schema_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        migrations.map((migration) => migration.migration_id),
        [1, 2],
      );
    }),
  );
});
