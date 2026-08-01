import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("061_ScientOperationReceipts", () => {
  it.effect("upgrades 060, reruns idempotently, and enforces receipt ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 60 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'scient_operation_%'
      `;
      assert.deepEqual(before, []);

      const upgraded = yield* runMigrations();
      assert.deepEqual(upgraded, [[61, "ScientOperationReceipts"]]);
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(migrationEntries.at(-1)?.slice(0, 2), [61, "ScientOperationReceipts"]);

      yield* sql`
        INSERT INTO scient_operation_claims (
          claim_key, claim_key_version, semantic_identity_hash, actor_scope_hash,
          attempt_sequence, operation_id, owner_id, operation, project_id, grant_hash,
          authority_generation_hash, authority_id_hash, actor_kind, actor_ref_hash,
          provider_thread_hash, provider, provider_turn_hash, ingress, idempotency_mode,
          payload_fingerprint, status, started_at, updated_at
        ) VALUES (
          'claim-1', 2, 'semantic-hash', 'scope-hash', 1, 'operation-1', 'owner-1',
          'thread.message.send', 'project-1', 'grant-hash', ${`sha256:v1:${"d".repeat(64)}`},
          ${`sha256:v1:${"a".repeat(64)}`}, 'provider-thread', ${`sha256:v1:${"b".repeat(64)}`},
          ${`sha256:v1:${"b".repeat(64)}`}, 'claudeAgent', ${`sha256:v1:${"c".repeat(64)}`},
          'provider-gateway', 'semantic', 'payload-hash',
          'succeeded', 1, 2
        )
      `;
      yield* sql`
        INSERT INTO scient_operation_receipts (
          receipt_id, operation_id, claim_key, operation, project_id, grant_hash,
          authority_generation_hash, authority_id_hash, actor_kind, actor_ref_hash,
          provider_thread_hash, provider, provider_turn_hash, ingress, receipt_sequence,
          started_at, finished_at, outcome, effects_json
        ) VALUES (
          'receipt-1', 'operation-1', 'claim-1', 'thread.message.send', 'project-1',
          'grant-hash', ${`sha256:v1:${"d".repeat(64)}`}, ${`sha256:v1:${"a".repeat(64)}`},
          'provider-thread', ${`sha256:v1:${"b".repeat(64)}`}, ${`sha256:v1:${"b".repeat(64)}`},
          'claudeAgent', ${`sha256:v1:${"c".repeat(64)}`}, 'provider-gateway',
          1, 1, 2, 'succeeded', '[]'
        )
      `;

      for (const invalidUpdate of [
        sql`UPDATE scient_operation_claims SET actor_ref_hash = ${`sha256:v1:${"e".repeat(64)}`} WHERE claim_key = 'claim-1'`,
        sql`UPDATE scient_operation_claims SET authority_id_hash = 'raw-authority' WHERE claim_key = 'claim-1'`,
        sql`UPDATE scient_operation_claims SET automation_hash = ${`sha256:v1:${"e".repeat(64)}`} WHERE claim_key = 'claim-1'`,
      ]) {
        const accepted = yield* invalidUpdate.pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
        assert.isFalse(accepted);
      }

      const orphanAccepted = yield* sql`
        INSERT INTO scient_operation_receipts (
          receipt_id, operation_id, claim_key, operation, project_id, grant_hash,
          authority_generation_hash, authority_id_hash, actor_kind, actor_ref_hash,
          provider_thread_hash, provider, provider_turn_hash, ingress, receipt_sequence,
          started_at, finished_at, outcome, effects_json
        ) VALUES (
          'receipt-orphan', 'operation-orphan', 'claim-missing', 'thread.message.send',
          'project-1', 'grant-hash', ${`sha256:v1:${"d".repeat(64)}`},
          ${`sha256:v1:${"a".repeat(64)}`}, 'provider-thread', ${`sha256:v1:${"b".repeat(64)}`},
          ${`sha256:v1:${"b".repeat(64)}`}, 'claudeAgent', ${`sha256:v1:${"c".repeat(64)}`},
          'provider-gateway', 1, 1, 2, 'succeeded', '[]'
        )
      `.pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(orphanAccepted);

      yield* sql`DELETE FROM scient_operation_claims WHERE claim_key = 'claim-1'`;
      const receipts = yield* sql`SELECT receipt_id FROM scient_operation_receipts`;
      assert.deepEqual(receipts, []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
