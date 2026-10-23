import { NodeId, ProviderThreadId, ProviderTurnId, RunAttemptId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasCurrentRunStop, type CurrentRunStopRecords } from "./RunStartDecisions.ts";

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
