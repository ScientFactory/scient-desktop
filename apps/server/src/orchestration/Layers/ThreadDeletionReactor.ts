import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type TurnId,
} from "@synara/contracts";
import { makeDrainableWorker } from "@synara/shared/DrainableWorker";
import { collectSubagentDescendants } from "@synara/shared/threadHierarchy";
import { Cause, Effect, Layer, Stream } from "effect";

import { ProfileStatsArchive } from "../../profileStatsArchive";
import { ProviderService } from "../../provider/Services/ProviderService";
import { TerminalManager } from "../../terminal/Services/Manager";
import { THREAD_RETENTION_COMMAND_ID_PREFIX } from "../../threadRetention";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

// Crash recovery / backfill: threads soft-deleted before the purge could run
// (or before purge existed) are archived and purged shortly after startup.
const PURGE_STARTUP_SWEEP_DELAY_MS = 60 * 1000;

const MISSING_PROVIDER_BINDING_DETAIL = "no persisted provider binding exists";
const SUBAGENT_SETTLEMENT_POLL_ATTEMPTS = 50;
const SUBAGENT_SETTLEMENT_POLL_INTERVAL_MS = 100;

export type DeletedThreadProviderCleanup =
  | {
      readonly kind: "stop-session";
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "interrupt-subagent-turn";
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly providerThreadId: string;
    }
  | {
      readonly kind: "defer-active-subagent";
      readonly threadId: ThreadId;
    };

export function providerCleanupCanPurgeImmediately(cleanup: DeletedThreadProviderCleanup): boolean {
  return cleanup.kind === "stop-session";
}

export function hasUnsettledSameCascadeDescendants(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): boolean {
  const root = readModel.threads.find((thread) => thread.id === threadId);
  if (!root || root.deletedAt === null) return false;
  const sameCascadeProjectThreads = readModel.threads.filter(
    (thread) => thread.projectId === root.projectId && thread.deletedAt === root.deletedAt,
  );
  return collectSubagentDescendants(sameCascadeProjectThreads, threadId).some(
    (thread) => (thread.session?.activeTurnId ?? null) !== null,
  );
}

export const waitForDeletedSubagentSettlement = Effect.fn("waitForDeletedSubagentSettlement")(
  function* (input: {
    readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, unknown>;
    readonly threadId: ThreadId;
    readonly attempts?: number;
    readonly intervalMs?: number;
  }) {
    const attempts = Math.max(1, input.attempts ?? SUBAGENT_SETTLEMENT_POLL_ATTEMPTS);
    const intervalMs = Math.max(0, input.intervalMs ?? SUBAGENT_SETTLEMENT_POLL_INTERVAL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const readModel = yield* input.getReadModel();
      const thread = readModel.threads.find((candidate) => candidate.id === input.threadId);
      if (!thread || (thread.session?.activeTurnId ?? null) === null) return true;
      if (attempt + 1 < attempts) yield* Effect.sleep(intervalMs);
    }
    return false;
  },
);

/**
 * Resolves provider cleanup before a deleted thread is hard-purged. Subagents
 * share their highest reachable parent's provider session, so an active child
 * turn must be interrupted through that owner rather than stopped as though it
 * had an independent provider binding. Corrupt or incomplete lineage falls
 * back to the existing per-thread stop path, which is safe to retry.
 */
export function resolveDeletedThreadProviderCleanup(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): DeletedThreadProviderCleanup {
  const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
  const thread = threadById.get(threadId);
  const directParentId = thread?.parentThreadId ?? null;
  const activeTurnId = thread?.session?.activeTurnId ?? null;
  if (!thread || !directParentId || activeTurnId === null) {
    return { kind: "stop-session", threadId };
  }

  const directParent = threadById.get(directParentId);
  const isEligibleProviderAncestor = (ancestor: OrchestrationThread): boolean =>
    ancestor.projectId === thread.projectId &&
    ancestor.archivedAt === null &&
    (ancestor.deletedAt === null ||
      (thread.deletedAt !== null && ancestor.deletedAt === thread.deletedAt));
  const providerThreadPrefix = `subagent:${directParentId}:`;
  const rawThreadId = String(thread.id);
  if (
    !directParent ||
    !isEligibleProviderAncestor(directParent) ||
    !rawThreadId.startsWith(providerThreadPrefix)
  ) {
    return { kind: "defer-active-subagent", threadId };
  }

  const providerThreadId = rawThreadId.slice(providerThreadPrefix.length);
  if (providerThreadId.length === 0) {
    return { kind: "defer-active-subagent", threadId };
  }

  let providerOwner = directParent;
  const visitedThreadIds = new Set<ThreadId>([thread.id]);
  while (providerOwner.parentThreadId) {
    if (visitedThreadIds.has(providerOwner.id)) {
      return { kind: "defer-active-subagent", threadId };
    }
    visitedThreadIds.add(providerOwner.id);
    const expectedOwnerPrefix = `subagent:${providerOwner.parentThreadId}:`;
    if (!String(providerOwner.id).startsWith(expectedOwnerPrefix)) {
      return { kind: "defer-active-subagent", threadId };
    }
    const parent = threadById.get(providerOwner.parentThreadId);
    if (!parent || !isEligibleProviderAncestor(parent)) {
      return { kind: "defer-active-subagent", threadId };
    }
    providerOwner = parent;
  }

  return {
    kind: "interrupt-subagent-turn",
    threadId: providerOwner.id,
    turnId: activeTurnId,
    providerThreadId,
  };
}

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

