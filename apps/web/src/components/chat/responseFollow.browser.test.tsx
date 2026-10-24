import {
  fakeTimers,
  act as _fixtureAct,
  render as _fixtureRender,
  type Screen,
} from "../../../test/render";
import { waitForTestReceipt } from "../../../test/receipt";
import { useStableCallback } from "~/hooks/useStableCallback";
import "../../index.css";
import {
  EnvironmentId,
  MessageId,
  RunId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useLayoutEffect, useRef } from "react";

import { expect, it, vi } from "vite-plus/test";
import { MessagesTimeline } from "./MessagesTimeline";
import { motionClock } from "./motionClock";
import { useQueuedDeliveryFollow, useResponseFollow } from "./responseFollow";
import { deriveTimelineWorking } from "./timelineWorkingState";
import { CHAT_TIMELINE_ANCHOR_OFFSET, readTimelinePosition } from "./timelineScrollAnchoring";

/*
 * The send follow as ChatView wires it: the controller (chat/responseFollow.ts)
 * owns the follow and reads V2 runs and messages; the timeline runs it. The
 * harness below calls the controller exactly as ChatView does: a send at the
 * end starts it, Scroll to end and a thread switch clear it, and a queued
 * delivery is decided by the controller itself. Tests feed V2 state only.
 *
 * Motion reads `motionClock`, which these tests drive: every frame advances
 * it by 16ms, so the follow and the answer reveal move by known amounts.
 */

const env = EnvironmentId.make("response-follow-tests");
const date = "2026-10-07T00:00:00.000Z";
const realNow = motionClock.now;

async function _setupFixture0(_fixture: _Fixture) {
  motionClock.now = () => vi.getMockedSystemTime()?.getTime() ?? 0;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  motionClock.now = realNow;
  _fixture.chat.sending.clear();
}
async function play(_fixture: _Fixture, ms: number, eachFrame?: () => void | Promise<void>) {
  if (!eachFrame) {
    await _fixtureAct(() => vi.advanceTimersByTimeAsync(ms));
    return;
  }
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    await _fixtureAct(() => vi.advanceTimersByTimeAsync(Math.min(16, ms - elapsed)));
    await eachFrame();
  }
}
async function playUntil(_fixture: _Fixture, done: () => boolean, ms = 6000) {
  const motionDeadline = motionClock.now() + ms;
  await vi.waitFor(
    async () => {
      if (!done() && motionClock.now() < motionDeadline) {
        await _fixtureAct(() => vi.advanceTimersByTimeAsync(16));
      }
      expect(done()).toBe(true);
    },
    { interval: 0 },
  );
}

/** Legend's receipt needs scheduled work; waitFor drives the owned clock while it is pending. */
async function scroll(operation: () => Promise<void>) {
  let receipt!: Promise<void>;
  await _fixtureAct(() => {
    receipt = operation();
  });
  await vi.waitFor(() => receipt);
}

async function waitForMeasuredRow(_fixture: _Fixture, rowId: string, signal: AbortSignal) {
  const list = _fixture.listRef.current!;
  const measured = Promise.withResolvers<void>();
  const check = () => {
    const state = list.getState();
    const index = state.indexByKey(rowId);
    if (index === undefined) return;
    const element = state.elementAtIndex(index);
    if (element instanceof HTMLElement && state.sizeAtIndex(index) === element.offsetHeight)
      measured.resolve();
  };
  const stopSize = list.getState().listen("totalSize", check);
  const stopPosition = list.getState().listen("lastPositionUpdate", check);
  using _measurement = {
    [Symbol.dispose]() {
      stopSize();
      stopPosition();
    },
  };
  // The reveal changes native layout; fake RAF must not outrun Legend's size delivery.
  check();
  await waitForTestReceipt(signal, measured.promise);
}

type Entry = React.ComponentProps<typeof MessagesTimeline>["timelineEntries"][number];
function message(
  index: number,
  role: "user" | "assistant",
  options: {
    text?: string;
    runId?: string;
    inputIntent?: OrchestrationV2UserMessageInputIntent;
    streaming?: boolean;
  } = {},
): Entry {
  return {
    kind: "message",
    id: `entry-${index}`,
    createdAt: date,
    message: {
      id: MessageId.make(`message-${index}`),
      role,
      text: options.text ?? `Message ${index}\n\n${"Readable paragraph. ".repeat(28)}`,
      runId: RunId.make(options.runId ?? `run-${index}`),
      createdAt: date,
      updatedAt: date,
      streaming: options.streaming ?? false,
      ...(options.inputIntent ? { inputIntent: options.inputIntent } : {}),
    },
  };
}
function tool(index: number, runId: string): Entry {
  return {
    id: `tool-${index}`,
    kind: "work",
    createdAt: date,
    entry: {
      id: `tool-${index}`,
      createdAt: date,
      runId: RunId.make(runId),
      label: `Run command ${index}`,
      tone: "error",
      toolLifecycleStatus: "completed",
      detail: "Command failed",
    },
  };
}
interface Run {
  id: RunId;
  userMessageId: MessageId;
  status: OrchestrationV2RunStatus;
}
const run = (id: string, userMessageId: string, status: OrchestrationV2RunStatus): Run => ({
  id: RunId.make(id),
  userMessageId: MessageId.make(userMessageId),
  status,
});

