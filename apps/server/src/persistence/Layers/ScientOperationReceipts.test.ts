import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  beginScientOperation,
  completeScientOperation,
  makeScientOperationAuthority,
  SCIENT_OPERATION_DEFINITIONS,
} from "../../scientOperations/authority.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  makeScientOperationReceiptRepository,
  scientOperationAttributionHash,
} from "./ScientOperationReceipts.ts";
import type { ScientOperationReceiptRepositoryShape } from "../Services/ScientOperationReceipts.ts";

const NOW = 1_800_000_000_000;

const authority = makeScientOperationAuthority({
  authorityId: "authority-sensitive",
  generation: "generation-sensitive",
  actor: {
    kind: "provider-thread",
    threadId: "caller-thread",
    provider: "codex",
    sessionKey: "session-sensitive",
  },
  projectIds: ["project-1"],
  capabilities: ["thread:drive", "thread:read"],
  issuedAt: NOW - 1,
  expiresAt: null,
  revokedAt: null,
});

function envelope(input: {
  readonly operationId: string;
  readonly requestId?: string;
  readonly fingerprint?: string;
}) {
  const started = beginScientOperation({
    authority,
    definition: SCIENT_OPERATION_DEFINITIONS["thread.message.send"],
    projectId: "project-1",
    ingress: "provider-gateway",
    operationId: input.operationId,
    semanticIdempotencyIdentity: input.requestId ?? null,
    semanticIdempotencyScope:
      input.requestId === undefined
        ? null
        : {
            kind: "provider-turn",
            provider: "codex",
            callerThreadId: "caller-thread",
            callerTurnId: "caller-turn",
          },
    payloadFingerprint: input.fingerprint ?? "fingerprint-1",
    receivedAt: NOW,
  });
  if (!started.allow) throw new Error("test authority rejected");
  return started.envelope;
}

function receipt(
  operationEnvelope: ReturnType<typeof envelope>,
  input: {
    readonly receiptId: string;
    readonly outcome?: "succeeded" | "failed" | "uncertain/reconciliation-required";
    readonly finishedAt?: number;
    readonly effects?: ReadonlyArray<{
      readonly kind: "orchestration-command";
      readonly identity: string;
    }>;
  },
) {
  return completeScientOperation({
    envelope: operationEnvelope,
    receiptId: input.receiptId,
    finishedAt: input.finishedAt ?? NOW + 1,
    outcome: input.outcome ?? "succeeded",
    errorCode: input.outcome === "failed" ? "operation_failed" : null,
    effects:
      input.effects ??
      (operationEnvelope.operation === "thread.message.send" && input.outcome !== "failed"
        ? [durableIntent(operationEnvelope).effect]
        : []),
  });
}

const sqlite = it.layer(SqlitePersistenceMemory);

