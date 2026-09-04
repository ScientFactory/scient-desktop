import { importLegacyQueue } from "./migration.ts";
import { discoverLegacyQueueThreads } from "./Store.ts";
import { isOrchestrationCommandRejection } from "../../orchestration/Errors.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../../config.ts";
import { WorkspacePaths } from "../../workspace/WorkspacePaths.ts";
import {
  CommandId,
  MessageId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { listenQueue } from "./signals.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  cleanupFailedUploadedAttachments,
  normalizeDispatchCommand,
} from "../../orchestration/Normalizer.ts";
import { readQueue, writeQueue, suspendQueue } from "./Ledger.ts";

export class ScientQueueWorker extends Context.Service<
  ScientQueueWorker,
  { start: Effect.Effect<void, never, Scope.Scope> }
>()("t3/scient/threadQueue/Worker/ScientQueueWorker") {}
export const ScientQueueWorkerLive = Layer.effect(
  ScientQueueWorker,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      SqlClient.SqlClient | FileSystem.FileSystem | Path.Path | ServerConfig | WorkspacePaths
    >();
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    // A persisted incomplete admission is never blindly replayed into a provider.
    const initialize = Effect.gen(function* () {
      const config = yield* ServerConfig;
      const legacyIds = yield* Effect.tryPromise(() => discoverLegacyQueueThreads(config.stateDir));
      for (const id of legacyIds) {
        const thread = yield* query.getThreadDetailById(id);
        if (Option.isSome(thread) && thread.value.deletedAt === null) {
          yield* importLegacyQueue(id, yield* readQueue(id, thread.value.session)).pipe(
            Effect.catch((cause) =>
              Effect.logError("Queue migration failed; source retained", cause),
            ),
          );
        }
      }
      const rows = yield* sql<{ thread_id: string }>`SELECT thread_id FROM scient_thread_queue`;
      for (const row of rows) {
        const id = ThreadId.make(row.thread_id);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const doc = yield* readQueue(id);
            if (doc.blocked) yield* suspendQueue(id, doc);
          }),
        );
      }
    });
    const processThread = Effect.fn("ScientQueue.processThread")(function* (id: ThreadId) {
      const doc = yield* readQueue(id);
      const item =
        doc.items.find((entry) => entry.state !== "editing" && entry.steerRequested) ??
        doc.items.find((entry) => entry.state !== "editing");
      if (!item || (!item.steerRequested && (doc.blocked || doc.awaitingCompletion || doc.paused)))
        return;
      const target = yield* query.getThreadDetailById(id);
      if (Option.isNone(target) || target.value.deletedAt !== null) return;
      const thread = target.value;
      if (
        !item.steerRequested &&
        (thread.session?.status === "running" || thread.session?.status === "starting")
      )
        return;
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make(`queue:${item.queueItemId}:${doc.revision}`),
        threadId: id,
        message: {
          messageId: MessageId.make(`queue:${item.queueItemId}`),
          role: "user",
          text: item.text,
          attachments: item.attachments,
        },
        modelSelection: item.steerRequested
          ? thread.modelSelection
          : (item.modelSelection ?? thread.modelSelection),
        runtimeMode: item.steerRequested
          ? thread.runtimeMode
          : (item.runtimeMode ?? thread.runtimeMode),
        interactionMode: item.steerRequested
          ? thread.interactionMode
          : (item.interactionMode ?? thread.interactionMode),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* Effect.gen(function* () {
        const normalized = yield* normalizeDispatchCommand(command);
        if (normalized.type !== "thread.turn.start") return;
        yield* engine
          .dispatch({ ...normalized, queueItemId: item.queueItemId, queueRevision: doc.revision })
          .pipe(
            Effect.tapError((cause) =>
              isOrchestrationCommandRejection(cause)
                ? cleanupFailedUploadedAttachments(command, normalized, { includeInline: true })
                : Effect.void,
            ),
          );
      }).pipe(
        Effect.catch((cause) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const latest = yield* readQueue(id);
              // A competing edit/reorder/start is an admission conflict, not a failed delivery.
              if (latest.revision !== doc.revision) return;
              yield* writeQueue(id, { ...latest, paused: `Queue paused: ${String(cause)}` });
            }),
          ),
        ),
      );
    });
    let started = false;
    return {
      start: Effect.gen(function* () {
        if (started) return;
        started = true;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            started = false;
          }),
        );
        const pending = new Set<ThreadId>();
        const mailbox = yield* Queue.unbounded<ThreadId>();
        const wake = (id: ThreadId) => {
          if (!pending.has(id)) {
            pending.add(id);
            Queue.offerUnsafe(mailbox, id);
          }
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => listenQueue(sql, wake)),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        yield* initialize;
        const rows = yield* sql<{ thread_id: string }>`SELECT thread_id FROM scient_thread_queue`;
        for (const row of rows) wake(ThreadId.make(row.thread_id));
        yield* Effect.forever(
          Effect.gen(function* () {
            const id = yield* Queue.take(mailbox);
            pending.delete(id);
            yield* processThread(id).pipe(
              Effect.catchCause((cause) => Effect.logError("Queue worker failed", cause)),
            );
          }),
        ).pipe(Effect.forkScoped);
      }).pipe(Effect.provideContext(context), Effect.orDie),
    };
  }),
);
