import "../../index.css";
import {
  EnvironmentId,
  MessageId,
  RunId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useCallback, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MessagesTimeline } from "./MessagesTimeline";
import { motionClock } from "./motionClock";
import { useQueuedDeliveryFollow, useResponseFollow } from "./responseFollow";
import { useTimelineWorking } from "./timelineWorkingState";
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

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("response-follow-tests");
const date = "2026-10-07T00:00:00.000Z";
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
  chat.sending.clear();
});
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** Plays `ms` of motion, a 16ms frame at a time. */
async function play(ms: number, eachFrame?: () => void) {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    clock += 16;
    await frame();
    eachFrame?.();
  }
}
/** Plays frames until `done` holds (at most `ms` of motion). */
async function playUntil(done: () => boolean, ms = 6000) {
  for (let elapsed = 0; elapsed < ms && !done(); elapsed += 16) {
    clock += 16;
    await frame();
  }
  expect(done()).toBe(true);
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

/** What ChatView does with the controller; the test drives these. */
const chat: {
  /** A later prompt sent from this window (ChatView's frameSubmittedMessage). */
  sendAtEnd: (promptId: string, options?: { firstMessage?: boolean }) => void;
  /** Prompts sent from this window whose send is still being dispatched (no V2 run yet). */
  sending: Set<string>;
  /** The Scroll to end control (ChatView's scrollToEnd → cancelTimelinePositioning). */
  scrollToEnd: () => void;
  followPromptId: string | null;
} = { sendAtEnd: () => {}, sending: new Set(), scrollToEnd: () => {}, followPromptId: null };

function Chat({
  threadKey,
  entries,
  runs,
}: {
  threadKey: string;
  entries: readonly Entry[];
  runs: readonly Run[];
}) {
  const messages = entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
  const follow = useResponseFollow({ threadKey, runs, messages, loaded: true });
  const { start, followSent, clear } = follow;
  const atEndRef = useRef(true);
  const readerAtEnd = useCallback(() => atEndRef.current, []);
  const followDelivered = useCallback(
    (promptId: MessageId) => {
      clear();
      start(promptId, true);
    },
    [clear, start],
  );
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
    chat.followPromptId = follow.promptId;
    chat.sendAtEnd = (promptId, options) => {
      chat.sending.add(promptId);
      if (atEndRef.current)
        flushSync(() => followSent(MessageId.make(promptId), options?.firstMessage ?? false));
    };
    chat.scrollToEnd = () => {
      flushSync(() => clear());
      void listRef.current?.scrollToEnd({ animated: false });
    };
  });
  const running = runs.find((entry) => entry.status === "running" || entry.status === "waiting");
  // ChatView's working state: the V2 phase, or a send still being dispatched
  // (until V2 admits it with a run; the dispatch is then reset).
  const sendBusy = [...chat.sending].some(
    (promptId) => !runs.some((entry) => entry.userMessageId === promptId),
  );
  const timelineWorking = useTimelineWorking({
    threadWorking: running !== undefined || sendBusy,
    onlySendBusy: sendBusy && running === undefined,
    dispatchBaselineUserMessageId: null,
    projection: { messages, runs },
    optimisticMessages: [],
  });
  return (
    <MessagesTimeline
      {...base}
      routeThreadKey={threadKey}
      timelineEntries={entries}
      isWorking={timelineWorking}
      runningRunId={running?.id ?? null}
      readingFollowPromptId={follow.promptId}
      responseFollow={follow.timeline}
      onIsAtEndChange={(atEnd) => {
        atEndRef.current = atEnd;
      }}
    />
  );
}

function render(threadKey: string, entries: readonly Entry[], runs: readonly Run[] = []) {
  if (!host) {
    host = document.createElement("div");
    Object.assign(host.style, { width: "720px", height: "600px" });
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() => root!.render(<Chat threadKey={threadKey} entries={entries} runs={runs} />));
}

