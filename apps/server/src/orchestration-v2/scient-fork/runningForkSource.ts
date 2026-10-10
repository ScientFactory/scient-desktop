/** A running fork reads its source's streamed text while the source turn is live.
 * These checks decide whether that captured source still owns the run. */
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import type { EventSinkV2Shape } from "../EventSink.ts";
import {
  ProviderTextSnapshotError,
  type ProviderAdapterV2Event,
  type ProviderTextSnapshotBatch,
  type ProviderTextSnapshotConsumerOwner,
  type ProviderTextSnapshotOwner,
  type ProviderTextSnapshotProjection,
} from "../ProviderAdapter.ts";
import type { ProviderEventIngestorV2Shape } from "../ProviderEventIngestor.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";
import type * as ProjectStore from "../ProjectStore.ts";
import type { ProviderEventRoutingState } from "../RunExecutionService.ts";

/** The records that decide whether a captured owner still runs its thread. */
const RUNNING_FORK_OWNER_FIELDS = [
  "runs",
  "attempts",
  "nodes",
  "providerThreads",
  "providerTurns",
  "providerSessions",
  "turnItems",
] as const;
type RunningForkOwnerRecords = ProjectionStore.ProjectionRecords<
  (typeof RUNNING_FORK_OWNER_FIELDS)[number]
>;

/**
 * Read the thread's control records (no history: its only items are the run's
 * stop requests and results) and fail with owner-lost unless the captured
 * owner still runs it.
 */
export const readCurrentRunningForkOwner = Effect.fnUntraced(function* (
  deps: {
    readonly projectionStore: ProjectionStore.ProjectionStoreV2Shape;
    readonly projectStore: ProjectStore.ProjectStoreV2["Service"];
  },
  owner: ProviderTextSnapshotOwner,
) {
  const { projectionStore, projectStore } = deps;
  const current: RunningForkOwnerRecords = yield* projectionStore.getThreadRecords(
    owner.threadId,
    RUNNING_FORK_OWNER_FIELDS,
    {
      turnItemRunIds: [owner.runId],
      turnItemTypes: ["run_interrupt_request", "run_interrupt_result"],
    },
  );
  const project = yield* projectStore.get(current.thread.projectId);
  const run = current.runs.find((row) => row.id === owner.runId);
  const attempt = current.attempts.find((row) => row.id === owner.activeAttemptId);
  const root = current.nodes.find((row) => row.id === owner.rootNodeId);
  const thread = current.providerThreads.find((row) => row.id === owner.providerThreadId);
  const turn = current.providerTurns.find((row) => row.id === owner.providerTurnId);
  const session = current.providerSessions.find((row) => row.id === owner.providerSessionId);
  const stopRequested = current.turnItems.some(
    (item) =>
      item.runId === owner.runId &&
      item.type === "run_interrupt_request" &&
      !current.turnItems.some(
        (result) => result.runId === owner.runId && result.type === "run_interrupt_result",
      ),
  );
  if (
    stopRequested ||
    current.thread.archivedAt !== null ||
    current.thread.deletedAt !== null ||
    Option.isNone(project) ||
    project.value.deletedAt !== null ||
    run === undefined ||
    !["running", "waiting"].includes(run.status) ||
    run.activeAttemptId !== owner.activeAttemptId ||
    run.rootNodeId !== owner.rootNodeId ||
    run.ordinal !== owner.runOrdinal ||
    run.providerInstanceId !== owner.providerInstanceId ||
    run.providerThreadId !== owner.providerThreadId ||
    attempt?.runId !== owner.runId ||
    attempt.rootNodeId !== owner.rootNodeId ||
    attempt.providerInstanceId !== owner.providerInstanceId ||
    attempt.providerThreadId !== owner.providerThreadId ||
    (attempt.providerTurnId !== null && attempt.providerTurnId !== owner.providerTurnId) ||
    attempt.status !== "running" ||
    root?.runId !== owner.runId ||
    root.threadId !== owner.threadId ||
    !["running", "waiting"].includes(root.status) ||
    thread?.providerSessionId !== owner.providerSessionId ||
    thread.providerInstanceId !== owner.providerInstanceId ||
    thread.driver !== owner.driver ||
    thread.lastRunOrdinal !== owner.runOrdinal ||
    thread.nativeThreadRef?.driver !== owner.driver ||
    thread.nativeThreadRef?.nativeId !== owner.nativeThreadId ||
    thread.nativeThreadRef.strength !== "strong" ||
    turn?.runAttemptId !== owner.activeAttemptId ||
    turn.nodeId !== owner.rootNodeId ||
    turn.providerThreadId !== owner.providerThreadId ||
    turn.nativeTurnRef?.driver !== owner.driver ||
    turn.nativeTurnRef?.nativeId !== owner.nativeTurnId ||
    turn.nativeTurnRef.strength !== "strong" ||
    turn.nativeAcceptance !== "accepted" ||
    !["running", "waiting"].includes(turn.status) ||
    session?.providerInstanceId !== owner.providerInstanceId ||
    session.driver !== owner.driver ||
    ["stopped", "error"].includes(session.status)
  )
    return yield* new ProviderTextSnapshotError({ reason: "owner-lost" });
  return current;
});

