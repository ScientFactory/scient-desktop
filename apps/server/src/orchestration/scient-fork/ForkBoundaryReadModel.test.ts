import { MessageId, ThreadForkCopiedBoundary, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
const encodeCopiedBoundaries = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ThreadForkCopiedBoundary)),
);

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

function insertMessage(
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly turnId: string;
    readonly role: "user" | "assistant";
    readonly createdAt: string;
  },
) {
  return sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    ) VALUES (
      ${input.messageId}, ${input.threadId}, ${input.turnId}, ${input.role},
      ${input.role}, 0, ${input.createdAt}, ${input.createdAt}
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
    readonly copiedBoundariesJson?: string;
  },
) {
  return sql`
    INSERT INTO scient_thread_lineage (
      thread_id, forked_from_thread_id, fork_point_turn_id, fork_point_turn_count,
      source_checkpoint_turn_count, baseline_turn_id, baseline_user_message_id,
      baseline_assistant_message_id, workspace_mode, provider_mode,
      provider_bootstrap_status, attachment_copies_json, copied_boundaries_json, fidelity_mode,
      status, checkpoint_status, workspace_status, attempt_count, last_error,
      created_at, updated_at
    ) VALUES (
      ${input.threadId}, ${input.forkedFromThreadId}, NULL, ${input.forkPointTurnCount},
      NULL, ${input.baselineTurnId}, NULL, NULL, ${input.workspaceMode},
      'transcript-bootstrap', 'pending', '[]', ${input.copiedBoundariesJson ?? "[]"}, 'transcript-bootstrap',
      'pending', 'pending', 'pending', 0, NULL,
      ${input.createdAt}, ${input.createdAt}
    )
  `;
}

const layer = it.layer(SqlitePersistenceMemory);