const viewport = () => listRef.current!.getScrollableNode()!;
const toEnd = () => {
  const node = viewport();
  return node.scrollHeight - node.clientHeight - node.scrollTop;
};
/** The prompt text's top, from the viewport's top. */
const promptTextTop = (promptId: string) => {
  const body = host!.querySelector(
    `[data-message-id="${promptId}"] [data-user-message-body="true"]`,
  );
  return body
    ? body.getBoundingClientRect().top - viewport().getBoundingClientRect().top
    : Number.NaN;
};
/** An answered history, resting at its end. */
async function answeredThread(key: string) {
  const history = Array.from({ length: 10 }, (_, i) =>
    message(i, i % 2 ? "assistant" : "user", { runId: `run-${i - (i % 2)}` }),
  );
  const runs = [0, 2, 4, 6, 8].map((i) => run(`run-${i}`, `message-${i}`, "completed"));
  render(key, history, runs);
  await expect.poll(() => readTimelinePosition(key)?.atEnd).toBe(true);
  await play(64);
  return { history, runs };
}
/** Rows a later prompt's run adds: tool steps. */
const steps = (count: number, runId: string) =>
  Array.from({ length: count }, (_, i) => tool(i, runId));
/** A thread switch away and back, as the reader would do. */
async function visitElsewhere(key: string) {
  render(key, [message(500, "user", { text: "Elsewhere" })]);
  await play(96);
}

it("follows a later prompt sent at the end through its run's start, to the prompt at the top", async () => {
  const key = "follow:send";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  // Sent: the prompt is listed before the server has it; V2 has no run yet.
  chat.sendAtEnd("message-10");
  render(key, [...history, prompt], runs);
  await playUntil(() => toEnd() <= 1);
  // Admitted: its run prepares and starts. Nothing moves, and the follow
  // waits for the run rather than ending, though nothing reports working.
  for (const status of ["preparing", "starting"] as const) {
    render(key, [...history, prompt], [...runs, run("run-10", "message-10", status)]);
    await play(320);
  }
  expect(chat.followPromptId).toBe("message-10");
  // The run runs and its steps arrive: each is followed, staying at the end,
  // until the prompt's text reaches the top margin.
  const start = viewport().scrollTop;
  let count = 0;
  while (promptTextTop("message-10") > CHAT_TIMELINE_ANCHOR_OFFSET + 1 && count < 40) {
    count += 1;
    render(
      key,
      [...history, prompt, ...steps(count, "run-10")],
      [...runs, run("run-10", "message-10", "running")],
    );
    await playUntil(
      () => toEnd() <= 1 || promptTextTop("message-10") <= CHAT_TIMELINE_ANCHOR_OFFSET + 1,
    );
    expect(promptTextTop("message-10")).toBeGreaterThanOrEqual(CHAT_TIMELINE_ANCHOR_OFFSET - 1);
  }
  expect(viewport().scrollTop).toBeGreaterThan(start);
  // At the top it stops: later steps go below.
  const stopped = viewport().scrollTop;
  render(
    key,
    [...history, prompt, ...steps(count + 8, "run-10")],
    [...runs, run("run-10", "message-10", "running")],
  );
  await play(320);
  expect(Math.abs(viewport().scrollTop - stopped)).toBeLessThanOrEqual(1);
});

it("ends once the prompt's own run has ended and its answer is shown", async () => {
  const key = "follow:settle";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  chat.sendAtEnd("message-10");
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  render(key, [...history, prompt, ...steps(1, "run-10")], runningRuns);
  await playUntil(() => toEnd() <= 1);
  expect(readTimelinePosition(key)?.followingPromptId).toBe("message-10");
  const answer = message(11, "assistant", { text: "Done.", runId: "run-10" });
  render(
    key,
    [...history, prompt, ...steps(1, "run-10"), answer],
    [...runs, run("run-10", "message-10", "completed")],
  );
  await playUntil(() => chat.followPromptId === null);
  await play(64);
  expect(readTimelinePosition(key)?.followingPromptId).toBeUndefined();
});

