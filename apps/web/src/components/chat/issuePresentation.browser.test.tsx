import "../../index.css";
import {
  CheckpointId,
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  NodeId,
  TurnItemId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import * as DateTime from "effect/DateTime";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { MessagesTimeline } from "./MessagesTimeline";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";

const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("issue-presentation-fixture");
const base = {
  listRef,
  isWorking: false,
  activeTurnInProgress: false,
  activeTurnStartedAt: null,
  latestRun: null,
  runningRunId: null,
  turnDiffSummaries: [],
  onOpenTurnDiff: () => {},
  onOpenThread: () => {},
  onForkFromRun: () => Promise.resolve(),
  onRollbackCheckpoint: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: env,
  markdownCwd: undefined,
  resolvedTheme: "light" as const,
  timestampFormat: "locale" as const,
  workspaceRoot: undefined,
  runs: [],
  providerStatuses: [],
  anchorMessageId: null,
  onAnchorReady: () => {},
  onAnchorSizeChanged: () => {},
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
  const date = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
  const threadId = ThreadId.make("fixture-thread");
  const runId = RunId.make("fixture-run");
  const itemBase = {
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: date,
    completedAt: date,
    updatedAt: date,
  };
  const items: ReadonlyArray<OrchestrationV2TurnItem> = [
    {
      ...itemBase,
      id: TurnItemId.make("user"),
      ordinal: 0,
      type: "user_message",
      messageId: MessageId.make("user"),
      inputIntent: "turn_start",
      text: "hey, are you there?",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    {
      ...itemBase,
      id: TurnItemId.make("capture-failure"),
      ordinal: 1,
      status: "failed",
      title:
        "VCS process failed in GitVcsDriver.checkpoints.captureCheckpoint: git status (/example/project) exited with 1 - Changed files exceed the checkpoint capture size limit (512 MiB per file, 1 GiB total).",
      type: "checkpoint",
      checkpointId: CheckpointId.make("capture-failure"),
      scopeId: CheckpointScopeId.make("fixture-scope"),
      files: [],
    },
    {
      ...itemBase,
      id: TurnItemId.make("answer"),
      ordinal: 2,
      type: "assistant_message",
      messageId: MessageId.make("answer"),
      text: "Here. What do you need?",
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
              timelineEntries={deriveTimelineEntriesFromVisibleTurnItems({
                optimisticMessages: [],
                visibleTurnItems: items.map((item, position) => ({
                  position,
                  visibility: "local",
                  sourceThreadId: threadId,
                  sourceItemId: item.id,
                  item,
                })),
              })}
            />
          </div>
          <div style={{ padding: "24px", borderTop: "1px solid #ddd" }}>
            <ComposerPendingApprovalPanel
              approval={{
                requestId: RuntimeRequestId.make("approval"),
                responseCapability: "live" as const,
                requestKind: "command",
                createdAt: DateTime.formatIso(date),
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
  const runId = RunId.make("run-subagents");
  const threadId = ThreadId.make("thread-subagents");
  const itemBase = {
    threadId,
    runId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
  };
  const note = "Droid reports a sub-agent's steps only when it finishes.";
  const subagent = (
    id: string,
    title: string,
    ordinal: number,
    status: "running" | "cancelled",
  ): Extract<OrchestrationV2TurnItem, { type: "subagent" }> => ({
    ...itemBase,
    id: TurnItemId.make(id),
    nodeId: NodeId.make(id),
    ordinal,
    type: "subagent",
    subagentId: NodeId.make(id),
    origin: "provider_native",
    driver: ProviderDriverKind.make("droid"),
    providerInstanceId: ProviderInstanceId.make("droid"),
    childThreadId: null,
    title,
    prompt: title,
    progress: note,
    result: status === "cancelled" ? "Cancelled when you sent a follow-up message." : null,
    status,
    startedAt: DateTime.makeUnsafe(at(60)),
    completedAt: status === "cancelled" ? DateTime.makeUnsafe(at(90)) : null,
    updatedAt: DateTime.makeUnsafe(at(status === "cancelled" ? 90 : 60)),
  });
  const subagents = [
    subagent("task-ci", "Audit build, CI, and release pipeline for the desktop app", 0, "running"),
    subagent("task-code", "Audit scient-desktop code smells", 1, "cancelled"),
  ];
  const agentPanelModel = deriveAgentPanelModel({
    agents: [],
    v2Projection: projectedSubagentsToRuntime(
      subagents.map((item) => ({
        ...item,
        model: null,
        presentation: { kind: "subagent", role: "explorer" },
      })),
    ),
  });
  const waiting: OrchestrationV2TurnItem = {
    ...itemBase,
    id: TurnItemId.make("wait-1"),
    nodeId: NodeId.make("root"),
    ordinal: 2,
    type: "dynamic_tool",
    toolName: "TaskOutput",
    input: { taskId: "task-ci", timeout: 600_000 },
    status: "running",
    title:
      "Waiting for sub-agent · Audit build, CI, and release pipeline for the desktop app (up to 10 min)",
    startedAt: DateTime.makeUnsafe(at(100)),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(at(100)),
  };
  const timeline = (items: ReadonlyArray<OrchestrationV2TurnItem>) => (
    <MessagesTimeline
      {...base}
      routeThreadKey="fixture"
      isWorking
      activeTurnStartedAt={at(0)}
      runningRunId={runId}
      agentPanelModel={agentPanelModel}
      latestRun={{ runId, status: "running", startedAt: at(0), completedAt: null }}
      timelineEntries={deriveTimelineEntriesFromVisibleTurnItems({
        optimisticMessages: [],
        visibleTurnItems: items.map((item, position) => ({
          position,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        })),
      })}
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
      expect(row.getBoundingClientRect().height, row.textContent ?? "").toBeLessThan(48);
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
