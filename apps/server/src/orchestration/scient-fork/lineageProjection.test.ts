import { CommandId, EventId, ThreadId, TurnId, type OrchestrationEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { applyScientThreadLineageProjection } from "./lineageProjection.ts";
import { ensureScientForkSchema } from "./schema.ts";

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
      forkAtTurnId: TurnId.make("origin-turn-2"),
      forkAtTurnCount: 2,
      sourceCheckpointTurnCount: 2,
      baselineTurnId: TurnId.make("fork-baseline"),
      baselineUserMessageId: null,
      baselineAssistantMessageId: null,
      workspaceMode: "local",
      providerMode: "transcript-bootstrap",
      attachmentCopies: [],
      createdAt: NOW,
    },
  };
}

interface LineageRow {
  readonly thread_id: string;
  readonly forked_from_thread_id: string;
  readonly fork_point_turn_count: number;
  readonly workspace_mode: string;
  readonly provider_mode: string;
  readonly provider_bootstrap_status: string;
  readonly attachment_copies_json: string;
  readonly status: string;
  readonly checkpoint_status: string;
  readonly workspace_status: string;
  readonly attempt_count: number;
}

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("scient thread lineage projection", (it) => {
  const prepare = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureScientForkSchema(sql);
    yield* sql`DELETE FROM scient_thread_lineage`;
    return sql;
  });

  it.effect("records an accepted fork as durable pending work", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* applyScientThreadLineageProjection(forkedEvent(11), sql);

      const rows = yield* sql<LineageRow>`SELECT * FROM scient_thread_lineage`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.thread_id, NEW);
      assert.strictEqual(rows[0]?.forked_from_thread_id, ORIGIN);
      assert.strictEqual(rows[0]?.fork_point_turn_count, 2);
      assert.strictEqual(rows[0]?.workspace_mode, "local");
      assert.strictEqual(rows[0]?.provider_mode, "transcript-bootstrap");
      assert.strictEqual(rows[0]?.provider_bootstrap_status, "pending");
      assert.strictEqual(rows[0]?.attachment_copies_json, "[]");
      assert.strictEqual(rows[0]?.status, "pending");
      assert.strictEqual(rows[0]?.attempt_count, 0);
    }),
  );

  it.effect("ignores non-fork events", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
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

  it.effect("does not reset completed work when projection replay re-applies lineage", () =>
    Effect.gen(function* () {
      const sql = yield* prepare;
      yield* applyScientThreadLineageProjection(forkedEvent(11), sql);
      const completed = {
        ...forkedEvent(12),
        type: "thread.fork-completed",
        payload: {
          threadId: NEW,
          checkpointStatus: "ready",
          workspaceStatus: "shared",
        },
      } as OrchestrationEvent;
      yield* applyScientThreadLineageProjection(completed, sql);
      yield* applyScientThreadLineageProjection(forkedEvent(11), sql);

      const rows = yield* sql<LineageRow>`SELECT * FROM scient_thread_lineage`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.status, "ready");
      assert.strictEqual(rows[0]?.checkpoint_status, "ready");
      assert.strictEqual(rows[0]?.workspace_status, "shared");
    }),
  );
});