const resetDatabase: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM scient_operation_attempt_receipts`;
  yield* sql`DELETE FROM scient_operation_intents`;
  yield* sql`DELETE FROM scient_operation_receipts`;
  yield* sql`DELETE FROM scient_operation_claims`;
  yield* sql`DELETE FROM scient_operation_executor_owner`;
});

const claim = (
  repository: ScientOperationReceiptRepositoryShape,
  operationEnvelope: ReturnType<typeof envelope>,
) =>
  repository.claim({
    envelope: operationEnvelope,
    intent: durableIntent(operationEnvelope),
  });

const durableIntent = (operationEnvelope: ReturnType<typeof envelope>) => ({
  effect: {
    kind: "orchestration-command" as const,
    identity: `scient-operation:v2:${operationEnvelope.idempotency.claimKey}:thread-send`,
  },
  expectedAggregateKind: "thread" as const,
  expectedAggregateId: "target-thread",
  replayResult: {
    kind: "thread.message.send.v1" as const,
    threadId: "target-thread",
    dispatched: "queue" as const,
  },
});

sqlite("ScientOperationReceiptRepository", (it) => {
  it("uses stable domain-separated attribution digest vectors", () => {
    assert.strictEqual(
      scientOperationAttributionHash("provider-thread", "codex", "caller-thread"),
      "sha256:v1:8421523debced01df204e4631f8b612076e399a49fd262ebe2b07c2c373bfa22",
    );
    assert.notStrictEqual(
      scientOperationAttributionHash("automation", "same"),
      scientOperationAttributionHash("integration", "same"),
    );
    assert.notStrictEqual(
      scientOperationAttributionHash("provider-thread", "codex", "caller-thread"),
      scientOperationAttributionHash("provider-turn", "codex", "caller-thread", "caller-turn"),
    );
  });

  it.effect("persists only approved replay and redacted authority fields", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* makeScientOperationReceiptRepository({ ownerId: "owner-1" });
      yield* repository.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
      const operationEnvelope = envelope({
        operationId: "operation-1",
        requestId: "request-sensitive",
      });
      assert.deepStrictEqual(yield* claim(repository, operationEnvelope), { kind: "acquired" });
      yield* repository.finish({
        envelope: operationEnvelope,
        receipt: receipt(operationEnvelope, {
          receiptId: "receipt-1",
          effects: [durableIntent(operationEnvelope).effect],
        }),
        replayResult: {
          kind: "thread.message.send.v1",
          threadId: "target-thread",
          dispatched: "queue",
        },
      });

      const state = yield* repository.getByClaimKey({
        claimKey: operationEnvelope.idempotency.claimKey,
      });
      assert.isTrue(Option.isSome(state));
      if (Option.isNone(state)) return;
      assert.strictEqual(state.value.status, "succeeded");
      assert.deepStrictEqual(state.value.replayResult, {
        kind: "thread.message.send.v1",
        threadId: "target-thread",
        dispatched: "queue",
      });
      assert.strictEqual(state.value.receipt?.receiptSequence, 1);
      assert.match(state.value.receipt?.authorityGenerationHash ?? "", /^sha256:/u);

      const stored = JSON.stringify(
        yield* sql`
          SELECT * FROM scient_operation_claims
          JOIN scient_operation_receipts USING (claim_key)
          JOIN scient_operation_attempt_receipts USING (claim_key)
          JOIN scient_operation_intents USING (claim_key)
        `,
      );
      assert.notInclude(stored, "generation-sensitive");
      assert.notInclude(stored, "session-sensitive");
      assert.notInclude(stored, "request-sensitive");
      assert.notInclude(stored, "caller-thread");
      assert.notInclude(stored, "caller-turn");
      assert.include(stored, "target-thread");
    }),
  );

  it.effect("detects payload conflicts and rejects a stale attempt's late finish", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      const repository = yield* makeScientOperationReceiptRepository({ ownerId: "owner-1" });
      yield* repository.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
      const first = envelope({ operationId: "attempt-1", requestId: "same-request" });
      yield* claim(repository, first);
      const conflicting = envelope({
        operationId: "attempt-conflict",
        requestId: "same-request",
        fingerprint: "different-fingerprint",
      });
      assert.deepStrictEqual(yield* claim(repository, conflicting), { kind: "payload-conflict" });

      yield* repository.finish({
        envelope: first,
        receipt: receipt(first, { receiptId: "failed-1", outcome: "failed" }),
        replayResult: null,
      });
      const retry = envelope({ operationId: "attempt-2", requestId: "same-request" });
      assert.deepStrictEqual(yield* claim(repository, retry), { kind: "acquired" });
      const lateSucceeded = yield* repository
        .finish({
          envelope: first,
          receipt: receipt(first, { receiptId: "late-success" }),
          replayResult: {
            kind: "thread.message.send.v1",
            threadId: "target-thread",
            dispatched: "queue",
          },
        })
        .pipe(
          Effect.match({
            onFailure: () => false,
            onSuccess: () => true,
          }),
        );
      assert.isFalse(lateSucceeded);
    }),
  );

  it.effect("orders reconciliation by sequence even when the wall clock rolls back", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      const repository = yield* makeScientOperationReceiptRepository({ ownerId: "owner-1" });
      yield* repository.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
      const operationEnvelope = envelope({ operationId: "operation-clock", requestId: "clock" });
      yield* repository.claim({
        envelope: operationEnvelope,
        intent: durableIntent(operationEnvelope),
      });
      yield* repository.finish({
        envelope: operationEnvelope,
        receipt: receipt(operationEnvelope, {
          receiptId: "uncertain-clock",
          outcome: "uncertain/reconciliation-required",
          finishedAt: NOW + 100,
        }),
        replayResult: null,
      });
      const reconciled = yield* repository.reconcileIntent({
        claimKey: operationEnvelope.idempotency.claimKey,
        receiptId: "reconciled-clock",
        commandId: durableIntent(operationEnvelope).effect.identity,
        aggregateKind: "thread",
        aggregateId: "target-thread",
        resultSequence: 42,
        commandStatus: "accepted",
        commandError: null,
        finishedAt: NOW - 100,
      });
      assert.strictEqual(reconciled.receiptSequence, 2);
      assert.strictEqual(reconciled.reconcilesReceiptId, "uncertain-clock");
      const state = yield* repository.getByClaimKey({
        claimKey: operationEnvelope.idempotency.claimKey,
      });
      assert.isTrue(Option.isSome(state));
      if (Option.isSome(state))
        assert.strictEqual(state.value.receipt?.receiptId, "reconciled-clock");
    }),
  );

  it.effect("keeps replay eligibility pending until an exact terminal release decision", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      const sql = yield* SqlClient.SqlClient;
      const oldOwner = yield* makeScientOperationReceiptRepository({ ownerId: "owner-old" });
      yield* oldOwner.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
      const first = envelope({ operationId: "replay-origin", requestId: "replay-key" });
      yield* claim(oldOwner, first);
      yield* oldOwner.finish({
        envelope: first,
        receipt: receipt(first, { receiptId: "replay-origin-receipt" }),
        replayResult: durableIntent(first).replayResult,
      });

      const retry = envelope({ operationId: "replay-attempt", requestId: "replay-key" });
      const replay = yield* claim(oldOwner, retry);
      assert.strictEqual(replay.kind, "replay");
      if (replay.kind !== "replay") return;
      const pending = yield* sql<{ readonly status: string; readonly finishedAt: number | null }>`
        SELECT replay_release_status AS "status", finished_at AS "finishedAt"
        FROM scient_operation_attempt_receipts WHERE operation_id = ${retry.operationId}
      `;
      assert.deepStrictEqual(pending, [{ status: "pending", finishedAt: null }]);
      yield* oldOwner.finalizeReplayAttempt({
        ...replay.attempt,
        disposition: "allowed",
        errorCode: null,
        finishedAt: NOW + 10,
      });
      // Exact retry is idempotent even when its observer supplies a later wall clock.
      yield* oldOwner.finalizeReplayAttempt({
        ...replay.attempt,
        disposition: "allowed",
        errorCode: null,
        finishedAt: NOW + 20,
      });
      const conflictAccepted = yield* oldOwner
        .finalizeReplayAttempt({
          ...replay.attempt,
          disposition: "denied",
          errorCode: "replay_release_denied",
          finishedAt: NOW + 20,
        })
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(conflictAccepted);

      const crashedRetry = envelope({
        operationId: "replay-crashed",
        requestId: "replay-key",
      });
      const crashed = yield* claim(oldOwner, crashedRetry);
      assert.strictEqual(crashed.kind, "replay");
      if (crashed.kind !== "replay") return;
      const newOwner = yield* makeScientOperationReceiptRepository({ ownerId: "owner-new" });
      yield* newOwner.acquireOwner({ now: NOW + 31_000, staleBefore: NOW + 1 });
      yield* newOwner.recoverInterrupted({
        recoveredAt: NOW + 31_001,
      });
      const recovered = yield* sql<{ readonly status: string; readonly errorCode: string }>`
        SELECT replay_release_status AS "status", replay_release_error_code AS "errorCode"
        FROM scient_operation_attempt_receipts WHERE operation_id = ${crashedRetry.operationId}
      `;
      assert.deepStrictEqual(recovered, [
        { status: "unknown", errorCode: "replay_release_audit_unknown" },
      ]);
      const staleAllowed = yield* oldOwner
        .finalizeReplayAttempt({
          ...crashed.attempt,
          disposition: "allowed",
          errorCode: null,
          finishedAt: NOW + 31_002,
        })
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(staleAllowed);
    }),
  );

  it.effect("hashes an interrupt's independent authorizing turn attribution", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* makeScientOperationReceiptRepository({ ownerId: "owner-1" });
      yield* repository.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
      const started = beginScientOperation({
        authority,
        definition: SCIENT_OPERATION_DEFINITIONS["thread.interrupt"],
        projectId: "project-1",
        ingress: "provider-gateway",
        operationId: "interrupt-operation",
        semanticIdempotencyIdentity: null,
        providerAuthorizingTurnId: "interrupt-turn-sensitive",
        payloadFingerprint: "interrupt-payload",
        receivedAt: NOW,
      });
      if (!started.allow) throw new Error("interrupt authority rejected");
      yield* repository.claim({ envelope: started.envelope, intent: null });
      const expectedTurn = scientOperationAttributionHash(
        "provider-turn",
        "codex",
        "caller-thread",
        "interrupt-turn-sensitive",
      );
      const rows = yield* sql<{
        readonly providerTurnHash: string;
        readonly actorRefHash: string;
        readonly providerThreadHash: string;
      }>`
        SELECT provider_turn_hash AS "providerTurnHash",
               actor_ref_hash AS "actorRefHash",
               provider_thread_hash AS "providerThreadHash"
        FROM scient_operation_attempt_receipts
        WHERE operation_id = ${started.envelope.operationId}
      `;
      assert.strictEqual(rows[0]?.providerTurnHash, expectedTurn);
      assert.strictEqual(rows[0]?.actorRefHash, rows[0]?.providerThreadHash);
      assert.notInclude(JSON.stringify(rows), "interrupt-turn-sensitive");
    }),
  );

  it.effect("pseudonymizes every actor-specific persisted identifier", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* makeScientOperationReceiptRepository({ ownerId: "owner-1" });
      yield* repository.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
      const actors = [
        {
          actor: {
            kind: "provider-thread" as const,
            threadId: "provider-thread-sensitive",
            provider: "codex",
            sessionKey: "provider-session-sensitive",
          },
          providerAuthorizingTurnId: "provider-turn-sensitive",
        },
        {
          actor: {
            kind: "automation-run" as const,
            automationId: "automation-sensitive",
            runId: "automation-run-sensitive",
          },
        },
        {
          actor: {
            kind: "external-integration" as const,
            integrationId: "integration-sensitive",
          },
        },
        { actor: { kind: "manual-user" as const, userId: "manual-user-sensitive" } },
      ];
      for (const [index, item] of actors.entries()) {
        const actorAuthority = makeScientOperationAuthority({
          authorityId: `actor-authority-sensitive-${index}`,
          generation: `actor-generation-sensitive-${index}`,
          actor: item.actor,
          projectIds: ["project-1"],
          capabilities: ["thread:read"],
          issuedAt: NOW - 1,
          expiresAt: null,
          revokedAt: null,
        });
        const started = beginScientOperation({
          authority: actorAuthority,
          definition: SCIENT_OPERATION_DEFINITIONS["thread.read"],
          projectId: "project-1",
          ingress:
            item.actor.kind === "automation-run"
              ? "automation"
              : item.actor.kind === "external-integration"
                ? "external-mcp"
                : "provider-gateway",
          operationId: `actor-operation-${index}`,
          parentOperationId: `actor-parent-sensitive-${index}`,
          semanticIdempotencyIdentity: null,
          ...(item.providerAuthorizingTurnId === undefined
            ? {}
            : { providerAuthorizingTurnId: item.providerAuthorizingTurnId }),
          payloadFingerprint: `actor-payload-${index}`,
          receivedAt: NOW,
        });
        if (!started.allow) throw new Error("actor authority rejected");
        yield* repository.claim({ envelope: started.envelope, intent: null });
        yield* repository.finish({
          envelope: started.envelope,
          receipt: completeScientOperation({
            envelope: started.envelope,
            receiptId: `actor-receipt-${index}`,
            finishedAt: NOW + 1,
            outcome: "succeeded",
            effects: [],
          }),
          replayResult: null,
        });
      }
      const stored = JSON.stringify({
        claims: yield* sql`SELECT * FROM scient_operation_claims`,
        attempts: yield* sql`SELECT * FROM scient_operation_attempt_receipts`,
        intents: yield* sql`SELECT * FROM scient_operation_intents`,
        receipts: yield* sql`SELECT * FROM scient_operation_receipts`,
      });
      for (const raw of [
        "provider-thread-sensitive",
        "provider-turn-sensitive",
        "provider-session-sensitive",
        "automation-sensitive",
        "automation-run-sensitive",
        "integration-sensitive",
        "manual-user-sensitive",
        "actor-authority-sensitive",
        "actor-generation-sensitive",
        "actor-parent-sensitive",
      ]) {
        assert.notInclude(stored, raw);
      }
      assert.match(stored, /sha256:v1:[a-f0-9]{64}/u);
    }),
  );

  it.effect("takes over only a stale owner, recovers its claim, and rejects its late finish", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      const oldOwner = yield* makeScientOperationReceiptRepository({ ownerId: "old-owner" });
      const newOwner = yield* makeScientOperationReceiptRepository({ ownerId: "new-owner" });
      yield* oldOwner.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
      const operationEnvelope = envelope({ operationId: "frozen-operation", requestId: "frozen" });
      yield* claim(oldOwner, operationEnvelope);

      const activeTakeover = yield* newOwner
        .acquireOwner({ now: NOW + 10_000, staleBefore: NOW - 20_000 })
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(activeTakeover);
      yield* newOwner.acquireOwner({ now: NOW + 31_000, staleBefore: NOW + 1_000 });
      assert.strictEqual(
        yield* newOwner.recoverInterrupted({
          recoveredAt: NOW + 31_001,
        }),
        1,
      );
      const sql = yield* SqlClient.SqlClient;
      const recoveredAttribution = yield* sql<{
        readonly claimActorRefHash: string;
        readonly receiptActorRefHash: string;
      }>`
        SELECT c.actor_ref_hash AS "claimActorRefHash",
               r.actor_ref_hash AS "receiptActorRefHash"
        FROM scient_operation_claims c
        JOIN scient_operation_receipts r USING (claim_key)
        WHERE c.claim_key = ${operationEnvelope.idempotency.claimKey}
      `;
      assert.strictEqual(
        recoveredAttribution[0]?.receiptActorRefHash,
        recoveredAttribution[0]?.claimActorRefHash,
      );
      assert.notInclude(JSON.stringify(recoveredAttribution), "caller-thread");
      const lateFinish = yield* oldOwner
        .finish({
          envelope: operationEnvelope,
          receipt: receipt(operationEnvelope, { receiptId: "old-late" }),
          replayResult: {
            kind: "thread.message.send.v1",
            threadId: "target-thread",
            dispatched: "queue",
          },
        })
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      assert.isFalse(lateFinish);
    }),
  );

  it.effect(
    "rejects stale-owner recovery after takeover without changing live-owner claims or replays",
    () =>
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* SqlClient.SqlClient;
        const oldOwner = yield* makeScientOperationReceiptRepository({ ownerId: "old-owner" });
        const newOwner = yield* makeScientOperationReceiptRepository({ ownerId: "new-owner" });
        yield* oldOwner.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
        yield* newOwner.acquireOwner({ now: NOW + 31_000, staleBefore: NOW + 1_000 });

        const inProgress = envelope({
          operationId: "new-owner-in-progress",
          requestId: "new-owner-in-progress-key",
        });
        assert.deepStrictEqual(yield* claim(newOwner, inProgress), { kind: "acquired" });

        const replayOrigin = envelope({
          operationId: "new-owner-replay-origin",
          requestId: "new-owner-replay-key",
        });
        assert.deepStrictEqual(yield* claim(newOwner, replayOrigin), { kind: "acquired" });
        yield* newOwner.finish({
          envelope: replayOrigin,
          receipt: receipt(replayOrigin, { receiptId: "new-owner-replay-receipt" }),
          replayResult: durableIntent(replayOrigin).replayResult,
        });
        const replayAttempt = envelope({
          operationId: "new-owner-replay-attempt",
          requestId: "new-owner-replay-key",
        });
        const replay = yield* claim(newOwner, replayAttempt);
        assert.strictEqual(replay.kind, "replay");

        const staleRecoveryAccepted = yield* oldOwner
          .recoverInterrupted({ recoveredAt: NOW + 31_001 })
          .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
        assert.isFalse(staleRecoveryAccepted);

        const liveClaim = yield* sql<{
          readonly status: string;
          readonly ownerId: string;
        }>`
          SELECT status, owner_id AS "ownerId"
          FROM scient_operation_claims
          WHERE operation_id = ${inProgress.operationId}
        `;
        assert.deepStrictEqual(liveClaim, [{ status: "in_progress", ownerId: newOwner.ownerId }]);
        const liveReplay = yield* sql<{
          readonly status: string;
          readonly finishedAt: number | null;
          readonly ownerId: string;
        }>`
          SELECT replay_release_status AS "status", finished_at AS "finishedAt",
                 attempt_owner_id AS "ownerId"
          FROM scient_operation_attempt_receipts
          WHERE operation_id = ${replayAttempt.operationId}
        `;
        assert.deepStrictEqual(liveReplay, [
          { status: "pending", finishedAt: null, ownerId: newOwner.ownerId },
        ]);
      }),
  );

  it.effect(
    "retention prunes old unique terminals but preserves semantic and uncertain claims",
    () =>
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* makeScientOperationReceiptRepository({ ownerId: "owner-1" });
        yield* repository.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
        const unique = envelope({ operationId: "unique-operation" });
        const semantic = envelope({
          operationId: "semantic-operation",
          requestId: "keep-semantic",
        });
        const uncertain = envelope({
          operationId: "uncertain-operation",
          requestId: "keep-uncertain",
        });
        for (const item of [unique, semantic, uncertain]) yield* claim(repository, item);
        yield* repository.finish({
          envelope: unique,
          receipt: receipt(unique, { receiptId: "unique-receipt", finishedAt: NOW - 10_000 }),
          replayResult: durableIntent(unique).replayResult,
        });
        yield* repository.finish({
          envelope: semantic,
          receipt: receipt(semantic, { receiptId: "semantic-receipt", finishedAt: NOW - 10_000 }),
          replayResult: {
            kind: "thread.message.send.v1",
            threadId: "target-thread",
            dispatched: "queue",
          },
        });
        yield* sql`
        UPDATE scient_operation_claims
        SET updated_at = ${NOW - 10_000}, finished_at = ${NOW - 10_000}
        WHERE claim_key = ${uncertain.idempotency.claimKey}
      `;
        assert.strictEqual(yield* repository.pruneTerminal({ finishedBefore: NOW, limit: 10 }), 1);
        const remaining = yield* sql<{ readonly claimKey: string }>`
        SELECT claim_key AS "claimKey" FROM scient_operation_claims
      `;
        assert.sameMembers(
          remaining.map((row) => row.claimKey),
          [semantic.idempotency.claimKey, uncertain.idempotency.claimKey],
        );
      }),
  );

  it.effect("rejects free-text and path-like orchestration command identities", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      const repository = yield* makeScientOperationReceiptRepository({ ownerId: "owner-1" });
      yield* repository.acquireOwner({ now: NOW, staleBefore: NOW - 30_000 });
      for (const [index, identity] of ["free text", "/tmp/command", "folder\\command"].entries()) {
        const operationEnvelope = envelope({
          operationId: `bad-effect-${index}`,
          requestId: `bad-effect-${index}`,
        });
        yield* claim(repository, operationEnvelope);
        const persisted = yield* repository
          .finish({
            envelope: operationEnvelope,
            receipt: receipt(operationEnvelope, {
              receiptId: `bad-effect-receipt-${index}`,
              effects: [{ kind: "orchestration-command", identity }],
            }),
            replayResult: {
              kind: "thread.message.send.v1",
              threadId: "target-thread",
              dispatched: "queue",
            },
          })
          .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
        assert.isFalse(persisted);
      }
    }),
  );
});
