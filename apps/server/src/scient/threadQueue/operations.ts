import { ScientThreadQueueUpdateRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off -- Pure hash for durable edit request identity.
import * as NodeCrypto from "node:crypto";
import type {
  ScientThreadQueueEnqueueRequest,
  ScientThreadQueueRemoveRequest,
  ScientThreadQueueReorderRequest,
  ScientThreadQueueControlRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { QueueError, type QueueDocument } from "./Ledger.ts";

const encodeUpdate = Schema.encodeEffect(Schema.fromJsonString(ScientThreadQueueUpdateRequest));

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

export const updateQueue = Effect.fn("ScientQueue.update")(function* (
  payload: ScientThreadQueueUpdateRequest,
  doc: QueueDocument,
) {
  const sql = yield* SqlClient.SqlClient;
  const item = doc.items.find((entry) => entry.queueItemId === payload.queueItemId);
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(
      yield* encodeUpdate(payload).pipe(
        Effect.mapError((cause) => new QueueError({ message: String(cause) })),
      ),
    )
    .digest("hex");
  const receipts = yield* sql<{
    edit_token: string | null;
    edit_fingerprint: string | null;
  }>`SELECT edit_token, edit_fingerprint FROM scient_queue_receipts WHERE queue_item_id = ${payload.queueItemId} AND thread_id = ${payload.threadId}`;
  if (receipts[0]?.edit_token === payload.editToken) {
    // A stash receipt is not proof that an update was ever accepted.
    if (receipts[0].edit_fingerprint === null)
      return yield* new QueueError({
        message:
          "This edit was already stashed. Stash these changes to keep them and restore your ordinary draft.",
      });
    if (receipts[0].edit_fingerprint !== fingerprint)
      return yield* new QueueError({
        message:
          "An earlier version of this edit was already queued. Stash these newer edits to keep them and restore your ordinary draft.",
      });
    return doc;
  }
  if (!item || item.editToken !== payload.editToken)
    return yield* Effect.fail(
      new QueueError({
        message: "This queue edit belongs to another editor or has already finished.",
      }),
    );
  if (item.state === "waiting") return doc; // lost response to a successful requeue
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`UPDATE scient_queue_receipts SET edit_token = ${payload.editToken}, edit_fingerprint = ${fingerprint} WHERE queue_item_id = ${payload.queueItemId} AND thread_id = ${payload.threadId}`;
  return {
    ...doc,
    items: doc.items.map((entry) =>
      entry === item
        ? {
            ...entry,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            selectedScientSkillNames: payload.selectedScientSkillNames,
            composerSnapshot: payload.composerSnapshot,
            context: payload.context,
            text: payload.text,
            attachments: payload.attachments,
            state: "waiting" as const,
            steerRequested: false,
            sendRequested: false,
            updatedAt: now,
          }
        : entry,
    ),
  };
});

export const removeQueue = Effect.fn("ScientQueue.remove")(function* (
  payload: ScientThreadQueueRemoveRequest,
  doc: QueueDocument,
) {
  if (
    doc.items.some((item) => item.queueItemId === payload.queueItemId && item.state === "editing")
  )
    return yield* Effect.fail(new QueueError({ message: "This message is being edited." }));
  return {
    ...doc,
    items: doc.items.filter((item) => item.queueItemId !== payload.queueItemId),
  };
});

export const reorderQueue = Effect.fn("ScientQueue.reorder")(function* (
  payload: ScientThreadQueueReorderRequest,
  doc: QueueDocument,
) {
  const visible = doc.items.filter((item) => item.state !== "editing");
  const ids = new Set(payload.queueItemIds);
  if (
    ids.size !== visible.length ||
    ids.size !== payload.queueItemIds.length ||
    visible.some((item) => !ids.has(item.queueItemId))
  )
    return yield* Effect.fail(
      new QueueError({ message: "The queue changed. Refresh and try dragging again." }),
    );
  const ordered = payload.queueItemIds.map((id) =>
    visible.find((item) => item.queueItemId === id)!,
  );
  let index = 0;
  return {
    ...doc,
    // Reordering cancels an unadmitted explicit Send; the user must confirm the new head.
    items: doc.items.map((item) =>
      item.state === "editing" ? item : { ...ordered[index++]!, sendRequested: false },
    ),
  };
});

export const controlQueue = Effect.fn("ScientQueue.control")(function* (
  payload: ScientThreadQueueControlRequest,
  doc: QueueDocument,
) {
  const sql = yield* SqlClient.SqlClient;
  if (payload.action === "resume") {
    // A failed admission of an explicit Send keeps its durable request. Retry
    // may re-attempt that request, but cannot release any other finalization barrier.
    const next = doc.items.find((entry) => entry.state !== "editing");
    if (doc.blocked || !doc.paused || (doc.awaitingCompletion && !next?.sendRequested)) return doc;
    const query = yield* ProjectionSnapshotQuery;
    const thread = yield* query.getThreadDetailById(payload.threadId);
    if (
      Option.isNone(thread) ||
      thread.value.session?.status === "running" ||
      thread.value.session?.status === "starting"
    )
      return yield* Effect.fail(new QueueError({ message: "The current turn is still active." }));
    return { ...doc, blocked: false, turnId: null, paused: null };
  }
  const item = doc.items.find((entry) => entry.queueItemId === payload.queueItemId);
  const receipts = yield* sql<{
    edit_token: string | null;
  }>`SELECT edit_token FROM scient_queue_receipts WHERE queue_item_id = ${payload.queueItemId ?? ""} AND thread_id = ${payload.threadId}`;
  if (payload.editToken && receipts[0]?.edit_token === payload.editToken) return doc;
  if (!item)
    return yield* Effect.fail(
      new QueueError({
        message: "The queued message has already started or was removed.",
      }),
    );
  if (payload.action === "stash") {
    if (item.state !== "editing" || item.editToken !== payload.editToken)
      return yield* new QueueError({ message: "This queue edit belongs to another editor." });
    yield* sql`UPDATE scient_queue_receipts SET edit_token = ${payload.editToken}, edit_fingerprint = NULL WHERE queue_item_id = ${item.queueItemId} AND thread_id = ${payload.threadId}`;
    return { ...doc, items: doc.items.filter((entry) => entry !== item) };
  }
  if (payload.action === "steer") {
    if (item.state === "editing")
      return yield* Effect.fail(new QueueError({ message: "This message is being edited." }));
    return {
      ...doc,
      items: doc.items.map((entry) =>
        entry === item
          ? { ...entry, steerRequested: true, sendRequested: false }
          : entry.sendRequested
            ? { ...entry, sendRequested: false }
            : entry,
      ),
    };
  }
  if (payload.action === "send") {
    const query = yield* ProjectionSnapshotQuery;
    const thread = yield* query.getThreadDetailById(payload.threadId);
    if (
      !doc.awaitingCompletion ||
      doc.blocked ||
      doc.paused ||
      Option.isNone(thread) ||
      thread.value.session?.status === "running" ||
      thread.value.session?.status === "starting" ||
      item.state === "editing" ||
      doc.items.find((entry) => entry.state !== "editing") !== item ||
      doc.items.some((entry) => entry.steerRequested)
    )
      return yield* Effect.fail(new QueueError({ message: "This message is not ready to send." }));
    if (item.sendRequested) return doc;
    return {
      ...doc,
      items: doc.items.map((entry) => (entry === item ? { ...entry, sendRequested: true } : entry)),
    };
  }
  if (!payload.editToken || (item.state === "editing" && item.editToken !== payload.editToken))
    return yield* Effect.fail(
      new QueueError({ message: "This message is being edited elsewhere." }),
    );
  return {
    ...doc,
    items: doc.items.map((entry) =>
      entry === item
        ? {
            ...entry,
            state: "editing" as const,
            editToken: payload.editToken,
            steerRequested: false,
            sendRequested: false,
          }
        : entry,
    ),
  };
});
