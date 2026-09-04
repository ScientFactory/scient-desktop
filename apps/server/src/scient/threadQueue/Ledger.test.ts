import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "@effect/vitest";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  readQueue,
  writeQueue,
  observeQueueCommand,
  finalizeQueueTurn,
  type QueueDocument,
  suspendQueue,
} from "./Ledger.ts";
import { enqueueQueue, controlQueue, reorderQueue, updateQueue } from "./operations.ts";

const threadId = ThreadId.make("queue-owner");
const otherThreadId = ThreadId.make("other-thread");
const now = "2026-09-04T12:00:00.000Z";
const layer = Layer.mergeAll(SqlitePersistenceMemory, Layer.mock(ProjectionSnapshotQuery)({})).pipe(
  Layer.provide(NodeServices.layer),
);
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | ProjectionSnapshotQuery>) =>
  effect.pipe(Effect.provide(layer));
const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  });
const change = <E>(
  operation: (
    doc: QueueDocument,
  ) => Effect.Effect<QueueDocument, E, SqlClient.SqlClient | ProjectionSnapshotQuery>,
) =>
  transaction(
    Effect.gen(function* () {
      const next = yield* operation(yield* readQueue(threadId));
      return yield* writeQueue(threadId, next);
    }),
  );
const enqueue = (id: string) =>
  change((doc) =>
    enqueueQueue({ threadId, queueItemId: `qitem_${id}`, text: id, attachments: [] }, doc),
  );
const edit = (id: string, editToken = "editor-a") =>
  change((doc) =>
    controlQueue({ threadId, action: "edit", queueItemId: `qitem_${id}`, editToken }, doc),
  );
const update = (id: string, editToken = "editor-a") =>
  change((doc) =>
    updateQueue(
      { threadId, queueItemId: `qitem_${id}`, editToken, text: `${id} edited`, attachments: [] },
      doc,
    ),
  );
