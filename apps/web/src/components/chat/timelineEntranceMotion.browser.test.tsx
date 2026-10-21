import { act as _fixtureAct, render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { MessagesTimeline } from "./MessagesTimeline";
import { motionClock } from "./motionClock";
import { showStreamedAnswersNow, streamingTextAppearing } from "./useStreamingBlockEntrance";

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

const frames = async (count = 4) => {
  for (let i = 0; i < count; i++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
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
/** Plays `ms` of motion, a 16ms frame at a time. */
async function play(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    clock += 16;
    await frames(1);
  }
}
/** Plays frames until `done` holds (at most `ms` of motion). */
async function playUntil(done: () => boolean, ms = 6000) {
  for (let elapsed = 0; elapsed < ms && !done(); elapsed += 16) {
    clock += 16;
    await frames(1);
  }
  expect(done()).toBe(true);
}

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

it("marks the working header with its dot while the turn works, the sweep staying on Thinking", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "First question");
  await render(_fixture, "motion:working", [prompt], working);
  const dot = () =>
    _fixture.host!.querySelector('[data-timeline-row-kind="working"] .live-activity-dot');
  await expect.poll(() => dot()).not.toBeNull();
  // One sweep, on the current activity (chat/liveActivity.tsx), and no one-time entrance on the label.
  expect(
    _fixture.host!.querySelector('[data-timeline-row-kind="working"] .live-activity-focus'),
  ).toBeNull();
  expect(
    _fixture.host!.querySelector('[data-timeline-row-kind="thinking"] .live-activity-focus'),
  ).not.toBeNull();
  const label = _fixture.host!.querySelector('[data-timeline-row-kind="working"] .border-b > div');
  expect(animationsOf(label)).toHaveLength(0);
});

it("plays the entrance for a first prompt being placed, and for no other prompt", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const first = entry(1, "First question");
  await render(_fixture, "motion:first", [first], {
    anchorMessageId: first.message.id,
    timelinePositioningPending: true,
  });
  const bubble = (id: string) =>
    _fixture.host!.querySelector(`[data-message-id="${id}"] .group.flex.flex-col.items-end`);
  await expect.poll(() => bubble(first.message.id)).not.toBeNull();
  expect(animationsOf(bubble(first.message.id))).toHaveLength(1);
  // Its row remounts while it is still being placed: no replay.
  await render(_fixture, "motion:elsewhere", [entry(60, "Elsewhere")]);
  await frames(4);
  await render(_fixture, "motion:first", [first], {
    anchorMessageId: first.message.id,
    timelinePositioningPending: true,
  });
  await expect.poll(() => bubble(first.message.id)).not.toBeNull();
  expect(animationsOf(bubble(first.message.id))).toHaveLength(0);
  const later = entry(2, "Later question");
  await render(_fixture, "motion:first", [first, later], { anchorMessageId: first.message.id });
  await expect.poll(() => bubble(later.message.id)).not.toBeNull();
  expect(animationsOf(bubble(later.message.id))).toHaveLength(0);
});

it("reveals a streaming answer line by line after a short wait, once, and nothing else", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  const answer = (text: string, streaming: boolean) => reply(2, text, streaming);
  const text = () =>
    _fixture.host!.querySelector<HTMLElement>('[data-message-role="assistant"] .chat-markdown');
  const front = () => Number.parseFloat(text()?.style.getPropertyValue("--reveal-front") || "0");
  await render(
    _fixture,
    "motion:stream",
    [prompt, answer("First paragraph.\n\nSecond paragraph.", true)],
    working,
  );
  await playUntil(() => text()?.classList.contains("streamed-reveal") === true);
  // The first lines wait a moment, so the next paragraphs are in hand.
  await play(800);
  expect(front()).toBe(0);
  // Then the lines appear at a steady pace.
  await playUntil(() => front() > 10, 1000);
  const reached = front();
  // Remounted mid-reveal (a thread switch and back): it continues, no replay.
  await render(_fixture, "motion:elsewhere-stream", [entry(70, "Elsewhere")]);
  await play(64);
  await render(
    _fixture,
    "motion:stream",
    [prompt, answer("First paragraph.\n\nSecond paragraph.", true)],
    working,
  );
  await playUntil(() => text()?.classList.contains("streamed-reveal") === true);
  expect(front()).toBeGreaterThanOrEqual(reached);
  // Once the answer is done, the reveal finishes and the mask goes.
  await render(
    _fixture,
    "motion:stream",
    [prompt, answer("First paragraph.\n\nSecond paragraph.", false)],
    {
      isWorking: false,
      activeTurnInProgress: false,
    },
  );
  await playUntil(() => text()?.classList.contains("streamed-reveal") === false);
  // A finished answer that was never revealed here simply shows.
  await render(_fixture, "motion:finished", [prompt, answer("Already done.", false)], {
    isWorking: false,
    activeTurnInProgress: false,
  });
  await play(64);
  expect(text()?.classList.contains("streamed-reveal")).toBe(false);
});

