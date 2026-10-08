import "../../index.css";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { MessagesTimeline } from "./MessagesTimeline";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { motionClock } from "./motionClock";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("live-activity-tests");
const date = "2026-09-29T00:00:00.000Z";
function entry(index: number, text = `Message ${index}\n\n${"Readable paragraph. ".repeat(28)}`) {
  return {
    kind: "message" as const,
    id: `entry-${index}`,
    createdAt: date,
    message: {
      id: MessageId.make(`message-${index}`),
      role: "user" as const,
      text,
      runId: RunId.make(`run-${index}`),
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
  };
}
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
function render(
  key: string,
  entries: React.ComponentProps<typeof MessagesTimeline>["timelineEntries"],
  extra: Partial<React.ComponentProps<typeof MessagesTimeline>> = {},
) {
  if (!host) {
    host = document.createElement("div");
    Object.assign(host.style, { width: "720px", height: "600px" });
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() =>
    root!.render(
      <MessagesTimeline {...base} routeThreadKey={key} timelineEntries={entries} {...extra} />,
    ),
  );
}
// The answer reveal reads `motionClock`; every frame here advances it by 16ms.
const realNow = motionClock.now;
let clock = 0;
beforeEach(() => {
  clock = 0;
  motionClock.now = () => clock;
});
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  motionClock.now = realNow;
});
const working = { isWorking: true, activeTurnInProgress: true, runningRunId: RunId.make("run-1") };
const sweeps = () => Array.from(host!.querySelectorAll(".live-activity-focus"));
const rowOf = (element: Element) =>
  (element.closest("[data-timeline-row-kind]") as HTMLElement | null)?.dataset.timelineRowKind;
const cycleSeconds = (element: Element) =>
  Number.parseFloat(
    (
      element.closest("[style*='--live-activity-duration']") as HTMLElement | null
    )?.style.getPropertyValue("--live-activity-duration") ?? "NaN",
  );
function runningTool(id: string, label: string) {
  return {
    id,
    kind: "work" as const,
    createdAt: date,
    entry: {
      id,
      createdAt: date,
      runId: RunId.make("run-1"),
      label,
      tone: "tool" as const,
      toolLifecycleStatus: "inProgress" as const,
      detail: label,
    },
  };
}

it("sweeps only the current activity, and shows the working header's dot", async () => {
  render("live:thinking", [entry(1, "Find the bug")], working);
  await expect.poll(() => sweeps().length).toBe(1);
  expect(rowOf(sweeps()[0]!)).toBe("thinking");
  // The working header has the steady dot and no sweep of its own.
  const header = host!.querySelector('[data-timeline-row-kind="working"]')!;
  expect(header.querySelector(".live-activity-dot")).not.toBeNull();
  expect(header.querySelector(".live-activity-focus")).toBeNull();
  // The sweeping label's own text rests lighter under the light.
  const rest = host!.querySelector('[data-timeline-row-kind="thinking"] .live-activity-rest')!;
  expect(getComputedStyle(rest).opacity).toBe("0.55");
  expect(getComputedStyle(sweeps()[0]!).animationName).toBe("scient-live-activity-sweep");
});

it("moves the sweep to the running tool, with no stepped shine anywhere", async () => {
  render(
    "live:tool",
    [entry(1, "Run the tests"), runningTool("tool-1", "Running pnpm test")],
    working,
  );
  await expect.poll(() => sweeps().length).toBe(1);
  expect(rowOf(sweeps()[0]!)).toBe("work-live");
  expect(host!.querySelector(".live-tool-shine")).toBeNull();
});

it("gives a longer label a longer cycle at the same pace", async () => {
  render("live:short", [entry(1, "Short")], working);
  await expect.poll(() => sweeps().length).toBe(1);
  const short = cycleSeconds(sweeps()[0]!);
  render(
    "live:long",
    [
      entry(2, "Long"),
      runningTool("tool-2", "Running pnpm test --filter @t3tools/web --reporter verbose"),
    ],
    working,
  );
  await expect.poll(() => rowOf(sweeps()[0] ?? document.body)).toBe("work-live");
  const long = cycleSeconds(sweeps()[0]!);
  expect(short).toBeGreaterThan(1.5);
  expect(long).toBeGreaterThan(short + 0.5);
});

