/** Reads and acknowledges queue documents persisted before native admission. */
import {
  SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD,
  SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD,
  ScientThreadQueueItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class QueueError extends Schema.TaggedError<QueueError>()("QueueError", {
  message: Schema.String,
}) {}

const Document = Schema.Struct({
  revision: Schema.Number,
  migrated: Schema.Boolean,
  items: Schema.Array(ScientThreadQueueItem),
  blocked: Schema.Boolean,
  turnId: Schema.NullOr(Schema.String),
  paused: Schema.NullOr(Schema.String),
  awaitingCompletion: Schema.optional(Schema.Boolean),
});
export type QueueDocument = typeof Document.Type;
const documentCodec = Schema.fromJsonString(Document);
const decode = Schema.decodeUnknownEffect(documentCodec);
const encode = Schema.encodeEffect(documentCodec);

export const readQueue = Effect.fn("ScientQueue.read")(function* (
  threadId: ThreadId,
  session?: { readonly status: string; readonly activeTurnId: string | null } | null,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        document: string;
      }>`SELECT document FROM scient_thread_queue WHERE thread_id = ${threadId}`;
      const document: QueueDocument = rows[0]
        ? yield* decode(rows[0].document).pipe(
            Effect.mapError((cause) => new QueueError({ message: String(cause) })),
          )
        : ({
            revision: 0,
            migrated: false,
            items: [],
            blocked: session?.status === "running" || session?.status === "starting",
            turnId: session?.activeTurnId ?? null,
            paused: null,
          } satisfies QueueDocument);
      // Upgrade pauses written by the earlier queue candidate without touching payloads.
      if (
        document.awaitingCompletion === undefined &&
        document.paused?.startsWith("Queue paused ")
      ) {
        return yield* suspendQueue(threadId, document);
      }
      return document;
    }),
  );
});

export const writeQueue = Effect.fn("ScientQueue.write")(function* (
  threadId: ThreadId,
  document: QueueDocument,
) {
  const sql = yield* SqlClient.SqlClient;
  const serialized = yield* encode({
    ...document,
    revision: document.revision + 1,
  }).pipe(Effect.mapError((cause) => new QueueError({ message: String(cause) })));
  if (new TextEncoder().encode(serialized).byteLength > SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD) {
    return yield* Effect.fail(
      new QueueError({
        message: "The queue is full. Remove an image or another queued message first.",
      }),
    );
  }
  const attachmentBytes = document.items.reduce(
    (total, item) =>
      total +
      item.attachments.reduce(
        (bytes, attachment) => bytes + ("dataUrl" in attachment ? 0 : attachment.sizeBytes),
        0,
      ),
    0,
  );
  if (
    new TextEncoder().encode(serialized).byteLength + attachmentBytes >
    SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD
  )
    return yield* new QueueError({
      message: "The queue is full. Remove an attachment or another queued message first.",
    });
  if (document.items.length > SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD) {
    return yield* Effect.fail(new QueueError({ message: "The queue already holds 20 messages." }));
  }
  yield* sql`INSERT INTO scient_thread_queue (thread_id, document, revision) VALUES (${threadId}, ${serialized}, ${document.revision + 1})
    ON CONFLICT(thread_id) DO UPDATE SET document = excluded.document, revision = excluded.revision`;
  return { ...document, revision: document.revision + 1 };
});

/** Keep legacy turn finalization and queue acknowledgement in the caller's transaction. */
export const suspendQueue = Effect.fn("ScientQueue.suspend")(function* (
  threadId: ThreadId,
  current: QueueDocument,
) {
  const sql = yield* SqlClient.SqlClient;
  if (current.turnId) {
    yield* sql`INSERT INTO scient_queue_finalization (thread_id, turn_id, successful)
      VALUES (${threadId}, ${current.turnId}, 0)
      ON CONFLICT(thread_id, turn_id) DO UPDATE SET successful = 0`;
  }
  return yield* writeQueue(threadId, {
    ...current,
    items: current.items.map((item) =>
      item.steerRequested || item.sendRequested
        ? { ...item, steerRequested: false, sendRequested: false }
        : item,
    ),
    blocked: false,
    turnId: null,
    awaitingCompletion: true,
    paused: null,
  });
});