it("follows a queued prompt the server delivers in one update while the reader is at the end", async () => {
  const key = "follow:queued";
  const { history, runs } = await answeredThread(key);
  // The prompt was never seen waiting: its queueing and its delivery arrive
  // in one V2 update, as the delivered (queued_turn) prompt and its run.
  const delivered = message(10, "user", {
    text: "Queued follow-up",
    runId: "run-10",
    inputIntent: "queued_turn",
  });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  render(key, [...history, delivered], runningRuns);
  await play(16);
  expect(chat.followPromptId).toBe("message-10");
  const start = viewport().scrollTop;
  for (let count = 1; count <= 6; count++) {
    render(key, [...history, delivered, ...steps(count, "run-10")], runningRuns);
    await playUntil(
      () => toEnd() <= 1 || promptTextTop("message-10") <= CHAT_TIMELINE_ANCHOR_OFFSET + 1,
    );
  }
  expect(viewport().scrollTop).toBeGreaterThan(start);
});

it("follows this window's queued send when its delivery arrives before its receipt", async () => {
  const key = "follow:receipt-race";
  const { history, runs } = await answeredThread(key);
  // Sent at the end: listed and followed; the server queues it.
  const sent = message(10, "user", { text: "Sent while busy", runId: "run-10" });
  chat.sendAtEnd("message-10");
  render(key, [...history, sent], runs);
  await playUntil(() => toEnd() <= 1);
  // The reader scrolls up, which ends that follow, then goes back to the end.
  viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  await play(64);
  expect(chat.followPromptId).toBeNull();
  await listRef.current!.scrollToEnd({ animated: false });
  viewport().dispatchEvent(new Event("scroll"));
  await play(64);
  // V2 delivers it (same message id, now a queued_turn) before this window's
  // receipt said it was queued: it is followed as a delivery.
  const delivered = message(10, "user", {
    text: "Sent while busy",
    runId: "run-10",
    inputIntent: "queued_turn",
  });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  render(key, [...history, delivered], runningRuns);
  await play(16);
  expect(chat.followPromptId).toBe("message-10");
  const start = viewport().scrollTop;
  render(key, [...history, delivered, ...steps(4, "run-10")], runningRuns);
  await playUntil(() => toEnd() <= 1);
  expect(viewport().scrollTop).toBeGreaterThan(start);
});

it("leaves a prompt another window sent directly alone, and never saves that as following", async () => {
  const key = "follow:other-window";
  const { history, runs } = await answeredThread(key);
  const direct = message(10, "user", {
    text: "From another window",
    runId: "run-10",
    inputIntent: "turn_start",
  });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  render(key, [...history, direct], runningRuns);
  await play(64);
  // Nothing moves for it; the reader scrolls down to it themselves.
  expect(chat.followPromptId).toBeNull();
  await listRef.current!.scrollToEnd({ animated: false });
  viewport().dispatchEvent(new Event("scroll"));
  await play(64);
  // Resting at the end of a working thread is not following it.
  expect(readTimelinePosition(key)?.atEnd).toBe(true);
  expect(readTimelinePosition(key)?.followingPromptId).toBeUndefined();
  const resting = viewport().scrollTop;
  render(key, [...history, direct, ...steps(8, "run-10")], runningRuns);
  await play(320);
  expect(chat.followPromptId).toBeNull();
  expect(Math.abs(viewport().scrollTop - resting)).toBeLessThanOrEqual(1);
});

