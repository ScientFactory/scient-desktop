/** A start the app declined before native acceptance. Its cancellation commits only
 * while every captured owner is still current. */
import type {
  CheckpointScopeId,
  NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as EffectOutbox from "../EffectOutbox.ts";
import type * as IdAllocator from "../IdAllocator.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "../ProviderAdapter.ts";
import type * as ProviderSessionManager from "../ProviderSessionManager.ts";

/** The captured owner of a locally declined start, never a native acceptance receipt. */
export interface PendingStartOwner {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly activeAttemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly checkpointScopeId: OrchestrationV2ExecutionNode["checkpointScopeId"];
  readonly runOrdinal: number;
  readonly providerThread: Pick<
    OrchestrationV2ProviderThread,
    "id" | "driver" | "providerInstanceId" | "providerSessionId" | "nativeThreadRef"
  >;
  readonly interruptRequestId: TurnItemId;
  readonly interruptResultId: TurnItemId;
  readonly retainedTurn?: {
    readonly id: ProviderTurnId;
    readonly attemptId: RunAttemptId;
    readonly runId: RunId;
    readonly runOrdinal: number;
  };
}

export function matchesPendingStartOwner(
  current: ProjectionStore.ProjectionRecords<
    "runs" | "attempts" | "nodes" | "providerThreads" | "providerTurns"
  >,
  owner: PendingStartOwner,
): boolean {
  const run = current.runs.find((row) => row.id === owner.runId);
  const attempt = current.attempts.find((row) => row.id === owner.activeAttemptId);
  const root = current.nodes.find((row) => row.id === owner.rootNodeId);
  const thread = current.providerThreads.find((row) => row.id === owner.providerThread.id);
  const ref = thread?.nativeThreadRef;
  const capturedRef = owner.providerThread.nativeThreadRef;
  const retained = owner.retainedTurn;
  const priorTurn =
    retained === undefined
      ? undefined
      : current.providerTurns.find((row) => row.id === retained.id);
  const priorAttempt =
    retained === undefined
      ? undefined
      : current.attempts.find((row) => row.id === retained.attemptId);
  const priorRun =
    retained === undefined ? undefined : current.runs.find((row) => row.id === retained.runId);
  const priorOwnerMatches =
    retained !== undefined &&
    priorTurn?.runAttemptId === retained.attemptId &&
    priorTurn.providerThreadId === owner.providerThread.id &&
    priorTurn.nodeId === priorAttempt?.rootNodeId &&
    priorAttempt?.runId === retained.runId &&
    priorAttempt.providerInstanceId === owner.providerThread.providerInstanceId &&
    priorAttempt.providerThreadId === owner.providerThread.id &&
    priorRun?.ordinal === retained.runOrdinal &&
    ["completed", "interrupted", "cancelled", "failed"].includes(priorRun.status) &&
    priorRun.threadId === owner.threadId &&
    priorRun.rootNodeId === priorAttempt.rootNodeId &&
    priorRun.providerThreadId === owner.providerThread.id &&
    priorRun.providerInstanceId === owner.providerThread.providerInstanceId &&
    retained.runOrdinal < owner.runOrdinal;
  const priorRoot = current.nodes.find((row) => row.id === priorAttempt?.rootNodeId);
  const sameRunSupersededOwnerMatches =
    retained !== undefined &&
    retained.runId === owner.runId &&
    retained.runOrdinal === owner.runOrdinal &&
    priorRun?.id === owner.runId &&
    priorRun.ordinal === retained.runOrdinal &&
    priorRun.threadId === owner.threadId &&
    priorTurn?.runAttemptId === retained.attemptId &&
    priorTurn.providerThreadId === owner.providerThread.id &&
    priorTurn.nodeId === priorAttempt?.rootNodeId &&
    priorAttempt?.runId === owner.runId &&
    priorAttempt.id !== owner.activeAttemptId &&
    attempt !== undefined &&
    priorAttempt.attemptOrdinal < attempt.attemptOrdinal &&
    priorAttempt.status === "superseded" &&
    priorAttempt.providerInstanceId === owner.providerThread.providerInstanceId &&
    priorAttempt.providerThreadId === owner.providerThread.id &&
    priorRoot?.id !== owner.rootNodeId &&
    priorRoot?.rootNodeId === priorAttempt.rootNodeId &&
    priorRoot.kind === "root_turn" &&
    priorRoot.parentNodeId === null &&
    priorRoot.threadId === owner.threadId &&
    priorRoot.runId === owner.runId &&
    priorRoot.providerThreadId === owner.providerThread.id;
  return (
    current.thread.id === owner.threadId &&
    current.thread.archivedAt === null &&
    current.thread.deletedAt === null &&
    current.thread.activeProviderThreadId === owner.providerThread.id &&
    run?.status === "running" &&
    run.ordinal === owner.runOrdinal &&
    run.activeAttemptId === owner.activeAttemptId &&
    run.rootNodeId === owner.rootNodeId &&
    run.providerThreadId === owner.providerThread.id &&
    run.providerInstanceId === owner.providerThread.providerInstanceId &&
    attempt?.status === "running" &&
    attempt.runId === owner.runId &&
    attempt.rootNodeId === owner.rootNodeId &&
    attempt.providerThreadId === owner.providerThread.id &&
    attempt.providerInstanceId === owner.providerThread.providerInstanceId &&
    attempt.providerTurnId === null &&
    root?.status === "running" &&
    root.kind === "root_turn" &&
    root.parentNodeId === null &&
    root.checkpointScopeId === owner.checkpointScopeId &&
    root.threadId === owner.threadId &&
    root.runId === owner.runId &&
    root.rootNodeId === owner.rootNodeId &&
    root.providerThreadId === owner.providerThread.id &&
    root.providerTurnId === null &&
    thread?.appThreadId === owner.threadId &&
    thread.providerInstanceId === owner.providerThread.providerInstanceId &&
    thread.providerSessionId === owner.providerThread.providerSessionId &&
    thread.driver === owner.providerThread.driver &&
    (ref === null
      ? capturedRef === null
      : capturedRef !== null &&
        ref?.driver === capturedRef.driver &&
        ref?.nativeId === capturedRef.nativeId &&
        ref?.strength === capturedRef.strength &&
        ref?.fingerprint === capturedRef.fingerprint &&
        ref?.ordinal === capturedRef.ordinal) &&
    (thread.lastRunOrdinal === owner.runOrdinal ||
      (priorOwnerMatches && thread.lastRunOrdinal === retained?.runOrdinal)) &&
    (retained === undefined || priorOwnerMatches || sameRunSupersededOwnerMatches) &&
    !current.providerTurns.some(
      (turn) => turn.runAttemptId === owner.activeAttemptId || turn.nodeId === owner.rootNodeId,
    )
  );
}

/** Recheck the captured owner inside the write transaction that commits the cancellation. */
export const pendingStartOwnerIsCurrent = Effect.fn("pendingStartOwnerIsCurrent")(function* (
  projectionStore: ProjectionStore.ProjectionStoreV2Shape,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
  },
  owner: PendingStartOwner & {
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  },
) {
  const current = yield* projectionStore.getThreadRecords(input.threadId, [
    "runs",
    "attempts",
    "nodes",
    "providerThreads",
    "providerTurns",
  ]);
  return !(
    owner.threadId !== input.threadId ||
    owner.runId !== input.runId ||
    owner.activeAttemptId !== input.activeAttemptId ||
    !matchesPendingStartOwner(current, owner) ||
    !owner.effects.every(
      (effect) =>
        effect.threadId === owner.threadId &&
        effect.request.type === "checkpoint.capture" &&
        effect.request.runId === owner.runId &&
        effect.request.scopeId === owner.checkpointScopeId,
    ) ||
    !(yield* projectionStore.hasUnpairedRunInterruptRequest(
      input.threadId,
      owner.interruptRequestId,
      owner.interruptResultId,
    ))
  );
});