/** What ChatView does with the controller; the test drives these. */

function Chat({
  fixture: _fixture,
  threadKey,
  entries,
  runs,
}: { fixture: _Fixture } & {
  threadKey: string;
  entries: readonly Entry[];
  runs: readonly Run[];
}) {
  const messages = entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
  const follow = useResponseFollow({ threadKey, runs, messages, loaded: true });
  const { start, followSent, clear } = follow;
  const cancelPositionRestoreRef = useRef<(() => void) | null>(null);
  const cancelPositioning = useStableCallback(() => {
    cancelPositionRestoreRef.current?.();
    clear();
  });
  const atEndRef = useRef(true);
  const readerAtEnd = useStableCallback(() => atEndRef.current);
  const followDelivered = useStableCallback((promptId: MessageId) => {
    clear();
    start(promptId, true);
  });
  useQueuedDeliveryFollow({
    threadKey,
    latestPrompt: messages.findLast((entry) => entry.role === "user") ?? null,
    readerAtEnd,
    follow: followDelivered,
  });
  // A thread switch clears the follow (ChatView's thread reset).
  const shownThread = useRef(threadKey);
  useLayoutEffect(() => {
    if (shownThread.current === threadKey) return;
    shownThread.current = threadKey;
    clear();
  }, [threadKey, clear]);
  useLayoutEffect(() => {
    _fixture.publishChat({
      followPromptId: follow.promptId,
      sendAtEnd: (promptId, options) => {
        _fixture.markSending(promptId);
        if (atEndRef.current) followSent(MessageId.make(promptId), options?.firstMessage ?? false);
      },
      scrollToEnd: async () => {
        cancelPositioning();
        await _fixture.listRef.current?.scrollToEnd({ animated: false });
        _fixture.listRef.current?.getScrollableNode()?.dispatchEvent(new Event("scroll"));
      },
    });
  });
  const running = runs.find((entry) => entry.status === "running" || entry.status === "waiting");
  // ChatView's working state: the V2 phase, or a send still being dispatched
  // (until V2 admits it with a run; the dispatch is then reset).
  const sendBusy = [..._fixture.chat.sending].some(
    (promptId) => !runs.some((entry) => entry.userMessageId === promptId),
  );
  const timelineWorking = deriveTimelineWorking({
    threadWorking: running !== undefined || sendBusy,
    onlySendBusy: sendBusy && running === undefined,
    dispatchBaselineUserMessageId: null,
    projection: { messages, runs },
    optimisticMessages: [],
  });
  return (
    <MessagesTimeline
      emptyPlaceholderInset={0}
      {..._fixture.base}
      routeThreadKey={threadKey}
      timelineEntries={entries}
      isWorking={timelineWorking}
      runningRunId={running?.id ?? null}
      readingFollowPromptId={follow.promptId}
      responseFollow={follow.timeline}
      cancelPositionRestoreRef={cancelPositionRestoreRef}
      onManualNavigation={cancelPositioning}
      onIsAtEndChange={(atEnd) => {
        atEndRef.current = atEnd;
      }}
    />
  );
}

async function render(
  _fixture: _Fixture,
  threadKey: string,
  entries: readonly Entry[],
  runs: readonly Run[] = [],
) {
  if (!_fixture.host) {
    _fixture.host = document.createElement("div");
    Object.assign(_fixture.host.style, { width: "720px", height: "600px" });
    document.body.append(_fixture.host);
    // No routed controls are exercised in this measured viewport fixture.
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
    _fixture.cleanup.use(fakeTimers());
  }
  await _fixtureAct(
    async () =>
      await _fixture.root0!.rerender(
        <Chat fixture={_fixture} threadKey={threadKey} entries={entries} runs={runs} />,
      ),
  );
}

const viewport = (_fixture: _Fixture) => _fixture.listRef.current!.getScrollableNode()!;
const toEnd = (_fixture: _Fixture) => {
  const node = viewport(_fixture);
  return node.scrollHeight - node.clientHeight - node.scrollTop;
};
/** The prompt text's top, from the viewport's top. */
const promptTextTop = (_fixture: _Fixture, promptId: string) => {
  const body = _fixture.host!.querySelector(
    `[data-message-id="${promptId}"] [data-user-message-body="true"]`,
  );
  return body
    ? body.getBoundingClientRect().top - viewport(_fixture).getBoundingClientRect().top
    : Number.NaN;
};
/** An answered history, resting at its end. */
async function answeredThread(_fixture: _Fixture, key: string) {
  const history = Array.from({ length: 10 }, (_, i) =>
    message(i, i % 2 ? "assistant" : "user", { runId: `run-${i - (i % 2)}` }),
  );
  const runs = [0, 2, 4, 6, 8].map((i) => run(`run-${i}`, `message-${i}`, "completed"));
  await render(_fixture, key, history, runs);
  await playUntil(_fixture, () => readTimelinePosition(key)?.atEnd === true);
  await play(_fixture, 64);
  return { history, runs };
}
/** Rows a later prompt's run adds: tool steps. */
const steps = (count: number, runId: string) =>
  Array.from({ length: count }, (_, i) => tool(i, runId));