/** Whether control or workspace authority changed since the source was captured. */
export const runningForkAuthorityChanged = (
  owner: ProviderTextSnapshotOwner,
  capture: ProviderTextSnapshotProjection,
  current: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "providerTurns" | "nodes">,
  project: Option.Option<{ readonly workspaceRoot: string }>,
): boolean => {
  const before = capture.projection;
  const root = current.nodes.find((node) => node.id === owner.rootNodeId);
  const priorRoot = before.nodes.find((node) => node.id === owner.rootNodeId);
  // Text beyond the acknowledged cutoff is harmless. Changes in
  // control or workspace authority cannot replace the captured source.
  return (
    current.runs.find((run) => run.id === owner.runId)?.status !==
      before.runs.find((run) => run.id === owner.runId)?.status ||
    current.providerTurns.find((turn) => turn.id === owner.providerTurnId)?.status !==
      before.providerTurns.find((turn) => turn.id === owner.providerTurnId)?.status ||
    root?.status !== priorRoot?.status ||
    current.thread.projectId !== before.thread.projectId ||
    current.thread.providerInstanceId !== before.thread.providerInstanceId ||
    !modelSelectionsEqual(current.thread.modelSelection, before.thread.modelSelection) ||
    current.thread.runtimeMode !== before.thread.runtimeMode ||
    current.thread.interactionMode !== before.thread.interactionMode ||
    current.thread.activeProviderThreadId !== before.thread.activeProviderThreadId ||
    current.thread.branch !== before.thread.branch ||
    current.thread.worktreePath !== before.thread.worktreePath ||
    current.thread.workspaceAuthorityRevision !== before.thread.workspaceAuthorityRevision ||
    current.thread.rollbackRequestId !== before.thread.rollbackRequestId ||
    current.thread.rollbackCompletedRequestId !== before.thread.rollbackCompletedRequestId ||
    current.thread.conversationFork?.status !== before.thread.conversationFork?.status ||
    root?.checkpointScopeId !== priorRoot?.checkpointScopeId ||
    Option.isNone(project) ||
    project.value.workspaceRoot !== capture.workspaceRoot
  );
};

/** The live root run's side of a running fork's text snapshot. A captured frame sets
 * its message's text floor; a later live frame that would rewind below it is dropped. */
export const makeRunningForkTextSnapshots = (input: {
  readonly owner: ProviderTextSnapshotConsumerOwner;
  readonly eventRouting: Ref.Ref<ProviderEventRoutingState>;
  readonly eventSink: Pick<EventSinkV2Shape, "captureRunningForkText">;
  readonly providerEventIngestor: Pick<ProviderEventIngestorV2Shape, "normalize">;
}) => {
  const { owner: current, eventRouting, eventSink, providerEventIngestor } = input;
  const snapshotTextFloors = new Map<string, string>();
  return {
    capture: (event: ProviderTextSnapshotBatch) =>
      Effect.gen(function* () {
        const owner = event.owner;
        const routing = yield* Ref.get(eventRouting);
        if (
          owner.threadId !== current.threadId ||
          owner.runId !== current.runId ||
          owner.activeAttemptId !== current.activeAttemptId ||
          owner.rootNodeId !== current.rootNodeId ||
          owner.runOrdinal !== current.runOrdinal ||
          owner.providerThreadId !== current.providerThreadId ||
          owner.providerSessionId !== current.providerSessionId ||
          owner.providerInstanceId !== current.providerInstanceId ||
          owner.driver !== current.driver ||
          routing.rootTurnEnded ||
          routing.rootProviderTurnId !== owner.providerTurnId ||
          eventSink.captureRunningForkText === undefined
        )
          return yield* new ProviderTextSnapshotError({ reason: "owner-lost" });
        const normalized = yield* Effect.forEach(event.events, (frame) =>
          providerEventIngestor.normalize({
            providerSessionId: current.providerSessionId,
            providerInstanceId: current.providerInstanceId,
            threadId: current.threadId,
            runId: current.runId,
            nodeId: current.rootNodeId,
            event: frame,
          }),
        );
        const capture = yield* eventSink.captureRunningForkText({
          owner,
          events: normalized.flat(),
        });
        for (const frame of event.events) {
          if (frame.type === "message.updated")
            snapshotTextFloors.set(`message.updated:${frame.message.id}`, frame.message.text);
          if (frame.type === "turn_item.updated" && frame.turnItem.type === "assistant_message")
            snapshotTextFloors.set(`turn_item.updated:${frame.turnItem.id}`, frame.turnItem.text);
        }
        return capture;
      }),
    floor: (deliveredEvent: ProviderAdapterV2Event): ProviderAdapterV2Event | null => {
      const text =
        deliveredEvent.type === "message.updated"
          ? deliveredEvent.message
          : deliveredEvent.type === "turn_item.updated" &&
              deliveredEvent.turnItem.type === "assistant_message"
            ? deliveredEvent.turnItem
            : null;
      if (text !== null) {
        const key = `${deliveredEvent.type}:${text.id}`;
        const floor = snapshotTextFloors.get(key);
        if (!text.streaming) snapshotTextFloors.delete(key);
        else if (floor !== undefined && !text.text.startsWith(floor)) return null;
      }
      return deliveredEvent;
    },
  };
};
