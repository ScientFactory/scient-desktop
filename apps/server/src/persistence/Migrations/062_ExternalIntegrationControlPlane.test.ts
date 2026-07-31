import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const digest = (char: string) => `sha256:v1:${char.repeat(64)}`;

describe("062_ExternalIntegrationControlPlane", () => {
  it.effect("upgrades 061 idempotently and enforces hashed, read-only grants", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 61 });
      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'scient_external_integration%'
        `,
        [],
      );
      assert.deepEqual(yield* runMigrations(), [[62, "ExternalIntegrationControlPlane"]]);
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(migrationEntries.at(-1)?.slice(0, 2), [
        62,
        "ExternalIntegrationControlPlane",
      ]);

      yield* sql`
        INSERT INTO scient_external_integrations (
          integration_hash, credential_reference_hash, pairing_token_hash,
          integration_access_token_hash, pairing_expires_at,
          peer_identity_hash, pairing_state, rate_limit_max, rate_limit_window_ms,
          rate_window_started_at, created_at, updated_at
        ) VALUES (${digest("a")}, ${digest("b")}, ${digest("c")}, NULL, 300001, ${digest("d")}, 'pending', 10, 1000, 1, 1, 1)
      `;
      const rawSecretAccepted = yield* sql`
        UPDATE scient_external_integrations SET credential_reference_hash = 'keychain://plaintext'
        WHERE integration_hash = ${digest("a")}
      `.pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(rawSecretAccepted);
      const excessivePairingLifetimeAccepted = yield* sql`
        UPDATE scient_external_integrations SET pairing_expires_at = created_at + 600001
        WHERE integration_hash = ${digest("a")}
      `.pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(excessivePairingLifetimeAccepted);
      const rawAccessTokenAccepted = yield* sql`
        UPDATE scient_external_integrations
        SET pairing_state = 'paired', pairing_token_hash = NULL,
            integration_access_token_hash = 'plaintext-access-token', paired_at = 2
        WHERE integration_hash = ${digest("a")}
      `.pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(rawAccessTokenAccepted);
      const writeGrantAccepted = yield* sql`
        INSERT INTO scient_external_integration_capabilities (integration_hash, capability)
        VALUES (${digest("a")}, 'project-file:write')
      `.pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(writeGrantAccepted);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
