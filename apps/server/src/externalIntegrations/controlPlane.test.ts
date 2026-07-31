import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ExternalIntegrationControlError,
  makeExternalIntegrationControlPlane,
} from "./controlPlane.ts";

const sqlite = it.layer(SqlitePersistenceMemory);
const NOW = 1_800_000_000_000;
const config = (identity: string, maxRequests = 10) => ({
  externalIdentity: identity,
  credentialReference: `keychain-ref:${identity}`,
  peerIdentity: "unix-uid:501",
  projects: [{ projectId: "project-1", threadIds: ["thread-1", "thread-2"] }],
  capabilities: ["project:context:read", "thread:list", "thread:read"] as const,
  rateLimit: { maxRequests, windowMs: 60_000 },
  now: NOW,
});

const capture = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );
const controlCode = (error: unknown) =>
  error instanceof ExternalIntegrationControlError ? error.code : "unexpected_error";

const pair = (identity: string, maxRequests = 10) =>
  Effect.gen(function* () {
    const control = yield* makeExternalIntegrationControlPlane;
    const created = yield* control.createPending(config(identity, maxRequests));
    yield* control.completePairing({
      externalIdentity: identity,
      pairingToken: created.pairingToken,
      credentialReference: `keychain-ref:${identity}`,
      peerIdentity: "unix-uid:501",
      now: NOW + 1,
    });
    return control;
  });