it("keeps a follow cancelled by scrolling up cancelled across a thread switch", async () => {
  const key = "follow:cancel-sticks";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  chat.sendAtEnd("message-10");
  render(key, [...history, prompt, ...steps(1, "run-10")], runningRuns);
  await playUntil(() => toEnd() <= 1);
  // A small upward scroll, still within the end's allowance: it cancels.
  viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
  viewport().scrollTop -= 20;
  viewport().dispatchEvent(new Event("scroll"));
  await play(64);
  const saved = readTimelinePosition(key)!;
  expect(saved.followingPromptId).toBeUndefined();
  await visitElsewhere("follow:cancel-sticks-elsewhere");
  // Back while the run still works: the saved spot, and no follow.
  render(key, [...history, prompt, ...steps(6, "run-10")], runningRuns);
  await expect.poll(() => readTimelinePosition(key)?.messageId).toBe(saved.messageId);
  await play(160);
  expect(chat.followPromptId).toBeNull();
  expect(toEnd()).toBeGreaterThan(40);
});

it("lets Scroll to end cancel a follow resumed after coming back to the thread", async () => {
  const key = "follow:resumed-cancel";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  chat.sendAtEnd("message-10");
  render(key, [...history, prompt, ...steps(1, "run-10")], runningRuns);
  await playUntil(() => toEnd() <= 1);
  await expect.poll(() => readTimelinePosition(key)?.followingPromptId).toBe("message-10");
  await visitElsewhere("follow:resumed-cancel-elsewhere");
  // Back: the follow is restored for that prompt and carries on.
  render(key, [...history, prompt, ...steps(2, "run-10")], runningRuns);
  await playUntil(() => chat.followPromptId === "message-10");
  // The reader clicks Scroll to end: a one-shot jump that ends the follow.
  chat.scrollToEnd();
  await playUntil(() => toEnd() <= 1);
  expect(chat.followPromptId).toBeNull();
  const after = viewport().scrollTop;
  render(key, [...history, prompt, ...steps(12, "run-10")], runningRuns);
  await play(320);
  expect(Math.abs(viewport().scrollTop - after)).toBeLessThanOrEqual(1);
  expect(toEnd()).toBeGreaterThan(40);
});

it("brings a reader who left while following back to where the follow would be now", async () => {
  const key = "follow:away";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  chat.sendAtEnd("message-10");
  render(key, [...history, prompt, ...steps(1, "run-10")], runningRuns);
  await playUntil(() => toEnd() <= 1);
  await expect.poll(() => readTimelinePosition(key)?.followingPromptId).toBe("message-10");
  await visitElsewhere("follow:away-elsewhere");
  // Meanwhile the agent worked and answered at length.
  const answer = message(40, "assistant", {
    runId: "run-10",
    text: Array.from({ length: 8 }, () => "A long answer paragraph. ".repeat(10)).join("\n\n"),
  });
  render(key, [...history, prompt, ...steps(14, "run-10"), answer], runningRuns);
  const answerTop = () => {
    const element = host!.querySelector('[data-message-id="message-40"]');
    return element
      ? element.getBoundingClientRect().top - viewport().getBoundingClientRect().top
      : Number.NaN;
  };
  await playUntil(() => Math.abs(answerTop() - CHAT_TIMELINE_ANCHOR_OFFSET) <= 2);
  expect(toEnd()).toBeGreaterThan(100);
});

it("returns a reader who scrolled well up before leaving a working thread to that spot", async () => {
  const key = "follow:left-up";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  chat.sendAtEnd("message-10");
  render(key, [...history, prompt], runningRuns);
  await playUntil(() => toEnd() <= 1);
  viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
  viewport().scrollTop -= 400;
  viewport().dispatchEvent(new Event("scroll"));
  await play(96);
  const saved = readTimelinePosition(key)!;
  expect(saved.followingPromptId).toBeUndefined();
  await visitElsewhere("follow:left-up-elsewhere");
  render(key, [...history, prompt, ...steps(6, "run-10")], runningRuns);
  await expect.poll(() => readTimelinePosition(key)?.messageId).toBe(saved.messageId);
  await play(128);
  expect(toEnd()).toBeGreaterThan(200);
});

