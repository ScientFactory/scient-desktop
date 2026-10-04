import { describe, expect, it } from "vite-plus/test";
import {
  claudeTaskPresentation,
  parseWorkflowProgress,
  workflowAgentStatus,
} from "./ClaudeSubagentPresentation.ts";
import { mergeSubagentPresentation } from "./SubagentPresentation.ts";

describe("native subagent display observations", () => {
  it("retains workflow identity, sparse usage and first observation through settlement and reactivation", () => {
    const start = mergeSubagentPresentation(
      undefined,
      {
        kind: "workflow",
        workflowName: "Audit",
        role: "researcher",
        usage: { totalTokens: 100, inputTokens: 80 },
        phases: [{ index: 0, title: "Review" }],
      },
      "2026-10-04T00:00:00.000Z",
    );
    const end = mergeSubagentPresentation(
      start,
      claudeTaskPresentation({
        usage: { total_tokens: 150, tool_uses: 3 },
        output_file: "/workspace/result.md",
      }),
      "2026-10-04T00:01:00.000Z",
    );
    expect(end).toMatchObject({
      kind: "workflow",
      role: "researcher",
      activationCount: 1,
      firstSeenAt: "2026-10-04T00:00:00.000Z",
      usage: { totalTokens: 150, inputTokens: 80, toolUses: 3 },
      phases: [{ index: 0, title: "Review" }],
      outputFile: "/workspace/result.md",
    });
    expect(
      mergeSubagentPresentation(end, undefined, "2026-10-04T00:02:00.000Z", true),
    ).toMatchObject({ activationCount: 2, firstSeenAt: start.firstSeenAt });
  });
  it("merges count-only observations without fabricating a token total", () => {
    const start = mergeSubagentPresentation(
      undefined,
      claudeTaskPresentation({ usage: { tool_uses: 2 } }),
      "2026-10-04T00:00:00.000Z",
    );
    expect(start.usage).toEqual({ toolUses: 2 });
    const total = mergeSubagentPresentation(
      start,
      { usage: { totalTokens: 40 } },
      "2026-10-04T00:01:00.000Z",
    );
    const calls = mergeSubagentPresentation(
      total,
      { usage: { toolUses: 5 } },
      "2026-10-04T00:02:00.000Z",
    );
    expect(calls.usage).toEqual({ totalTokens: 40, toolUses: 5 });
    expect(
      mergeSubagentPresentation(
        calls,
        { usage: { totalTokens: 30, toolUses: 1 } },
        "2026-10-04T00:03:00.000Z",
      ).usage,
    ).toEqual({ totalTokens: 40, toolUses: 5 });
    expect(
      mergeSubagentPresentation(calls, { usage: { toolUses: 0 } }, "2026-10-04T00:04:00.000Z", true)
        .usage,
    ).toEqual({ toolUses: 0 });
  });
  it("bounds and deduplicates malformed workflow observations without inventing pending work", () => {
    const progress = parseWorkflowProgress([
      null,
      { type: "workflow_phase", index: -1, title: "invalid" },
      ...Array.from({ length: 70 }, (_, index) => ({
        type: "workflow_phase",
        index,
        title: `Phase ${index}`,
      })),
      { type: "workflow_phase", index: 0, title: "duplicate" },
      ...Array.from({ length: 110 }, (_, index) => ({
        type: "workflow_agent",
        index,
        state: "pending",
      })),
      { type: "workflow_agent", index: 0, state: "done" },
    ]);
    expect(progress?.phases).toHaveLength(64);
    expect(progress?.agents).toHaveLength(100);
    expect(progress?.phases[0]?.title).toBe("Phase 0");
    expect(workflowAgentStatus(progress!.agents[0]!)).toBe("pending");
    expect(workflowAgentStatus({ ...progress!.agents[0]!, state: "paused" })).toBe("idle");
    expect(claudeTaskPresentation({ usage: { total_tokens: NaN }, workflow_progress: [] })).toEqual(
      {},
    );
  });
});