it("shows what arrived at once when the reader presses Stop, instead of typing it out", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${"Words ".repeat(30)}`);
  const answer = (streaming: boolean) => reply(44, long.join("\n\n"), streaming);
  const text = () =>
    _fixture.host!.querySelector<HTMLElement>('[data-message-role="assistant"] .chat-markdown');
  const front = () => Number.parseFloat(text()?.style.getPropertyValue("--reveal-front") || "0");
  await render(_fixture, "motion:stop", [prompt, answer(true)], working);
  await playUntil(() => text()?.classList.contains("streamed-reveal") === true);
  await playUntil(() => front() > 10, 2000);
  // Well short of the whole answer, then Stop: everything shows on the next frame.
  expect(front()).toBeLessThan(text()!.scrollHeight / 2);
  showStreamedAnswersNow();
  await play(64);
  expect(front()).toBeGreaterThanOrEqual(text()!.scrollHeight);
  // The cut-off answer settles with nothing left to play out.
  await render(_fixture, "motion:stop", [prompt, answer(false)], {
    isWorking: false,
    activeTurnInProgress: false,
  });
  await play(64);
  expect(text()?.classList.contains("streamed-reveal")).toBe(false);
});

it("shows a stopped answer in full when its row comes back, after leaving mid-reveal", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${"Words ".repeat(30)}`);
  const answer = (streaming: boolean) => reply(45, long.join("\n\n"), streaming);
  const text = () =>
    _fixture.host!.querySelector<HTMLElement>('[data-message-role="assistant"] .chat-markdown');
  const front = () => Number.parseFloat(text()?.style.getPropertyValue("--reveal-front") || "0");
  await render(_fixture, "motion:stop-away", [prompt, answer(true)], working);
  await playUntil(() => front() > 10, 2000);
  // The row unmounts mid-reveal (another thread), then the reader presses Stop.
  await render(_fixture, "motion:stop-away-elsewhere", [entry(72, "Elsewhere")]);
  await play(32);
  showStreamedAnswersNow();
  // Back to the stopped answer: everything shows, nothing left to type out.
  await render(_fixture, "motion:stop-away", [prompt, answer(false)], {
    isWorking: false,
    activeTurnInProgress: false,
  });
  await play(64);
  expect(text()?.classList.contains("streamed-reveal")).toBe(false);
});

it("drops an answer's appearing state when its row unmounts mid-reveal", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  const answer = reply(43, "First paragraph.\n\nSecond paragraph.", true);
  await render(_fixture, "motion:appearing", [prompt, answer], working);
  await playUntil(() => streamingTextAppearing(answer.message.id));
  // Another thread: the row unmounts while its lines are still appearing.
  await render(_fixture, "motion:appearing-elsewhere", [entry(71, "Elsewhere")]);
  await play(32);
  expect(streamingTextAppearing(answer.message.id)).toBe(false);
});

it("closes a finished turn's working header gradually, so the answer slides up", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  const answer = (streaming: boolean) => reply(2, "The answer.", streaming);
  await render(_fixture, "motion:exit", [prompt, answer(true)], working);
  const answerTop = () =>
    _fixture.host!.querySelector('[data-message-role="assistant"]')!.getBoundingClientRect().top;
  const header = () => _fixture.host!.querySelector('[data-timeline-row-kind="working"]');
  const exit = () =>
    header()
      ?.querySelector(".border-b")
      ?.getAnimations()
      .find(
        (animation) =>
          !(animation instanceof CSSTransition) && !(animation instanceof CSSAnimation),
      );
  await expect.poll(() => header()).not.toBeNull();
  await frames(8);
  const before = answerTop();
  await render(_fixture, "motion:exit", [prompt, answer(false)], {
    isWorking: false,
    activeTurnInProgress: false,
  });
  // Held halfway through its exit: still in place, the answer part of the way up.
  const animation = exit()!;
  animation.pause();
  animation.currentTime = 160;
  await frames(4);
  expect(header()).not.toBeNull();
  const midway = answerTop();
  expect(midway).toBeLessThan(before - 2);
  // Its end removes it, and the answer rests where it would without it.
  animation.finish();
  await expect.poll(() => header()).toBeNull();
  await frames(6);
  const after = answerTop();
  expect(midway).toBeGreaterThan(after + 2);
  expect(before - after).toBeGreaterThan(20);
});