it("scrolls smoothly with an answer appearing line by line, never ahead of it", async () => {
  const key = "follow:paced";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  chat.sendAtEnd("message-10");
  render(key, [...history, prompt], runningRuns);
  await playUntil(() => toEnd() <= 1);
  const paragraph =
    "A paragraph that wraps over a few lines, arriving whole as providers stream it. ";
  const answer = (count: number) =>
    message(11, "assistant", {
      runId: "run-10",
      streaming: true,
      text: Array.from({ length: count }, () => paragraph.repeat(3)).join("\n\n"),
    });
  render(key, [...history, prompt, answer(1)], runningRuns);
  await play(32);
  render(key, [...history, prompt, answer(3)], runningRuns);
  const text = () => host!.querySelector<HTMLElement>(".streamed-reveal");
  await playUntil(() => text() !== null);
  const revealed = () => Number.parseFloat(text()?.style.getPropertyValue("--reveal-front") || "0");
  const positions: number[] = [];
  let aheadOfReveal = 0;
  await play(2600, () => {
    positions.push(viewport().scrollTop);
    const element = text();
    if (!element) return;
    // The reading bottom stays within the end gap (and the row's own spacing)
    // of the lines shown: the view never runs ahead into hidden text.
    const shownBottom = element.getBoundingClientRect().top + revealed();
    const readingBottom =
      viewport().getBoundingClientRect().top +
      viewport().clientHeight -
      base.contentInsetEndAdjustment;
    aheadOfReveal = Math.max(aheadOfReveal, readingBottom - shownBottom - 64);
  });
  const moves = positions.slice(1).map((value, index) => value - positions[index]!);
  expect(positions.at(-1)! - positions[0]!).toBeGreaterThan(40);
  expect(Math.max(...moves)).toBeLessThan(12);
  expect(moves.every((move) => move >= -0.5)).toBe(true);
  expect(aheadOfReveal).toBeLessThanOrEqual(0);
  // It follows all the way: the latest line and the row after it rest above the composer.
  await playUntil(() => toEnd() <= 1);
});

it("yields to the reader scrolling down mid-follow, then carries on from where they stop", async () => {
  const key = "follow:yield";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  chat.sendAtEnd("message-10");
  render(key, [...history, prompt], runningRuns);
  await playUntil(() => toEnd() <= 1);
  const answer = message(13, "assistant", {
    runId: "run-10",
    streaming: true,
    text: Array.from({ length: 6 }, () => "A paragraph that wraps. ".repeat(12)).join("\n\n"),
  });
  render(key, [...history, prompt, answer], runningRuns);
  await play(1300);
  // Count the follow's own writes to the scroll position: a write cancels the
  // browser's smooth scroll of the reader's wheel in motion.
  const node = viewport();
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
    await play(16);
  }
  expect(followWrites).toBe(0);
  delete (node as { scrollTop?: number }).scrollTop;
  // Once they stop, the follow carries on to where it rests: this answer is
  // taller than the reading area, so the prompt's text at the top margin.
  expect(promptTextTop("message-10")).toBeGreaterThan(CHAT_TIMELINE_ANCHOR_OFFSET + 1);
  await playUntil(() => promptTextTop("message-10") <= CHAT_TIMELINE_ANCHOR_OFFSET + 1);
  await play(192);
  expect(promptTextTop("message-10")).toBeGreaterThanOrEqual(CHAT_TIMELINE_ANCHOR_OFFSET - 1);
  expect(toEnd()).toBeGreaterThan(1);
});