/** A thread switch away and back, as the reader would do. */
async function visitElsewhere(_fixture: _Fixture, key: string) {
  await render(_fixture, key, [message(500, "user", { text: "Elsewhere" })]);
  await play(_fixture, 96);
}

it("follows a later prompt sent at the end through its run's start, to the prompt at the top", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:send";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  // Sent: the prompt is listed before the server has it; V2 has no run yet.
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(_fixture, key, [...history, prompt], runs);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  // Admitted: its run prepares and starts. Nothing moves, and the follow
  // waits for the run rather than ending, though nothing reports working.
  for (const status of ["preparing", "starting"] as const) {
    await render(
      _fixture,
      key,
      [...history, prompt],
      [...runs, run("run-10", "message-10", status)],
    );
    await play(_fixture, 320);
  }
  expect(_fixture.chat.followPromptId).toBe("message-10");
  // The run runs and its steps arrive: each is followed, staying at the end,
  // until the prompt's text reaches the top margin.
  const start = viewport(_fixture).scrollTop;
  let count = 0;
  while (promptTextTop(_fixture, "message-10") > CHAT_TIMELINE_ANCHOR_OFFSET + 1 && count < 40) {
    count += 1;
    await render(
      _fixture,
      key,
      [...history, prompt, ...steps(count, "run-10")],
      [...runs, run("run-10", "message-10", "running")],
    );
    await playUntil(
      _fixture,
      () =>
        toEnd(_fixture) <= 1 ||
        promptTextTop(_fixture, "message-10") <= CHAT_TIMELINE_ANCHOR_OFFSET + 1,
    );
    expect(promptTextTop(_fixture, "message-10")).toBeGreaterThanOrEqual(
      CHAT_TIMELINE_ANCHOR_OFFSET - 1,
    );
  }
  expect(viewport(_fixture).scrollTop).toBeGreaterThan(start);
  // At the top it stops: later steps go below.
  const stopped = viewport(_fixture).scrollTop;
  await render(
    _fixture,
    key,
    [...history, prompt, ...steps(count + 8, "run-10")],
    [...runs, run("run-10", "message-10", "running")],
  );
  await play(_fixture, 320);
  expect(Math.abs(viewport(_fixture).scrollTop - stopped)).toBeLessThanOrEqual(1);
});

it("ends once the prompt's own run has ended and its answer is shown", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:settle";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await render(_fixture, key, [...history, prompt, ...steps(1, "run-10")], runningRuns);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  expect(readTimelinePosition(key)?.followingPromptId).toBe("message-10");
  const answer = message(11, "assistant", { text: "Done.", runId: "run-10" });
  await render(
    _fixture,
    key,
    [...history, prompt, ...steps(1, "run-10"), answer],
    [...runs, run("run-10", "message-10", "completed")],
  );
  await playUntil(_fixture, () => _fixture.chat.followPromptId === null);
  await play(_fixture, 64);
  expect(readTimelinePosition(key)?.followingPromptId).toBeUndefined();
});

it("follows a queued prompt the server delivers in one update while the reader is at the end", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:queued";
  const { history, runs } = await answeredThread(_fixture, key);
  // The prompt was never seen waiting: its queueing and its delivery arrive
  // in one V2 update, as the delivered (queued_turn) prompt and its run.
  const delivered = message(10, "user", {
    text: "Queued follow-up",
    runId: "run-10",
    inputIntent: "queued_turn",
  });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await render(_fixture, key, [...history, delivered], runningRuns);
  await play(_fixture, 16);
  expect(_fixture.chat.followPromptId).toBe("message-10");
  const start = viewport(_fixture).scrollTop;
  for (let count = 1; count <= 6; count++) {
    await render(_fixture, key, [...history, delivered, ...steps(count, "run-10")], runningRuns);
    await playUntil(
      _fixture,
      () =>
        toEnd(_fixture) <= 1 ||
        promptTextTop(_fixture, "message-10") <= CHAT_TIMELINE_ANCHOR_OFFSET + 1,
    );
  }
  expect(viewport(_fixture).scrollTop).toBeGreaterThan(start);
});

it("follows this window's queued send when its delivery arrives before its receipt", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:receipt-race";
  const { history, runs } = await answeredThread(_fixture, key);
  // Sent at the end: listed and followed; the server queues it.
  const sent = message(10, "user", { text: "Sent while busy", runId: "run-10" });
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(_fixture, key, [...history, sent], runs);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  // The reader scrolls up, which ends that follow, then goes back to the end.
  viewport(_fixture).dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  await play(_fixture, 64);
  expect(_fixture.chat.followPromptId).toBeNull();
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  viewport(_fixture).dispatchEvent(new Event("scroll"));
  await play(_fixture, 64);
  // V2 delivers it (same message id, now a queued_turn) before this window's
  // receipt said it was queued: it is followed as a delivery.
  const delivered = message(10, "user", {
    text: "Sent while busy",
    runId: "run-10",
    inputIntent: "queued_turn",
  });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await render(_fixture, key, [...history, delivered], runningRuns);
  await play(_fixture, 16);
  expect(_fixture.chat.followPromptId).toBe("message-10");
  const start = viewport(_fixture).scrollTop;
  await render(_fixture, key, [...history, delivered, ...steps(4, "run-10")], runningRuns);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  expect(viewport(_fixture).scrollTop).toBeGreaterThan(start);
});

