import { describe, expect, it } from "vite-plus/test";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { agentSpawnRowLabel, deriveAgentSpawnSummary } from "./agentSpawnSummary";

const agent = (status: RuntimeSubagent["status"]) => ({ kind: "subagent" as const, status });

describe("agentSpawnRowLabel", () => {
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
