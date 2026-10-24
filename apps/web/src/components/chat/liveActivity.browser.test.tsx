import { act as _fixtureAct, render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";

import { expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import type { CDPSession } from "vite-plus/test/browser-playwright";
import { ThreadId } from "@t3tools/contracts";
import { MessagesTimeline } from "./MessagesTimeline";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { motionClock } from "./motionClock";

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

async function render(
  _fixture: _Fixture,
  key: string,
  entries: React.ComponentProps<typeof MessagesTimeline>["timelineEntries"],
  extra: Partial<React.ComponentProps<typeof MessagesTimeline>> = {},
) {
  if (!_fixture.host) {
    _fixture.host = document.createElement("div");
    Object.assign(_fixture.host.style, { width: "720px", height: "600px" });
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await _fixtureAct(
    async () =>
      await _fixture.root0!.rerender(
        <MessagesTimeline
          emptyPlaceholderInset={0}
          {..._fixture.base}
          routeThreadKey={key}
          timelineEntries={entries}
          {...extra}
        />,
      ),
  );
}
// The answer reveal reads `motionClock`; every frame here advances it by 16ms.
const realNow = motionClock.now;
let clock = 0;
async function _setupFixture0(_fixture: _Fixture) {
  clock = 0;
  motionClock.now = () => clock;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  motionClock.now = realNow;
}
const working = { isWorking: true, activeTurnInProgress: true, runningRunId: RunId.make("run-1") };
const sweeps = (_fixture: _Fixture) =>
  Array.from(_fixture.host!.querySelectorAll(".live-activity-focus"));
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

// regression: 7424d1c45c fix(chat): one sweep in every live state; dot kept through the exit; review fixes
it("runs the light at the label's own pace, looping with no pause", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "live:timing", [entry(1, "Timing")], working);
  await vi.waitFor(() => {
    expect(sweeps(_fixture).length).toBe(1);
  });
  const overlay = sweeps(_fixture)[0]!;
  const cycle = cycleSeconds(overlay);
  const counter = overlay.querySelector(".live-activity-focus-counter")!;
  expect(Number.parseFloat(getComputedStyle(overlay).animationDuration)).toBeCloseTo(cycle, 2);
  expect(Number.parseFloat(getComputedStyle(counter).animationDuration)).toBeCloseTo(cycle, 2);
  const animation = overlay
    .getAnimations()
    .find((candidate) => candidate instanceof CSSAnimation) as CSSAnimation;
  expect(animation.animationName).toBe("scient-live-activity-sweep");
  // A continuous loop: straight from the start to the end, no held frames.
  const offsets = (animation.effect as KeyframeEffect).getKeyframes().map((frame) => frame.offset);
  expect(offsets).toEqual([0, 1]);
});

// regression: 7424d1c45c fix(chat): one sweep in every live state; dot kept through the exit; review fixes
it("lets the header's own label sweep while compacting before the compaction row exists", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "live:compacting", [entry(1, "/compact")], {
    ...working,
    isCompacting: true,
  });
  await vi.waitFor(() => {
    expect(sweeps(_fixture).length).toBe(1);
  });
  expect(rowOf(sweeps(_fixture)[0]!)).toBe("working");
});

// regression: 7424d1c45c fix(chat): one sweep in every live state; dot kept through the exit; review fixes
it("keeps the dot through the header's exit, so the label never shifts", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "live:exit", [entry(1, "Done soon")], working);
  await vi.waitFor(() => {
    expect(_fixture.host!.querySelector(".live-activity-dot")).not.toBeNull();
  });
  await render(_fixture, "live:exit", [entry(1, "Done soon")], { isWorking: false });
  const header = _fixture.host!.querySelector('[data-timeline-row-kind="working"]');
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

// regression: 7424d1c45c fix(chat): one sweep in every live state; dot kept through the exit; review fixes
it("sweeps only the latest running setup stage, and never in the setup popover's card", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixtureAct(
    async () =>
      await _fixture.root0!.rerender(
        <WorktreeSetupCard
          snapshot={setupSnapshot()}
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={null}
        />,
      ),
  );
  expect(sweeps(_fixture)).toHaveLength(1);
  expect(
    sweeps(_fixture)[0]!
      .closest("[data-worktree-setup-stage]")
      ?.getAttribute("data-worktree-setup-stage"),
  ).toBe("agent");
  await _fixtureAct(
    async () =>
      await _fixture.root0!.rerender(
        <WorktreeSetupCard
          snapshot={setupSnapshot()}
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={null}
          sweep={false}
        />,
      ),
  );
  expect(sweeps(_fixture)).toHaveLength(0);
});