it("leaves a prompt another window sent directly alone, and never saves that as following", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:other-window";
  const { history, runs } = await answeredThread(_fixture, key);
  const direct = message(10, "user", {
    text: "From another window",
    runId: "run-10",
    inputIntent: "turn_start",
  });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await render(_fixture, key, [...history, direct], runningRuns);
  await play(_fixture, 64);
  // Nothing moves for it; the reader scrolls down to it themselves.
  expect(_fixture.chat.followPromptId).toBeNull();
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  viewport(_fixture).dispatchEvent(new Event("scroll"));
  await play(_fixture, 64);
  // Resting at the end of a working thread is not following it.
  expect(readTimelinePosition(key)?.atEnd).toBe(true);
  expect(readTimelinePosition(key)?.followingPromptId).toBeUndefined();
  const resting = viewport(_fixture).scrollTop;
  await render(_fixture, key, [...history, direct, ...steps(8, "run-10")], runningRuns);
  await play(_fixture, 320);
  expect(_fixture.chat.followPromptId).toBeNull();
  expect(Math.abs(viewport(_fixture).scrollTop - resting)).toBeLessThanOrEqual(1);
});

it("keeps a follow cancelled by scrolling up cancelled across a thread switch", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:cancel-sticks";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(_fixture, key, [...history, prompt, ...steps(1, "run-10")], runningRuns);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  // A small upward scroll, still within the end's allowance: it cancels.
  viewport(_fixture).dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
  viewport(_fixture).scrollTop -= 20;
  viewport(_fixture).dispatchEvent(new Event("scroll"));
  await play(_fixture, 64);
  const saved = readTimelinePosition(key)!;
  expect(saved.followingPromptId).toBeUndefined();
  await visitElsewhere(_fixture, "follow:cancel-sticks-elsewhere");
  // Back while the run still works: the saved spot, and no follow.
  await render(_fixture, key, [...history, prompt, ...steps(6, "run-10")], runningRuns);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)?.messageId).toBe(saved.messageId);
  });
  await play(_fixture, 160);
  expect(_fixture.chat.followPromptId).toBeNull();
  expect(toEnd(_fixture)).toBeGreaterThan(40);
});

it("ends only for keys that scroll the timeline, not for a menu's arrow keys or shortcuts", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:keys";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(
    _fixture,
    key,
    [...history, prompt, ...steps(1, "run-10")],
    [...runs, run("run-10", "message-10", "running")],
  );
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  expect(_fixture.chat.followPromptId).toBe("message-10");
  // Arrow keys moving through a menu outside the timeline.
  const menuItem = document.createElement("button");
  menuItem.setAttribute("role", "menuitem");
  document.body.append(menuItem);
  for (const keyName of ["ArrowUp", "Home", "PageUp"]) {
    menuItem.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true }));
  }
  menuItem.remove();
  // Keys scrolling a nested region (tool output) inside the timeline.
  const nested = document.createElement("div");
  Object.assign(nested.style, { height: "60px", overflowY: "auto" });
  nested.tabIndex = 0;
  nested.append(Object.assign(document.createElement("div"), { style: "height: 400px" }));
  viewport(_fixture).append(nested);
  nested.scrollTop = 100;
  nested.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  nested.remove();
  // A shortcut with a modifier, pressed in the timeline.
  viewport(_fixture).dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowUp", metaKey: true, bubbles: true }),
  );
  await play(_fixture, 64);
  expect(_fixture.chat.followPromptId).toBe("message-10");
  // The reader's own scroll key in the timeline still ends it.
  viewport(_fixture).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await playUntil(_fixture, () => _fixture.chat.followPromptId === null);
  expect(_fixture.chat.followPromptId).toBeNull();
});

it("lets Scroll to end cancel a follow resumed after coming back to the thread", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:resumed-cancel";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(_fixture, key, [...history, prompt, ...steps(1, "run-10")], runningRuns);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)?.followingPromptId).toBe("message-10");
  });
  await visitElsewhere(_fixture, "follow:resumed-cancel-elsewhere");
  // Back: the follow is restored for that prompt and carries on.
  await render(_fixture, key, [...history, prompt, ...steps(2, "run-10")], runningRuns);
  await playUntil(_fixture, () => _fixture.chat.followPromptId === "message-10");
  // The reader clicks Scroll to end: a one-shot jump that ends the follow.
  await scroll(() => _fixture.chat.scrollToEnd());
  await play(_fixture, 32);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  expect(_fixture.chat.followPromptId).toBeNull();
  const after = viewport(_fixture).scrollTop;
  await render(_fixture, key, [...history, prompt, ...steps(12, "run-10")], runningRuns);
  await play(_fixture, 320);
  expect(Math.abs(viewport(_fixture).scrollTop - after)).toBeLessThanOrEqual(1);
  expect(toEnd(_fixture)).toBeGreaterThan(40);
});

