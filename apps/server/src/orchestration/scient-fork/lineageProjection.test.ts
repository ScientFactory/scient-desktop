import { CommandId, EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { applyScientThreadLineageProjection } from "./lineageProjection.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ORIGIN = ThreadId.make("origin-thread");
const NEW = ThreadId.make("forked-thread");

function forkedEvent(sequence: number): Extract<OrchestrationEvent, { type: "thread.forked" }> {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: NEW,
    occurredAt: NOW,
    commandId: CommandId.make("cmd-fork"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-fork"),
    metadata: {},
    type: "thread.forked",
    payload: {
      originThreadId: ORIGIN,
      newThreadId: NEW,
      forkAtTurnCount: 2,
      workspaceMode: "local",
      fidelityMode: "chat-only",
      createdAt: NOW,
    },
  };
}

interface LineageRow {
  readonly thread_id: string;
  readonly forked_from_thread_id: string;
  readonly fork_point_turn_count: number;
  readonly workspace_mode: string;
  readonly fidelity_mode: string;
  readonly created_at: string;
}

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("scient thread lineage projection", (it) => {
  it.effect("folds thread.forked into scient_thread_lineage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // The in-memory sqlite layer is memoized across the suite's tests, so
      // isolate each test's assertions from prior inserts.
      yield* sql`DELETE FROM scient_thread_lineage`;

      yield* applyScientThreadLineageProjection(forkedEvent(11), sql);

      const rows = yield* sql<LineageRow>`SELECT * FROM scient_thread_lineage`;
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(rows[0], {
        thread_id: NEW,
        forked_from_thread_id: ORIGIN,
        fork_point_turn_count: 2,
        workspace_mode: "local",
        fidelity_mode: "chat-only",
        created_at: NOW,
      });
    }),
  );

  it.effect("ignores non-fork events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // The in-memory sqlite layer is memoized across the suite's tests, so
      // isolate each test's assertions from prior inserts.
      yield* sql`DELETE FROM scient_thread_lineage`;

      const nonFork = {
        ...forkedEvent(12),
        type: "thread.deleted",
        payload: { threadId: NEW, deletedAt: NOW },
      } as unknown as OrchestrationEvent;
      yield* applyScientThreadLineageProjection(nonFork, sql);

      const rows = yield* sql<LineageRow>`SELECT * FROM scient_thread_lineage`;
      assert.strictEqual(rows.length, 0);
    }),
  );

  it.effect("is idempotent when the same fork is re-applied", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // The in-memory sqlite layer is memoized across the suite's tests, so
      // isolate each test's assertions from prior inserts.
      yield* sql`DELETE FROM scient_thread_lineage`;

      yield* applyScientThreadLineageProjection(forkedEvent(11), sql);
      yield* applyScientThreadLineageProjection(forkedEvent(11), sql);

      const rows = yield* sql<LineageRow>`SELECT * FROM scient_thread_lineage`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.thread_id, NEW);
    }),
  );

  it.effect("updates fidelity_mode when a fork completes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DELETE FROM scient_thread_lineage`;

      yield* applyScientThreadLineageProjection(forkedEvent(11), sql);
      const completed = {
        ...forkedEvent(12),
        type: "thread.fork-completed",
        payload: { threadId: NEW, fidelityMode: "native-session" },
      } as unknown as OrchestrationEvent;
      yield* applyScientThreadLineageProjection(completed, sql);

      const rows = yield* sql<LineageRow>`SELECT * FROM scient_thread_lineage`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.fidelity_mode, "native-session");
    }),
  );
});