layer("ForkBoundaryReadModel resolver", (it) => {
  const prepare = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_thread_messages`;
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
      yield* insertMessage(sql, {
        threadId: ORIGIN,
        messageId: U1,
        turnId: T1,
        role: "user",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* insertMessage(sql, {
        threadId: ORIGIN,
        messageId: A1,
        turnId: T1,
        role: "assistant",
        createdAt: "2026-01-01T00:00:02.000Z",
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
      yield* insertMessage(sql, {
        threadId: ORIGIN,
        messageId: U2,
        turnId: T2,
        role: "user",
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* insertMessage(sql, {
        threadId: ORIGIN,
        messageId: A2,
        turnId: T2,
        role: "assistant",
        createdAt: "2026-01-01T00:00:04.000Z",
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
      yield* insertMessage(sql, {
        threadId: ORIGIN,
        messageId: U3,
        turnId: T3,
        role: "user",
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      yield* insertMessage(sql, {
        threadId: ORIGIN,
        messageId: A3,
        turnId: T3,
        role: "assistant",
        createdAt: "2026-01-01T00:00:06.000Z",
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

  it.effect("resolves a user message to the completed boundary immediately before it", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* seedThreeTurns(sql);
      const resolver = makeForkBoundaryResolver(sql);

      const result = yield* resolver.resolve({
        originThreadId: ORIGIN,
        sourceUserMessageId: U2,
        threadCreatedAt: THREAD_CREATED_AT,
      });

      assert.strictEqual(result.forkPoint.kind, "user-message");
      assert.strictEqual(result.selectedBoundary.assistantMessageId, A1);
      assert.strictEqual(result.selectedBoundary.conversationTurnCount, 1);
    }),
  );

  it.effect("resolves the first user message to the synthetic turn-zero boundary", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* seedThreeTurns(sql);
      const resolver = makeForkBoundaryResolver(sql);

      const result = yield* resolver.resolve({
        originThreadId: ORIGIN,
        sourceUserMessageId: U1,
        threadCreatedAt: THREAD_CREATED_AT,
      });

      assert.strictEqual(result.selectedBoundary.conversationTurnCount, 0);
      assert.strictEqual(result.selectedBoundary.assistantMessageId, null);
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
      // VAL-BOUNDARY-008: the checkpoint count is exactly the selected
      // boundary's own checkpoint (T1 → count 1), not a later turn's.
      assert.strictEqual(result.selectedBoundary.checkpointTurnCount, 1);
      assert.strictEqual(result.selectedBoundary.checkpointStatus, "ready");
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

  it.effect("resolves copied boundaries directly when forking a fork", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      const forkThreadId = ThreadId.make("recursive-fork-origin");
      const copiedTurn1 = TurnId.make("copied-turn-1");
      const copiedTurn2 = TurnId.make("copied-turn-2");
      const copiedUser1 = MessageId.make("copied-user-1");
      const copiedUser2 = MessageId.make("copied-user-2");
      const copiedAssistant1 = MessageId.make("copied-assistant-1");
      const copiedAssistant2 = MessageId.make("copied-assistant-2");
      const nativeTurnId = TurnId.make("recursive-native-turn-1");
      const nativeUser = MessageId.make("recursive-native-user-1");
      const nativeAssistant = MessageId.make("recursive-native-assistant-1");
      const copiedBoundaries = [
        {
          turnId: copiedTurn1,
          userMessageId: copiedUser1,
          assistantMessageId: copiedAssistant1,
          completedAt: "2026-01-01T00:00:02.000Z",
        },
        {
          turnId: copiedTurn2,
          userMessageId: copiedUser2,
          assistantMessageId: copiedAssistant2,
          completedAt: "2026-01-01T00:00:04.000Z",
        },
      ];

      yield* insertLineage(sql, {
        threadId: forkThreadId,
        forkedFromThreadId: ORIGIN,
        baselineTurnId: copiedTurn2,
        forkPointTurnCount: 2,
        workspaceMode: "local",
        createdAt: NOW,
        copiedBoundariesJson: encodeCopiedBoundaries(copiedBoundaries),
      });
      // Copied messages exist in the destination transcript and projection
      // creates completed turn rows for their assistant messages. The manifest
      // remains their logical authority, so these rows must not be appended a
      // second time as native post-fork turns.
      for (const [turnId, userMessageId, assistantMessageId, completedAt] of [
        [copiedTurn1, copiedUser1, copiedAssistant1, "2026-01-01T00:00:02.000Z"],
        [copiedTurn2, copiedUser2, copiedAssistant2, "2026-01-01T00:00:04.000Z"],
      ] as const) {
        yield* insertMessage(sql, {
          threadId: forkThreadId,
          messageId: userMessageId,
          turnId,
          role: "user",
          createdAt: completedAt,
        });
        yield* insertMessage(sql, {
          threadId: forkThreadId,
          messageId: assistantMessageId,
          turnId,
          role: "assistant",
          createdAt: completedAt,
        });
      }
      yield* insertTurn(sql, {
        threadId: forkThreadId,
        turnId: copiedTurn1,
        pendingMessageId: null,
        assistantMessageId: copiedAssistant1,
        state: "completed",
        requestedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        checkpointTurnCount: null,
        checkpointStatus: null,
      });
      yield* insertTurn(sql, {
        threadId: forkThreadId,
        turnId: copiedTurn2,
        pendingMessageId: null,
        assistantMessageId: copiedAssistant2,
        state: "completed",
        requestedAt: "2026-01-01T00:00:03.000Z",
        completedAt: "2026-01-01T00:00:04.000Z",
        checkpointTurnCount: 0,
        checkpointStatus: "ready",
      });
      yield* insertTurn(sql, {
        threadId: forkThreadId,
        turnId: nativeTurnId,
        pendingMessageId: nativeUser,
        assistantMessageId: nativeAssistant,
        state: "completed",
        requestedAt: "2026-01-01T00:00:05.000Z",
        completedAt: "2026-01-01T00:00:06.000Z",
        checkpointTurnCount: 1,
        checkpointStatus: "ready",
      });
      yield* insertMessage(sql, {
        threadId: forkThreadId,
        messageId: nativeUser,
        turnId: nativeTurnId,
        role: "user",
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      yield* insertMessage(sql, {
        threadId: forkThreadId,
        messageId: nativeAssistant,
        turnId: nativeTurnId,
        role: "assistant",
        createdAt: "2026-01-01T00:00:06.000Z",
      });

      const resolver = makeForkBoundaryResolver(sql);
      const copiedAssistantResult = yield* resolver.resolve({
        originThreadId: forkThreadId,
        sourceAssistantMessageId: copiedAssistant1,
        threadCreatedAt: NOW,
      });
      assert.strictEqual(copiedAssistantResult.selectedBoundary.turnId, copiedTurn1);
      assert.strictEqual(copiedAssistantResult.boundaries.length, 4);
      assert.deepStrictEqual(
        copiedAssistantResult.boundaries.map((boundary) => boundary.assistantMessageId),
        [null, copiedAssistant1, copiedAssistant2, nativeAssistant],
      );

      const copiedUserResult = yield* resolver.resolve({
        originThreadId: forkThreadId,
        sourceUserMessageId: copiedUser2,
        threadCreatedAt: NOW,
      });
      assert.strictEqual(copiedUserResult.forkPoint.kind, "user-message");
      assert.strictEqual(copiedUserResult.selectedBoundary.assistantMessageId, copiedAssistant1);

      const nativeResult = yield* resolver.resolve({
        originThreadId: forkThreadId,
        sourceAssistantMessageId: nativeAssistant,
        threadCreatedAt: NOW,
      });
      assert.strictEqual(nativeResult.selectedBoundary.conversationTurnCount, 1);
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
