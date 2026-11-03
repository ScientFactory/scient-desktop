import {
  CommandId,
  ScientThreadQueueOperationError,
  type ScientThreadQueueListRequest,
  type ScientThreadQueueControlRequest,
  type ScientThreadQueueSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { listScientThreadQueue } from "../../scient/threadQueue/Store.ts";
import { readQueue } from "./LegacyQueueLedger.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ThreadManagementService } from "../ThreadManagementService.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

type Request =
  | { readonly method: "list"; readonly payload: ScientThreadQueueListRequest }
  | { readonly method: "control"; readonly payload: ScientThreadQueueControlRequest };

type Dependencies =
  | OrchestratorV2
  | ThreadManagementService
  | EventSinkV2
  | SqlClient.SqlClient
  | ServerConfig;

/** Old queue transports read native runs. SQL documents are admission staging only. */
export const makeLegacyQueueCompatibility = Effect.gen(function* () {
  const services = yield* Effect.context<Dependencies>();
  const orchestrator = yield* OrchestratorV2;
  const threads = yield* ThreadManagementService;
  const sink = yield* EventSinkV2;
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
    if (request.method === "control") {
      const payload = request.payload;
      const action = payload.action;
      if (action === "resume") {
        yield* threads.dispatch({ type: "queue.resume", commandId, threadId });
      } else {
        const run = ownedRuns.find((run) => run.legacyQueue?.queueItemId === payload.queueItemId);
        if (run === undefined)
          return yield* new ScientThreadQueueOperationError({
            message: "The queued message has already started or was removed.",
          });
        if (action === "extract" || action === "stash") {
          const editToken = payload.editToken;
          if (!editToken)
            return yield* new ScientThreadQueueOperationError({
              message: "An edit identity is required.",
            });
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(
              `legacy-extract:${threadId}:${payload.queueItemId}:${editToken}`,
            ),
            threadId,
            runId: run.id,
            ...(payload.expectedUpdatedAt !== undefined
              ? { expectedUpdatedAt: DateTime.makeUnsafe(payload.expectedUpdatedAt) }
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