it("rests between changes: no frames while the run works and nothing changes", async () => {
  const key = "follow:idle";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const runningRuns = [...runs, run("run-10", "message-10", "running")];
  chat.sendAtEnd("message-10");
  const answer = message(11, "assistant", {
    runId: "run-10",
    streaming: true,
    text: "A short streaming answer.",
  });
  render(key, [...history, prompt, ...steps(2, "run-10"), answer], runningRuns);
  // The answer appears and the follow catches up; then the provider pauses.
  await playUntil(() => toEnd() <= 1);
  await play(2000);
  const motionFrames = vi.fn();
  const requestFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    const stack = new Error().stack ?? "";
    if (/useBoundedAnswerFollow|useStreamingBlockEntrance/.test(stack)) motionFrames();
    return requestFrame.call(window, callback);
  };
  try {
    await play(480);
    expect(motionFrames).not.toHaveBeenCalled();
    // More text arrives: the reveal wakes and shows it, and the follow keeps up.
    const longer = message(11, "assistant", {
      runId: "run-10",
      streaming: true,
      text: `A short streaming answer.\n\n${"More text that arrives later. ".repeat(12)}`,
    });
    render(key, [...history, prompt, ...steps(2, "run-10"), longer], runningRuns);
    await play(64);
    expect(motionFrames).toHaveBeenCalled();
  } finally {
    window.requestAnimationFrame = requestFrame;
  }
});

it("follows a queued prompt promoted to a steer through the run it went into", async () => {
  const key = "follow:promoted";
  const { history, runs } = await answeredThread(key);
  // Run 10 works on prompt 10; prompt 11 waits in the queue as its own run.
  const prompt = message(10, "user", { text: "Working prompt", runId: "run-10" });
  const working = [...runs, run("run-10", "message-10", "running")];
  render(
    key,
    [...history, prompt, ...steps(1, "run-10")],
    [...working, run("run-11", "message-11", "queued")],
  );
  await listRef.current!.scrollToEnd({ animated: false });
  viewport().dispatchEvent(new Event("scroll"));
  await play(96);
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
  render(key, rows(0), promotedRuns);
  await play(16);
  expect(chat.followPromptId).toBe("message-11");
  // At rest, a change that wakes the follow without anything to reveal (the
  // window grows a little): a follow judged settled would end here.
  await playUntil(() => toEnd() <= 1);
  await play(160);
  host!.style.height = "640px";
  await play(96);
  expect(chat.followPromptId).toBe("message-11");
  // Run 10 keeps working on it: its steps are followed, not settled away.
  const start = viewport().scrollTop;
  for (let count = 1; count <= 4; count++) {
    render(key, rows(count), promotedRuns);
    await playUntil(
      () => toEnd() <= 1 || promptTextTop("message-11") <= CHAT_TIMELINE_ANCHOR_OFFSET + 1,
    );
  }
  expect(chat.followPromptId).toBe("message-11");
  expect(viewport().scrollTop).toBeGreaterThan(start);
  // Run 10 ends: the follow ends with it.
  const answer = message(12, "assistant", { text: "Done.", runId: "run-10" });
  render(
    key,
    [...rows(4), answer],
    [...runs, run("run-10", "message-10", "completed"), run("run-11", "message-11", "cancelled")],
  );
  await playUntil(() => chat.followPromptId === null);
});