it("brings a reader who left while following back to where the follow would be now", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:away";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(_fixture, key, [...history, prompt, ...steps(1, "run-10")], runningRuns);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)?.followingPromptId).toBe("message-10");
  });
  await visitElsewhere(_fixture, "follow:away-elsewhere");
  // Meanwhile the agent worked and answered at length.
  const answer = message(40, "assistant", {
    runId: "run-10",
    text: Array.from({ length: 8 }, () => "A long answer paragraph. ".repeat(10)).join("\n\n"),
  });
  await render(_fixture, key, [...history, prompt, ...steps(14, "run-10"), answer], runningRuns);
  const answerTop = () => {
    const element = _fixture.host!.querySelector('[data-message-id="message-40"]');
    return element
      ? element.getBoundingClientRect().top - viewport(_fixture).getBoundingClientRect().top
      : Number.NaN;
  };
  await playUntil(_fixture, () => Math.abs(answerTop() - CHAT_TIMELINE_ANCHOR_OFFSET) <= 2);
  expect(toEnd(_fixture)).toBeGreaterThan(100);
});

it("returns a reader who scrolled well up before leaving a working thread to that spot", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:left-up";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(_fixture, key, [...history, prompt], runningRuns);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  viewport(_fixture).dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
  viewport(_fixture).scrollTop -= 400;
  viewport(_fixture).dispatchEvent(new Event("scroll"));
  await play(_fixture, 96);
  const saved = readTimelinePosition(key)!;
  expect(saved.followingPromptId).toBeUndefined();
  await visitElsewhere(_fixture, "follow:left-up-elsewhere");
  await render(_fixture, key, [...history, prompt, ...steps(6, "run-10")], runningRuns);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)?.messageId).toBe(saved.messageId);
  });
  await play(_fixture, 128);
  expect(toEnd(_fixture)).toBeGreaterThan(200);
});

it("scrolls smoothly with an answer appearing line by line, never ahead of it", async (context) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:paced";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(_fixture, key, [...history, prompt], runningRuns);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  const paragraph =
    "A paragraph that wraps over a few lines, arriving whole as providers stream it. ";
  const answer = (count: number) =>
    message(11, "assistant", {
      runId: "run-10",
      streaming: true,
      text: Array.from({ length: count }, () => paragraph.repeat(3)).join("\n\n"),
    });
  await render(_fixture, key, [...history, prompt, answer(1)], runningRuns);
  await play(_fixture, 32);
  await render(_fixture, key, [...history, prompt, answer(3)], runningRuns);
  const text = () => _fixture.host!.querySelector<HTMLElement>(".streamed-reveal");
  await playUntil(_fixture, () => text() !== null);
  const revealed = () => Number.parseFloat(text()?.style.getPropertyValue("--reveal-front") || "0");
  const positions: number[] = [];
  let aheadOfReveal = 0;
  await play(_fixture, 2600, async () => {
    positions.push(viewport(_fixture).scrollTop);
    const element = text();
    if (!element) return;
    // The reading bottom stays within the end gap (and the row's own spacing)
    // of the lines shown: the view never runs ahead into hidden text.
    const shownBottom = element.getBoundingClientRect().top + revealed();
    const readingBottom =
      viewport(_fixture).getBoundingClientRect().top +
      viewport(_fixture).clientHeight -
      _fixture.base.contentInsetEndAdjustment;
    aheadOfReveal = Math.max(aheadOfReveal, readingBottom - shownBottom - 64);
    await waitForMeasuredRow(_fixture, "entry-11", context.signal);
  });
  const moves = positions.slice(1).map((value, index) => value - positions[index]!);
  expect(positions.at(-1)! - positions[0]!).toBeGreaterThan(40);
  expect(Math.max(...moves)).toBeLessThan(12);
  expect(moves.every((move) => move >= -0.5)).toBe(true);
  expect(aheadOfReveal).toBeLessThanOrEqual(0);
  // It follows all the way: the latest line and the row after it rest above the composer.
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
});