/** A Stop requested before the native offer declines the start. */
export const startUnlessStopRequested = (
  currentAttemptRunning: Effect.Effect<boolean>,
  input: {
    readonly projectionStore: ProjectionStore.ProjectionStoreV2Shape;
    readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  },
) => {
  const { projectionStore, idAllocator } = input;
  return currentAttemptRunning.pipe(
    Effect.flatMap((current) =>
      current
        ? projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(
              Effect.map((requested) => !requested),
              Effect.catchCause(() => Effect.succeed(false)),
            )
        : Effect.succeed(false),
    ),
  );
};

/** Capture the owner of a start declined by Stop before native acceptance. Built at layer
 * scope: a long-lived run must retain only its captured owner, never startup history. */
export const pendingStartCancellation =
  (deps: {
    readonly projectionStore: ProjectionStore.ProjectionStoreV2Shape;
    readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
    readonly providerSessions: ProviderSessionManager.ProviderSessionManagerV2Shape;
  }) =>
  (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly rootNodeId: NodeId;
    readonly checkpointScopeId: CheckpointScopeId;
    readonly runOrdinal: number;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly session: ProviderAdapterV2SessionRuntime;
    readonly hasUnpairedRunInterruptRequest: () => Effect.Effect<boolean>;
  }) =>
  () =>
    Effect.gen(function* () {
      const { projectionStore, idAllocator, providerSessions } = deps;
      if (!(yield* input.hasUnpairedRunInterruptRequest())) return undefined;
      const current = yield* projectionStore.getThreadRecords(input.threadId, [
        "runs",
        "attempts",
        "nodes",
        "providerThreads",
        "providerTurns",
      ]);
      const previous = current.providerTurns.findLast(
        (turn) => turn.providerThreadId === input.providerThread.id,
      );
      const previousAttempt = current.attempts.find(
        (candidate) => candidate.id === previous?.runAttemptId,
      );
      const previousRun = current.runs.find((candidate) => candidate.id === previousAttempt?.runId);
      const owner: PendingStartOwner = {
        threadId: input.threadId,
        runId: input.runId,
        activeAttemptId: input.activeAttemptId,
        rootNodeId: input.rootNodeId,
        checkpointScopeId: input.checkpointScopeId,
        runOrdinal: input.runOrdinal,
        providerThread: input.providerThread,
        interruptRequestId: idAllocator.derive.runSignalTurnItem({
          runId: input.runId,
          signal: "interrupt-request",
        }),
        interruptResultId: idAllocator.derive.runSignalTurnItem({
          runId: input.runId,
          signal: "interrupt-result",
        }),
        ...(previous === undefined || previousAttempt === undefined || previousRun === undefined
          ? {}
          : {
              retainedTurn: {
                id: previous.id,
                attemptId: previousAttempt.id,
                runId: previousRun.id,
                runOrdinal: previousRun.ordinal,
              },
            }),
      };
      if (!matchesPendingStartOwner(current, owner)) return undefined;
      const live = yield* providerSessions.get(input.providerSessionId);
      if (Option.isNone(live) || live.value !== input.session) return undefined;
      if (owner.retainedTurn !== undefined) {
        // The new turn was never offered. Stop retained work through its real
        // previous native turn, preserving shared-session and receipt identity.
        yield* input.session.interruptTurn({
          providerThread: input.providerThread,
          providerTurnId: owner.retainedTurn.id,
          requestRuntimeRestart: true,
        });
      }
      return owner;
    });
