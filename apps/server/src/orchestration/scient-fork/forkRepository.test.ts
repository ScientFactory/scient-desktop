/**
 * Scient fork repository lifecycle tests.
 *
 * Covers VAL-PERSIST-001 through VAL-PERSIST-004 and VAL-PERSIST-012:
 * pending durability/idempotence, bounded monotonic claims, failed retry
 * without new identity, abandoned terminal truthfulness, and the terminal
 * abandoned guard that prevents regression under any lifecycle operation.
 *
 * All fixtures are synthetic in-memory SQLite databases. No live user data.
 */
import { ThreadId, TurnId, MessageId, type ThreadForkedPayload } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  claimFork,
  getForkStatus,
  insertPendingFork,
  listRecoverableForks,
  markForkAbandoned,
  markForkFailed,
  markForkReady,
} from "./forkRepository.ts";

const NOW = "2026-08-08T12:00:00.000Z";
const LATER = "2026-08-08T13:00:00.000Z";
const THREAD = ThreadId.make("fork-lifecycle-thread");
const ORIGIN = ThreadId.make("origin-lifecycle");

function makePayload(threadId: string = THREAD): ThreadForkedPayload {
  return {
    originThreadId: ThreadId.make(ORIGIN),
    newThreadId: ThreadId.make(threadId),
    forkAtTurnId: TurnId.make("turn-2"),
    forkAtTurnCount: 2,
    sourceCheckpointTurnCount: 2,
    baselineTurnId: TurnId.make("baseline-1"),
    baselineUserMessageId: MessageId.make("user-1"),
    baselineAssistantMessageId: MessageId.make("assistant-1"),
    workspaceMode: "local",
    providerMode: "transcript-bootstrap",
    attachmentCopies: [],
    createdAt: NOW,
  };
}

interface LineageRow {
  readonly thread_id: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly provider_bootstrap_status: string;
  readonly checkpoint_status: string;
  readonly workspace_status: string;
  readonly updated_at: string | null;
  readonly created_at: string;
}

const readRow = (sql: SqlClient.SqlClient, threadId: string = THREAD) =>
  sql<LineageRow>`SELECT * FROM scient_thread_lineage WHERE thread_id = ${threadId}`.pipe(
    Effect.map((rows) => rows[0]),
  );

// SqlitePersistenceMemory already runs Scient migrations, so the
// scient_thread_lineage table is created with all canonical columns.
const layer = SqlitePersistenceMemory;

