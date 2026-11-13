/**
 * Why a delegated task failed, for `mcp.delegated_task.finished`: read from the child run the task
 * reported, never from the task's result text.
 */
import type { OrchestrationV2Run, OrchestrationV2Subagent } from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";

import { delegatedTaskResultRun } from "../orchestration-v2/RestartBackgroundNote.ts";
import type { OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import { analyticsFailureCode } from "./ProviderFailureCodes.ts";

export interface DelegatedTaskFailure {
  /**
   * `before_provider`: the child run failed before its provider started a turn (preparation,
   * admission, start). `provider`: the provider ran a turn and failed it. `unknown`: no local child
   * run to read, as for a task on another machine.
   */
  readonly failurePhase: "before_provider" | "provider" | "unknown";
  readonly failureClass?: string;
  readonly failureCode?: string;
  readonly httpStatus?: number;
}

const UNKNOWN: DelegatedTaskFailure = { failurePhase: "unknown" };

/** The child run that holds the task's outcome, as the orchestrator chose it when finalizing. */
function taskRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  task: OrchestrationV2Subagent,
  forkedFromNodeId: string | undefined,
): OrchestrationV2Run | undefined {
  if (runs.some((run) => run.delegatedTaskId === task.id))
    return delegatedTaskResultRun(runs, task.id);
  // The task that created the child thread drives its first runs without a task id.
  if (task.id !== forkedFromNodeId) return undefined;
  return runs
    .filter((run) => run.delegatedTaskId === undefined)
    .toSorted((a, b) => b.ordinal - a.ordinal)[0];
}

export const delegatedTaskFailure = Effect.fn("DelegatedTaskFailure.summarize")(function* (
  orchestrator: Pick<OrchestratorV2Shape, "getThreadRecords">,
  task: OrchestrationV2Subagent,
) {
  if (task.childThreadId === null) return UNKNOWN;
  const child = yield* orchestrator.getThreadRecords(
    task.childThreadId,
    ["runs", "providerTurns", "turnItems"],
    { turnItemTypes: ["error"] },
  );
  const forkedFrom = child.thread.forkedFrom;
  const run = taskRun(
    child.runs,
    task,
    forkedFrom?.type === "node" ? forkedFrom.nodeId : undefined,
  );
  if (run === undefined || run.status !== "failed") return UNKNOWN;
  const started = child.providerTurns.some(
    (turn) => run.activeAttemptId !== null && turn.runAttemptId === run.activeAttemptId,
  );
  const failure = latestRootProviderFailure(run, child.turnItems);
  const failureCode = analyticsFailureCode(task.driver, failure?.code ?? null);
  return {
    failurePhase: started ? "provider" : "before_provider",
    ...(failure === null ? {} : { failureClass: failure.class }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failure?.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
  } satisfies DelegatedTaskFailure;
});
