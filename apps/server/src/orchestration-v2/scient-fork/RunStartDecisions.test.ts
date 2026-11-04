import { NodeId, ProviderThreadId, ProviderTurnId, RunAttemptId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasCurrentRunStop,
  steerExecutionThread,
  type CurrentRunStopRecords,
} from "./RunStartDecisions.ts";

const runId = RunId.make("synthetic-run");
const attemptId = RunAttemptId.make("synthetic-attempt");
const rootId = NodeId.make("synthetic-root");
const threadId = ProviderThreadId.make("synthetic-provider-thread");
const turnId = ProviderTurnId.make("synthetic-turn");
const interrupt = {
  type: "run_interrupt_request" as const,
  runId,
  nodeId: rootId,
  providerThreadId: threadId,
  providerTurnId: turnId,
};
const records: CurrentRunStopRecords = {
  runs: [{ id: runId, activeAttemptId: attemptId, rootNodeId: rootId, providerThreadId: threadId }],
  attempts: [{ id: attemptId, runId, rootNodeId: rootId, providerTurnId: turnId }],
  providerTurns: [{ id: turnId, runAttemptId: attemptId, nodeId: rootId, ordinal: 1 }],
  turnItems: [interrupt],
};

describe("current Stop identity", () => {
  it("recognizes the current native turn, including a terminal turn used by continuation checks", () => {
    expect(hasCurrentRunStop(records, runId)).toBe(true);
  });

  it.each([
    { runId: RunId.make("historical-run") },
    { nodeId: NodeId.make("historical-root") },
    { providerThreadId: ProviderThreadId.make("historical-thread") },
    { providerTurnId: ProviderTurnId.make("historical-turn") },
    { type: "run_interrupt_result" as const },
  ])("ignores historical or unrelated control records: %j", (changes) => {
    expect(
      hasCurrentRunStop({ ...records, turnItems: [{ ...interrupt, ...changes }] }, runId),
    ).toBe(false);
  });

  it("recognizes Stop before native acceptance without inventing a turn", () => {
    expect(
      hasCurrentRunStop(
        {
          ...records,
          attempts: [{ ...records.attempts[0]!, providerTurnId: null }],
          providerTurns: [],
          turnItems: [{ ...interrupt, providerThreadId: null, providerTurnId: null }],
        },
        runId,
      ),
    ).toBe(true);
  });

  it("uses the current attempt's latest recorded turn while its receipt is being projected", () => {
    expect(
      hasCurrentRunStop(
        {
          ...records,
          attempts: [{ ...records.attempts[0]!, providerTurnId: null }],
          providerTurns: [
            {
              id: ProviderTurnId.make("historical-turn"),
              runAttemptId: attemptId,
              nodeId: rootId,
              ordinal: 0,
            },
            ...records.providerTurns,
          ],
        },
        runId,
      ),
    ).toBe(true);
  });

  it("does not bind an interrupt to a missing or replaced attempt", () => {
    expect(hasCurrentRunStop({ ...records, attempts: [] }, runId)).toBe(false);
    expect(hasCurrentRunStop({ ...records, runs: [] }, runId)).toBe(false);
    expect(
      hasCurrentRunStop(
        {
          ...records,
          attempts: [{ ...records.attempts[0]!, rootNodeId: NodeId.make("historical-root") }],
        },
        runId,
      ),
    ).toBe(false);
  });
});

describe("steer execution modes", () => {
  type SteerInput = Parameters<typeof steerExecutionThread>[0];
  // The composer switched to plan mode after the run started in default mode.
  const thread = {
    runtimeMode: "full-access",
    interactionMode: "plan",
  } as unknown as SteerInput["thread"];
  const targetRun = {
    runtimeMode: "full-access",
    interactionMode: "default",
  } as unknown as SteerInput["targetRun"];
  const steer = (notice: Partial<SteerInput>) =>
    steerExecutionThread({
      thread,
      targetRun,
      runtimeMode: undefined,
      interactionMode: undefined,
      delegatedCompletion: undefined,
      ...notice,
    });

  it("runs a user steer under the composer's modes", () => {
    const { executionThread, executionModesChanged } = steer({});
    expect(executionThread.interactionMode).toBe("plan");
    expect(executionModesChanged).toBe(true);
  });

  it("keeps the run's modes for a delegated task question, so it never restarts the turn", () => {
    const { executionThread, executionModesChanged } = steer({
      notification: {
        source: { kind: "delegated_task", taskIds: [NodeId.make("task:question")] },
        outcome: "updated",
        summary: "Delegated task has a question",
      },
    });
    expect(executionThread.interactionMode).toBe("default");
    expect(executionModesChanged).toBe(false);
  });
});
