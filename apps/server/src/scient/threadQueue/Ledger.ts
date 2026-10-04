// @effect-diagnostics nodeBuiltinImport:off -- Bounded identity for every valid command id.
import * as NodeCrypto from "node:crypto";
import { notifyQueue } from "./signals.ts";
import {
  SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD,
  SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD,
  ScientThreadQueueItem,
  type ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
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
  notifyQueue(sql, threadId);
  return { ...document, revision: document.revision + 1 };
});

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

export function queueCommandItemId(
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
) {
  return `qitem_${NodeCrypto.createHash("sha256").update(`${command.threadId.length}:${command.threadId}${command.commandId}`).digest("hex")}`;
}
export const wasQueuedCommand = Effect.fn("ScientQueue.wasQueuedCommand")(function* (
  command: OrchestrationCommand,
) {
  if (command.type !== "thread.turn.start" || command.queueItemId) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT 1 FROM scient_queue_receipts WHERE queue_item_id = ${queueCommandItemId(command)} AND thread_id = ${command.threadId}`;
  return rows.length > 0;
});

/** Reconcile accepted retries before upload normalization or bootstrap side effects. */
export const readAcceptedTurnReceipt = Effect.fn("ScientQueue.readAcceptedTurnReceipt")(
  function* (command: {
    type: string;
    commandId: string;
    threadId?: string | undefined;
    submissionId?: string | undefined;
  }) {
    if (command.type !== "thread.turn.start" || !command.threadId) return undefined;
    const sql = yield* SqlClient.SqlClient;
    const [receipt] = yield* sql<{
      aggregate_kind: string;
      aggregate_id: string;
      result_sequence: number;
      status: string;
    }>`
    SELECT aggregate_kind, aggregate_id, result_sequence, status FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`;
    if (
      !receipt ||
      receipt.status !== "accepted" ||
      receipt.aggregate_kind !== "thread" ||
      receipt.aggregate_id !== command.threadId
    )
      return undefined;
    const queueItemId = `qitem_${NodeCrypto.createHash("sha256").update(`${command.threadId.length}:${command.threadId}${command.commandId}`).digest("hex")}`;
    const rows =
      yield* sql`SELECT 1 FROM scient_queue_receipts WHERE queue_item_id = ${queueItemId} AND thread_id = ${command.threadId}`;
    const queued = rows.length > 0;
    return {
      sequence: receipt.result_sequence,
      queued,
      ...(command.submissionId
        ? {
            submission: {
              submissionId: command.submissionId,
              outcome: queued ? ("queued" as const) : ("sent" as const),
            },
          }
        : {}),
    };
  },
);

/** Runs inside the engine's event/receipt transaction, before publishing any event. */
export const observeQueueCommand = Effect.fn("ScientQueue.observeCommand")(function* (
  command: OrchestrationCommand,
  thread: OrchestrationThread | undefined,
  bootstrapHandoff?: string,
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
    const setupMessage =
      bootstrapHandoff === command.message.messageId &&
      current.turnId === null &&
      !thread?.session?.activeTurnId &&
      thread?.session?.status === "starting" &&
      thread.session.providerName === null
        ? yield* sql`SELECT 1 FROM projection_thread_messages WHERE thread_id = ${command.threadId} AND message_id = ${bootstrapHandoff} AND role = 'user'`
        : [];
    const ownsSetup = setupMessage.length > 0;
    const mustQueue =
      current.blocked ||
      items.some((item) => item.sendRequested) ||
      (!current.awaitingCompletion &&
        (current.paused !== null || items.some((item) => item.state !== "editing"))) ||
      thread?.session?.status === "running" ||
      thread?.session?.status === "starting";
    if (!command.queueItemId && command.sendIntent === "normal" && mustQueue && !ownsSetup) {
      const queueItemId = queueCommandItemId(command);
      const now = command.createdAt;
      yield* sql`INSERT INTO scient_queue_receipts (queue_item_id, thread_id) VALUES (${queueItemId}, ${command.threadId})`;
      yield* writeQueue(command.threadId, {
        ...current,
        items: [
          ...items,
          {
            queueItemId,
            threadId: command.threadId,
            messageId: command.message.messageId,
            text: command.message.text,
            attachments: command.message.attachments,
            context: command.message.context,
            composerSnapshot: command.composerSnapshot,
            selectedScientSkillNames: command.selectedScientSkillNames,
            modelSelection: command.modelSelection ?? thread?.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            titleSeed: command.titleSeed,
            sourceProposedPlan: command.sourceProposedPlan,
            state: "waiting",
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      return true;
    }
    if (command.queueItemId) {
      const item = items.find((entry) => entry.queueItemId === command.queueItemId);
      if (
        command.queueRevision !== current.revision ||
        !item ||
        item.state === "editing" ||
        (!item.steerRequested &&
          (current.blocked ||
            (current.awaitingCompletion && !item.sendRequested) ||
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

/**
 * The answer part runs after persisted assistant output; the checkpoint part
 * records settlement regardless of capture success. Only answer success can
 * release the queue, and Stop remains sticky for the interrupted turn.
 */
export const finalizeQueueTurn = Effect.fn("ScientQueue.finalizeTurn")(function* (
  threadId: ThreadId,
  turnId: string,
  successful: boolean,
  part: "answer" | "checkpoint" = "answer",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Checkpoint completion is a settlement barrier, not an answer-success vote.
      // An interrupt still writes successful=0 before either finalizer can release it.
      yield* sql`INSERT INTO scient_queue_finalization (thread_id, turn_id, answer_done, checkpoint_done, successful)
        VALUES (${threadId}, ${turnId}, ${part === "answer" ? 1 : 0}, ${part === "checkpoint" ? 1 : 0}, ${part === "checkpoint" || successful ? 1 : 0})
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
        // An unadmitted Steer targeted the turn that has now ended.
        items: current.items.map((item) =>
          item.steerRequested ? { ...item, steerRequested: false } : item,
        ),
        blocked: false,
        turnId: null,
        awaitingCompletion: completion.successful !== 1,
        paused: current.paused,
      });
    }),
  );
});
