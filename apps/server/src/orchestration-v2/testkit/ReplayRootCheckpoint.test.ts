import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2Checkpoint,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { resolveReplayRootCheckpoint } from "./OrchestratorScenario.ts";

const threadId = ThreadId.make("thread:replay-owned");
const runId = RunId.make("run:replay-owned:1");
const nodeId = NodeId.make("node:replay-owned:1");
const scopeId = CheckpointScopeId.make("checkpoint-scope:replay-owned");
const checkpointId = CheckpointId.make("checkpoint:replay-owned:1");
function input() {
  return {
    threadId,
    ordinal: 1,
    cwd: "/replay/workspace",
    projection: {
      runs: [{ id: runId, threadId, ordinal: 1, rootNodeId: nodeId }],
      nodes: [
        { id: nodeId, threadId, runId, kind: "root_turn" as const, checkpointScopeId: scopeId },
      ],
      checkpointScopes: [
        {
          id: scopeId,
          threadId,
          runId,
          nodeId,
          providerThreadId: ProviderThreadId.make("provider-thread:replay-owned"),
          parentScopeId: null,
          kind: "root_run" as const,
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/replay/workspace",
          createdAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z"),
        },
      ],
      checkpoints: [
        {
          id: checkpointId,
          threadId,
          runId,
          nodeId,
          scopeId,
          appRunOrdinal: 1,
          ordinalWithinScope: 1,
          status: "ready" as OrchestrationV2Checkpoint["status"],
        },
      ],
    },
  };
}
describe("recorded root checkpoint identity", () => {
  it("selects the exact owned root ordinal instead of deriving the obsolete literal root id", () => {
    assert.equal(resolveReplayRootCheckpoint(input()).id, checkpointId);
  });
  it.each([
    "absent",
    "ambiguous",
    "foreign-thread",
    "foreign-run",
    "foreign-node",
    "wrong-scope",
    "wrong-cwd",
    "wrong-ordinal",
    "not-ready",
  ])("rejects %s checkpoint identity", (condition) => {
    const value = input();
    const checkpoint = value.projection.checkpoints[0]!;
    switch (condition) {
      case "absent":
        value.projection.checkpoints = [];
        break;
      case "ambiguous":
        value.projection.checkpoints.push({
          ...checkpoint,
          id: CheckpointId.make("checkpoint:duplicate"),
        });
        break;
      case "foreign-thread":
        checkpoint.threadId = ThreadId.make("thread:foreign");
        break;
      case "foreign-run":
        checkpoint.runId = RunId.make("run:foreign");
        break;
      case "foreign-node":
        checkpoint.nodeId = NodeId.make("node:foreign");
        break;
      case "wrong-scope":
        checkpoint.scopeId = CheckpointScopeId.make("scope:foreign");
        break;
      case "wrong-cwd":
        value.projection.checkpointScopes[0]!.cwd = "/foreign/workspace";
        break;
      case "wrong-ordinal":
        checkpoint.appRunOrdinal = 2;
        break;
      case "not-ready":
        value.projection.checkpoints = [];
        value.projection.checkpoints.push({ ...checkpoint, status: "missing" });
        break;
    }
    assert.throws(() => resolveReplayRootCheckpoint(value), /Replay rollback requires/);
  });
});
