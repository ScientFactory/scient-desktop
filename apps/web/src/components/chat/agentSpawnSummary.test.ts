import { describe, expect, it } from "vite-plus/test";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { agentSpawnRowLabel, deriveAgentSpawnSummary } from "./agentSpawnSummary";

const batch = (status: RuntimeSubagent["status"]) => ({ kind: "subagent_batch" as const, status });
const agent = (status: RuntimeSubagent["status"]) => ({ kind: "subagent" as const, status });

describe("deriveAgentSpawnSummary", () => {
  it("counts a native batch without claiming the number of children", () => {
    expect(deriveAgentSpawnSummary({ agents: [batch("running")], agentCount: 1 })).toEqual({
      live: true,
      lead: "Launched 1 subagent batch",
      status: "1 working",
      tone: "working",
    });
    expect(deriveAgentSpawnSummary({ agents: [batch("idle")], agentCount: 1 })).toEqual({
      live: false,
      lead: "Launched 1 subagent batch",
      status: "1 idle",
      tone: "inactive",
    });
  });

  it("keeps individual agents and batches separate in a mixed group", () => {
    expect(
      deriveAgentSpawnSummary({
        agents: [agent("running"), batch("running"), batch("idle")],
        agentCount: 3,
      }).lead,
    ).toBe("Launched 1 subagent and 2 batches");
  });

  it.each([
    ["idle", "1 idle", "inactive"],
    ["cancelled", "1 stopped", "inactive"],
    ["interrupted", "1 stopped", "inactive"],
    ["failed", "1 failed", "failed"],
    ["completed", "✓ completed", "completed"],
  ] as const)("reports %s accurately alongside a completed agent", (state, status, tone) => {
    expect(
      deriveAgentSpawnSummary({ agents: [agent("completed"), agent(state)], agentCount: 2 }),
    ).toMatchObject({ live: false, status, tone });
  });

  it("does not claim completion when the roster is missing a member", () => {
    expect(deriveAgentSpawnSummary({ agents: [agent("completed")], agentCount: 2 })).toMatchObject({
      status: "Status unavailable",
      tone: "inactive",
    });
  });

  it("keeps a workflow active between child launches", () => {
    expect(
      deriveAgentSpawnSummary({
        agents: [agent("completed")],
        agentCount: 1,
        coordinatorStatus: "running",
      }),
    ).toMatchObject({ live: true, status: "working", tone: "working" });
  });

  it.each([
    ["failed", "Workflow failed", "failed"],
    ["cancelled", "Workflow stopped", "inactive"],
  ] as const)(
    "preserves a %s workflow outcome when its children completed",
    (coordinatorStatus, status, tone) => {
      expect(
        deriveAgentSpawnSummary({ agents: [agent("completed")], agentCount: 1, coordinatorStatus }),
      ).toMatchObject({ live: false, status, tone });
    },
  );

  it("says in the row how the agents stand, unless they simply completed", () => {
    const label = (agents: ReadonlyArray<ReturnType<typeof agent>>, workflowName?: string) =>
      agentSpawnRowLabel(
        deriveAgentSpawnSummary({ agents, agentCount: agents.length }),
        workflowName ?? null,
      );
    // Alive, and how many: a collapsed row must not read as stuck.
    expect(label([agent("running"), agent("completed")])).toBe(
      "Kicked off 2 subagents · 1 working",
    );
    expect(label([agent("completed"), agent("completed")])).toBe("Ran 2 subagents");
    expect(label([agent("completed"), agent("cancelled")])).toBe("Ran 2 subagents · 1 stopped");
    expect(label([agent("failed")])).toBe("Ran 1 subagent · 1 failed");
    expect(label([agent("idle")])).toBe("Ran 1 subagent · 1 idle");
    expect(label([agent("running")], "Review")).toBe("Kicked off 1 subagent · Review · 1 working");
  });
});
