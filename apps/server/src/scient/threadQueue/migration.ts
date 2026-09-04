import { type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { QueueError, readQueue, writeQueue, type QueueDocument } from "./Ledger.ts";
import { listScientThreadQueue } from "./Store.ts";

export const importLegacyQueue = Effect.fn("ScientQueue.importLegacy")(function* (
  threadId: ThreadId,
  initial: QueueDocument,
) {
  if (initial.migrated) return initial;
  const config = yield* ServerConfig;
  const legacy = yield* Effect.tryPromise(() =>
    listScientThreadQueue({ stateDir: config.stateDir, threadId }),
  );
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* readQueue(threadId);
      if (current.migrated) return current;
      const source = current.revision === 0 ? initial : current;
      const items = [
        ...source.items,
        ...legacy.items
          .filter((item) => !source.items.some((entry) => entry.queueItemId === item.queueItemId))
          .map((item) => ({
            ...item,
            threadId,
            state: "waiting" as const,
            steerRequested: false,
            editToken: undefined,
          })),
      ];
      for (const item of items) {
        const [receipt] = yield* sql<{
          thread_id: string;
        }>`SELECT thread_id FROM scient_queue_receipts WHERE queue_item_id = ${item.queueItemId}`;
        if (receipt && receipt.thread_id !== threadId)
          return yield* new QueueError({
            message:
              "A legacy queue message ID belongs to another thread. The source file has been kept.",
          });
        yield* sql`INSERT OR IGNORE INTO scient_queue_receipts (queue_item_id, thread_id) VALUES (${item.queueItemId}, ${threadId})`;
      }
      return yield* writeQueue(threadId, { ...source, migrated: true, items });
    }),
  );
});
