import { assert } from "@effect/vitest";
import {
  ThreadId,
  NodeId,
  CheckpointScopeId,
  CheckpointId,
  CheckpointRef,
  EventId,
  CommandId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import { EventSinkV2 } from "../../EventSink.ts";
import { OrchestratorV2 } from "../../Orchestrator.ts";
export const rollbackToBaseline = Effect.fn("test.nativeFork.rollbackToBaseline")(function* (
  threadId: ThreadId,
  suffix: string,
  retainedRunOrdinal = 0,
) {
  const store = yield* ProjectionStoreV2;
  const projection = yield* store.getThreadProjection(threadId);
  const nodeId = projection.runs.at(-1)?.rootNodeId ?? NodeId.make(`${suffix}-baseline-node`);
  const scopeId = CheckpointScopeId.make(`${suffix}-baseline-scope`);
  const checkpointId = CheckpointId.make(`${suffix}-baseline-checkpoint`);
  const now = yield* DateTime.now;
  yield* (yield* EventSinkV2).write({
    events: [
      {
        id: EventId.make(`${suffix}-baseline-scope`),
        threadId: threadId,
        type: "checkpoint-scope.created",
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId: threadId,
          runId: null,
          nodeId,
          parentScopeId: null,
          providerThreadId: projection.thread.activeProviderThreadId,
          kind: "manual",
          ordinalWithinParent: 0,
          advancesAppRunCount: false,
          cwd: "/tmp/import-project",
          createdAt: now,
        },
      },
      {
        id: EventId.make(`${suffix}-baseline-checkpoint`),
        threadId: threadId,
        type: "checkpoint.captured",
        occurredAt: now,
        payload: {
          id: checkpointId,
          threadId: threadId,
          scopeId,
          runId: null,
          nodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: retainedRunOrdinal === 0 ? null : retainedRunOrdinal,
          ref: CheckpointRef.make("refs/scient/import-baseline"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      },
    ],
  });
  const rollbackId = CommandId.make(`rollback-native-${suffix}`);
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({
      threadId: threadId,
      afterSequence: cursor,
    }),
  );
  yield* orchestrator.dispatch({
    type: "checkpoint.rollback",
    commandId: rollbackId,
    threadId: threadId,
    scopeId,
    checkpointId,
    restoreFiles: false,
  });
  const initial = yield* store.getThreadProjection(threadId);
  const rolledBack = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => store.getThreadProjection(threadId)),
    ),
  ).pipe(
    Stream.filter((projection) => projection.thread.rollbackCompletedRequestId === rollbackId),
    Stream.runHead,
    Effect.timeout("15 seconds"),
  );
  assert.isTrue(Option.isSome(rolledBack));
  return Option.getOrThrow(rolledBack);
});