it("yields to the reader scrolling down mid-follow, then carries on from where they stop", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:yield";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(_fixture, key, [...history, prompt], runningRuns);
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  const answer = message(13, "assistant", {
    runId: "run-10",
    streaming: true,
    text: Array.from({ length: 6 }, () => "A paragraph that wraps. ".repeat(12)).join("\n\n"),
  });
  await render(_fixture, key, [...history, prompt, answer], runningRuns);
  await play(_fixture, 1300);
  // Count the follow's own writes to the scroll position: a write cancels the
  // browser's smooth scroll of the reader's wheel in motion.
  const node = viewport(_fixture);
  const setter = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!.set!;
  const getter = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!.get!;
  let readerWriting = false;
  let followWrites = 0;
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => getter.call(node),
    set: (value: number) => {
      if (!readerWriting) followWrites += 1;
      setter.call(node, value);
    },
  });
  // The reader scrolls down themselves, the browser moving it a little each frame.
  for (let elapsed = 0; elapsed < 400; elapsed += 16) {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
    readerWriting = true;
    node.scrollTop = Math.min(node.scrollTop + 6, node.scrollHeight - node.clientHeight);
    readerWriting = false;
    await play(_fixture, 16);
  }
  expect(followWrites).toBe(0);
  delete (node as { scrollTop?: number }).scrollTop;
  // Once they stop, the follow carries on to where it rests: this answer is
  // taller than the reading area, so the prompt's text at the top margin.
  expect(promptTextTop(_fixture, "message-10")).toBeGreaterThan(CHAT_TIMELINE_ANCHOR_OFFSET + 1);
  await playUntil(
    _fixture,
    () => promptTextTop(_fixture, "message-10") <= CHAT_TIMELINE_ANCHOR_OFFSET + 1,
  );
  await play(_fixture, 192);
  expect(promptTextTop(_fixture, "message-10")).toBeGreaterThanOrEqual(
    CHAT_TIMELINE_ANCHOR_OFFSET - 1,
  );
  expect(toEnd(_fixture)).toBeGreaterThan(1);
});

it("rests between changes: no frames while the run works and nothing changes", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:idle";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  const answer = message(11, "assistant", {
    runId: "run-10",
    streaming: true,
    text: "A short streaming answer.",
  });
  await render(_fixture, key, [...history, prompt, ...steps(2, "run-10"), answer], runningRuns);
  // The answer appears and the follow catches up; then the provider pauses.
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  await play(_fixture, 2000);
  const motionFrames = vi.fn();
  const requestFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    const stack = new Error().stack ?? "";
    if (/useBoundedAnswerFollow|useStreamingBlockEntrance/.test(stack)) motionFrames();
    return requestFrame.call(window, callback);
  };
  try {
    await play(_fixture, 480);
    expect(motionFrames).not.toHaveBeenCalled();
    // More text arrives: the reveal wakes and shows it, and the follow keeps up.
    const longer = message(11, "assistant", {
      runId: "run-10",
      streaming: true,
      text: `A short streaming answer.\n\n${"More text that arrives later. ".repeat(12)}`,
    });
    await render(_fixture, key, [...history, prompt, ...steps(2, "run-10"), longer], runningRuns);
    await play(_fixture, 64);
    expect(motionFrames).toHaveBeenCalled();
  } finally {
    window.requestAnimationFrame = requestFrame;
  }
});

