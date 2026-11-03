import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "@effect/vitest";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import {
  readQueue,
  writeQueue,
  suspendQueue,
  type QueueDocument,
} from "../../orchestration-v2/legacy/LegacyQueueLedger.ts";

const threadId = ThreadId.make("queue-owner");
const savedAt = "2026-01-01T00:00:00.000Z";
const layer = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(layer));
const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  });
const change = <E>(
  operation: (doc: QueueDocument) => Effect.Effect<QueueDocument, E, SqlClient.SqlClient>,
) =>
  transaction(
    Effect.gen(function* () {
      const next = yield* operation(yield* readQueue(threadId));
      return yield* writeQueue(threadId, next);
    }),
  );
const enqueue = (id: string) =>
  change((doc) =>
    Effect.succeed({
      ...doc,
      items: [
        ...doc.items,
        {
          threadId,
          queueItemId: `qitem_${id}`,
          text: id,
          attachments: [],
          state: "waiting" as const,
          createdAt: savedAt,
          updatedAt: savedAt,
        },
      ],
    }),
  );

describe("legacy queue saved-document compatibility", () => {
  it.effect("refuses to save a document over the item cap", () =>
    run(
      Effect.gen(function* () {
        for (let index = 0; index < 20; index++) yield* enqueue(String(index));
        expect(Exit.isFailure(yield* Effect.exit(enqueue("overflow")))).toBe(true);
        expect((yield* readQueue(threadId)).items).toHaveLength(20);
      }),
    ),
  );

  it.effect("upgrades the previous Stop pause and retains its invalidation across reads", () =>
    run(
      Effect.gen(function* () {
        const doc = yield* enqueue("A");
        yield* writeQueue(threadId, {
          ...doc,
          blocked: true,
          turnId: "old",
          paused: "Queue paused after Stop. Retry when you are ready to continue.",
        });
        const upgraded = yield* readQueue(threadId);
        expect(upgraded.awaitingCompletion).toBe(true);
        expect(upgraded.paused).toBeNull();
        expect((yield* readQueue(threadId)).revision).toBe(upgraded.revision);
        expect(upgraded.items).toEqual(doc.items);
        expect(upgraded.blocked).toBe(false);
        expect(upgraded.turnId).toBeNull();
        const sql = yield* SqlClient.SqlClient;
        const invalidation = yield* sql<{ successful: number }>`
          SELECT successful FROM scient_queue_finalization
          WHERE thread_id = ${threadId} AND turn_id = 'old'`;
        expect(invalidation).toEqual([{ successful: 0 }]);
        const again = yield* readQueue(threadId);
        expect(again).toEqual(upgraded);
        expect(
          yield* sql`SELECT successful FROM scient_queue_finalization
          WHERE thread_id = ${threadId} AND turn_id = 'old'`,
        ).toEqual(invalidation);
      }),
    ),
  );

  it.effect("restart reconciliation preserves saved payloads and invalidates the old turn", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* enqueue("B");
        const doc = yield* readQueue(threadId);
        yield* writeQueue(threadId, { ...doc, blocked: true, turnId: "pre-restart" });
        const before = yield* readQueue(threadId);
        yield* transaction(suspendQueue(threadId, before));
        const waiting = yield* readQueue(threadId);
        expect(waiting.items).toEqual(before.items);
        expect(waiting.awaitingCompletion).toBe(true);
        expect(waiting.blocked).toBe(false);
        expect(waiting.turnId).toBeNull();
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`SELECT successful FROM scient_queue_finalization
          WHERE thread_id = ${threadId} AND turn_id = 'pre-restart'`,
        ).toEqual([{ successful: 0 }]);
        expect(yield* readQueue(threadId)).toEqual(waiting);
      }),
    ),
  );
});