sqlite("ExternalIntegrationControlPlane", (it) => {
  it.effect("stores hashes only, pairs with exact proof, and emits security receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const control = yield* makeExternalIntegrationControlPlane;
      const created = yield* control.createPending(config("integration-sensitive"));
      const rows = yield* sql<{
        readonly integrationHash: string;
        readonly credentialHash: string;
        readonly tokenHash: string;
        readonly peerHash: string;
      }>`
        SELECT integration_hash AS "integrationHash",
               credential_reference_hash AS "credentialHash",
               pairing_token_hash AS "tokenHash", peer_identity_hash AS "peerHash"
        FROM scient_external_integrations
      `;
      const encoded = JSON.stringify(rows);
      assert.notInclude(encoded, "integration-sensitive");
      assert.notInclude(encoded, "keychain-ref");
      assert.notInclude(encoded, created.pairingToken);
      assert.notInclude(encoded, "unix-uid:501");

      const denied = yield* capture(
        control.completePairing({
          externalIdentity: "integration-sensitive",
          pairingToken: "wrong-token",
          credentialReference: "keychain-ref:integration-sensitive",
          peerIdentity: "unix-uid:501",
          now: NOW + 1,
        }),
      );
      assert.isFalse(denied.ok);
      if (!denied.ok) assert.strictEqual(controlCode(denied.error), "pairing_denied");

      yield* control.completePairing({
        externalIdentity: "integration-sensitive",
        pairingToken: created.pairingToken,
        credentialReference: "keychain-ref:integration-sensitive",
        peerIdentity: "unix-uid:501",
        now: NOW + 2,
      });
      const admission = yield* control.admitRead({
        externalIdentity: "integration-sensitive",
        credentialReference: "keychain-ref:integration-sensitive",
        verifiedPeerIdentity: "unix-uid:501",
        operation: "thread.read",
        projectId: "project-1",
        threadId: "thread-1",
        now: NOW + 3,
      });
      yield* control.releaseRead(admission, NOW + 4);
      const events = yield* control.listSecurityEvents("integration-sensitive");
      assert.deepEqual(
        events.map(({ eventType, outcome }) => [eventType, outcome]),
        [
          ["created", "recorded"],
          ["paired", "recorded"],
          ["admission", "allowed"],
          ["release", "allowed"],
        ],
      );
    }),
  );

  it.effect("denies wrong peer, project, thread, capability and unpaired state", () =>
    Effect.gen(function* () {
      const control = yield* makeExternalIntegrationControlPlane;
      yield* control.createPending(config("pending"));
      const base = {
        externalIdentity: "pending",
        credentialReference: "keychain-ref:pending",
        verifiedPeerIdentity: "unix-uid:501",
        operation: "thread.read" as const,
        projectId: "project-1",
        threadId: "thread-1",
        now: NOW + 1,
      };
      const pending = yield* capture(control.admitRead(base));
      assert.isFalse(pending.ok);
      if (!pending.ok) assert.strictEqual(controlCode(pending.error), "integration_not_paired");

      const paired = yield* pair("scoped");
      const cases = [
        {
          ...base,
          externalIdentity: "scoped",
          credentialReference: "keychain-ref:scoped",
          verifiedPeerIdentity: "unix-uid:502",
        },
        {
          ...base,
          externalIdentity: "scoped",
          credentialReference: "keychain-ref:scoped",
          projectId: "project-2",
        },
        {
          ...base,
          externalIdentity: "scoped",
          credentialReference: "keychain-ref:scoped",
          threadId: "thread-3",
        },
      ];
      const codes: string[] = [];
      for (const attempt of cases) {
        const result = yield* capture(paired.admitRead(attempt));
        if (!result.ok && result.error instanceof ExternalIntegrationControlError) {
          codes.push(result.error.code);
        }
      }
      assert.deepEqual(codes, [
        "peer_identity_mismatch",
        "project_scope_denied",
        "thread_scope_denied",
      ]);

      const limited = yield* makeExternalIntegrationControlPlane;
      const created = yield* limited.createPending({
        ...config("no-thread-read"),
        capabilities: ["thread:list"],
      });
      yield* limited.completePairing({
        externalIdentity: "no-thread-read",
        pairingToken: created.pairingToken,
        credentialReference: "keychain-ref:no-thread-read",
        peerIdentity: "unix-uid:501",
        now: NOW + 1,
      });
      const capability = yield* capture(
        limited.admitRead({
          ...base,
          externalIdentity: "no-thread-read",
          credentialReference: "keychain-ref:no-thread-read",
        }),
      );
      assert.isFalse(capability.ok);
      if (!capability.ok) assert.strictEqual(controlCode(capability.error), "capability_denied");
    }),
  );

  it.effect("rate limits concurrent admissions atomically", () =>
    Effect.gen(function* () {
      const control = yield* pair("concurrent", 2);
      const attempt = () =>
        capture(
          control.admitRead({
            externalIdentity: "concurrent",
            credentialReference: "keychain-ref:concurrent",
            verifiedPeerIdentity: "unix-uid:501",
            operation: "thread.list",
            projectId: "project-1",
            now: NOW + 10,
          }),
        );
      const results = yield* Effect.all([attempt(), attempt(), attempt()], {
        concurrency: "unbounded",
      });
      assert.strictEqual(results.filter((result) => result.ok).length, 2);
      assert.strictEqual(results.filter((result) => !result.ok).length, 1);
      const denied = results.find((result) => !result.ok);
      if (denied !== undefined && !denied.ok) {
        assert.strictEqual(controlCode(denied.error), "rate_limit_exceeded");
      }
    }),
  );

  it.effect("survives service reconstruction and revocation invalidates stale reads", () =>
    Effect.gen(function* () {
      const first = yield* pair("restart");
      const admission = yield* first.admitRead({
        externalIdentity: "restart",
        credentialReference: "keychain-ref:restart",
        verifiedPeerIdentity: "unix-uid:501",
        operation: "thread.read",
        projectId: "project-1",
        threadId: "thread-1",
        now: NOW + 2,
      });
      // A new service value over the same durable database models server restart.
      const restarted = yield* makeExternalIntegrationControlPlane;
      yield* restarted.revoke("restart", NOW + 3);
      const stale = yield* capture(restarted.releaseRead(admission, NOW + 4));
      assert.isFalse(stale.ok);
      if (!stale.ok) assert.strictEqual(controlCode(stale.error), "stale_authority");
      const revoked = yield* capture(
        restarted.admitRead({
          externalIdentity: "restart",
          credentialReference: "keychain-ref:restart",
          verifiedPeerIdentity: "unix-uid:501",
          operation: "thread.list",
          projectId: "project-1",
          now: NOW + 5,
        }),
      );
      assert.isFalse(revoked.ok);
      if (!revoked.ok) assert.strictEqual(controlCode(revoked.error), "integration_revoked");
    }),
  );
});
