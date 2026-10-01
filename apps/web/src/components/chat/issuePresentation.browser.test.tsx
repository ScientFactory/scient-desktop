import "../../index.css";
import {
  EnvironmentId,
  EventId,
  MessageId,
  TurnId,
  ApprovalRequestId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { MessagesTimeline } from "./MessagesTimeline";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";

const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("issue-presentation-fixture");
const base = {
  listRef,
  isWorking: false,
  activeTurnStartedAt: null,
  latestTurn: null,
  runningTurnId: null,
  turnDiffSummaries: [],
  onOpenTurnDiff: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: env,
  markdownCwd: undefined,
  resolvedTheme: "light" as const,
  timestampFormat: "locale" as const,
  workspaceRoot: undefined,
  anchorMessageId: null,
  onAnchorReady: () => {},
  contentInsetEndAdjustment: 100,
  onIsAtEndChange: vi.fn(),
  onManualNavigation: () => {},
};

it("keeps a successful answer clean and puts retry feedback on its approval", async () => {
  await page.viewport(1000, 800);
  const host = document.createElement("div");
  Object.assign(host.style, {
    width: "900px",
    height: "650px",
    display: "flex",
    flexDirection: "column",
    background: "white",
    color: "black",
  });
  document.body.append(host);
  const root = createRoot(host);
  const date = "2026-09-29T00:00:00.000Z";
  const turnId = TurnId.make("fixture-turn");
  const activities = [
    {
      id: EventId.make("capture-failure"),
      kind: "checkpoint.capture.failed",
      tone: "error" as const,
      summary: "Checkpoint capture failed",
      createdAt: date,
      turnId,
      payload: {
        detail:
          "VCS process failed in GitVcsDriver.checkpoints.captureCheckpoint: git status (/example/project) exited with 1 - Changed files exceed the checkpoint capture size limit (512 MiB per file, 1 GiB total).",
      },
    },
  ];
  const messages = [
    {
      id: MessageId.make("user"),
      role: "user" as const,
      text: "hey, are you there?",
      turnId,
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
    {
      id: MessageId.make("answer"),
      role: "assistant" as const,
      text: "Here. What do you need?",
      turnId,
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
  ];
  try {
    flushSync(() =>
      root.render(
        <>
          <div style={{ height: "500px" }}>
            <MessagesTimeline
              {...base}
              routeThreadKey="fixture"
              timelineEntries={deriveTimelineEntries(
                messages,
                [],
                deriveWorkLogEntries(activities),
              )}
            />
          </div>
          <div style={{ padding: "24px", borderTop: "1px solid #ddd" }}>
            <ComposerPendingApprovalPanel
              approval={{
                requestId: ApprovalRequestId.make("approval"),
                requestKind: "command",
                createdAt: date,
                detail: "git status",
                responseError: "Approval could not be sent. Try again.",
              }}
              pendingCount={1}
            />
          </div>
        </>,
      ),
    );
    await expect.poll(() => host.textContent).toContain("Here. What do you need?");
    if (import.meta.env.VITE_SCIENT_ISSUE_SCREENSHOT) {
      await page.screenshot({ path: import.meta.env.VITE_SCIENT_ISSUE_SCREENSHOT, element: host });
    }
    expect(host.textContent).not.toContain("VCS process failed");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Approval could not be sent. Try again.",
    );
  } finally {
    root.unmount();
    host.remove();
  }
});

it("shows running sub-agents and a long wait as alive, on one line, with a ticking timer", async () => {
  await page.viewport(700, 800);
  const host = document.createElement("div");
  Object.assign(host.style, {
    width: "520px",
    height: "650px",
    display: "flex",
    flexDirection: "column",
    background: "white",
    color: "black",
  });
  document.body.append(host);
  const root = createRoot(host);

  // The turn began 2m 5s ago; its sub-agents were launched a minute in.
  const start = Date.now() - 125_000;
  const at = (seconds: number) => new Date(start + seconds * 1_000).toISOString();
  const turnId = TurnId.make("turn-subagents");
  const activity = (
    id: string,
    kind: string,
    seconds: number,
    payload: Record<string, unknown>,
  ): OrchestrationThreadActivity => ({
    id: EventId.make(id),
    kind,
    summary: kind,
    tone: kind.startsWith("task.") ? "info" : "tool",
    turnId,
    createdAt: at(seconds),
    payload: kind.startsWith("task.") ? { ...payload, agentKind: "agent" } : payload,
  });
  const agent = (taskId: string, title: string) => ({
    taskId,
    toolUseId: taskId,
    taskType: "subagent",
    title,
    role: "explorer",
  });
  const ci = agent("task-ci", "Audit build, CI, and release pipeline for the desktop app");
  const code = agent("task-code", "Audit scient-desktop code smells");
  const note = "Droid reports a sub-agent's steps only when it finishes.";
  const subagents = [
    activity("a1", "task.started", 60, ci),
    activity("a2", "task.progress", 60, { ...ci, summary: note, status: "running" }),
    activity("a3", "task.started", 60, code),
    activity("a4", "task.updated", 90, {
      ...code,
      status: "cancelled",
      error: "Cancelled when you sent a follow-up message.",
    }),
  ];
  const waiting = activity("a5", "tool.updated", 100, {
    itemType: "collab_agent_tool_call",
    toolCallId: "wait-1",
    status: "inProgress",
    title:
      "Waiting for sub-agent · Audit build, CI, and release pipeline for the desktop app (up to 10 min)",
  });
  const timeline = (activities: ReadonlyArray<OrchestrationThreadActivity>) => (
    <MessagesTimeline
      {...base}
      routeThreadKey="fixture"
      isWorking
      runningTurnId={turnId}
      activeTurnStartedAt={at(0)}
      latestTurn={{ turnId, state: "running", startedAt: at(0), completedAt: null }}
      agentPanelModel={deriveAgentPanelModel({ agents: foldSubagentActivities(activities) })}
      timelineEntries={deriveTimelineEntries([], [], deriveWorkLogEntries(activities))}
    />
  );

  try {
    flushSync(() => root.render(timeline(subagents)));
    const rowWith = (text: string) =>
      [...host.querySelectorAll<HTMLElement>("button, [role=button], [data-timeline-row-kind]")]
        .filter((element) => element.textContent?.includes(text))
        .toSorted((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0];
    const elapsedIn = (text: string | null | undefined, after: string) =>
      text?.slice(text.indexOf(after) + after.length).match(/(?:(\d+)m )?(\d+)s/);
    const seconds = (match: RegExpMatchArray | null | undefined) =>
      match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : Number.NaN;

    // The collapsed row: how the sub-agents stand, and for how long they have worked.
    await expect.poll(() => host.textContent).toContain("Kicked off 2 subagents · 1 working · 1m");
    const spawn = rowWith("Kicked off 2 subagents")!;
    const first = seconds(elapsedIn(spawn.textContent, "1 working · "));
    expect(first).toBeGreaterThanOrEqual(65);
    expect(first).toBeLessThan(80);
    // It is a clock: it moves without any new event.
    await expect
      .poll(() => seconds(elapsedIn(spawn.textContent, "1 working · ")), { timeout: 5_000 })
      .toBeGreaterThan(first);

    const fitsOnOneLine = (row: HTMLElement) => {
      expect(row.getBoundingClientRect().height, row.textContent ?? "").toBeLessThan(40);
      expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
        host.getBoundingClientRect().right,
      );
    };
    fitsOnOneLine(spawn);

    // Opened: each sub-agent with its type, state, and why it stopped.
    (spawn.closest<HTMLElement>("[aria-expanded]") ??
      spawn.querySelector<HTMLElement>("[aria-expanded]"))!.click();
    await expect.poll(() => host.textContent).toContain("Cancelled when you sent a follow-up");
    const text = host.textContent ?? "";
    expect(text).toContain("explorer");
    expect(text).toMatch(/Working · 1m \d+s/);
    expect(text).toContain(note);
    expect(text).toContain("Stopped · 30s");
    const screenshot = async (name: string) => {
      const directory = import.meta.env.VITE_SCIENT_SUBAGENT_ROWS_SCREENSHOTS;
      if (directory) await page.screenshot({ path: `${directory}/${name}.png`, element: host });
    };
    await screenshot("subagents");

    // The main agent then waits on a sub-agent: the step says so and counts too.
    flushSync(() => root.render(timeline([...subagents, waiting])));
    await expect.poll(() => host.textContent).toContain("Waiting for sub-agent");
    const wait = rowWith("Waiting for sub-agent")!;
    expect(seconds(elapsedIn(wait.textContent, "(up to 10 min) · "))).toBeGreaterThanOrEqual(25);
    fitsOnOneLine(wait);
    // A long name gives way to the timer, not the other way round.
    const timer = [...wait.querySelectorAll<HTMLElement>("span")].find((span) =>
      /^ · \d/.test(span.textContent ?? ""),
    )!;
    expect(timer.getBoundingClientRect().right).toBeLessThanOrEqual(
      wait.getBoundingClientRect().right,
    );
    expect(timer.getBoundingClientRect().width).toBeGreaterThan(20);
    await screenshot("waiting");
  } finally {
    root.unmount();
    host.remove();
  }
});