export const cleanupSucceededUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<boolean, E, R> =>
  effect.pipe(
    Effect.as(true),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false));
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const profileStatsArchive = yield* ProfileStatsArchive;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;

  const refreshCommandReadModelAfterPurge = (threadId: string) =>
    orchestrationEngine.refreshCommandReadModel().pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion cleanup could not refresh command read model", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const stopProviderSessionWithoutBinding = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
    cause: Cause.Cause<unknown>,
  ) =>
    Effect.logDebug("thread deletion cleanup found no provider session to stop", {
      threadId,
      cause: Cause.pretty(cause),
    }).pipe(Effect.as(true));

  const stopProviderRuntime = Effect.fn(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    if (hasUnsettledSameCascadeDescendants(readModel, threadId)) {
      yield* Effect.logWarning(
        "thread deletion cleanup retained provider owner for unsettled subagent descendants",
        { threadId },
      );
      return false;
    }
    const cleanup = resolveDeletedThreadProviderCleanup(readModel, threadId);
    if (cleanup.kind === "defer-active-subagent") {
      yield* Effect.logWarning("thread deletion cleanup deferred active subagent purge", {
        threadId,
      });
      return providerCleanupCanPurgeImmediately(cleanup);
    }
    if (cleanup.kind === "interrupt-subagent-turn") {
      const interruptAcknowledged = yield* providerService
        .interruptTurn({
          threadId: cleanup.threadId,
          turnId: cleanup.turnId,
          providerThreadId: cleanup.providerThreadId,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            if (Cause.pretty(cause).includes(MISSING_PROVIDER_BINDING_DETAIL)) {
              return Effect.logWarning(
                "thread deletion cleanup could not prove active subagent interruption",
                { threadId, cause: Cause.pretty(cause) },
              ).pipe(Effect.as(false));
            }
            return Effect.logDebug("thread deletion cleanup skipped subagent turn interrupt", {
              threadId,
              providerOwnerThreadId: cleanup.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false));
          }),
        );
      if (interruptAcknowledged) {
        yield* Effect.logDebug("thread deletion cleanup waiting for subagent terminal settlement", {
          threadId,
        });
        const settled = yield* waitForDeletedSubagentSettlement({
          getReadModel: orchestrationEngine.getReadModel,
          threadId,
        });
        if (settled) return true;
        yield* Effect.logWarning(
          "thread deletion cleanup timed out waiting for subagent terminal settlement",
          { threadId },
        );
      }
      // Provider interruption is asynchronous. Keep the soft-delete tombstone
      // until the terminal event clears activeTurnId; the startup sweep safely
      // retries the hard purge after settlement.
      return providerCleanupCanPurgeImmediately(cleanup);
    }
    return yield* providerService.stopSession({ threadId }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        if (Cause.pretty(cause).includes(MISSING_PROVIDER_BINDING_DETAIL)) {
          return stopProviderSessionWithoutBinding(threadId, cause);
        }
        return Effect.logDebug("thread deletion cleanup skipped provider session stop", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false));
      }),
    );
  });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    cleanupSucceededUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  // Retention deletes only hide the thread (its rows keep feeding profile
  // stats directly). Explicit deletes snapshot the stat aggregates and then
  // hard-delete the thread's rows so disk space is actually reclaimed.
  const purgeThreadData = (event: ThreadDeletedEvent) => {
    if (event.commandId?.startsWith(THREAD_RETENTION_COMMAND_ID_PREFIX)) {
      return Effect.void;
    }
    return profileStatsArchive
      .purgeThreadWithStatsSnapshot({ threadId: event.payload.threadId })
      .pipe(
        Effect.flatMap((purged) =>
          purged ? refreshCommandReadModelAfterPurge(event.payload.threadId) : Effect.void,
        ),
        Effect.catch((error) =>
          // A failed purge leaves the thread soft-deleted; the startup sweep
          // retries it on the next boot.
          Effect.logWarning("thread deletion cleanup skipped stats archive purge", {
            threadId: event.payload.threadId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
  };

  const cleanupThreadBeforePurge = Effect.fn(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    const providerCleanupSucceeded = yield* stopProviderRuntime(threadId);
    const terminalCleanupSucceeded = yield* closeThreadTerminals(threadId);
    return providerCleanupSucceeded && terminalCleanupSucceeded;
  });

  const processThreadDeleted = Effect.fn(function* (event: ThreadDeletedEvent) {
    const { threadId } = event.payload;
    const cleanupSucceeded = yield* cleanupThreadBeforePurge(threadId);
    if (!cleanupSucceeded) {
      yield* Effect.logWarning("thread deletion cleanup deferred stats archive purge", {
        threadId,
      });
      return;
    }
    yield* purgeThreadData(event);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
    yield* Effect.forkScoped(
      Effect.sleep(PURGE_STARTUP_SWEEP_DELAY_MS).pipe(
        Effect.flatMap(() =>
          profileStatsArchive.purgeSoftDeletedManualThreads({
            beforePurge: (threadId) => cleanupThreadBeforePurge(ThreadId.makeUnsafe(threadId)),
          }),
        ),
        Effect.tap((purgedCount) =>
          purgedCount > 0 ? refreshCommandReadModelAfterPurge("startup-sweep") : Effect.void,
        ),
        Effect.flatMap((purgedCount) =>
          purgedCount > 0
            ? Effect.logInfo("purged soft-deleted threads after stats archive snapshot", {
                purgedCount,
              })
            : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.logWarning("startup purge sweep for deleted threads failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
