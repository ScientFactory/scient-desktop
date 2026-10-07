import type { ScientThreadQueueEnqueueRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { QueueError, type QueueDocument } from "../../orchestration-v2/legacy/LegacyQueueLedger.ts";

export const enqueueQueue = Effect.fn("ScientQueue.enqueue")(function* (
  payload: ScientThreadQueueEnqueueRequest,
  doc: QueueDocument,
) {
  const sql = yield* SqlClient.SqlClient;
  const receipts = yield* sql<{
    thread_id: string;
  }>`SELECT thread_id FROM scient_queue_receipts WHERE queue_item_id = ${payload.queueItemId}`;
  if (receipts[0] && receipts[0].thread_id !== payload.threadId)
    return yield* new QueueError({ message: "This message belongs to another thread." });
  if (receipts.length || doc.items.some((item) => item.queueItemId === payload.queueItemId))
    return doc;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO scient_queue_receipts (queue_item_id, thread_id) VALUES (${payload.queueItemId}, ${payload.threadId})`;
  return {
    ...doc,
    items: [
      ...doc.items,
      { ...payload, state: "waiting" as const, createdAt: now, updatedAt: now },
    ],
  };
});
