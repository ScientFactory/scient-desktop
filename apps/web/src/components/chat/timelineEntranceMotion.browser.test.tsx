import "../../index.css";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { MessagesTimeline } from "./MessagesTimeline";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("entrance-motion-tests");
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
/** The answer to prompt 1, in that prompt's run. */
function reply(index: number, text: string, streaming: boolean) {
  const { message, ...row } = entry(index, text);
  return {
    ...row,
    message: { ...message, role: "assistant" as const, runId: RunId.make("run-1"), streaming },
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
const frames = async (count = 4) => {
  for (let i = 0; i < count; i++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const animationsOf = (element: Element | null | undefined) =>
  element
    ? element
        .getAnimations()
        // Script entrances only, not the stylesheet's own transitions.
        .filter(
          (animation) =>
            !(animation instanceof CSSTransition) &&
            !(animation instanceof CSSAnimation) &&
            animation.playState !== "finished",
        )
    : [];
const working = { isWorking: true, activeTurnInProgress: true, runningRunId: RunId.make("run-1") };

it("gives the working label the thinking traces' live shine for as long as the turn works", async () => {
  const prompt = entry(1, "First question");
  render("motion:working", [prompt], working);
  const shine = () =>
    host!.querySelector('[data-timeline-row-kind="working"] .live-activity-focus');
  await expect.poll(() => shine()).not.toBeNull();
  // The same overlay the thinking row uses, and no one-time entrance on the label.
  expect(
    host!.querySelector('[data-timeline-row-kind="thinking"] .live-activity-focus'),
  ).not.toBeNull();
  const label = host!.querySelector('[data-timeline-row-kind="working"] .border-b > div');
  expect(animationsOf(label)).toHaveLength(0);
});

it("plays the entrance for a first prompt being placed, and for no other prompt", async () => {
  const first = entry(1, "First question");
  render("motion:first", [first], {
    anchorMessageId: first.message.id,
    timelinePositioningPending: true,
  });
  const bubble = (id: string) =>
    host!.querySelector(`[data-message-id="${id}"] .group.flex.flex-col.items-end`);
  await expect.poll(() => bubble(first.message.id)).not.toBeNull();
  expect(animationsOf(bubble(first.message.id))).toHaveLength(1);
  // Its row remounts while it is still being placed: no replay.
  render("motion:elsewhere", [entry(60, "Elsewhere")]);
  await frames(4);
  render("motion:first", [first], {
    anchorMessageId: first.message.id,
    timelinePositioningPending: true,
  });
  await expect.poll(() => bubble(first.message.id)).not.toBeNull();
  expect(animationsOf(bubble(first.message.id))).toHaveLength(0);
  const later = entry(2, "Later question");
  render("motion:first", [first, later], { anchorMessageId: first.message.id });
  await expect.poll(() => bubble(later.message.id)).not.toBeNull();
  expect(animationsOf(bubble(later.message.id))).toHaveLength(0);
});

it("reveals a streaming answer line by line after a short wait, once, and nothing else", async () => {
  const prompt = entry(1, "Question");
  const answer = (text: string, streaming: boolean) => reply(2, text, streaming);
  const text = () =>
    host!.querySelector<HTMLElement>('[data-message-role="assistant"] .chat-markdown');
  const front = () => Number.parseFloat(text()?.style.getPropertyValue("--reveal-front") || "0");
  render("motion:stream", [prompt, answer("First paragraph.\n\nSecond paragraph.", true)], working);
  await expect.poll(() => text()?.classList.contains("streamed-reveal")).toBe(true);
  // The first lines wait a moment, so the next paragraphs are in hand.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(front()).toBe(0);
  // Then the lines appear at a steady pace.
  await expect.poll(front, { timeout: 3000 }).toBeGreaterThan(10);
  const reached = front();
  // Remounted mid-reveal (a thread switch and back): it continues, no replay.
  render("motion:elsewhere-stream", [entry(70, "Elsewhere")]);
  await frames(4);
  render("motion:stream", [prompt, answer("First paragraph.\n\nSecond paragraph.", true)], working);
  await expect.poll(() => text()?.classList.contains("streamed-reveal")).toBe(true);
  expect(front()).toBeGreaterThanOrEqual(reached);
  // Once the answer is done, the reveal finishes and the mask goes.
  render("motion:stream", [prompt, answer("First paragraph.\n\nSecond paragraph.", false)], {
    isWorking: false,
    activeTurnInProgress: false,
  });
  await expect
    .poll(() => text()?.classList.contains("streamed-reveal"), { timeout: 4000 })
    .toBe(false);
  // A finished answer that was never revealed here simply shows.
  render("motion:finished", [prompt, answer("Already done.", false)], {
    isWorking: false,
    activeTurnInProgress: false,
  });
  await frames(4);
  expect(text()?.classList.contains("streamed-reveal")).toBe(false);
});

it("closes a finished turn's working header gradually, so the answer slides up", async () => {
  const prompt = entry(1, "Question");
  const answer = (streaming: boolean) => reply(2, "The answer.", streaming);
  render("motion:exit", [prompt, answer(true)], working);
  const answerTop = () =>
    host!.querySelector('[data-message-role="assistant"]')!.getBoundingClientRect().top;
  const header = () => host!.querySelector('[data-timeline-row-kind="working"]');
  await expect.poll(() => header()).not.toBeNull();
  await frames(8);
  const before = answerTop();
  render("motion:exit", [prompt, answer(false)], { isWorking: false, activeTurnInProgress: false });
  // Mid-exit: still in place, the answer part of the way up.
  await new Promise((resolve) => setTimeout(resolve, 140));
  await frames(2);
  expect(header()).not.toBeNull();
  const midway = answerTop();
  expect(midway).toBeLessThan(before - 2);
  // Then it is gone, and the answer rests where it would without it.
  await expect.poll(() => header()).toBeNull();
  await frames(6);
  const after = answerTop();
  expect(midway).toBeGreaterThan(after + 2);
  expect(before - after).toBeGreaterThan(20);
});

it("hides Thinking while the answer's lines appear, and brings it back when the agent moves on", async () => {
  const prompt = entry(1, "Question");
  const answer = reply(41, "First paragraph.\n\nSecond paragraph.", true);
  // The row's own wrapper, inside the work-log block the timeline puts it in.
  const thinking = () =>
    host!.querySelector('[data-timeline-row-kind="thinking"] > div > div') as HTMLElement | null;
  render("motion:thinking", [prompt, answer], working);
  await expect.poll(() => thinking()).not.toBeNull();
  // During the short wait before any line shows, Thinking still shows the work.
  expect(thinking()!.classList.contains("opacity-0")).toBe(false);
  // Once the lines appear, it steps aside.
  await expect
    .poll(() => thinking()?.classList.contains("opacity-0"), { timeout: 3000 })
    .toBe(true);
  // The agent goes back to work after the text (a tool step): its live activity
  // shows again (here the running tool takes the activity row's place).
  const tool = {
    id: "tool-after-text",
    kind: "work" as const,
    createdAt: date,
    entry: {
      id: "tool-after-text",
      createdAt: date,
      runId: RunId.make("run-1"),
      label: "Run command",
      tone: "tool" as const,
      toolLifecycleStatus: "completed" as const,
      detail: "Command output",
    },
  };
  render("motion:thinking", [prompt, answer, tool], working);
  await expect
    .poll(() => {
      const live = host!.querySelector('[data-timeline-row-kind="work-live"]');
      const visibleThinking = thinking() && !thinking()!.classList.contains("opacity-0");
      return Boolean(live) || Boolean(visibleThinking);
    })
    .toBe(true);
});

it("crosses the blank space between paragraphs without pausing", async () => {
  const prompt = entry(1, "Question");
  const text = "One line.\n\nTwo line.\n\nThree line.";
  const answer = reply(2, text, true);
  render("motion:gaps", [prompt, answer], working);
  const root = () =>
    host!.querySelector<HTMLElement>('[data-message-role="assistant"] .chat-markdown');
  await expect.poll(() => root()?.classList.contains("streamed-reveal")).toBe(true);
  const paragraphs = Array.from(root()!.querySelectorAll("p"));
  const top = root()!.getBoundingClientRect().top;
  const gapStart = paragraphs[0]!.getBoundingClientRect().bottom - top;
  const gapEnd = paragraphs[1]!.getBoundingClientRect().top - top;
  const lineHeight = Number.parseFloat(getComputedStyle(root()!).lineHeight);
  const front = () => Number.parseFloat(root()!.style.getPropertyValue("--reveal-front") || "0");
  await expect.poll(() => front() >= gapStart, { timeout: 4000 }).toBe(true);
  const entered = performance.now();
  await expect.poll(() => front() >= gapEnd, { timeout: 4000 }).toBe(true);
  const crossed = performance.now() - entered;
  // At the line pace the gap would take (gap / 4 lines a second); it takes far less.
  const atLinePace = ((gapEnd - gapStart) / lineHeight) * 250;
  expect(crossed).toBeLessThan(Math.max(80, atLinePace / 2));
});
