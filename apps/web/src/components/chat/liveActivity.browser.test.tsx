import "../../index.css";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MessagesTimeline } from "./MessagesTimeline";
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