it.layer(layer)("forkRepository lifecycle", (it) => {
  const reset = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM scient_thread_lineage`;
    return sql;
  });

  // -------------------------------------------------------------------------
  // VAL-PERSIST-001: Pending lineage is durable and idempotent
  // -------------------------------------------------------------------------

  it.effect("insertPendingFork creates one pending row with immutable facts", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      const payload = makePayload();
      yield* insertPendingFork(sql, payload);

      const row = yield* readRow(sql);
      assert.isTrue(row !== undefined);
      assert.strictEqual(row!.status, "pending");
      assert.strictEqual(row!.attempt_count, 0);
      assert.strictEqual(row!.last_error, null);
      assert.strictEqual(row!.provider_bootstrap_status, "pending");
      assert.strictEqual(row!.created_at, NOW);
    }),
  );

  it.effect("replaying insertPendingFork is idempotent — identity and row count unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      const payload = makePayload();
      yield* insertPendingFork(sql, payload);
      yield* insertPendingFork(sql, payload);

      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM scient_thread_lineage WHERE thread_id = ${THREAD}
      `;
      assert.strictEqual(rows.length, 1);

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "pending");
      assert.strictEqual(row!.attempt_count, 0);
    }),
  );

  // -------------------------------------------------------------------------
  // VAL-PERSIST-002: Claims are bounded and monotonic
  // -------------------------------------------------------------------------

  it.effect("claim increments attempts, clears error, and sets provisioning", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());

      // Simulate a prior failure.
      yield* markForkFailed(sql, { threadId: THREAD, error: "prior crash", updatedAt: NOW });
      const failed = yield* readRow(sql);
      assert.strictEqual(failed!.status, "failed");
      assert.strictEqual(failed!.last_error, "prior crash");

      const claimed = yield* claimFork(sql, THREAD, LATER);
      assert.isTrue(claimed);

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "provisioning");
      assert.strictEqual(row!.attempt_count, 1);
      assert.strictEqual(row!.last_error, null);
    }),
  );

  it.effect("ready forks cannot be claimed", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkReady(sql, {
        threadId: THREAD,
        checkpointStatus: "ready",
        workspaceStatus: "shared",
        updatedAt: LATER,
      });

      const claimed = yield* claimFork(sql, THREAD, LATER);
      assert.isFalse(claimed);

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "ready");
      assert.strictEqual(row!.attempt_count, 1);
    }),
  );

  it.effect("abandoned forks cannot be claimed", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkAbandoned(sql, { threadId: THREAD, error: "terminal", updatedAt: LATER });

      const claimed = yield* claimFork(sql, THREAD, LATER);
      assert.isFalse(claimed);

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "abandoned");
    }),
  );

  // -------------------------------------------------------------------------
  // VAL-PERSIST-003: Failed work retries without new identity
  // -------------------------------------------------------------------------

  it.effect("failed fork can retry and reach ready without a new destination", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());

      // First attempt fails.
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkFailed(sql, { threadId: THREAD, error: "side effect crash", updatedAt: NOW });
      const failed = yield* readRow(sql);
      assert.strictEqual(failed!.status, "failed");
      assert.strictEqual(failed!.attempt_count, 1);

      // Restart: recovery lists the failed row.
      const recoverable = yield* listRecoverableForks(sql);
      assert.strictEqual(recoverable.length, 1);
      assert.strictEqual(recoverable[0]!.newThreadId, THREAD);

      // Second attempt succeeds.
      const claimed = yield* claimFork(sql, THREAD, LATER);
      assert.isTrue(claimed);
      yield* markForkReady(sql, {
        threadId: THREAD,
        checkpointStatus: "ready",
        workspaceStatus: "shared",
        updatedAt: LATER,
      });

      const ready = yield* readRow(sql);
      assert.strictEqual(ready!.status, "ready");
      assert.strictEqual(ready!.attempt_count, 2);
      assert.strictEqual(ready!.last_error, null);
      // Same thread identity — no new destination allocated.
      assert.strictEqual(ready!.thread_id, THREAD);
    }),
  );

  // -------------------------------------------------------------------------
  // VAL-PERSIST-004: Abandoned work is terminal and truthful
  // -------------------------------------------------------------------------

  it.effect("abandoned forks are excluded from recovery", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkAbandoned(sql, {
        threadId: THREAD,
        error: "permanently unusable",
        updatedAt: LATER,
      });

      const recoverable = yield* listRecoverableForks(sql);
      assert.strictEqual(recoverable.length, 0);

      const status = yield* getForkStatus(sql, THREAD);
      assert.strictEqual(status!.status, "abandoned");
      assert.strictEqual(status!.last_error, "permanently unusable");
    }),
  );

  // -------------------------------------------------------------------------
  // VAL-PERSIST-012: Abandoned is terminal and cannot regress
  // -------------------------------------------------------------------------

  it.effect("abandoned cannot regress to failed", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkAbandoned(sql, {
        threadId: THREAD,
        error: "terminal failure",
        updatedAt: LATER,
      });

      // Attempt to mark failed — must not regress.
      yield* markForkFailed(sql, { threadId: THREAD, error: "attempted retry", updatedAt: LATER });

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "abandoned");
      assert.strictEqual(row!.last_error, "terminal failure");
    }),
  );

  it.effect("abandoned cannot regress to ready", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkAbandoned(sql, {
        threadId: THREAD,
        error: "terminal failure",
        updatedAt: LATER,
      });

      // Attempt to mark ready — must not regress.
      yield* markForkReady(sql, {
        threadId: THREAD,
        checkpointStatus: "ready",
        workspaceStatus: "shared",
        updatedAt: LATER,
      });

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "abandoned");
      assert.strictEqual(row!.last_error, "terminal failure");
    }),
  );

  it.effect("abandoned cannot be reclaimed", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkAbandoned(sql, {
        threadId: THREAD,
        error: "terminal failure",
        updatedAt: LATER,
      });

      const claimed = yield* claimFork(sql, THREAD, LATER);
      assert.isFalse(claimed);

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "abandoned");
      assert.strictEqual(row!.attempt_count, 1);
    }),
  );

  it.effect("abandoned cannot be re-abandoned with a different error", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkAbandoned(sql, {
        threadId: THREAD,
        error: "original terminal",
        updatedAt: LATER,
      });

      // Attempt to re-abandon with a different error — must not change.
      yield* markForkAbandoned(sql, {
        threadId: THREAD,
        error: "different error",
        updatedAt: LATER,
      });

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "abandoned");
      assert.strictEqual(row!.last_error, "original terminal");
    }),
  );

  it.effect("ready cannot be marked failed", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkReady(sql, {
        threadId: THREAD,
        checkpointStatus: "ready",
        workspaceStatus: "shared",
        updatedAt: LATER,
      });

      yield* markForkFailed(sql, { threadId: THREAD, error: "late failure", updatedAt: LATER });

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "ready");
      assert.strictEqual(row!.last_error, null);
    }),
  );

  it.effect("ready cannot be abandoned", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* insertPendingFork(sql, makePayload());
      yield* claimFork(sql, THREAD, NOW);
      yield* markForkReady(sql, {
        threadId: THREAD,
        checkpointStatus: "ready",
        workspaceStatus: "shared",
        updatedAt: LATER,
      });

      yield* markForkAbandoned(sql, { threadId: THREAD, error: "late abandon", updatedAt: LATER });

      const row = yield* readRow(sql);
      assert.strictEqual(row!.status, "ready");
      assert.strictEqual(row!.last_error, null);
    }),
  );

  // -------------------------------------------------------------------------
  // Recovery selection: only pending/provisioning/failed with baseline
  // -------------------------------------------------------------------------

  it.effect("listRecoverableForks selects only pending, provisioning, and failed", () =>
    Effect.gen(function* () {
      const sql = yield* reset;

      // Seed one row in each lifecycle state.
      const states: Array<{ readonly id: string; readonly status: string }> = [
        { id: "fork-pending", status: "pending" },
        { id: "fork-provisioning", status: "provisioning" },
        { id: "fork-failed", status: "failed" },
        { id: "fork-ready", status: "ready" },
        { id: "fork-abandoned", status: "abandoned" },
      ];

      for (const state of states) {
        const payload = makePayload(state.id);
        yield* insertPendingFork(sql, payload);
        if (state.status !== "pending") {
          yield* claimFork(sql, ThreadId.make(state.id), NOW);
        }
        if (state.status === "failed") {
          yield* markForkFailed(sql, {
            threadId: ThreadId.make(state.id),
            error: "fail",
            updatedAt: NOW,
          });
        } else if (state.status === "abandoned") {
          yield* markForkAbandoned(sql, {
            threadId: ThreadId.make(state.id),
            error: "abandon",
            updatedAt: NOW,
          });
        } else if (state.status === "ready") {
          yield* markForkReady(sql, {
            threadId: ThreadId.make(state.id),
            checkpointStatus: "ready",
            workspaceStatus: "shared",
            updatedAt: NOW,
          });
        }
      }

      const recoverable = yield* listRecoverableForks(sql);
      const ids = recoverable.map((r) => r.newThreadId).sort();
      assert.deepStrictEqual(ids, ["fork-failed", "fork-pending", "fork-provisioning"]);
    }),
  );
});