/** A followed prompt left behind, and a later prompt another window sent while the reader was away. */
async function leaveThenReturnPastAnotherPrompt(
  key: string,
  followedRun: OrchestrationV2RunStatus,
) {
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Followed prompt", runId: "run-10" });
  chat.sendAtEnd("message-10");
  render(
    key,
    [...history, prompt, ...steps(1, "run-10")],
    [...runs, run("run-10", "message-10", "running")],
  );
  await playUntil(() => toEnd() <= 1);
  await expect.poll(() => readTimelinePosition(key)?.followingPromptId).toBe("message-10");
  await visitElsewhere(`${key}-elsewhere`);
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
  render(
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
const answerBottom = (messageId: string) => {
  const element = host!.querySelector(`[data-message-id="${messageId}"]`);
  return element
    ? element.getBoundingClientRect().bottom - viewport().getBoundingClientRect().top
    : Number.NaN;
};
const readingBottom = () => viewport().clientHeight - base.contentInsetEndAdjustment;

it("brings a reader back to the prompt they followed, not past it to a later one", async () => {
  const key = "follow:return-identity";
  await leaveThenReturnPastAnotherPrompt(key, "running");
  // Back at the followed prompt's response: its end rests above the composer,
  // and the later prompt (and its long answer) stays below.
  await playUntil(() => Math.abs(answerBottom("message-11") - (readingBottom() - 16)) <= 2);
  expect(promptTextTop("message-10")).toBeGreaterThanOrEqual(CHAT_TIMELINE_ANCHOR_OFFSET - 1);
  expect(promptTextTop("message-30")).toBeGreaterThan(readingBottom() - 40);
  // Its run still works, so its follow carries on, for that prompt.
  await playUntil(() => chat.followPromptId === "message-10");
  const resting = viewport().scrollTop;
  await play(320);
  expect(Math.abs(viewport().scrollTop - resting)).toBeLessThanOrEqual(1);
});

it("brings a reader back to the prompt they followed when it finished while they were away", async () => {
  const key = "follow:return-finished";
  await leaveThenReturnPastAnotherPrompt(key, "completed");
  await playUntil(() => Math.abs(answerBottom("message-11") - (readingBottom() - 16)) <= 2);
  expect(promptTextTop("message-10")).toBeGreaterThanOrEqual(CHAT_TIMELINE_ANCHOR_OFFSET - 1);
  expect(promptTextTop("message-30")).toBeGreaterThan(readingBottom() - 40);
  // Finished: nothing to carry on with.
  await play(320);
  expect(chat.followPromptId).toBeNull();
});

it("keeps the reveal of a first prompt as it was: traces do not move it", async () => {
  const key = "follow:first";
  const { history, runs } = await answeredThread(key);
  const prompt = message(10, "user", { text: "Short follow-up", runId: "run-10" });
  const working = [...runs, run("run-10", "message-10", "running")];
  // Sent as a thread's first prompt (ChatView's first-message path).
  chat.sendAtEnd("message-10", { firstMessage: true });
  render(key, [...history, prompt], working);
  await play(160);
  expect(chat.followPromptId).toBe("message-10");
  for (let count = 1; count <= 8; count++) {
    render(key, [...history, prompt, ...steps(count, "run-10")], working);
    await play(96);
  }
  // Without whole-response following, the traces are left below the view.
  expect(toEnd()).toBeGreaterThan(100);
});

for (const followed of ["running", "completed"] as const)
  it(`brings a reader back to the prompt they followed across rows never rendered (${followed})`, async () => {
    const key = `follow:return-virtualized-${followed}`;
    const { history, runs } = await answeredThread(key);
    const prompt = message(10, "user", { text: "Followed prompt", runId: "run-10" });
    chat.sendAtEnd("message-10");
    render(
      key,
      [...history, prompt, ...steps(1, "run-10")],
      [...runs, run("run-10", "message-10", "running")],
    );
    await playUntil(() => toEnd() <= 1);
    await expect.poll(() => readTimelinePosition(key)?.followingPromptId).toBe("message-10");
    await visitElsewhere(`${key}-elsewhere`);
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
    render(
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
    await playUntil(() => {
      const bottom = answerBottom("message-11");
      return Number.isFinite(bottom) && Math.abs(bottom - (readingBottom() - 16)) <= 2;
    });
    await play(160);
    expect(Math.abs(answerBottom("message-11") - (readingBottom() - 16))).toBeLessThanOrEqual(2);
    expect(toEnd()).toBeGreaterThan(400);
    // The later prompt starts at the composer's edge, at most its first line showing.
    expect(
      Number.isNaN(promptTextTop("message-30")) ||
        promptTextTop("message-30") > readingBottom() - 40,
    ).toBe(true);
    if (followed === "running") await playUntil(() => chat.followPromptId === "message-10");
    else expect(chat.followPromptId).toBeNull();
  });
