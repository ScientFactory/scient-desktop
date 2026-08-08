import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ForkBoundaryResolutionError, makeForkBoundaryResolver } from "./ForkBoundaryReadModel.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ORIGIN = ThreadId.make("origin-one");
const OTHER = ThreadId.make("origin-other");
const THREAD_CREATED_AT = "2026-01-01T00:00:00.000Z";

const T1 = TurnId.make("turn-1");
const T2 = TurnId.make("turn-2");
const T3 = TurnId.make("turn-3");
const A1 = MessageId.make("assistant-1");
const A2 = MessageId.make("assistant-2");
const A3 = MessageId.make("assistant-3");
const U1 = MessageId.make("user-1");
const U2 = MessageId.make("user-2");
const U3 = MessageId.make("user-3");

interface TurnSeed {
  readonly threadId: string;
  readonly turnId: string;
  readonly pendingMessageId: string | null;
  readonly assistantMessageId: string | null;
  readonly state: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly checkpointTurnCount: number | null;
  readonly checkpointStatus: string | null;
}

function insertTurn(sql: SqlClient.SqlClient, seed: TurnSeed) {
  return sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, assistant_message_id,
      state, requested_at, started_at, completed_at,
      checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json
    ) VALUES (
      ${seed.threadId}, ${seed.turnId}, ${seed.pendingMessageId}, ${seed.assistantMessageId},
      ${seed.state}, ${seed.requestedAt}, ${seed.requestedAt}, ${seed.completedAt},
      ${seed.checkpointTurnCount}, NULL, ${seed.checkpointStatus}, '[]'
    )
  `;
}

function insertLineage(
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly forkedFromThreadId: string;
    readonly baselineTurnId: string;
    readonly forkPointTurnCount: number;
    readonly workspaceMode: string;
    readonly createdAt: string;
  },
) {
  return sql`
    INSERT INTO scient_thread_lineage (
      thread_id, forked_from_thread_id, fork_point_turn_id, fork_point_turn_count,
      source_checkpoint_turn_count, baseline_turn_id, baseline_user_message_id,
      baseline_assistant_message_id, workspace_mode, provider_mode,
      provider_bootstrap_status, attachment_copies_json, fidelity_mode,
      status, checkpoint_status, workspace_status, attempt_count, last_error,
      created_at, updated_at
    ) VALUES (
      ${input.threadId}, ${input.forkedFromThreadId}, NULL, ${input.forkPointTurnCount},
      NULL, ${input.baselineTurnId}, NULL, NULL, ${input.workspaceMode},
      'transcript-bootstrap', 'pending', '[]', 'transcript-bootstrap',
      'pending', 'pending', 'pending', 0, NULL,
      ${input.createdAt}, ${input.createdAt}
    )
  `;
}

const layer = it.layer(SqlitePersistenceMemory);

layer("ForkBoundaryReadModel resolver", (it) => {
  const prepare = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM scient_thread_lineage`;
    return sql;
  });

  const seedThreeTurns = (sql: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* insertTurn(sql, {
        threadId: ORIGIN,
        turnId: T1,
        pendingMessageId: U1,
        assistantMessageId: A1,
        state: "completed",
        requestedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        checkpointTurnCount: 1,
        checkpointStatus: "ready",
      });
      yield* insertTurn(sql, {
        threadId: ORIGIN,
        turnId: T2,
        pendingMessageId: U2,
        assistantMessageId: A2,
        state: "completed",
        requestedAt: "2026-01-01T00:00:03.000Z",
        completedAt: "2026-01-01T00:00:04.000Z",
        checkpointTurnCount: 2,
        checkpointStatus: "ready",
      });
      yield* insertTurn(sql, {
        threadId: ORIGIN,
        turnId: T3,
        pendingMessageId: U3,
        assistantMessageId: A3,
        state: "completed",
        requestedAt: "2026-01-01T00:00:05.000Z",
        completedAt: "2026-01-01T00:00:06.000Z",
        checkpointTurnCount: 3,
        checkpointStatus: "ready",
      });
    });

  it.effect("resolves the exact boundary by assistant message ID from SQL", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* seedThreeTurns(sql);
      const resolver = makeForkBoundaryResolver(sql);

      const result = yield* resolver.resolve({
        originThreadId: ORIGIN,
        sourceAssistantMessageId: A2,
        threadCreatedAt: THREAD_CREATED_AT,
      });

      assert.strictEqual(result.selectedBoundary.assistantMessageId, A2);
      assert.strictEqual(result.selectedBoundary.turnId, T2);
      assert.strictEqual(result.selectedBoundary.conversationTurnCount, 2);
    }),
  );

  it.effect("returns all SQL-backed boundaries ordered by turn count", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* seedThreeTurns(sql);
      const resolver = makeForkBoundaryResolver(sql);

      const result = yield* resolver.resolve({
        originThreadId: ORIGIN,
        sourceAssistantMessageId: A1,
        threadCreatedAt: THREAD_CREATED_AT,
      });

      // Baseline (synthetic) + three completed turns.
      assert.strictEqual(result.boundaries.length, 4);
      assert.strictEqual(result.boundaries[0]?.conversationTurnCount, 0);
      assert.strictEqual(result.boundaries[1]?.conversationTurnCount, 1);
      assert.strictEqual(result.boundaries[2]?.conversationTurnCount, 2);
      assert.strictEqual(result.boundaries[3]?.conversationTurnCount, 3);
    }),
  );

  it.effect("fails for an unknown assistant message ID", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* seedThreeTurns(sql);
      const resolver = makeForkBoundaryResolver(sql);

      const error = yield* resolver
        .resolve({
          originThreadId: ORIGIN,
          sourceAssistantMessageId: MessageId.make("missing-assistant"),
          threadCreatedAt: THREAD_CREATED_AT,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ForkBoundaryResolutionError);
      assert.include(error.detail, "missing-assistant");
    }),
  );

  it.effect("fails for an assistant owned by a different origin thread", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* seedThreeTurns(sql);
      // Seed a turn under a different thread with its own assistant.
      yield* insertTurn(sql, {
        threadId: OTHER,
        turnId: TurnId.make("other-turn-1"),
        pendingMessageId: MessageId.make("other-user-1"),
        assistantMessageId: MessageId.make("other-assistant-1"),
        state: "completed",
        requestedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        checkpointTurnCount: 1,
        checkpointStatus: "ready",
      });
      const resolver = makeForkBoundaryResolver(sql);

      // Requesting other-assistant-1 from ORIGIN must fail — the resolver
      // only queries projection_turns for the named origin thread.
      const error = yield* resolver
        .resolve({
          originThreadId: ORIGIN,
          sourceAssistantMessageId: MessageId.make("other-assistant-1"),
          threadCreatedAt: THREAD_CREATED_AT,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ForkBoundaryResolutionError);
    }),
  );

  it.effect("selects an older boundary even when a newer turn is completed", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* seedThreeTurns(sql);
      const resolver = makeForkBoundaryResolver(sql);

      const result = yield* resolver.resolve({
        originThreadId: ORIGIN,
        sourceAssistantMessageId: A1,
        threadCreatedAt: THREAD_CREATED_AT,
      });

      assert.strictEqual(result.selectedBoundary.assistantMessageId, A1);
      assert.strictEqual(result.selectedBoundary.turnId, T1);
      assert.strictEqual(result.selectedBoundary.conversationTurnCount, 1);
    }),
  );

  it.effect("excludes running turns from boundary resolution", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* seedThreeTurns(sql);
      // Add a running turn whose assistant message would be selectable if
      // state were not checked.
      yield* insertTurn(sql, {
        threadId: ORIGIN,
        turnId: TurnId.make("turn-running"),
        pendingMessageId: MessageId.make("user-running"),
        assistantMessageId: MessageId.make("assistant-running"),
        state: "running",
        requestedAt: "2026-01-01T00:00:07.000Z",
        completedAt: null,
        checkpointTurnCount: null,
        checkpointStatus: null,
      });
      const resolver = makeForkBoundaryResolver(sql);

      const error = yield* resolver
        .resolve({
          originThreadId: ORIGIN,
          sourceAssistantMessageId: MessageId.make("assistant-running"),
          threadCreatedAt: THREAD_CREATED_AT,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ForkBoundaryResolutionError);
    }),
  );

  it.effect("detects fork baseline via scient_thread_lineage join", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      // Seed a forked thread: its baseline turn is the fork baseline.
      const forkThreadId = ThreadId.make("fork-thread");
      const baselineTurnId = TurnId.make("fork-baseline");
      yield* insertLineage(sql, {
        threadId: forkThreadId,
        forkedFromThreadId: ORIGIN,
        baselineTurnId,
        forkPointTurnCount: 2,
        workspaceMode: "local",
        createdAt: NOW,
      });
      yield* insertTurn(sql, {
        threadId: forkThreadId,
        turnId: baselineTurnId,
        pendingMessageId: MessageId.make("fork-baseline-user"),
        assistantMessageId: MessageId.make("fork-baseline-assistant"),
        state: "completed",
        requestedAt: NOW,
        completedAt: NOW,
        checkpointTurnCount: 0,
        checkpointStatus: "ready",
      });
      // Seed a post-fork turn.
      const postForkTurnId = TurnId.make("fork-turn-1");
      yield* insertTurn(sql, {
        threadId: forkThreadId,
        turnId: postForkTurnId,
        pendingMessageId: MessageId.make("fork-user-1"),
        assistantMessageId: MessageId.make("fork-assistant-1"),
        state: "completed",
        requestedAt: "2026-01-01T00:00:10.000Z",
        completedAt: "2026-01-01T00:00:11.000Z",
        checkpointTurnCount: 1,
        checkpointStatus: "ready",
      });
      const resolver = makeForkBoundaryResolver(sql);

      // Select the baseline assistant.
      const baselineResult = yield* resolver.resolve({
        originThreadId: forkThreadId,
        sourceAssistantMessageId: MessageId.make("fork-baseline-assistant"),
        threadCreatedAt: NOW,
      });
      assert.strictEqual(baselineResult.selectedBoundary.conversationTurnCount, 0);
      assert.strictEqual(baselineResult.selectedBoundary.turnId, baselineTurnId);

      // Select the post-fork assistant.
      const postForkResult = yield* resolver.resolve({
        originThreadId: forkThreadId,
        sourceAssistantMessageId: MessageId.make("fork-assistant-1"),
        threadCreatedAt: NOW,
      });
      assert.strictEqual(postForkResult.selectedBoundary.conversationTurnCount, 1);
      assert.strictEqual(postForkResult.selectedBoundary.turnId, postForkTurnId);
    }),
  );

  it.effect("does not invent boundaries from missing SQL data", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      // No projection_turns rows at all for this thread.
      const resolver = makeForkBoundaryResolver(sql);

      const error = yield* resolver
        .resolve({
          originThreadId: ORIGIN,
          sourceAssistantMessageId: A1,
          threadCreatedAt: THREAD_CREATED_AT,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ForkBoundaryResolutionError);
    }),
  );

  it.effect("returns null checkpoint info for a completed non-Git turn", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* insertTurn(sql, {
        threadId: ORIGIN,
        turnId: T1,
        pendingMessageId: U1,
        assistantMessageId: A1,
        state: "completed",
        requestedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        checkpointTurnCount: null,
        checkpointStatus: null,
      });
      const resolver = makeForkBoundaryResolver(sql);

      const result = yield* resolver.resolve({
        originThreadId: ORIGIN,
        sourceAssistantMessageId: A1,
        threadCreatedAt: THREAD_CREATED_AT,
      });

      assert.isNull(result.selectedBoundary.checkpointTurnCount);
      assert.isNull(result.selectedBoundary.checkpointStatus);
    }),
  );
});
