/**
 * The last checkpoint capture attempt for an answered run. A completed answer
 * leaves its run `waiting` until the capture commits, and a waiting run blocks
 * the thread's queue and Send. Git failures already record an `error`
 * checkpoint and complete the run. A capture that fails for any other reason
 * (a failed database commit, a missing or mismatched capture target) was only
 * retried, and after the last attempt the run stayed `waiting` until restart.
 * The last attempt now completes the run with an `error` checkpoint instead,
 * without touching the workspace, so the queue continues.
 */
import {
  CommandId,
  type CheckpointScopeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { checkpointRefForScopeOrdinal } from "../CheckpointService.ts";
import type * as EventSink from "../EventSink.ts";
import type * as IdAllocator from "../IdAllocator.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";

/** True while the effect worker runs a capture's last attempt. */
export class CheckpointCaptureFinalAttempt extends Context.Reference<boolean>(
  "scient/orchestration-v2/CheckpointCaptureFinalAttempt",
  { defaultValue: () => false },
) {}

interface CaptureTarget {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly scopeId: CheckpointScopeId;
}

interface SettlementDependencies {
  readonly eventSink: EventSink.EventSinkV2Shape;
  readonly ids: IdAllocator.IdAllocatorV2Shape;
  readonly projections: ProjectionStore.ProjectionStoreV2Shape;
  readonly makeCheckpointTurnItem: (input: {
    readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
    readonly run: OrchestrationV2Run;
    readonly rootNode: OrchestrationV2ExecutionNode;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly checkpoint: OrchestrationV2Checkpoint;
    readonly completedAt: DateTime.Utc;
  }) => OrchestrationV2TurnItem;
}

/** Completes a still-waiting run with an `error` checkpoint. False when nothing waits. */
const settleWaitingRun = Effect.fnUntraced(function* (
  deps: SettlementDependencies,
  target: CaptureTarget,
) {
  const { eventSink, ids, projections } = deps;
  const { run, rootNode, scope, providerThread } = yield* projections.getCheckpointCaptureContext(
    target.threadId,
    target,
  );
  if (run === undefined || run.status !== "waiting") return false;

  const completedAt = yield* DateTime.now;
  const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
  const checkpointTarget =
    rootNode !== undefined && scope !== undefined && providerThread !== undefined
      ? { rootNode, scope, providerThread }
      : undefined;
  const checkpoint: OrchestrationV2Checkpoint | undefined =
    checkpointTarget === undefined
      ? undefined
      : {
          id: yield* ids.allocate.checkpoint({
            checkpointScopeId: checkpointTarget.scope.id,
            name: String(run.ordinal),
          }),
          threadId: checkpointTarget.scope.threadId,
          scopeId: checkpointTarget.scope.id,
          runId: run.id,
          nodeId: checkpointTarget.rootNode.id,
          parentCheckpointId:
            run.ordinal > 0
              ? yield* ids.allocate.checkpoint({
                  checkpointScopeId: checkpointTarget.scope.id,
                  name: String(run.ordinal - 1),
                })
              : null,
          ordinalWithinScope: run.ordinal,
          appRunOrdinal: run.ordinal,
          ref: checkpointRefForScopeOrdinal({
            scopeId: checkpointTarget.scope.id,
            ordinalWithinScope: run.ordinal,
          }),
          status: "error",
          files: [],
          capturedAt: completedAt,
        };
  // As in the capture itself, never replay this snapshot's delegated completion.
  const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } = run;
  const nodeId = rootNode?.id;
  yield* eventSink.commitCommand({
    commandId,
    threadId: target.threadId,
    commandType: "checkpoint.capture",
    acceptedAt: completedAt,
    effects: [],
    events: [
      ...(checkpoint === undefined || checkpointTarget === undefined
        ? []
        : [
            {
              id: yield* ids.allocate.event({ threadId: target.threadId, commandId }),
              type: "checkpoint.captured" as const,
              threadId: target.threadId,
              runId: run.id,
              nodeId: checkpointTarget.rootNode.id,
              driver: checkpointTarget.providerThread.driver,
              providerInstanceId: run.providerInstanceId,
              occurredAt: completedAt,
              payload: checkpoint,
            },
            {
              id: yield* ids.allocate.event({ threadId: target.threadId, commandId }),
              type: "turn-item.updated" as const,
              threadId: target.threadId,
              runId: run.id,
              nodeId: checkpointTarget.rootNode.id,
              driver: checkpointTarget.providerThread.driver,
              providerInstanceId: run.providerInstanceId,
              occurredAt: completedAt,
              payload: deps.makeCheckpointTurnItem({
                idAllocator: ids,
                run,
                rootNode: checkpointTarget.rootNode,
                providerThread: checkpointTarget.providerThread,
                checkpoint,
                completedAt,
              }),
            },
          ]),
      {
        id: yield* ids.allocate.event({ threadId: target.threadId, commandId }),
        type: "run.updated" as const,
        threadId: target.threadId,
        runId: run.id,
        ...(nodeId === undefined ? {} : { nodeId }),
        providerInstanceId: run.providerInstanceId,
        occurredAt: completedAt,
        payload: {
          ...runWithoutDelegatedCompletion,
          status: "completed" as const,
          completedAt,
          checkpointId: checkpoint?.id ?? run.checkpointId,
        },
      },
      ...(rootNode === undefined
        ? []
        : [
            {
              id: yield* ids.allocate.event({ threadId: target.threadId, commandId }),
              type: "node.updated" as const,
              threadId: target.threadId,
              runId: run.id,
              nodeId: rootNode.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: completedAt,
              payload: {
                ...rootNode,
                status: "completed" as const,
                completedAt,
                checkpointScopeId: scope?.id ?? rootNode.checkpointScopeId,
              },
            },
          ]),
    ],
  });
  return true;
});

/**
 * Wraps one capture execution. On the last attempt, a failure settles a
 * still-waiting run instead of leaving it waiting; every other failure, and
 * every earlier attempt, fails as before so the worker retries.
 */
export const settleUncapturedRunOnFinalAttempt =
  (deps: SettlementDependencies, target: CaptureTarget) =>
  <E, R>(capture: Effect.Effect<void, E, R>) =>
    capture.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!(yield* CheckpointCaptureFinalAttempt)) return yield* Effect.fail(error);
          if (!(yield* settleWaitingRun(deps, target))) return yield* Effect.fail(error);
          yield* Effect.logWarning(
            "Completed a run with an unavailable checkpoint after its last capture attempt failed",
            { ...target, cause: error },
          );
        }),
      ),
    );