const command = (
  id: string,
  revision: number,
  owner = threadId,
): Extract<OrchestrationCommand, { type: "thread.turn.start" }> => ({
  type: "thread.turn.start",
  commandId: CommandId.make(`queue:qitem_${id}:${revision}`),
  queueItemId: `qitem_${id}`,
  queueRevision: revision,
  threadId: owner,
  message: {
    messageId: MessageId.make(`queue:qitem_${id}`),
    role: "user",
    text: id,
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: now,
});

const sessionCommand = (
  turnId: string | null,
  status: "running" | "ready" | "stopped" = "running",
): OrchestrationCommand => ({
  type: "thread.session.set",
  commandId: CommandId.make(`session-${turnId}-${status}`),
  threadId,
  createdAt: now,
  session: {
    threadId,
    providerName: "codex",
    runtimeMode: "full-access",
    status,
    activeTurnId: turnId ? TurnId.make(turnId) : null,
    lastError: null,
    updatedAt: now,
  },
});
const stop = () =>
  transaction(
    observeQueueCommand(
      {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("stop"),
        threadId,
        createdAt: now,
      },
      undefined,
    ),
  );
const ordinaryStart = (sendIntent: "normal" | undefined = "normal") => {
  const { queueItemId: _id, queueRevision: _revision, ...start } = command("manual", 0);
  return transaction(
    observeQueueCommand({ ...start, ...(sendIntent ? { sendIntent } : {}) }, undefined),
  );
};
const adopt = (id: string) => transaction(observeQueueCommand(sessionCommand(id), undefined));
const finish = (id: string) =>
  Effect.gen(function* () {
    yield* finalizeQueueTurn(threadId, id, true, "answer");
    yield* finalizeQueueTurn(threadId, id, true, "checkpoint");
  });

describe("server queue ordering and admission", () => {
  it.effect("keeps the hidden edit slot while visible messages are dragged", () =>
    run(
      Effect.gen(function* () {
        for (const id of ["A", "B", "C", "D"]) yield* enqueue(id);
        yield* edit("B");
        yield* change((doc) =>
          reorderQueue({ threadId, queueItemIds: ["qitem_D", "qitem_A", "qitem_C"] }, doc),
        );
        const result = yield* update("B");
        expect(result.items.map((item) => item.queueItemId)).toEqual([
          "qitem_D",
          "qitem_B",
          "qitem_A",
          "qitem_C",
        ]);
      }),
    ),
  );
  it.effect("skips editing items without losing their position after admitted work", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* enqueue("B");
        yield* enqueue("C");
        const doc = yield* edit("A");
        yield* transaction(observeQueueCommand(command("B", doc.revision), undefined));
        const restored = yield* update("A");
        expect(restored.items.map((item) => item.queueItemId)).toEqual(["qitem_A", "qitem_C"]);
        expect(restored.blocked).toBe(true);
      }),
    ),
  );
  it.effect(
    "admits only one request across competing clients and provider acknowledgement gaps",
    () =>
      run(
        Effect.gen(function* () {
          yield* enqueue("A");
          const doc = yield* enqueue("B");
          const outcomes = yield* Effect.all(
            [
              Effect.exit(transaction(observeQueueCommand(command("A", doc.revision), undefined))),
              Effect.exit(transaction(observeQueueCommand(command("A", doc.revision), undefined))),
            ],
            { concurrency: 2 },
          );
          expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
          const next = yield* readQueue(threadId);
          expect(next.items.map((item) => item.text)).toEqual(["B"]);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                transaction(observeQueueCommand(command("B", next.revision), undefined)),
              ),
            ),
          ).toBe(true);
        }),
      ),
  );
  it.effect("rejects cross-thread and stale-content admissions", () =>
    run(
      Effect.gen(function* () {
        const doc = yield* enqueue("A");
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              transaction(
                observeQueueCommand(command("A", doc.revision, otherThreadId), undefined),
              ),
            ),
          ),
        ).toBe(true);
        yield* edit("A");
        yield* update("A");
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              transaction(observeQueueCommand(command("A", doc.revision), undefined)),
            ),
          ),
        ).toBe(true);
        expect((yield* readQueue(threadId)).items[0]?.text).toBe("A edited");
      }),
    ),
  );
  it.effect.each(["answer", "checkpoint"] as const)(
    "waits for both durable completion parts when %s arrives first",
    (first) =>
      run(
        Effect.gen(function* () {
          yield* enqueue("A");
          yield* transaction(
            observeQueueCommand(
              {
                type: "thread.session.set",
                commandId: CommandId.make("running"),
                threadId,
                session: {
                  threadId,
                  providerName: "codex",
                  runtimeMode: "full-access",
                  status: "running",
                  activeTurnId: TurnId.make("turn-1"),
                  lastError: null,
                  updatedAt: now,
                },
                createdAt: now,
              },
              undefined,
            ),
          );
          yield* finalizeQueueTurn(threadId, "turn-1", true, first);
          expect((yield* readQueue(threadId)).blocked).toBe(true);
          yield* finalizeQueueTurn(
            threadId,
            "turn-1",
            true,
            first === "answer" ? "checkpoint" : "answer",
          );
          expect((yield* readQueue(threadId)).blocked).toBe(false);
        }),
      ),
  );
  it.effect("does not let stale completion release a newer turn", () =>
    run(
      Effect.gen(function* () {
        const doc = yield* enqueue("A");
        yield* writeQueue(threadId, { ...doc, blocked: true, turnId: "new-turn" });
        yield* finalizeQueueTurn(threadId, "old-turn", true, "answer");
        yield* finalizeQueueTurn(threadId, "old-turn", true, "checkpoint");
        expect((yield* readQueue(threadId)).blocked).toBe(true);
      }),
    ),
  );
  it.effect("does not let a terminal signal release a start that is not yet adopted", () =>
    run(
      Effect.gen(function* () {
        const doc = yield* enqueue("A");
        yield* writeQueue(threadId, { ...doc, blocked: true, turnId: "old-turn" });
        yield* finish("old-turn");
        // Admission records no provider turn until adoption, so `turnId` is null
        // for a window on every ordinary start. Relaxing the eligible-turn check
        // to treat null as "matches anything" would let this late duplicate of an
        // already-finished turn release the new start and deliver twice.
        const admitted = yield* readQueue(threadId);
        yield* writeQueue(threadId, { ...admitted, blocked: true, turnId: null });
        yield* finish("old-turn");
        expect((yield* readQueue(threadId)).blocked).toBe(true);
      }),
    ),
  );
  it.effect("waits after failed completion rather than delivering the next message", () =>
    run(
      Effect.gen(function* () {
        const doc = yield* enqueue("A");
        yield* writeQueue(threadId, { ...doc, blocked: true, turnId: "turn-1" });
        yield* finalizeQueueTurn(threadId, "turn-1", false, "answer");
        yield* finalizeQueueTurn(threadId, "turn-1", true, "checkpoint");
        const paused = yield* readQueue(threadId);
        expect(paused.awaitingCompletion).toBe(true);
        expect(paused.paused).toBeNull();
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              transaction(observeQueueCommand(command("A", paused.revision), undefined)),
            ),
          ),
        ).toBe(true);
      }),
    ),
  );
  it.effect("makes enqueue and requeue retry safe even after delivery has consumed the item", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* edit("A");
        const doc = yield* update("A");
        yield* transaction(observeQueueCommand(command("A", doc.revision), undefined));
        yield* enqueue("A");
        yield* update("A");
        expect((yield* readQueue(threadId)).items).toEqual([]);
      }),
    ),
  );
  it.effect("retries Stash safely without acknowledging an update that was never queued", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* edit("A");
        yield* change((doc) =>
          controlQueue(
            { threadId, action: "stash", queueItemId: "qitem_A", editToken: "editor-a" },
            doc,
          ),
        );
        const retry = yield* change((doc) =>
          controlQueue(
            { threadId, action: "stash", queueItemId: "qitem_A", editToken: "editor-a" },
            doc,
          ),
        );
        expect(retry.items).toEqual([]);
        expect(Exit.isFailure(yield* Effect.exit(update("A")))).toBe(true);
        expect((yield* readQueue(threadId)).items).toEqual([]);
      }),
    ),
  );
  it.effect("does not let another editor overwrite a withdrawn message", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* edit("A");
        expect(Exit.isFailure(yield* Effect.exit(edit("A", "editor-b")))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(update("A", "editor-b")))).toBe(true);
        expect((yield* readQueue(threadId)).items[0]?.editToken).toBe("editor-a");
      }),
    ),
  );
  it.effect("does not let an ordinary stale Send steer or overtake the queue", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        const queued = command("A", 1);
        const { queueItemId: _id, queueRevision: _revision, ...ordinary } = queued;
        const rejected = yield* Effect.exit(
          transaction(observeQueueCommand({ ...ordinary, sendIntent: "normal" }, undefined)),
        );
        expect(Exit.isFailure(rejected)).toBe(true);
        expect((yield* readQueue(threadId)).items).toHaveLength(1);
      }),
    ),
  );
  it.effect("Retry cannot release an unpaused finalization barrier", () =>
    run(
      Effect.gen(function* () {
        const doc = yield* enqueue("A");
        yield* writeQueue(threadId, { ...doc, blocked: true, turnId: "finishing" });
        const result = yield* change((current) =>
          controlQueue({ threadId, action: "resume" }, current),
        );
        expect(result.blocked).toBe(true);
        expect(result.turnId).toBe("finishing");
      }),
    ),
  );
  it.effect("rejects a receipt ID reused by another thread", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        const result = yield* Effect.exit(
          enqueueQueue(
            {
              threadId: otherThreadId,
              queueItemId: "qitem_A",
              text: "wrong target",
              attachments: [],
            },
            yield* readQueue(otherThreadId),
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect((yield* readQueue(otherThreadId)).items).toEqual([]);
      }),
    ),
  );

  it.effect("rejects changed content after a lost requeue response", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* edit("A");
        yield* update("A");
        const changed = yield* Effect.exit(
          change((doc) =>
            updateQueue(
              {
                threadId,
                queueItemId: "qitem_A",
                editToken: "editor-a",
                text: "newer text",
                attachments: [],
              },
              doc,
            ),
          ),
        );
        expect(Exit.isFailure(changed)).toBe(true);
        expect((yield* readQueue(threadId)).items[0]?.text).toBe("A edited");
      }),
    ),
  );
  it.effect("enforces capacity transactionally without leaving an accepted receipt", () =>
    run(
      Effect.gen(function* () {
        for (let index = 0; index < 20; index++) yield* enqueue(String(index));
        expect(Exit.isFailure(yield* Effect.exit(enqueue("overflow")))).toBe(true);
        const sql = yield* SqlClient.SqlClient;
        const receipts =
          yield* sql`SELECT queue_item_id FROM scient_queue_receipts WHERE queue_item_id = 'qitem_overflow'`;
        expect(receipts).toEqual([]);
        expect((yield* readQueue(threadId)).items).toHaveLength(20);
      }),
    ),
  );
  it.effect("withdrawal cancels a raced Steer request and requeue waits normally", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* change((doc) =>
          controlQueue({ threadId, queueItemId: "qitem_A", action: "steer" }, doc),
        );
        const editing = yield* edit("A");
        expect(editing.items[0]?.steerRequested).toBe(false);
        const waiting = yield* update("A");
        expect(waiting.items[0]?.steerRequested).toBe(false);
        yield* writeQueue(threadId, { ...waiting, blocked: true, turnId: "active" });
        const blocked = yield* readQueue(threadId);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              transaction(observeQueueCommand(command("A", blocked.revision), undefined)),
            ),
          ),
        ).toBe(true);
      }),
    ),
  );
});

