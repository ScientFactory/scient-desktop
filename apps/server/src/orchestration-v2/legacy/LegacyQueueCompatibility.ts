import {
  CommandId,
  SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD,
  ScientThreadQueueOperationError,
  type ScientThreadQueueListRequest,
  type ScientThreadQueueEnqueueRequest,
  type ScientThreadQueueRemoveRequest,
  type ScientThreadQueueReorderRequest,
  type ScientThreadQueueControlRequest,
  type ScientThreadQueueUpdateRequest,
  type ScientThreadQueueSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { listScientThreadQueue } from "../../scient/threadQueue/Store.ts";
import { readQueue, writeQueue } from "./LegacyQueueLedger.ts";
import { enqueueQueue } from "../../scient/threadQueue/admission.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ThreadManagementService } from "../ThreadManagementService.ts";
import { EventSinkV2 } from "../EventSink.ts";
import type { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import type { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";
import { cutOverLegacyQueue } from "./LegacyQueueCutover.ts";

type Request =
  | { readonly method: "list"; readonly payload: ScientThreadQueueListRequest }
  | { readonly method: "enqueue"; readonly payload: ScientThreadQueueEnqueueRequest }
  | { readonly method: "remove"; readonly payload: ScientThreadQueueRemoveRequest }
  | { readonly method: "reorder"; readonly payload: ScientThreadQueueReorderRequest }
  | { readonly method: "control"; readonly payload: ScientThreadQueueControlRequest }
  | { readonly method: "update"; readonly payload: ScientThreadQueueUpdateRequest };

type Dependencies =
  | OrchestratorV2
  | ThreadManagementService
  | EventSinkV2
  | CommandReceiptStoreV2
  | SqlClient.SqlClient
  | LegacyV1ThreadImporter
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path;

/** Old queue transports read native runs. SQL documents are admission staging only. */
export const makeLegacyQueueCompatibility = Effect.gen(function* () {
  const services = yield* Effect.context<Dependencies>();
  const orchestrator = yield* OrchestratorV2;
  const threads = yield* ThreadManagementService;
  const sink = yield* EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const execute = Effect.fn("LegacyQueueCompatibility.execute")(function* (request: Request) {
    const { threadId } = request.payload;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (projection.thread.deletedAt !== null)
      return yield* new ScientThreadQueueOperationError({
        message: "The thread no longer exists.",
      });
    if (request.method !== "list" && projection.thread.archivedAt !== null)
      return yield* new ScientThreadQueueOperationError({ message: "Unarchive the thread first." });
    if (request.method === "list") {
      const recoveryError = () =>
        new ScientThreadQueueOperationError({
          message:
            "Saved queued work requires recovery and has been retained. Keep your recovery backup and restart Scient to retry admission. If this persists, request recovery support before sending these messages again.",
        });
      const document = yield* readQueue(threadId).pipe(Effect.mapError(() => recoveryError()));
      if (document.items.length > 0) return yield* recoveryError();
      if (!document.migrated) {
        const config = yield* ServerConfig;
        const legacy = yield* Effect.tryPromise(() =>
          listScientThreadQueue({
            stateDir: config.stateDir,
            threadId,
          }),
        ).pipe(Effect.mapError(() => recoveryError()));
        if (legacy.items.length > 0) return yield* recoveryError();
      }
    }
    const commandId = CommandId.make(`legacy-queue-api:${yield* randomUuidV4}`);
    const ownedRuns = projection.runs.filter((run) => run.legacyQueue !== undefined);
    if (request.method === "enqueue") {
      if (
        ownedRuns.filter((run) => run.status === "queued").length >=
          SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD &&
        !ownedRuns.some((run) => run.legacyQueue?.queueItemId === request.payload.queueItemId)
      )
        return yield* new ScientThreadQueueOperationError({
          message: "The queue already holds 20 messages.",
        });
      // Persist before native acceptance so a failed admission remains recoverable.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const document = yield* readQueue(threadId);
          yield* writeQueue(threadId, yield* enqueueQueue(request.payload, document));
        }),
      );
      yield* cutOverLegacyQueue(threadId);
    } else if (request.method === "remove" || request.method === "control") {
      const payload = request.payload;
      const action = request.method === "remove" ? "remove" : request.payload.action;
      if (action === "resume") {
        yield* threads.dispatch({ type: "queue.resume", commandId, threadId });
      } else {
        const run = ownedRuns.find((run) => run.legacyQueue?.queueItemId === payload.queueItemId);
        if (run === undefined)
          return yield* new ScientThreadQueueOperationError({
            message: "The queued message has already started or was removed.",
          });
        if (action === "extract" || action === "stash" || action === "remove") {
          const extraction = request.method === "control" && action !== "remove";
          const editToken = request.method === "control" ? request.payload.editToken : undefined;
          if (extraction && !editToken)
            return yield* new ScientThreadQueueOperationError({
              message: "An edit identity is required.",
            });
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: extraction
              ? CommandId.make(`legacy-extract:${threadId}:${payload.queueItemId}:${editToken}`)
              : commandId,
            threadId,
            runId: run.id,
            ...(request.method === "control" && request.payload.expectedUpdatedAt !== undefined
              ? { expectedUpdatedAt: DateTime.makeUnsafe(request.payload.expectedUpdatedAt) }
              : {}),
          });
        } else if (action === "send") {
          yield* threads.dispatch({
            type: "queue.resume",
            commandId,
            threadId,
            runId: run.id,
          });
        } else if (action === "steer") {
          const active = projection.runs.find((candidate) =>
            ["starting", "running", "waiting"].includes(candidate.status),
          );
          if (active === undefined)
            return yield* new ScientThreadQueueOperationError({
              message: "There is no active run to steer.",
            });
          yield* threads.dispatch({
            type: "queued-message.promote-to-steer",
            commandId,
            threadId,
            queuedRunId: run.id,
            targetRunId: active.id,
          });
        } else {
          return yield* new ScientThreadQueueOperationError({
            message: "Extract this message into an ordinary draft to edit it.",
          });
        }
      }
    } else if (request.method === "reorder") {
      const queued = ownedRuns.filter((run) => run.status === "queued");
      const ids = new Set(request.payload.queueItemIds);
      if (
        ids.size !== queued.length ||
        ids.size !== request.payload.queueItemIds.length ||
        queued.some((run) => !ids.has(run.legacyQueue!.queueItemId))
      )
        return yield* new ScientThreadQueueOperationError({
          message: "The queue changed. Refresh before reordering it.",
        });
      yield* orchestrator.dispatch({
        type: "legacy-queue.reorder",
        commandId,
        threadId,
        queueItemIds: request.payload.queueItemIds,
      });
    } else if (request.method === "update") {
      return yield* new ScientThreadQueueOperationError({
        message:
          "This edit reservation ended at migration. Recover the edited text as an ordinary draft.",
      });
    }

    const current = yield* orchestrator.getThreadProjection(threadId);
    const revision = yield* sink.latestSequence({ threadId });
    return {
      threadId,
      revision,
      nativeQueue: true,
      awaitingCompletion: current.runs.some(
        (run) => run.status === "queued" && run.queueHeld === true,
      ),
      paused: null,
      items: current.runs
        .filter((run) => run.status === "queued" && run.legacyQueue !== undefined)
        .toSorted((a, b) => (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal))
        .flatMap((run) => {
          const message = current.messages.find((message) => message.id === run.userMessageId);
          if (message === undefined) return [];
          return [
            {
              ...run.legacyQueue!,
              threadId,
              messageId: message.id,
              text: message.text,
              attachments: message.attachments,
              modelSelection: run.modelSelection,
              ...(message.context === undefined ? {} : { context: message.context }),
              ...(message.composerSnapshot === undefined
                ? {}
                : { composerSnapshot: message.composerSnapshot }),
              ...(message.selectedScientSkillNames === undefined
                ? {}
                : { selectedScientSkillNames: message.selectedScientSkillNames }),
              state: "waiting" as const,
              createdAt: DateTime.formatIso(message.createdAt),
              updatedAt: DateTime.formatIso(message.updatedAt),
            },
          ];
        }),
    } satisfies ScientThreadQueueSnapshot;
  });
  return {
    execute: (request: Request) => execute(request).pipe(Effect.provideContext(services)),
  };
});
