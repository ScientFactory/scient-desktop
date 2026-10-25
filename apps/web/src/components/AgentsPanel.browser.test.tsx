import { render as _fixtureRender, type Screen, act } from "../../test/render";
import { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import * as DateTime from "effect/DateTime";
import { type ReactNode } from "react";

import { expect, it, vi } from "vite-plus/test";
import { AgentsPanel } from "./AgentsPanel";

vi.mock("./ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Two rows cover both values of each flag; the flags take independent branches.
it.each([
  [true, true],
  [false, false],
] as const)(
  "preserves workflow history while gating current-workspace script reads (historical=%s, tokens=%s)",
  async (historical, tokens) => {
    await using _fixture = _createFixture();

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
    let renderer: Screen | undefined;
    const container = document.createElement("div");
    document.body.append(container);
    try {
      await act(async () => {
        renderer = _fixture.stack.use(
          await _fixtureRender(null, { container: container, router: false }),
        );
        await renderer.rerender(
          <AgentsPanel
            model={model}
            environmentId={EnvironmentId.make("environment")}
            threadId={ThreadId.make("thread")}
          />,
        );
      });
      const collapsedText = container.textContent ?? "";
      expect(model.totalTokens).toBe(tokens ? 20 : null);
      expect(collapsedText.includes("Unknown")).toBe(!tokens);
      const expand = container.querySelector("button")!;
      await act(() => expand.click());
      const script = [...container.querySelectorAll("button")].filter((button) =>
        button.textContent?.includes("script"),
      );
      expect(script).toHaveLength(historical ? 0 : 1);
      const text = container.textContent ?? "";
      expect(text).toContain("Audit");
      expect(text).toContain("Review");
      expect(text).toContain("Reader");
      expect(text).toContain("researcher");
      expect(text.includes("Unknown tok")).toBe(!tokens);
      expect(text.includes("Historical")).toBe(historical);
      expect(model.liveCount).toBe(0);
      expect(model.workflows[0]?.phases[0]?.activeCount).toBe(historical ? 0 : 1);
      expect(model.workflows[0]?.phases[0]?.state).toBe(historical ? "pending" : "running");
      expect(model.workflows[0]?.phases[0]?.members[0]?.status).toBe("idle");
      expect(text.includes("Idle · resumable")).toBe(!historical);
      expect(model.workflows[0]?.workflow.runHandles?.scriptPath).toBe("/old-workspace/audit.ts");
    } finally {
      await act(async () => await renderer?.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
