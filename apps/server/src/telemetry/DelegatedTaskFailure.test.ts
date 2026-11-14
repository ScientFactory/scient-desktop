import {
  NodeId,
  ProviderDriverKind,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";

import type { OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import { delegatedTaskFailure } from "./DelegatedTaskFailure.ts";

const now = DateTime.makeUnsafe("2026-11-13T10:00:00Z");
const childThreadId = ThreadId.make("child-thread");
const taskId = NodeId.make("task-node");
const rootNodeId = NodeId.make("child-root");
const attemptId = RunAttemptId.make("attempt-1");

const task = {
  id: taskId,
  childThreadId,
  driver: ProviderDriverKind.make("codex"),
  status: "failed",
} as OrchestrationV2Subagent;

function childRun(fields: Partial<OrchestrationV2Run>): OrchestrationV2Run {
  return {
    id: RunId.make("child-run"),
    threadId: childThreadId,
    ordinal: 1,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "failed",
    startedAt: now,
    ...fields,
  } as OrchestrationV2Run;
}

const failureItem = {
  id: TurnItemId.make("failure"),
  type: "error",
  status: "failed",
  runId: RunId.make("child-run"),
  nodeId: rootNodeId,
  ordinal: 2,
  updatedAt: now,
  failure: {
    class: "provider_error",
    message: "private provider text",
    code: "serverOverloaded",
    retryable: null,
    httpStatus: 529,
  },
} as OrchestrationV2TurnItem;

function orchestrator(records: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns?: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
  readonly turnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly forkedFromNode?: NodeId;
}): Pick<OrchestratorV2Shape, "getThreadRecords"> {
  return {
    getThreadRecords: () =>
      Effect.succeed({
        thread: {
          id: childThreadId,
          forkedFrom:
            records.forkedFromNode === undefined
              ? null
              : { type: "node", nodeId: records.forkedFromNode },
        },
        runs: records.runs,
        providerTurns: records.providerTurns ?? [],
        turnItems: records.turnItems ?? [],
      }) as never,
  };
}

describe("delegatedTaskFailure", () => {
  it.effect("reads a follow-up task's own run, failed by its provider", () =>
    Effect.gen(function* () {
      const source = orchestrator({
        runs: [
          childRun({ delegatedTaskId: taskId }),
          childRun({
            id: RunId.make("other-task"),
            delegatedTaskId: NodeId.make("other"),
            ordinal: 2,
          }),
        ],
        providerTurns: [{ runAttemptId: attemptId }],
        turnItems: [failureItem],
      });
      assert.deepEqual(yield* delegatedTaskFailure(source, task), {
        failurePhase: "provider",
        failureClass: "provider_error",
        failureCode: "serverOverloaded",
        httpStatus: 529,
      });
    }),
  );

  it.effect("names a child run that failed before its provider started a turn", () =>
    Effect.gen(function* () {
      const source = orchestrator({ runs: [childRun({})], forkedFromNode: taskId });
      assert.deepEqual(yield* delegatedTaskFailure(source, task), {
        failurePhase: "before_provider",
      });
    }),
  );

  it.effect("does not guess for a task on another machine or a run that did not fail", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* delegatedTaskFailure(orchestrator({ runs: [] }), { ...task, childThreadId: null }),
        { failurePhase: "unknown" },
      );
      assert.deepEqual(
        yield* delegatedTaskFailure(
          orchestrator({ runs: [childRun({ status: "cancelled", delegatedTaskId: taskId })] }),
          task,
        ),
        { failurePhase: "unknown" },
      );
    }),
  );
});