it("runs the light at the label's own pace: the real animation duration and its 80% pass", async () => {
  render("live:timing", [entry(1, "Timing")], working);
  await expect.poll(() => sweeps().length).toBe(1);
  const overlay = sweeps()[0]!;
  const cycle = cycleSeconds(overlay);
  const counter = overlay.querySelector(".live-activity-focus-counter")!;
  expect(Number.parseFloat(getComputedStyle(overlay).animationDuration)).toBeCloseTo(cycle, 2);
  expect(Number.parseFloat(getComputedStyle(counter).animationDuration)).toBeCloseTo(cycle, 2);
  const animation = overlay
    .getAnimations()
    .find((candidate) => candidate instanceof CSSAnimation) as CSSAnimation;
  expect(animation.animationName).toBe("scient-live-activity-sweep");
  const offsets = (animation.effect as KeyframeEffect).getKeyframes().map((frame) => frame.offset);
  expect(offsets).toContain(0.8);
});

it("lets the header's own label sweep while compacting before the compaction row exists", async () => {
  render("live:compacting", [entry(1, "/compact")], { ...working, isCompacting: true });
  await expect.poll(() => sweeps().length).toBe(1);
  expect(rowOf(sweeps()[0]!)).toBe("working");
});

it("keeps the dot through the header's exit, so the label never shifts", async () => {
  render("live:exit", [entry(1, "Done soon")], working);
  await expect.poll(() => host!.querySelector(".live-activity-dot")).not.toBeNull();
  render("live:exit", [entry(1, "Done soon")], { isWorking: false });
  const header = host!.querySelector('[data-timeline-row-kind="working"]');
  expect(header).not.toBeNull();
  expect(header!.querySelector(".live-activity-dot")).not.toBeNull();
});

function setupSnapshot() {
  const stage = (id: "fetch" | "setup-script" | "agent", status: "done" | "running") => ({
    id,
    status,
    startedAt: date,
    endedAt: status === "done" ? date : null,
    percent: null,
    detail: null,
    tail: [],
  });
  return {
    threadId: ThreadId.make("thread-setup"),
    phase: "running" as const,
    startedAt: date,
    endedAt: null,
    branch: null,
    baseRef: null,
    worktreePath: null,
    setupScript: { name: "Install", command: "pnpm install", terminalId: "term-1" },
    // An async setup script still runs beside the agent-start stage.
    stages: [stage("fetch", "done"), stage("setup-script", "running"), stage("agent", "running")],
    error: null,
    sequence: 1,
  };
}

it("sweeps only the latest running setup stage, and never in the setup popover's card", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() =>
    root!.render(
      <WorktreeSetupCard
        snapshot={setupSnapshot()}
        onCancel={null}
        onWorkLocally={null}
        onOpenTerminal={null}
      />,
    ),
  );
  expect(sweeps()).toHaveLength(1);
  expect(
    sweeps()[0]!.closest("[data-worktree-setup-stage]")?.getAttribute("data-worktree-setup-stage"),
  ).toBe("agent");
  flushSync(() =>
    root!.render(
      <WorktreeSetupCard
        snapshot={setupSnapshot()}
        onCancel={null}
        onWorkLocally={null}
        onOpenTerminal={null}
        sweep={false}
      />,
    ),
  );
  expect(sweeps()).toHaveLength(0);
});

it("re-measures the pace between passes when the running tool changes", async () => {
  const prompt = entry(1, "Run things");
  render("live:retime", [prompt, runningTool("tool-a", "ls")], working);
  await expect.poll(() => rowOf(sweeps()[0] ?? document.body)).toBe("work-live");
  const first = cycleSeconds(sweeps()[0]!);
  // The same live row now shows a much longer tool label.
  render(
    "live:retime",
    [
      prompt,
      runningTool("tool-a", "ls"),
      runningTool(
        "tool-b",
        "Running pnpm test --filter @t3tools/web --reporter verbose --watch false",
      ),
    ],
    working,
  );
  // After the current pass ends, the cycle follows the new width.
  await expect
    .poll(() => cycleSeconds(sweeps()[0]!), { timeout: 8000 })
    .toBeGreaterThan(first + 0.5);
});
