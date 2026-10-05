import type {
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import type { EventStoreV2 } from "../../orchestration-v2/EventStore.ts";
import type { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import type { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { makeProviderFailure } from "../../orchestration-v2/ProviderFailure.ts";
import { isAutomaticCompletionRun } from "../../orchestration-v2/QueuedRunOrder.ts";

/** Bind the native terminal reaction once; reads and writes stay lazy under the caller's lock. */
export const makeScientTerminalQueueHold = <OrdinalError, WriteError>({
  projectionStore,
  eventStore,
  commandReceipts,
  idAllocator,
  nextTurnItemOrdinal,
  writeSystemEvents,
}: {
  readonly projectionStore: Pick<ProjectionStoreV2["Service"], "getThreadRecords">;
  readonly eventStore: Pick<EventStoreV2["Service"], "latestSequence" | "read">;
  readonly commandReceipts: Pick<CommandReceiptStoreV2["Service"], "getByCommandId">;
  readonly idAllocator: Pick<IdAllocatorV2["Service"], "derive">;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrdinalError>;
  readonly writeSystemEvents: (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
  ) => Effect.Effect<void, WriteError>;
}) => {
  const holdQueueAfterTerminal = Effect.fn("orchestrationV2.holdQueueAfterTerminal")(function* (
    stored: OrchestrationV2StoredEvent,
  ) {
    if (
      stored.event.type !== "run.updated" ||
      (stored.event.payload.status !== "failed" && stored.event.payload.status !== "interrupted")
    )
      return;
    const terminal = stored.event.payload;
    const threadId = stored.event.threadId;
    const projection = yield* projectionStore.getThreadRecords(
      threadId,
      ["runs", "messages", "nodes", "attempts", "providerTurns", "turnItems"],
      { messageRoles: ["user", "system"], turnItemRunIds: [terminal.id] },
    );
    const run = projection.runs.find((candidate) => candidate.id === terminal.id);
    if (
      run === undefined ||
      run.status !== terminal.status ||
      run.activeAttemptId !== terminal.activeAttemptId
    )
      return;
    const queued = projection.runs.filter(
      (candidate) =>
        candidate.status === "queued" &&
        candidate.queueHeld !== true &&
        !isAutomaticCompletionRun(projection, candidate),
    );
    const queueBoundaries = new Map<RunId, number>();
    let terminalSequence = stored.sequence;
    if (queued.length > 0) {
      // Only this rare terminal reaction reads historical run facts. Resume,
      // admission, and the original exact-attempt terminal transition remain
      // durable across restart; checkpoint/cleanup echoes confer no new hold.
      const throughSequence = yield* eventStore.latestSequence({ threadId });
      const queuedIds = new Set(queued.map((candidate) => candidate.id));
      const admissionSequences = new Map<RunId, number>();
      const releaseReceipts = new Map<CommandId, number>();
      yield* Stream.concat(
        eventStore.read({ threadId, eventType: "run.created", throughSequence }),
        eventStore.read({ threadId, eventType: "run.updated", throughSequence }),
      ).pipe(
        Stream.runForEach((entry) =>
          Effect.gen(function* () {
            const event = entry.event;
            if (event.type !== "run.created" && event.type !== "run.updated") return;
            const payload = event.payload;
            if (
              event.type === "run.updated" &&
              payload.id === terminal.id &&
              payload.activeAttemptId === terminal.activeAttemptId &&
              payload.rootNodeId === terminal.rootNodeId &&
              payload.providerThreadId === terminal.providerThreadId &&
              (payload.status === "failed" || payload.status === "interrupted")
            )
              terminalSequence = Math.min(terminalSequence, entry.sequence);
            if (!queuedIds.has(payload.id) || payload.status !== "queued") return;
            if (event.type === "run.created") {
              admissionSequences.set(
                payload.id,
                Math.min(admissionSequences.get(payload.id) ?? entry.sequence, entry.sequence),
              );
              return;
            }
            if (payload.queueHeld !== false || entry.commandId == null) return;
            let released = releaseReceipts.get(entry.commandId);
            if (released === undefined) {
              const receipt = yield* commandReceipts.getByCommandId(entry.commandId);
              released =
                Option.isSome(receipt) &&
                receipt.value.status === "accepted" &&
                receipt.value.threadId === threadId &&
                receipt.value.commandType === "queue.resume"
                  ? receipt.value.resultSequence
                  : 0;
              releaseReceipts.set(entry.commandId, released);
            }
            if (released >= entry.sequence)
              queueBoundaries.set(
                payload.id,
                Math.max(queueBoundaries.get(payload.id) ?? 0, entry.sequence),
              );
          }),
        ),
      );
      for (const [runId, sequence] of admissionSequences) {
        queueBoundaries.set(runId, Math.max(queueBoundaries.get(runId) ?? 0, sequence));
      }
    }
    const now = yield* DateTime.now;
    const rootNode = projection.nodes.find((node) => node.id === run.rootNodeId);
    const attempt = projection.attempts.find((entry) => entry.id === run.activeAttemptId);
    const nativeReceipt = projection.providerTurns.some(
      (turn) =>
        turn.runAttemptId === run.activeAttemptId &&
        turn.nodeId === run.rootNodeId &&
        turn.providerThreadId === run.providerThreadId &&
        (turn.acceptedAt !== undefined || turn.nativeAcceptance !== "pending"),
    );
    const retryable =
      run.status === "failed" &&
      run.queuePosition != null &&
      !isAutomaticCompletionRun(projection, run) &&
      attempt?.status === "failed" &&
      rootNode !== undefined &&
      !nativeReceipt;
    const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = queued
      .filter((candidate) => (queueBoundaries.get(candidate.id) ?? 0) <= terminalSequence)
      .map((candidate) => ({
        type: "run.updated",
        threadId,
        runId: candidate.id,
        providerInstanceId: candidate.providerInstanceId,
        occurredAt: now,
        payload: { ...candidate, queueHeld: true },
      }));
    if (retryable) {
      const failure =
        latestRootProviderFailure(run, projection.turnItems) ??
        makeProviderFailure({
          class: "unknown",
          message: "The queued provider could not start.",
        });
      events.push({
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.runSignalTurnItem({
            runId: run.id,
            signal: `queued-start-failure:${run.activeAttemptId}`,
          }),
          threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerThreadId: attempt.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* nextTurnItemOrdinal(projection),
          status: "failed",
          title: "Queued provider could not start",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure: { ...failure, code: "queued_start_failed" },
        },
      });
      events.push(
        {
          type: "run.updated",
          threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...run,
            status: "queued",
            queueHeld: true,
            startedAt: null,
            completedAt: null,
          },
        },
        {
          type: "node.updated",
          threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...rootNode, status: "pending", startedAt: null, completedAt: null },
        },
      );
    } else if (run.queuePosition != null) {
      events.push({
        type: "run.updated",
        threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, queuePosition: null },
      });
    }
    if (events.length > 0) yield* writeSystemEvents(events);
  });

  const holdLatestTerminalBeforePromotion = Effect.fn(
    "orchestrationV2.holdLatestTerminalBeforePromotion",
  )(function* (threadId: ThreadId) {
    const projection = yield* projectionStore.getThreadRecords(threadId, ["runs", "messages"], {
      messageRoles: ["user", "system"],
    });
    if (
      !projection.runs.some(
        (run) =>
          run.status === "queued" &&
          run.queueHeld !== true &&
          !isAutomaticCompletionRun(projection, run),
      )
    )
      return;
    const currentTerminals = new Map(
      projection.runs
        .filter((run) => run.status === "failed" || run.status === "interrupted")
        .map((run) => [run.id, run]),
    );
    if (currentTerminals.size === 0) return;
    const firstTerminals = new Map<RunId, OrchestrationV2StoredEvent>();
    const throughSequence = yield* eventStore.latestSequence({ threadId });
    yield* eventStore.read({ threadId, eventType: "run.updated", throughSequence }).pipe(
      Stream.runForEach((entry) =>
        Effect.sync(() => {
          if (
            entry.event.type !== "run.updated" ||
            String(entry.commandId).startsWith("command:runtime-reconcile:")
          )
            return;
          const terminal = entry.event.payload;
          const current = currentTerminals.get(terminal.id);
          if (
            current === undefined ||
            terminal.status !== current.status ||
            terminal.activeAttemptId !== current.activeAttemptId ||
            terminal.rootNodeId !== current.rootNodeId ||
            terminal.providerThreadId !== current.providerThreadId ||
            terminal.providerInstanceId !== current.providerInstanceId
          )
            return;
          const first = firstTerminals.get(current.id);
          if (first === undefined || entry.sequence < first.sequence)
            firstTerminals.set(current.id, entry);
        }),
      ),
    );
    // A later checkpoint echo is not a new terminal boundary. Reuse the hold
    // policy for the latest genuine current failure before reading the queue.
    let latest: OrchestrationV2StoredEvent | undefined;
    for (const terminal of firstTerminals.values()) {
      if (latest === undefined || terminal.sequence > latest.sequence) latest = terminal;
    }
    if (latest !== undefined) yield* holdQueueAfterTerminal(latest);
  });

  return { holdQueueAfterTerminal, holdLatestTerminalBeforePromotion };
};
