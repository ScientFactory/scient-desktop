import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  EXTERNAL_INTEGRATION_SECURITY_EVENT_RETAINED_LIMIT,
  ExternalIntegrationControlError,
  externalIntegrationIdentityHash,
  makeExternalIntegrationControlPlane,
} from "./controlPlane.ts";

const sqlite = it.layer(SqlitePersistenceMemory);
const NOW = 1_800_000_000_000;
let trustedNow = NOW;
const config = (identity: string, maxRequests = 10) => ({
  externalIdentity: identity,
  credentialReference: `keychain-ref:${identity}`,
  peerIdentity: "unix-uid:501",
  projects: [{ projectId: "project-1", threadIds: ["thread-1", "thread-2"] }],
  capabilities: ["project:context:read", "thread:list", "thread:read"] as const,
  rateLimit: { maxRequests, windowMs: 60_000 },
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
    const control = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
    const created = yield* control.createPending(config(identity, maxRequests));
    trustedNow += 1;
    const paired = yield* control.completePairing({
      externalIdentity: identity,
      pairingToken: created.pairingToken,
      credentialReference: `keychain-ref:${identity}`,
      peerIdentity: "unix-uid:501",
    });
    return { control, accessToken: paired.accessToken } as const;
  });

sqlite("ExternalIntegrationControlPlane", (it) => {
  it.effect("stores hashes only, pairs with exact proof, and emits security receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      trustedNow = NOW;
      const control = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
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
        }),
      );
      assert.isFalse(denied.ok);
      if (!denied.ok) assert.strictEqual(controlCode(denied.error), "pairing_denied");

      trustedNow += 2;
      const paired = yield* control.completePairing({
        externalIdentity: "integration-sensitive",
        pairingToken: created.pairingToken,
        credentialReference: "keychain-ref:integration-sensitive",
        peerIdentity: "unix-uid:501",
      });
      const pairedRows = yield* sql<{ readonly accessTokenHash: string }>`
        SELECT integration_access_token_hash AS "accessTokenHash"
        FROM scient_external_integrations
      `;
      assert.notInclude(JSON.stringify(pairedRows), paired.accessToken);
      assert.match(pairedRows[0]?.accessTokenHash ?? "", /^sha256:v1:[a-f0-9]{64}$/u);
      trustedNow += 1;
      const impersonation = yield* capture(
        control.admitRead({
          externalIdentity: "integration-sensitive",
          credentialReference: "keychain-ref:integration-sensitive",
          accessToken: "guessed-access-token",
          verifiedPeerIdentity: "unix-uid:501",
          operation: "thread.read",
          projectId: "project-1",
          threadId: "thread-1",
        }),
      );
      assert.isFalse(impersonation.ok);
      if (!impersonation.ok) {
        assert.strictEqual(controlCode(impersonation.error), "integration_access_denied");
      }
      trustedNow += 1;
      const admission = yield* control.admitRead({
        externalIdentity: "integration-sensitive",
        credentialReference: "keychain-ref:integration-sensitive",
        accessToken: paired.accessToken,
        verifiedPeerIdentity: "unix-uid:501",
        operation: "thread.read",
        projectId: "project-1",
        threadId: "thread-1",
      });
      trustedNow += 1;
      yield* control.releaseRead(admission);
      const events = yield* control.listSecurityEvents("integration-sensitive");
      assert.deepEqual(
        events.events.map(({ eventType, outcome }) => [eventType, outcome]),
        [
          ["created", "recorded"],
          ["paired", "recorded"],
          ["admission", "denied"],
          ["admission", "allowed"],
          ["release", "allowed"],
        ],
      );
    }),
  );

  it.effect("expires pending pairing proof using only the trusted host clock", () =>
    Effect.gen(function* () {
      trustedNow = NOW;
      const control = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
      const created = yield* control.createPending(config("expires"));
      trustedNow += 5 * 60 * 1_000;
      const expired = yield* capture(
        control.completePairing({
          externalIdentity: "expires",
          pairingToken: created.pairingToken,
          credentialReference: "keychain-ref:expires",
          peerIdentity: "unix-uid:501",
        }),
      );
      assert.isFalse(expired.ok);
      if (!expired.ok) assert.strictEqual(controlCode(expired.error), "pairing_expired");
    }),
  );

  it.effect("denies wrong peer, project, thread, capability and unpaired state", () =>
    Effect.gen(function* () {
      trustedNow = NOW;
      const control = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
      yield* control.createPending(config("pending"));
      const base = {
        externalIdentity: "pending",
        credentialReference: "keychain-ref:pending",
        accessToken: "unpaired-access-token",
        verifiedPeerIdentity: "unix-uid:501",
        operation: "thread.read" as const,
        projectId: "project-1",
        threadId: "thread-1",
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
          accessToken: paired.accessToken,
          verifiedPeerIdentity: "unix-uid:502",
        },
        {
          ...base,
          externalIdentity: "scoped",
          credentialReference: "keychain-ref:scoped",
          accessToken: paired.accessToken,
          projectId: "project-2",
        },
        {
          ...base,
          externalIdentity: "scoped",
          credentialReference: "keychain-ref:scoped",
          accessToken: paired.accessToken,
          threadId: "thread-3",
        },
      ];
      const codes: string[] = [];
      for (const attempt of cases) {
        const result = yield* capture(paired.control.admitRead(attempt));
        if (!result.ok && result.error instanceof ExternalIntegrationControlError) {
          codes.push(result.error.code);
        }
      }
      assert.deepEqual(codes, [
        "peer_identity_mismatch",
        "project_scope_denied",
        "thread_scope_denied",
      ]);

      const limited = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
      const created = yield* limited.createPending({
        ...config("no-thread-read"),
        capabilities: ["thread:list"],
      });
      const limitedPairing = yield* limited.completePairing({
        externalIdentity: "no-thread-read",
        pairingToken: created.pairingToken,
        credentialReference: "keychain-ref:no-thread-read",
        peerIdentity: "unix-uid:501",
      });
      const capability = yield* capture(
        limited.admitRead({
          ...base,
          externalIdentity: "no-thread-read",
          credentialReference: "keychain-ref:no-thread-read",
          accessToken: limitedPairing.accessToken,
        }),
      );
      assert.isFalse(capability.ok);
      if (!capability.ok) assert.strictEqual(controlCode(capability.error), "capability_denied");
    }),
  );

  it.effect("rate limits concurrent admissions atomically", () =>
    Effect.gen(function* () {
      trustedNow = NOW;
      const { control, accessToken } = yield* pair("concurrent", 2);
      const attempt = () =>
        capture(
          control.admitRead({
            externalIdentity: "concurrent",
            credentialReference: "keychain-ref:concurrent",
            accessToken,
            verifiedPeerIdentity: "unix-uid:501",
            operation: "thread.list",
            projectId: "project-1",
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
      const sql = yield* SqlClient.SqlClient;
      trustedNow = NOW;
      const first = yield* pair("restart");
      const admission = yield* first.control.admitRead({
        externalIdentity: "restart",
        credentialReference: "keychain-ref:restart",
        accessToken: first.accessToken,
        verifiedPeerIdentity: "unix-uid:501",
        operation: "thread.read",
        projectId: "project-1",
        threadId: "thread-1",
      });
      // A new service value over the same durable database models server restart.
      const restarted = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
      trustedNow += 1;
      yield* restarted.revoke("restart");
      trustedNow += 1;
      const stale = yield* capture(restarted.releaseRead(admission));
      assert.isFalse(stale.ok);
      if (!stale.ok) assert.strictEqual(controlCode(stale.error), "stale_authority");
      const revoked = yield* capture(
        restarted.admitRead({
          externalIdentity: "restart",
          credentialReference: "keychain-ref:restart",
          accessToken: first.accessToken,
          verifiedPeerIdentity: "unix-uid:501",
          operation: "thread.list",
          projectId: "project-1",
        }),
      );
      assert.isFalse(revoked.ok);
      if (!revoked.ok) assert.strictEqual(controlCode(revoked.error), "integration_revoked");

      const revokedState = (yield* sql<{
        readonly pairingState: string;
        readonly authorityGeneration: number;
        readonly revokedAt: number | null;
      }>`
          SELECT pairing_state AS "pairingState",
                 authority_generation AS "authorityGeneration",
                 revoked_at AS "revokedAt"
          FROM scient_external_integrations
          WHERE integration_hash = ${admission.integrationHash}
        `)[0]!;
      const recovery = yield* capture(
        restarted.beginRecoveryPairing({
          externalIdentity: "restart",
          credentialReference: "keychain-ref:restart",
          peerIdentity: "unix-uid:501",
        }),
      );
      assert.isFalse(recovery.ok);
      if (!recovery.ok) assert.strictEqual(controlCode(recovery.error), "integration_revoked");
      const afterRecoveryAttempt = (yield* sql<{
        readonly pairingState: string;
        readonly authorityGeneration: number;
        readonly revokedAt: number | null;
      }>`
          SELECT pairing_state AS "pairingState",
                 authority_generation AS "authorityGeneration",
                 revoked_at AS "revokedAt"
          FROM scient_external_integrations
          WHERE integration_hash = ${admission.integrationHash}
        `)[0]!;
      assert.deepEqual(afterRecoveryAttempt, revokedState);
    }),
  );

  it.effect("atomically re-pairs after a lost response and invalidates every stale proof", () =>
    Effect.gen(function* () {
      trustedNow = NOW;
      const first = yield* pair("recover");
      const staleAdmission = yield* first.control.admitRead({
        externalIdentity: "recover",
        credentialReference: "keychain-ref:recover",
        accessToken: first.accessToken,
        verifiedPeerIdentity: "unix-uid:501",
        operation: "thread.read",
        projectId: "project-1",
        threadId: "thread-1",
      });
      trustedNow += 1;
      const recovery = yield* first.control.beginRecoveryPairing({
        externalIdentity: "recover",
        credentialReference: "keychain-ref:recover",
        peerIdentity: "unix-uid:501",
      });
      assert.strictEqual(recovery.authorityGeneration, staleAdmission.authorityGeneration + 1);
      const staleRelease = yield* capture(first.control.releaseRead(staleAdmission));
      assert.isFalse(staleRelease.ok);
      if (!staleRelease.ok) assert.strictEqual(controlCode(staleRelease.error), "stale_authority");

      // Reconstructing the service models a process crash before pairing is completed.
      const restarted = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
      trustedNow += 1;
      const lostResponse = yield* restarted.completePairing({
        externalIdentity: "recover",
        pairingToken: recovery.pairingToken,
        credentialReference: "keychain-ref:recover",
        peerIdentity: "unix-uid:501",
      });
      // Model a committed pairing whose plaintext response was lost, then recover again.
      trustedNow += 1;
      const retried = yield* restarted.beginRecoveryPairing({
        externalIdentity: "recover",
        credentialReference: "keychain-ref:recover",
        peerIdentity: "unix-uid:501",
      });
      const lostToken = yield* capture(
        restarted.admitRead({
          externalIdentity: "recover",
          credentialReference: "keychain-ref:recover",
          accessToken: lostResponse.accessToken,
          verifiedPeerIdentity: "unix-uid:501",
          operation: "thread.list",
          projectId: "project-1",
        }),
      );
      assert.isFalse(lostToken.ok);
      if (!lostToken.ok) assert.strictEqual(controlCode(lostToken.error), "integration_not_paired");
      trustedNow += 1;
      const finalPair = yield* restarted.completePairing({
        externalIdentity: "recover",
        pairingToken: retried.pairingToken,
        credentialReference: "keychain-ref:recover",
        peerIdentity: "unix-uid:501",
      });
      yield* restarted.admitRead({
        externalIdentity: "recover",
        credentialReference: "keychain-ref:recover",
        accessToken: finalPair.accessToken,
        verifiedPeerIdentity: "unix-uid:501",
        operation: "thread.list",
        projectId: "project-1",
      });
      const lostTokenAfterRepair = yield* capture(
        restarted.admitRead({
          externalIdentity: "recover",
          credentialReference: "keychain-ref:recover",
          accessToken: lostResponse.accessToken,
          verifiedPeerIdentity: "unix-uid:501",
          operation: "thread.list",
          projectId: "project-1",
        }),
      );
      assert.isFalse(lostTokenAfterRepair.ok);
      if (!lostTokenAfterRepair.ok) {
        assert.strictEqual(controlCode(lostTokenAfterRepair.error), "integration_access_denied");
      }
      const originalToken = yield* capture(
        restarted.admitRead({
          externalIdentity: "recover",
          credentialReference: "keychain-ref:recover",
          accessToken: first.accessToken,
          verifiedPeerIdentity: "unix-uid:501",
          operation: "thread.list",
          projectId: "project-1",
        }),
      );
      assert.isFalse(originalToken.ok);
      if (!originalToken.ok) {
        assert.strictEqual(controlCode(originalToken.error), "integration_access_denied");
      }

      const wrongOwner = yield* capture(
        restarted.beginRecoveryPairing({
          externalIdentity: "recover",
          credentialReference: "keychain-ref:wrong",
          peerIdentity: "unix-uid:501",
        }),
      );
      assert.isFalse(wrongOwner.ok);
      if (!wrongOwner.ok) assert.strictEqual(controlCode(wrongOwner.error), "pairing_denied");

      trustedNow += 1;
      const expiring = yield* restarted.beginRecoveryPairing({
        externalIdentity: "recover",
        credentialReference: "keychain-ref:recover",
        peerIdentity: "unix-uid:501",
      });
      trustedNow += 5 * 60 * 1_000;
      const expired = yield* capture(
        restarted.completePairing({
          externalIdentity: "recover",
          pairingToken: expiring.pairingToken,
          credentialReference: "keychain-ref:recover",
          peerIdentity: "unix-uid:501",
        }),
      );
      assert.isFalse(expired.ok);
      if (!expired.ok) assert.strictEqual(controlCode(expired.error), "pairing_expired");
    }),
  );

  it.effect("paginates tied security events deterministically and rejects malformed cursors", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      trustedNow = NOW;
      const control = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
      yield* control.createPending(config("event-page"));
      const integrationHash = externalIntegrationIdentityHash("event-page");
      yield* sql`
        INSERT INTO scient_external_integration_security_events (
          event_id, integration_hash, event_type, outcome, reason_code, occurred_at
        ) VALUES
          ('tie-b', ${integrationHash}, 'admission', 'denied', 'test', ${NOW - 1}),
          ('tie-a', ${integrationHash}, 'admission', 'denied', 'test', ${NOW - 1})
      `;
      const first = yield* control.listSecurityEvents("event-page", { limit: 1 });
      assert.strictEqual(first.events[0]?.eventId, "tie-a");
      assert.isNotNull(first.nextCursor);
      const second = yield* control.listSecurityEvents("event-page", {
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.strictEqual(second.events[0]?.eventId, "tie-b");
      const malformed = yield* capture(
        control.listSecurityEvents("event-page", { cursor: "not-a-cursor" }),
      );
      assert.isFalse(malformed.ok);
      if (!malformed.ok) {
        assert.strictEqual(controlCode(malformed.error), "invalid_configuration");
      }
    }),
  );

  it.effect("compacts audit history to a documented bound while preserving anchor evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      trustedNow = NOW;
      const control = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
      const created = yield* control.createPending(config("retention"));
      const integrationHash = externalIntegrationIdentityHash("retention");
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 1152
        )
        INSERT INTO scient_external_integration_security_events (
          event_id, integration_hash, event_type, outcome, reason_code, occurred_at
        )
        SELECT printf('event-%04d', value), ${integrationHash}, 'admission', 'allowed',
               'authority_current', ${NOW} + value
        FROM sequence
      `;
      trustedNow = NOW + 2_000;
      yield* control.completePairing({
        externalIdentity: "retention",
        pairingToken: created.pairingToken,
        credentialReference: "keychain-ref:retention",
        peerIdentity: "unix-uid:501",
      });
      const count = Number(
        (yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM scient_external_integration_security_events
            WHERE integration_hash = ${integrationHash}
          `)[0]?.count ?? 0,
      );
      assert.strictEqual(count, EXTERNAL_INTEGRATION_SECURITY_EVENT_RETAINED_LIMIT);
      const anchors = yield* sql<{ readonly eventType: string }>`
        SELECT event_type AS "eventType"
        FROM scient_external_integration_security_events
        WHERE integration_hash = ${integrationHash} AND event_type IN ('created', 'paired')
        ORDER BY event_type
      `;
      assert.deepEqual(
        anchors.map(({ eventType }) => eventType),
        ["created", "paired"],
      );
      const page = yield* control.listSecurityEvents("retention", { limit: 100 });
      assert.strictEqual(page.events.length, 100);
      assert.strictEqual(
        page.retention.retainedLimit,
        EXTERNAL_INTEGRATION_SECURITY_EVENT_RETAINED_LIMIT,
      );
      assert.isAbove(page.retention.compactedCount, 0);
      assert.isNotNull(page.retention.compactedThrough);
    }),
  );
});
