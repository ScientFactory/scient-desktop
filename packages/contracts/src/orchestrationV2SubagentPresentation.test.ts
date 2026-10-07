import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2SubagentJson,
  OrchestrationV2SubagentPresentation,
} from "./orchestrationV2.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2SubagentJson);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2SubagentJson));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2SubagentJson));
const base = {
  id: "member",
  threadId: "thread",
  runId: null,
  parentNodeId: "coordinator",
  origin: "provider_native",
  createdBy: "agent",
  driver: "claude",
  providerInstanceId: "claude",
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: null,
  prompt: "",
  title: "Reader",
  model: "claude/reader",
  status: "completed",
  result: "Done",
  startedAt: null,
  completedAt: "2026-10-04T00:01:00.000Z",
  updatedAt: "2026-10-04T00:01:00.000Z",
};

describe("native subagent presentation wire contract", () => {
  it("round trips workflow observations while older records keep absent presentation", () => {
    const native = decode({
      ...base,
      presentation: {
        kind: "workflow_agent",
        workflowId: "coordinator",
        agentIndex: 0,
        phaseIndex: 1,
        phaseTitle: "Review",
        attempt: 2,
        role: "researcher",
        effort: "high",
        activationCount: 2,
        firstSeenAt: "2026-10-04T00:00:00.000Z",
        usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40, toolUses: 2 },
        runHandles: { runId: "observed-workflow", sessionUrl: "https://example.test/session" },
      },
    });
    expect(decodeJson(encodeJson(native))).toEqual(native);
    expect(decode(base).presentation).toBeUndefined();
    expect(native.childThreadId).toBeNull();
    expect(native.nativeTaskRef).toBeNull();
  });
  it("preserves count-only observations without inventing token totals", () => {
    const native = decode({
      ...base,
      presentation: { kind: "workflow_agent", usage: { toolUses: 3 } },
    });
    expect(decodeJson(encodeJson(native))).toEqual(native);
    expect(native.presentation?.usage).toEqual({ toolUses: 3 });
    const valid = Schema.is(OrchestrationV2SubagentPresentation);
    expect(valid({ kind: "workflow_agent", usage: {} })).toBe(false);
    expect(valid({ kind: "workflow_agent", usage: { toolUses: -1 } })).toBe(false);
    expect(valid({ kind: "workflow_agent", usage: { durationMs: 0 } })).toBe(true);
  });
  it("rejects unbounded phases, invalid counters and executable display URLs", () => {
    const valid = Schema.is(OrchestrationV2SubagentPresentation);
    expect(
      valid({
        kind: "workflow",
        phases: Array.from({ length: 65 }, (_, index) => ({ index, title: "phase" })),
      }),
    ).toBe(false);
    expect(valid({ kind: "subagent", usage: { totalTokens: -1 } })).toBe(false);
    expect(valid({ kind: "workflow", runHandles: { sessionUrl: "javascript:run()" } })).toBe(false);
  });
});