// regression: 7424d1c45c fix(chat): one sweep in every live state; dot kept through the exit; review fixes
it("re-measures the pace between passes when the running tool changes", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Run things");
  await render(_fixture, "live:retime", [prompt, runningTool("tool-a", "ls")], working);
  await vi.waitFor(() => {
    expect(rowOf(sweeps(_fixture)[0] ?? document.body)).toBe("work-live");
  });
  const first = cycleSeconds(sweeps(_fixture)[0]!);
  // The same live row now shows a much longer tool label.
  await render(
    _fixture,
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
  const overlay = sweeps(_fixture)[0]!;
  const animation = overlay.getAnimations().find((candidate) => candidate instanceof CSSAnimation)!;
  // Drive the pass boundary without waiting for a browser animation.
  animation.currentTime = first * 1000;
  overlay.dispatchEvent(
    new AnimationEvent("animationiteration", {
      bubbles: true,
      animationName: "scient-live-activity-sweep",
    }),
  );
  expect(cycleSeconds(overlay)).toBeGreaterThan(first + 0.5);
  // A new pace starts a fresh pass rather than jumping into its middle.
  expect(animation.effect!.getComputedTiming().progress ?? 1).toBeLessThan(0.2);
});

// regression: 8a83e7e204 fix(chat): re-timed sweeps start cleanly; a just-begun setup sweeps its header
it("never sweeps the setup popover beside the timeline's current activity", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const snapshot = {
    ...setupSnapshot(),
    // The agent has started; the async setup script still runs.
    stages: setupSnapshot().stages.map((stage) =>
      stage.id === "agent" ? { ...stage, status: "done" as const, endedAt: date } : stage,
    ),
  };
  await render(_fixture, "live:chip", [entry(1, "Go")], {
    ...working,
    worktreeSetup: snapshot,
    latestRun: {
      runId: RunId.make("run-1"),
      status: "running",
      startedAt: date,
      completedAt: null,
    },
  });
  const chip = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label$="Show setup progress."]');
  await vi.waitFor(() => {
    expect(chip()).not.toBeNull();
  });
  chip()!.click();
  // The popover's own card, rendered outside the timeline.
  const popoverStage = () =>
    Array.from(document.querySelectorAll('[data-worktree-setup-stage="setup-script"]')).find(
      (stage) => !_fixture.host!.contains(stage),
    );
  await vi.waitFor(() => {
    expect(popoverStage()).toBeDefined();
  });
  const popoverCard = popoverStage()!.closest("section")!;
  // Its running stage stays still: one sweep on the whole page, on the timeline.
  expect(popoverCard.querySelector(".live-activity-focus")).toBeNull();
  expect(document.querySelectorAll(".live-activity-focus")).toHaveLength(1);
  expect(_fixture.host!.contains(document.querySelector(".live-activity-focus"))).toBe(true);
});

async function emulate(feature: "prefers-reduced-motion" | "forced-colors", value: string) {
  const session: CDPSession = cdp();
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: feature, value }] });
}

// regression: 8a83e7e204 fix(chat): re-timed sweeps start cleanly; a just-begun setup sweeps its header
it("with reduced motion: no sweep or dimming, the dot still and visible", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await emulate("prefers-reduced-motion", "reduce");
  try {
    await render(_fixture, "live:reduced", [entry(1, "Calm")], working);
    await vi.waitFor(() => {
      expect(_fixture.host!.querySelector(".live-activity-dot")).not.toBeNull();
    });
    const dot = _fixture.host!.querySelector(".live-activity-dot")!;
    expect(getComputedStyle(dot).animationName).toBe("none");
    expect(getComputedStyle(dot).opacity).toBe("1");
    const overlay = _fixture.host!.querySelector(".live-activity-focus");
    if (overlay) {
      expect(getComputedStyle(overlay).animationName).toBe("none");
      expect(getComputedStyle(overlay).opacity).toBe("0");
    }
    const rest = _fixture.host!.querySelector(".live-activity-rest");
    if (rest) expect(getComputedStyle(rest).opacity).toBe("1");
  } finally {
    await emulate("prefers-reduced-motion", "");
  }
});

// regression: 8a83e7e204 fix(chat): re-timed sweeps start cleanly; a just-begun setup sweeps its header
it("in high contrast mode: the dot keeps the system text color", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await emulate("forced-colors", "active");
  try {
    await render(_fixture, "live:contrast", [entry(1, "Contrast")], working);
    await vi.waitFor(() => {
      expect(_fixture.host!.querySelector(".live-activity-dot")).not.toBeNull();
    });
    const dot = getComputedStyle(_fixture.host!.querySelector(".live-activity-dot")!);
    expect(dot.forcedColorAdjust).toBe("none");
    expect(dot.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(dot.animationName).toBe("none");
    // No sweep (overlay hidden, no motion) and no dimmed text either.
    await vi.waitFor(() => {
      expect(_fixture.host!.querySelector(".live-activity-focus")).not.toBeNull();
    });
    const overlay = _fixture.host!.querySelector(".live-activity-focus")!;
    expect(getComputedStyle(overlay).opacity).toBe("0");
    expect(getComputedStyle(overlay).animationName).toBe("none");
    const counter = overlay.querySelector(".live-activity-focus-counter")!;
    expect(getComputedStyle(counter).animationName).toBe("none");
    expect(getComputedStyle(_fixture.host!.querySelector(".live-activity-rest")!).opacity).toBe(
      "1",
    );
  } finally {
    await emulate("forced-colors", "");
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const listRef = createRef<LegendListRef>();
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
  return {
    listRef,
    base,
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