describe("Stop and completion recovery", () => {
  it.effect.each(["answer", "checkpoint"] as const)(
    "an abort with %s first preserves the queue until recovery completes",
    (first) =>
      run(
        Effect.gen(function* () {
          yield* enqueue("A");
          yield* enqueue("B");
          yield* edit("A");
          yield* adopt("aborted");
          const items = (yield* readQueue(threadId)).items;
          yield* finalizeQueueTurn(threadId, "aborted", false, first);
          expect((yield* readQueue(threadId)).blocked).toBe(true);
          yield* finalizeQueueTurn(
            threadId,
            "aborted",
            false,
            first === "answer" ? "checkpoint" : "answer",
          );
          const waiting = yield* readQueue(threadId);
          expect(waiting.blocked).toBe(false);
          expect(waiting.awaitingCompletion).toBe(true);
          expect(waiting.items).toEqual(items);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                transaction(observeQueueCommand(command("B", waiting.revision), undefined)),
              ),
            ),
          ).toBe(true);
          yield* ordinaryStart();
          yield* adopt("recovery");
          yield* finish("aborted");
          expect((yield* readQueue(threadId)).turnId).toBe("recovery");
          expect((yield* readQueue(threadId)).awaitingCompletion).toBe(true);
          yield* finish("recovery");
          const ready = yield* readQueue(threadId);
          expect(ready.awaitingCompletion).toBe(false);
          expect(ready.items).toEqual(items);
          yield* transaction(observeQueueCommand(command("B", ready.revision), undefined));
          expect((yield* readQueue(threadId)).items.map((item) => item.queueItemId)).toEqual([
            "qitem_A",
          ]);
        }),
      ),
  );

  it.effect(
    "Stop cancels a pending Steer but preserves an explicit Steer requested afterward",
    () =>
      run(
        Effect.gen(function* () {
          yield* enqueue("A");
          yield* adopt("running");
          yield* change((doc) =>
            controlQueue({ threadId, action: "steer", queueItemId: "qitem_A" }, doc),
          );
          yield* stop();
          const stopped = yield* readQueue(threadId);
          expect(stopped.items[0]?.steerRequested).toBe(false);
          expect(stopped.items[0]?.text).toBe("A");
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                transaction(observeQueueCommand(command("A", stopped.revision), undefined)),
              ),
            ),
          ).toBe(true);
          const steered = yield* change((doc) =>
            controlQueue({ threadId, action: "steer", queueItemId: "qitem_A" }, doc),
          );
          yield* transaction(observeQueueCommand(command("A", steered.revision), undefined));
          expect((yield* readQueue(threadId)).items).toEqual([]);
        }),
      ),
  );

  it.effect.each(["answer", "checkpoint"] as const)(
    "Stop between finalizers rejects a late %s and preserves edits and order",
    (first) =>
      run(
        Effect.gen(function* () {
          yield* enqueue("A");
          yield* enqueue("B");
          yield* edit("A");
          yield* adopt("interrupted");
          yield* finalizeQueueTurn(threadId, "interrupted", true, first);
          const before = (yield* readQueue(threadId)).items;
          yield* stop();
          yield* finish("interrupted");
          yield* transaction(observeQueueCommand(sessionCommand(null, "ready"), undefined));
          yield* change((doc) => controlQueue({ threadId, action: "resume" }, doc));
          const waiting = yield* readQueue(threadId);
          expect(waiting.items).toEqual(before);
          expect(waiting.awaitingCompletion).toBe(true);
          expect(waiting.paused).toBeNull();
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                transaction(observeQueueCommand(command("B", waiting.revision), undefined)),
              ),
            ),
          ).toBe(true);
          yield* ordinaryStart();
          yield* adopt("interrupted"); // Old adoption cannot bind the newly admitted execution.
          yield* finish("interrupted");
          expect((yield* readQueue(threadId)).blocked).toBe(true);
          expect((yield* readQueue(threadId)).turnId).toBeNull();
          yield* adopt("resumed");
          yield* finalizeQueueTurn(threadId, "resumed", true, "answer");
          expect((yield* readQueue(threadId)).blocked).toBe(true);
          yield* finalizeQueueTurn(threadId, "resumed", true, "checkpoint");
          const ready = yield* update("A");
          expect(ready.awaitingCompletion).toBe(false);
          expect(ready.items.map((item) => item.queueItemId)).toEqual(["qitem_A", "qitem_B"]);
          yield* transaction(observeQueueCommand(command("A", ready.revision), undefined));
          expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["B"]);
        }),
      ),
  );
  it.effect(
    "keeps a stopped pending start ineligible when its provider adoption arrives late",
    () =>
      run(
        Effect.gen(function* () {
          yield* ordinaryStart();
          yield* enqueue("A");
          yield* stop();
          yield* adopt("late-start");
          yield* finish("late-start");
          expect((yield* readQueue(threadId)).awaitingCompletion).toBe(true);
          yield* ordinaryStart();
          yield* adopt("late-start");
          yield* finish("late-start");
          expect((yield* readQueue(threadId)).turnId).toBeNull();
          yield* adopt("new-start");
          yield* finish("new-start");
          expect((yield* readQueue(threadId)).awaitingCompletion).toBe(false);
        }),
      ),
  );
  it.effect("allows one recovery start and waits again after another Stop", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* adopt("first");
        yield* stop();
        const outcomes = yield* Effect.all(
          [Effect.exit(ordinaryStart()), Effect.exit(ordinaryStart())],
          { concurrency: 2 },
        );
        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
        yield* adopt("second");
        yield* stop();
        yield* finish("first");
        yield* finish("second");
        expect((yield* readQueue(threadId)).awaitingCompletion).toBe(true);
        yield* ordinaryStart();
        yield* adopt("third");
        yield* finish("third");
        expect((yield* readQueue(threadId)).awaitingCompletion).toBe(false);
        expect((yield* readQueue(threadId)).items).toHaveLength(1);
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
        yield* ordinaryStart();
        yield* adopt("old");
        yield* finish("old");
        expect((yield* readQueue(threadId)).blocked).toBe(true);
      }),
    ),
  );
  it.effect("does not require recovery for session shutdown after successful finalization", () =>
    run(
      Effect.gen(function* () {
        yield* adopt("complete");
        yield* finish("complete");
        yield* transaction(observeQueueCommand(sessionCommand(null, "stopped"), undefined));
        expect((yield* readQueue(threadId)).awaitingCompletion).toBe(false);
      }),
    ),
  );
  it.effect("restart reconciliation preserves payloads and requires a later successful turn", () =>
    run(
      Effect.gen(function* () {
        yield* enqueue("A");
        yield* adopt("pre-restart");
        const before = yield* readQueue(threadId);
        yield* transaction(suspendQueue(threadId, before));
        yield* finish("pre-restart");
        const waiting = yield* readQueue(threadId);
        expect(waiting.items).toEqual(before.items);
        expect(waiting.awaitingCompletion).toBe(true);
        yield* ordinaryStart();
        yield* adopt("post-restart");
        yield* finish("post-restart");
        expect((yield* readQueue(threadId)).awaitingCompletion).toBe(false);
      }),
    ),
  );
});
