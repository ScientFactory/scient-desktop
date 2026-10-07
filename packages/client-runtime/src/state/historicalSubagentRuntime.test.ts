import { describe, expect, it } from "vite-plus/test";
import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { historicalSubagentsToRuntime } from "./historicalSubagentRuntime.ts";
import { deriveAgentPanelModel } from "./subagentRuntime.ts";

const encodeItem = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const item = (activityId: string, kind: string, payload: unknown) =>
  decodeItem({
    id: `migration:v1:history:activity:${activityId}`,
    threadId: "legacy-thread",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    type: "dynamic_tool",
    title: kind,
    toolName: kind,
    status: "completed",
    startedAt: "2026-10-04T00:00:00.000Z",
    completedAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    input: { activityId, kind, tone: "info", summary: kind, sequence: 0, turnId: null, payload },
  });

describe("inert migrated workflow display", () => {
  it("recovers namespaced phases and members without making unfinished history live", () => {
    const items = [
      item("start", "task.started", {
        taskId: "workflow",
        taskType: "local_workflow",
        title: "Audit",
      }),
      item("phase", "task.progress", {
        taskId: "workflow",
        phases: [{ index: 0, title: "Review" }],
      }),
      item("member", "task.progress", {
        taskId: "member",
        agentKind: "agent",
        parentAgentId: "workflow",
        agentIndex: 0,
        phaseIndex: 0,
        status: "running",
        title: "Reader",
        typedUsage: { totalTokens: 100, toolUses: 3 },
      }),
      item("approval", "approval.requested", { requestId: "historical-only" }),
    ];
    const agents = historicalSubagentsToRuntime([...items, ...items]);
    const model = deriveAgentPanelModel({ agents });
    expect(model.workflows).toHaveLength(1);
    expect(model.workflows[0]?.workflow.id).toBe("historical:legacy-thread:workflow");
    expect(model.workflows[0]?.phases[0]?.members[0]).toMatchObject({
      id: "historical:legacy-thread:member",
      status: "interrupted",
      usage: { totalTokens: 100, toolUses: 3 },
    });
    expect(model.liveCount).toBe(0);
    expect(agents).toHaveLength(2);
  });
  it("preserves historical idle observations without live phase authority", () => {
    const agents = historicalSubagentsToRuntime([
      item("idle-start", "task.started", { taskId: "idle-workflow", taskType: "local_workflow" }),
      item("idle-phase", "task.progress", {
        taskId: "idle-workflow",
        phases: [{ index: 0, title: "Review" }],
      }),
      item("idle-member", "task.progress", {
        taskId: "idle-member",
        agentKind: "agent",
        parentAgentId: "idle-workflow",
        phaseIndex: 0,
        status: "idle",
        title: "Reader",
      }),
    ]);
    const phase = deriveAgentPanelModel({ agents }).workflows[0]?.phases[0];
    expect(phase?.members[0]?.status).toBe("idle");
    expect(phase?.members[0]?.historical).toBe(true);
    expect(phase?.activeCount).toBe(0);
    expect(phase?.state).toBe("pending");
  });
  it("rejects ordinary dynamic tool inputs that resemble historical tasks", () => {
    const historical = item("start", "task.started", {
      taskId: "workflow",
      taskType: "local_workflow",
    });
    expect(
      historicalSubagentsToRuntime([
        {
          ...historical,
          id: decodeItem({
            ...encodeItem(historical),
            id: "provider-tool",
          }).id,
        },
      ]),
    ).toEqual([]);
  });
  it("uses frozen migration provenance after copied items acquire destination identities", () => {
    const source = item("copied-start", "task.started", {
      taskId: "copied-workflow",
      taskType: "local_workflow",
      title: "Copied audit",
    });
    const copied = decodeItem({
      ...encodeItem(source),
      id: "scient-fork:target:item:0",
      threadId: "target",
      inheritedFrom: {
        threadId: source.threadId,
        itemId: source.id,
        runId: null,
        status: source.status,
      },
    });
    const agents = historicalSubagentsToRuntime([copied, copied]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "historical:legacy-thread:copied-workflow",
      historical: true,
    });
    expect(deriveAgentPanelModel({ agents }).liveCount).toBe(0);
    const wrong = decodeItem({
      ...encodeItem(copied),
      inheritedFrom: {
        ...encodeItem(copied).inheritedFrom,
        itemId: "provider-owned-tool",
      },
    });
    expect(historicalSubagentsToRuntime([wrong])).toEqual([]);
  });
});