it("follows a queued prompt promoted to a steer through the run it went into", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:promoted";
  const { history, runs } = await answeredThread(_fixture, key);
  // Run 10 works on prompt 10; prompt 11 waits in the queue as its own run.
  const prompt = message(10, "user", { text: "Working prompt", runId: "run-10" });
  const working = [...runs, run("run-10", "message-10", "running")];
  await render(
    _fixture,
    key,
    [...history, prompt, ...steps(1, "run-10")],
    [...working, run("run-11", "message-11", "queued")],
  );
  // scrollToEnd targets the current layout; freshly mounted rows are still
  // estimated here, so wait until they are natively measured and the content
  // height has settled before aiming at the end.
  let settledHeight = -1;
  await playUntil(_fixture, () => {
    const state = _fixture.listRef.current!.getState();
    const lastRow = state.elementAtIndex(state.data.length - 1);
    const height = viewport(_fixture).scrollHeight;
    const settled = settledHeight === height;
    settledHeight = height;
    return !!lastRow && lastRow.getBoundingClientRect().height > 0 && settled;
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  viewport(_fixture).dispatchEvent(new Event("scroll"));
  await play(_fixture, 96);
  await vi.waitFor(() => {
    const state = _fixture.listRef.current!.getState();
    expect(
      readTimelinePosition(key)?.atEnd,
      JSON.stringify({
        remaining: toEnd(_fixture),
        position: readTimelinePosition(key),
        native: {
          top: viewport(_fixture).scrollTop,
          height: viewport(_fixture).scrollHeight,
        },
        model: { scroll: state.scroll, height: state.contentLength },
      }),
    ).toBe(true);
    expect(toEnd(_fixture)).toBeLessThanOrEqual(1);
  });
  // Promoted to a steer: its queued run is cancelled, and it is delivered into run 10.
  const promoted = message(11, "user", {
    text: "Promoted to steer",
    runId: "run-10",
    inputIntent: "promoted_queued_to_steer",
  });
  const promotedRuns = [...working, run("run-11", "message-11", "cancelled")];
  const rows = (count: number) => [
    ...history,
    prompt,
    ...steps(1, "run-10"),
    promoted,
    ...steps(count, "run-10").map((row) => ({ ...row, id: `after-${row.id}` })),
  ];
  await render(_fixture, key, rows(0), promotedRuns);
  await play(_fixture, 16);
  expect(_fixture.chat.followPromptId).toBe("message-11");
  // At rest, a change that wakes the follow without anything to reveal (the
  // window grows a little): a follow judged settled would end here.
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  await play(_fixture, 160);
  _fixture.host!.style.height = "640px";
  await play(_fixture, 96);
  expect(_fixture.chat.followPromptId).toBe("message-11");
  // Run 10 keeps working on it: its steps are followed, not settled away.
  const start = viewport(_fixture).scrollTop;
  for (let count = 1; count <= 4; count++) {
    await render(_fixture, key, rows(count), promotedRuns);
    await playUntil(
      _fixture,
      () =>
        toEnd(_fixture) <= 1 ||
        promptTextTop(_fixture, "message-11") <= CHAT_TIMELINE_ANCHOR_OFFSET + 1,
    );
  }
  expect(_fixture.chat.followPromptId).toBe("message-11");
  expect(viewport(_fixture).scrollTop).toBeGreaterThan(start);
  // Run 10 ends: the follow ends with it.
  const answer = message(12, "assistant", { text: "Done.", runId: "run-10" });
  await render(
    _fixture,
    key,
    [...rows(4), answer],
    [...runs, run("run-10", "message-10", "completed"), run("run-11", "message-11", "cancelled")],
  );
  await playUntil(_fixture, () => _fixture.chat.followPromptId === null);
});

/** A followed prompt left behind, and a later prompt another window sent while the reader was away. */
async function leaveThenReturnPastAnotherPrompt(
  _fixture: _Fixture,
  key: string,
  followedRun: OrchestrationV2RunStatus,
) {
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Followed prompt", runId: "run-10" });
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
  await render(
    _fixture,
    key,
    [...history, prompt, ...steps(1, "run-10")],
    [...runs, run("run-10", "message-10", "running")],
  );
  await playUntil(_fixture, () => toEnd(_fixture) <= 1);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)?.followingPromptId).toBe("message-10");
  });
  await visitElsewhere(_fixture, `${key}-elsewhere`);
  const answer = message(11, "assistant", { text: "A short answer.", runId: "run-10" });
  const later =
    followedRun === "running"
      ? message(30, "user", {
          text: "A steer from elsewhere",
          runId: "run-10",
          inputIntent: "steer",
        })
      : message(30, "user", {
          text: "Elsewhere's prompt",
          runId: "run-30",
          inputIntent: "turn_start",
        });
  const laterRun = followedRun === "running" ? "run-10" : "run-30";
  const laterAnswer = message(31, "assistant", {
    runId: laterRun,
    text: Array.from({ length: 8 }, () => "A long later answer. ".repeat(10)).join("\n\n"),
  });
  const returnedRuns = [
    ...runs,
    run("run-10", "message-10", followedRun),
    ...(followedRun === "running" ? [] : [run("run-30", "message-30", "running")]),
  ];
  await render(
    _fixture,
    key,
    [
      ...history,
      prompt,
      ...steps(3, "run-10"),
      answer,
      later,
      ...steps(4, laterRun).map((row) => ({ ...row, id: `later-${row.id}` })),
      laterAnswer,
    ],
    returnedRuns,
  );
}
const answerBottom = (_fixture: _Fixture, messageId: string) => {
  const element = _fixture.host!.querySelector(`[data-message-id="${messageId}"]`);
  return element
    ? element.getBoundingClientRect().bottom - viewport(_fixture).getBoundingClientRect().top
    : Number.NaN;
};
const readingBottom = (_fixture: _Fixture) =>
  viewport(_fixture).clientHeight - _fixture.base.contentInsetEndAdjustment;

it("brings a reader back to the prompt they followed, not past it to a later one", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:return-identity";
  await leaveThenReturnPastAnotherPrompt(_fixture, key, "running");
  // Back at the followed prompt's response: its end rests above the composer,
  // and the later prompt (and its long answer) stays below.
  await playUntil(
    _fixture,
    () => Math.abs(answerBottom(_fixture, "message-11") - (readingBottom(_fixture) - 16)) <= 2,
  );
  expect(promptTextTop(_fixture, "message-10")).toBeGreaterThanOrEqual(
    CHAT_TIMELINE_ANCHOR_OFFSET - 1,
  );
  expect(promptTextTop(_fixture, "message-30")).toBeGreaterThan(readingBottom(_fixture) - 40);
  // Its run still works, so its follow carries on, for that prompt.
  await playUntil(_fixture, () => _fixture.chat.followPromptId === "message-10");
  const resting = viewport(_fixture).scrollTop;
  await play(_fixture, 320);
  expect(Math.abs(viewport(_fixture).scrollTop - resting)).toBeLessThanOrEqual(1);
});

it("brings a reader back to the prompt they followed when it finished while they were away", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:return-finished";
  await leaveThenReturnPastAnotherPrompt(_fixture, key, "completed");
  await playUntil(
    _fixture,
    () => Math.abs(answerBottom(_fixture, "message-11") - (readingBottom(_fixture) - 16)) <= 2,
  );
  expect(promptTextTop(_fixture, "message-10")).toBeGreaterThanOrEqual(
    CHAT_TIMELINE_ANCHOR_OFFSET - 1,
  );
  expect(promptTextTop(_fixture, "message-30")).toBeGreaterThan(readingBottom(_fixture) - 40);
  // Finished: nothing to carry on with.
  await play(_fixture, 320);
  expect(_fixture.chat.followPromptId).toBeNull();
});

