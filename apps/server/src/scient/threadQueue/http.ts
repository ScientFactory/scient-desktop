import { importLegacyQueue } from "./migration.ts";
import {
  enqueueQueue,
  updateQueue,
  removeQueue,
  reorderQueue,
  controlQueue,
} from "./operations.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ScientThreadQueueOperationError,
  type ThreadId,
  type EnvironmentInternalError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { QueueError, readQueue, writeQueue, snapshot, type QueueDocument } from "./Ledger.ts";
import { ServerConfig } from "../../config.ts";

const isQueueError = Schema.is(QueueError);

export const scientThreadQueueHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientThreadQueue",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const config = yield* ServerConfig;
    const handle = (
      name: string,
      threadId: ThreadId,
      change?: (
        doc: QueueDocument,
      ) => Effect.Effect<
        QueueDocument,
        QueueError | SqlError | ProjectionRepositoryError,
        SqlClient.SqlClient | ProjectionSnapshotQuery
      >,
      knownRevision?: number,
    ) =>
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest(name);
        yield* requireEnvironmentScope(
          change ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
        );
        return yield* Effect.gen(function* () {
          if (!change && knownRevision !== undefined) {
            const [row] = yield* sql<{
              revision: number;
            }>`SELECT revision FROM scient_thread_queue WHERE thread_id = ${threadId}`;
            if (row?.revision === knownRevision)
              return { threadId, items: [], revision: row.revision, unchanged: true };
          }
          const thread = yield* query.getThreadDetailById(threadId);
          if (Option.isNone(thread) || thread.value.deletedAt !== null)
            return yield* Effect.fail(new QueueError({ message: "The thread no longer exists." }));
          yield* importLegacyQueue(threadId, yield* readQueue(threadId, thread.value.session));
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const currentThread = yield* query.getThreadDetailById(threadId);
              if (Option.isNone(currentThread) || currentThread.value.deletedAt !== null)
                return yield* new QueueError({ message: "The thread no longer exists." });
              let doc = yield* readQueue(threadId, currentThread.value.session);
              if (change) doc = yield* writeQueue(threadId, yield* change(doc));
              return snapshot(threadId, doc);
            }),
          );
        }).pipe(
          Effect.catch(
            (
              cause,
            ): Effect.Effect<never, ScientThreadQueueOperationError | EnvironmentInternalError> =>
              isQueueError(cause)
                ? Effect.fail(new ScientThreadQueueOperationError({ message: cause.message }))
                : failEnvironmentInternal("scient_thread_queue_operation_failed", cause),
          ),
        );
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ServerConfig, config),
        Effect.provideService(ProjectionSnapshotQuery, query),
      );
    return handlers
      .handle("list", ({ endpoint, payload }) =>
        handle(endpoint.name, payload.threadId, undefined, payload.knownRevision),
      )
      .handle("enqueue", ({ endpoint, payload }) =>
        handle(endpoint.name, payload.threadId, (doc) => enqueueQueue(payload, doc)),
      )
      .handle("update", ({ endpoint, payload }) =>
        handle(endpoint.name, payload.threadId, (doc) => updateQueue(payload, doc)),
      )
      .handle("remove", ({ endpoint, payload }) =>
        handle(endpoint.name, payload.threadId, (doc) => removeQueue(payload, doc)),
      )
      .handle("reorder", ({ endpoint, payload }) =>
        handle(endpoint.name, payload.threadId, (doc) => reorderQueue(payload, doc)),
      )
      .handle("control", ({ endpoint, payload }) =>
        handle(endpoint.name, payload.threadId, (doc) => controlQueue(payload, doc)),
      );
  }),
);