it("cancels a header's exit when the next run's header takes its place", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  await render(_fixture, "motion:exit-reuse", [prompt, reply(2, "The answer.", true)], working);
  const header = () =>
    _fixture.host!.querySelector<HTMLElement>('[data-timeline-row-kind="working"]');
  const root = () => header()?.querySelector<HTMLElement>(".border-b");
  await expect.poll(() => header()).not.toBeNull();
  await frames(8);
  const height = root()!.getBoundingClientRect().height;
  await render(_fixture, "motion:exit-reuse", [prompt, reply(2, "The answer.", false)], {
    isWorking: false,
    activeTurnInProgress: false,
  });
  const animation = root()!.getAnimations().at(-1)!;
  animation.pause();
  animation.currentTime = 200;
  // Another send starts within the exit: the same row is a running header again.
  const next = entry(3, "Next question");
  await render(
    _fixture,
    "motion:exit-reuse",
    [prompt, reply(2, "The answer.", false), next],
    working,
  );
  await frames(4);
  expect(animation.playState).toBe("idle");
  expect(
    root()!
      .getAnimations()
      .filter((item) => !(item instanceof CSSTransition)),
  ).toHaveLength(0);
  expect(Math.abs(root()!.getBoundingClientRect().height - height)).toBeLessThanOrEqual(1);
  expect(getComputedStyle(root()!).opacity).toBe("1");
});

it("hides Thinking while the answer's lines appear, and brings it back when the agent moves on", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  const answer = reply(41, "First paragraph.\n\nSecond paragraph.", true);
  // The row's own wrapper, inside the work-log block the timeline puts it in.
  const thinking = () =>
    _fixture.host!.querySelector(
      '[data-timeline-row-kind="thinking"] > div > div',
    ) as HTMLElement | null;
  await render(_fixture, "motion:thinking", [prompt, answer], working);
  await playUntil(() => thinking() !== null);
  // During the short wait before any line shows, Thinking still shows the work.
  await play(480);
  expect(thinking()!.classList.contains("opacity-0")).toBe(false);
  // Once the lines appear, it steps aside.
  await playUntil(() => thinking()?.classList.contains("opacity-0") === true, 1000);
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
  await render(_fixture, "motion:thinking", [prompt, answer, tool], working);
  await playUntil(() => {
    const live = _fixture.host!.querySelector('[data-timeline-row-kind="work-live"]');
    const visibleThinking = thinking() && !thinking()!.classList.contains("opacity-0");
    return Boolean(live) || Boolean(visibleThinking);
  });
});

it("keeps a hidden Thinking disclosure out of focus, then restores its group interaction", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  const answer = (streaming: boolean) =>
    reply(42, "First paragraph.\n\nSecond paragraph.", streaming);
  const failedTool = {
    id: "failed-tool-after-text",
    kind: "work" as const,
    createdAt: date,
    entry: {
      id: "failed-tool-after-text",
      createdAt: date,
      runId: RunId.make("run-1"),
      label: "Run command",
      tone: "tool" as const,
      toolLifecycleStatus: "failed" as const,
      detail: "Command failed",
    },
  };
  const disclosure = () =>
    _fixture.host!.querySelector<HTMLButtonElement>('[data-timeline-row-kind="thinking"] button');
  await render(_fixture, "motion:thinking-disclosure", [prompt, answer(true), failedTool], working);
  await playUntil(() => disclosure() !== null);
  await playUntil(() => streamingTextAppearing("message-42"));
  disclosure()!.focus();
  // Chromium refuses focus on the invisible native disclosure; it cannot steal
  // keyboard interaction while the answer is appearing above it.
  expect(document.activeElement).not.toBe(disclosure());
  expect(disclosure()!.getAttribute("aria-expanded")).toBe("false");
  await render(
    _fixture,
    "motion:thinking-disclosure",
    [prompt, answer(false), failedTool],
    working,
  );
  await playUntil(() => !streamingTextAppearing("message-42"));
  disclosure()!.focus();
  expect(document.activeElement).toBe(disclosure());
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => disclosure()?.getAttribute("aria-expanded")).toBe("true");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => disclosure()?.getAttribute("aria-expanded")).toBe("false");
});

it("crosses the blank space between paragraphs without pausing", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const prompt = entry(1, "Question");
  const text = "One line.\n\nTwo line.\n\nThree line.";
  const answer = reply(2, text, true);
  await render(_fixture, "motion:gaps", [prompt, answer], working);
  const root = () =>
    _fixture.host!.querySelector<HTMLElement>('[data-message-role="assistant"] .chat-markdown');
  await playUntil(() => root()?.classList.contains("streamed-reveal") === true);
  const paragraphs = Array.from(root()!.querySelectorAll("p"));
  const top = root()!.getBoundingClientRect().top;
  const gapStart = paragraphs[0]!.getBoundingClientRect().bottom - top;
  const gapEnd = paragraphs[1]!.getBoundingClientRect().top - top;
  const lineHeight = Number.parseFloat(getComputedStyle(root()!).lineHeight);
  const front = () => Number.parseFloat(root()!.style.getPropertyValue("--reveal-front") || "0");
  await playUntil(() => front() >= gapStart);
  const entered = clock;
  await playUntil(() => front() >= gapEnd);
  // In motion time: at the line pace the gap would take (gap / 4 lines a
  // second); it takes far less.
  const crossed = clock - entered;
  const atLinePace = ((gapEnd - gapStart) / lineHeight) * 250;
  expect(crossed).toBeLessThan(Math.max(80, atLinePace / 2));
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
