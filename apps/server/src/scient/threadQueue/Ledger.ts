import { notifyQueue } from "./signals.ts";
import {
  SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD,
  SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD,
  ScientThreadQueueItem,
  type ScientThreadQueueSnapshot,
  type ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class QueueError extends Schema.TaggedErrorClass<QueueError>()("QueueError", {
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
  session?: OrchestrationThread["session"],
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
  if (document.items.length > SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD) {
    return yield* Effect.fail(new QueueError({ message: "The queue already holds 20 messages." }));
  }
  yield* sql`INSERT INTO scient_thread_queue (thread_id, document, revision) VALUES (${threadId}, ${serialized}, ${document.revision + 1})
    ON CONFLICT(thread_id) DO UPDATE SET document = excluded.document, revision = excluded.revision`;
  notifyQueue(sql, threadId);
  return { ...document, revision: document.revision + 1 };
});

export function snapshot(threadId: ThreadId, document: QueueDocument): ScientThreadQueueSnapshot {
  return {
    threadId,
    items: document.items,
    revision: document.revision,
    paused: document.paused,
    awaitingCompletion: document.awaitingCompletion ?? false,
  };
}

/** Must share the caller's transaction: Stop revokes the old turn before waking the worker. */
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
      item.steerRequested ? { ...item, steerRequested: false } : item,
    ),
    blocked: false,
    turnId: null,
    awaitingCompletion: true,
    paused: null,
  });
});

/** Runs inside the engine's event/receipt transaction, before publishing any event. */
export const observeQueueCommand = Effect.fn("ScientQueue.observeCommand")(function* (
  command: OrchestrationCommand,
  thread: OrchestrationThread | undefined,
) {
  if (!("threadId" in command)) return;
  const sql = yield* SqlClient.SqlClient;
  if (command.type === "thread.delete") {
    const current = yield* readQueue(command.threadId);
    yield* writeQueue(command.threadId, {
      ...current,
      items: [],
      migrated: true,
      blocked: false,
      turnId: null,
      paused: null,
      awaitingCompletion: false,
    });
    yield* sql`DELETE FROM scient_queue_finalization WHERE thread_id = ${command.threadId}`;
    return;
  }
  if (
    command.type !== "thread.turn.start" &&
    command.type !== "thread.session.set" &&
    command.type !== "thread.turn.interrupt"
  )
    return;
  const current = yield* readQueue(command.threadId, thread?.session);
  if (command.type === "thread.turn.start") {
    let items = current.items;
    if (
      !command.queueItemId &&
      command.sendIntent === "normal" &&
      (current.blocked ||
        (!current.awaitingCompletion && items.some((item) => item.state !== "editing")) ||
        thread?.session?.status === "running" ||
        thread?.session?.status === "starting")
    ) {
      return yield* new QueueError({
        message:
          "The thread advanced while sending. Your draft is preserved; send again to queue it.",
      });
    }
    if (command.queueItemId) {
      const item = items.find((entry) => entry.queueItemId === command.queueItemId);
      if (
        command.queueRevision !== current.revision ||
        !item ||
        item.state === "editing" ||
        (!item.steerRequested &&
          (current.blocked ||
            current.awaitingCompletion ||
            current.paused ||
            thread?.session?.status === "running" ||
            thread?.session?.status === "starting"))
      ) {
        return yield* Effect.fail(
          new QueueError({ message: "The queue changed or the previous turn is still active." }),
        );
      }
      if (
        !item.steerRequested &&
        items.find((entry) => entry.state !== "editing")?.queueItemId !== item.queueItemId
      ) {
        return yield* Effect.fail(
          new QueueError({ message: "This message is no longer next in the queue." }),
        );
      }
      items = items.filter((entry) => entry.queueItemId !== item.queueItemId);
    }
    const steering =
      command.sendIntent === "steer" ||
      current.items.some(
        (entry) => entry.queueItemId === command.queueItemId && entry.steerRequested,
      );
    yield* writeQueue(command.threadId, {
      ...current,
      items,
      blocked: true,
      turnId: steering ? current.turnId : null,
      paused: !command.queueItemId && !steering ? null : current.paused,
    });
  } else if (command.type === "thread.turn.interrupt") {
    yield* suspendQueue(command.threadId, {
      ...current,
      turnId: current.turnId ?? thread?.session?.activeTurnId ?? null,
    });
  } else {
    const session = command.session;
    if (session.status === "running" && session.activeTurnId) {
      // An interrupted execution cannot regain eligibility through late adoption events.
      if (current.awaitingCompletion && !current.blocked) {
        yield* suspendQueue(command.threadId, { ...current, turnId: session.activeTurnId });
        return;
      }
      const [completion] = yield* sql<{
        successful: number;
        answer_done: number;
        checkpoint_done: number;
      }>`
        SELECT successful, answer_done, checkpoint_done FROM scient_queue_finalization
        WHERE thread_id = ${command.threadId} AND turn_id = ${session.activeTurnId}`;
      if (
        completion &&
        (completion.successful === 0 || (completion.answer_done && completion.checkpoint_done))
      )
        return;
      yield* writeQueue(command.threadId, {
        ...current,
        blocked: true,
        turnId: session.activeTurnId,
      });
    } else if (
      current.blocked &&
      (session.status === "error" ||
        session.status === "stopped" ||
        session.status === "interrupted")
    ) {
      yield* suspendQueue(command.threadId, current);
    }
  }
});

/** Called only after ingestion has persisted every final assistant segment, image and plan. */
export const finalizeQueueTurn = Effect.fn("ScientQueue.finalizeTurn")(function* (
  threadId: ThreadId,
  turnId: string,
  successful: boolean,
  part: "answer" | "checkpoint" = "answer",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO scient_queue_finalization (thread_id, turn_id, answer_done, checkpoint_done, successful)
        VALUES (${threadId}, ${turnId}, ${part === "answer" ? 1 : 0}, ${part === "checkpoint" ? 1 : 0}, ${successful ? 1 : 0})
        ON CONFLICT(thread_id, turn_id) DO UPDATE SET
          answer_done = MAX(answer_done, excluded.answer_done), checkpoint_done = MAX(checkpoint_done, excluded.checkpoint_done),
          successful = MIN(successful, excluded.successful)`;
      const [completion] = yield* sql<{
        answer_done: number;
        checkpoint_done: number;
        successful: number;
      }>`SELECT answer_done, checkpoint_done, successful FROM scient_queue_finalization WHERE thread_id = ${threadId} AND turn_id = ${turnId}`;
      const current = yield* readQueue(threadId);
      if (
        !current.blocked ||
        current.turnId !== turnId ||
        !completion?.answer_done ||
        !completion.checkpoint_done
      )
        return;
      yield* writeQueue(threadId, {
        ...current,
        blocked: false,
        turnId: null,
        awaitingCompletion: completion.successful !== 1,
        paused: current.paused,
      });
    }),
  );
});