it("keeps the reveal of a first prompt as it was: traces do not move it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const key = "follow:first";
  const { history, runs } = await answeredThread(_fixture, key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const working = [...runs, run("run-10", "message-10", "running")];
  // Sent as a thread's first prompt (ChatView's first-message path).
  await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10", { firstMessage: true }));
  await render(_fixture, key, [...history, prompt], working);
  await play(_fixture, 160);
  expect(_fixture.chat.followPromptId).toBe("message-10");
  for (let count = 1; count <= 8; count++) {
    await render(_fixture, key, [...history, prompt, ...steps(count, "run-10")], working);
    await play(_fixture, 96);
  }
  // Without whole-response following, the traces are left below the view.
  expect(toEnd(_fixture)).toBeGreaterThan(100);
});

it.each(["running", "completed"] as const)(
  "brings a reader back to the prompt they followed across rows never rendered (%s)",
  async (followed) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const key = `follow:return-virtualized-${followed}`;
    const { history, runs } = await answeredThread(_fixture, key);
    const prompt = message(10, "user", { text: "Followed prompt", runId: "run-10" });
    await _fixtureAct(() => _fixture.chat.sendAtEnd("message-10"));
    await render(
      _fixture,
      key,
      [...history, prompt, ...steps(1, "run-10")],
      [...runs, run("run-10", "message-10", "running")],
    );
    await playUntil(_fixture, () => toEnd(_fixture) <= 1);
    await vi.waitFor(() => {
      expect(readTimelinePosition(key)?.followingPromptId).toBe("message-10");
    });
    await visitElsewhere(_fixture, `${key}-elsewhere`);
    // While away: many steps and an answer for the followed prompt, then a
    // later prompt from elsewhere with many more rows. On return, the followed
    // response's end has never been rendered.
    const answer = message(11, "assistant", {
      text: "The followed response. ".repeat(20),
      runId: "run-10",
    });
    const laterRun = followed === "running" ? "run-10" : "run-30";
    const later = message(30, "user", {
      text: "Later prompt",
      runId: laterRun,
      inputIntent: followed === "running" ? "steer" : "turn_start",
    });
    await render(
      _fixture,
      key,
      [
        ...history,
        prompt,
        ...steps(20, "run-10"),
        answer,
        later,
        ...steps(40, laterRun).map((row) => ({ ...row, id: `later-${row.id}` })),
        message(31, "assistant", { text: "Latest answer", runId: laterRun }),
      ],
      [
        ...runs,
        run("run-10", "message-10", followed),
        ...(followed === "completed" ? [run("run-30", "message-30", "running")] : []),
      ],
    );
    // Back at the followed response's end: its answer shows, resting above
    // the composer, and the later prompt stays below the view.
    await playUntil(_fixture, () => {
      const bottom = answerBottom(_fixture, "message-11");
      return Number.isFinite(bottom) && Math.abs(bottom - (readingBottom(_fixture) - 16)) <= 2;
    });
    await play(_fixture, 160);
    expect(
      Math.abs(answerBottom(_fixture, "message-11") - (readingBottom(_fixture) - 16)),
    ).toBeLessThanOrEqual(2);
    expect(toEnd(_fixture)).toBeGreaterThan(400);
    // The later prompt starts at the composer's edge, at most its first line showing.
    expect(
      Number.isNaN(promptTextTop(_fixture, "message-30")) ||
        promptTextTop(_fixture, "message-30") > readingBottom(_fixture) - 40,
    ).toBe(true);
    if (followed === "running")
      await playUntil(_fixture, () => _fixture.chat.followPromptId === "message-10");
    else expect(_fixture.chat.followPromptId).toBeNull();
  },
);

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const listRef = createRef<LegendListRef>();
  let clock = 0;
  const base = {
    listRef,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    latestRun: null,
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
    onManualNavigation: () => {},
  };
  const chat: {
    /** A later prompt sent from this window (ChatView's frameSubmittedMessage). */
    sendAtEnd: (promptId: string, options?: { firstMessage?: boolean }) => void;
    /** Prompts sent from this window whose send is still being dispatched (no V2 run yet). */
    sending: Set<string>;
    /** The Scroll to end control (ChatView's scrollToEnd → cancelTimelinePositioning). */
    scrollToEnd: () => Promise<void>;
    followPromptId: string | null;
  } = {
    sendAtEnd: () => {},
    sending: new Set(),
    scrollToEnd: async () => {},
    followPromptId: null,
  };
  return {
    listRef,
    clock,
    base,
    chat,
    publishChat: (next: Omit<typeof chat, "sending">) => {
      Object.assign(chat, next);
    },
    markSending: (promptId: string) => {
      chat.sending.add(promptId);
    },
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
