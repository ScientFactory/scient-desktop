import { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import * as DateTime from "effect/DateTime";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { AgentsPanel } from "./AgentsPanel";

vi.mock("./ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

it.each([
  [true, true],
  [false, true],
  [false, false],
] as const)(
  "preserves workflow history while gating current-workspace script reads (historical=%s, tokens=%s)",
  async (historical, tokens) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const agents = projectedSubagentsToRuntime([
      {
        id: "workflow",
        prompt: "Audit",
        title: "Audit",
        model: null,
        status: "completed",
        result: "Verified",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(0),
        presentation: {
          kind: "workflow",
          phases: [{ index: 0, title: "Review" }],
          runHandles: { scriptPath: "/old-workspace/audit.ts" },
        },
      },
      {
        id: "member",
        prompt: "Read sources",
        title: "Reader",
        model: "provider/researcher",
        status: "idle",
        result: "Checked evidence",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(0),
        presentation: {
          kind: "workflow_agent",
          workflowId: NodeId.make("workflow"),
          phaseIndex: 0,
          role: "researcher",
          usage: { ...(tokens ? { totalTokens: 20 } : {}), toolUses: 2 },
        },
      },
    ]).map((agent) => ({ ...agent, historical }));
    const model = deriveAgentPanelModel({ agents });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <AgentsPanel
            model={model}
            environmentId={EnvironmentId.make("environment")}
            threadId={ThreadId.make("thread")}
          />,
        );
      });
      const collapsedText = renderer!.root
        .findAll(() => true)
        .flatMap((node) => node.children)
        .filter((child) => typeof child === "string")
        .join("|");
      expect(model.totalTokens).toBe(tokens ? 20 : null);
      expect(collapsedText.includes("—")).toBe(!tokens);
      const expand = renderer!.root.findAllByType("button")[0]!;
      await act(() => expand.props.onClick());
      const script = renderer!.root
        .findAllByType("button")
        .filter((button) =>
          button.children.some((child) => typeof child === "string" && child.includes("script")),
        );
      expect(script).toHaveLength(historical ? 0 : 1);
      const text = renderer!.root
        .findAll(() => true)
        .flatMap((node) => node.children)
        .filter((child) => typeof child === "string")
        .join("|");
      expect(text).toContain("Audit");
      expect(text).toContain("Review");
      expect(text).toContain("Reader");
      expect(text).toContain("researcher");
      expect(text.includes("— tok")).toBe(!tokens);
      expect(text.includes("Historical")).toBe(historical);
      expect(model.liveCount).toBe(0);
      expect(model.workflows[0]?.phases[0]?.activeCount).toBe(historical ? 0 : 1);
      expect(model.workflows[0]?.phases[0]?.state).toBe(historical ? "pending" : "running");
      expect(model.workflows[0]?.phases[0]?.members[0]?.status).toBe("idle");
      expect(text.includes("Idle · resumable")).toBe(!historical);
      expect(model.workflows[0]?.workflow.runHandles?.scriptPath).toBe("/old-workspace/audit.ts");
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  },
);
