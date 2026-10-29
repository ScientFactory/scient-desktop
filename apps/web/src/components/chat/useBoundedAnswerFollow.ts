import { useStableCallback } from "~/hooks/useStableCallback";
import { useLayoutEffect, useRef, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { observeResize } from "~/lib/observeResize";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  type TimelineListMeasurementState,
} from "./timelineScrollAnchoring";
import { isTimelineScrollTarget } from "./timelineScrollTarget";
import { motionClock } from "./motionClock";
import { streamingRevealActive, subscribeStreamingReveal } from "./useStreamingBlockEntrance";
import { keepsSettledAnswerVisible } from "~/scient/threadTimeline/keptAnswers";
import type { ChatMessage } from "../../types";

/** The reader's queued messages at the end of the timeline (QueuedRunsControl). */
const QUEUED_RUNS_SELECTOR = '[data-thread-queue="true"]';
/** How much of a message counts as its start being shown: its first lines. */
export const FIRST_LINES_PX = 48;
/** The timeline's estimated row height, for a row not yet measured. */
const ESTIMATED_ROW_SIZE = 90;
/** How the reveal moves: a top speed and how gently it eases to a stop. */
const REVEAL_PACE = { maxPxPerMs: 1.2, easeMs: 90 };
/** How long after the reader's last scroll input the follow keeps yielding. */
const READER_INPUT_GRACE_MS = 250;
/** The gap the timeline keeps between its last row and the composer at the end. */
export const END_GAP = 16;
/** A followed response's drift: a calm top speed, gentle acceleration and braking. */
const FOLLOW_MAX_SPEED = 1; // px per ms
const FOLLOW_ACCELERATION = 0.004; // px per ms², so ~250ms to top speed

/**
 * The last row of a prompt's response: the row before the next prompt, or
 * the timeline's last row. A later prompt (sent from another window, say)
 * and what follows it are not this prompt's response.
 */
export function promptResponseLastIndex(
  rows: readonly MessagesTimelineRow[],
  promptIndex: number,
): number {
  for (let index = promptIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.role === "user") return index - 1;
  }
  return rows.length - 1;
}

/**
 * Place an unmounted row from measured list positions so scrolling can mount it. Without its own
 * measurement, use the previous row and the list estimate rather than waiting for a DOM element.
 */
export function placeUnmountedRow(
  state: Pick<TimelineListMeasurementState, "scroll" | "positionAtIndex" | "sizeAtIndex">,
  index: number,
  viewportTop: number,
): { top: number; bottom: number } | null {
  const previous = index > 0 ? index - 1 : undefined;
  const position =
    state.positionAtIndex(index) ??
    (previous === undefined
      ? undefined
      : (state.positionAtIndex(previous) ?? NaN) + (state.sizeAtIndex(previous) ?? NaN));
  const size = state.sizeAtIndex(index) ?? ESTIMATED_ROW_SIZE;
  if (position === undefined || !Number.isFinite(position)) return null;
  const top = viewportTop + position - state.scroll;
  return { top, bottom: top + size };
}

/** An answer still streaming or still appearing line by line. */
const messageArriving = (message: ChatMessage) =>
  message.streaming || streamingRevealActive(message.id);

/**
 * Rows the reader reads, as opposed to work they watch go by: a message still arriving, one that
 * stays visible when its turn folds (keptAnswers.ts), a plan or a card, and work the reader opened.
 */
function isReadingRow(row: MessagesTimelineRow): boolean {
  switch (row.kind) {
    case "message":
      return (
        row.message.role === "assistant" &&
        row.message.text.trim().length > 0 &&
        (messageArriving(row.message) || keepsSettledAnswerVisible(row.message))
      );
    case "proposed-plan":
    case "html-render":
    case "mcp-app":
      return true;
    case "work-live":
    case "work-toggle":
    case "thinking":
      return row.expanded === true;
    default:
      return false;
  }
}

/** Rows of a prompt's response the reader has scrolled past: their start is above `readingTop`. */
function passedReadingRows(
  rows: readonly MessagesTimelineRow[],
  promptIndex: number,
  lastIndex: number,
  rowTop: (row: MessagesTimelineRow) => number | null,
  readingTop: number,
): ReadonlySet<string> {
  const passed = new Set<string>();
  for (let index = promptIndex + 1; index <= lastIndex; index += 1) {
    const row = rows[index];
    const top = row && isReadingRow(row) ? rowTop(row) : null;
    if (row && top !== null && top < readingTop - 2) passed.add(row.id);
  }
  return passed;
}

/**
 * The first row of a prompt's response whose start the follow may not push above the reading
 * margin, or -1. Rows already passed are read, except a message still arriving: an answer is
 * never followed down.
 */
export function followLimitIndex(
  rows: readonly MessagesTimelineRow[],
  promptIndex: number,
  lastIndex: number,
  passed: ReadonlySet<string>,
): number {
  for (let index = promptIndex + 1; index <= lastIndex; index += 1) {
    const row = rows[index];
    if (!row || !isReadingRow(row)) continue;
    if (!passed.has(row.id) || (row.kind === "message" && messageArriving(row.message)))
      return index;
  }
  return -1;
}

/**
 * Follow the response's live end until it would push the limit row's start (`limitTop`; null
 * when nothing limits it) above the reading margin. Past it, scroll only far enough to expose the
 * first lines of a message pushed below the fold.
 */
export function boundedAnswerScrollDelta(input: {
  limitTop: number | null;
  answerTop: number | null;
  answerBottom: number;
  viewportTop: number;
  viewportBottom: number;
  /**
   * How far the response's end is below its resting place above the composer. Without it only
   * the answer's growth is followed.
   */
  endBelow?: number;
}) {
  const readingTop = input.viewportTop + CHAT_TIMELINE_ANCHOR_OFFSET;
  const hiddenBelow = Math.max(0, input.endBelow ?? input.answerBottom - input.viewportBottom);
  const growth =
    input.limitTop === null
      ? hiddenBelow
      : Math.min(Math.max(0, input.limitTop - readingTop), hiddenBelow);
  if (input.answerTop === null) return growth;
  const firstLinesHidden = Math.max(
    0,
    Math.min(input.answerTop + FIRST_LINES_PX, input.answerBottom) - input.viewportBottom,
  );
  const answerRoom = Math.max(0, input.answerTop - readingTop);
  return Math.max(growth, Math.min(firstLinesHidden, answerRoom));
}

/**
 * Follow belongs to one prompt's V2 run and ends only after its last message is revealed or the
 * reader scrolls up. Downward/nested scrolling, selection, and clicks do not cancel it. Rest
 * without pending reveal work; save only an active follow owner.
 */
export function useBoundedAnswerFollow({
  listRef,
  rows,
  promptMessageId,
  responseSettled,
  suspended,
  composerInset,
  followResponse = false,
  joined = 0,
  onFinished,
}: {
  listRef: RefObject<LegendListRef | null>;
  rows: readonly MessagesTimelineRow[];
  promptMessageId: string | null;
  /** The prompt's own run has ended, so no more of its response will arrive. */
  responseSettled: boolean;
  suspended: boolean;
  composerInset: number;
  /** Follow the prompt's whole response to its live end, not only its answer. */
  followResponse?: boolean;
  /**
   * Changes each time the reader (re)joins this follow at the end: what they scrolled past by
   * then is read and no longer stops it.
   */
  joined?: number;
  /** Called once when the reveal for `promptMessageId` ends (revealed or cancelled). */
  onFinished?: (promptMessageId: string) => void;
}) {
  const intent = useRef<{
    prompt: string | null;
    stopped: boolean;
    /** A followed response's motion, kept across updates so its speed never jumps. */
    motion: { velocity: number; position: number | null };
    /** Until when the reader's own scrolling is in motion (the follow yields). */
    readerInputUntil: number;
    /** Reading rows above the reading margin when the reader joined; measured on the first frame. */
    passed: ReadonlySet<string> | null;
    joined: number;
  }>({
    prompt: null,
    stopped: false,
    motion: { velocity: 0, position: null },
    readerInputUntil: 0,
    passed: null,
    joined,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the follow animation: rAF loop, answer-row ResizeObserver and scroll writes on the list viewport
  useLayoutEffect(() => {
    if (intent.current.prompt !== promptMessageId)
      intent.current = {
        prompt: promptMessageId,
        stopped: false,
        motion: { velocity: 0, position: null },
        readerInputUntil: 0,
        passed: null,
        joined,
      };
    else if (intent.current.joined !== joined)
      intent.current = { ...intent.current, stopped: false, passed: null, joined };
    if (!promptMessageId || suspended || intent.current.stopped) return;
    const promptIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === promptMessageId,
    );
    if (promptIndex < 0) return;
    let answerIndex = -1;
    for (let i = promptIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      if (row?.kind !== "message") continue;
      if (row.message.role === "user") break;
      if (row.message.role === "assistant" && row.message.text.trim()) answerIndex = i;
    }
    const lastIndex = promptResponseLastIndex(rows, promptIndex);

    const list = listRef.current;
    const viewport = list?.getScrollableNode();
    const promptRow = rows[promptIndex]!;
    const answerRow = rows[answerIndex] ?? promptRow;
    // The response has settled once the prompt's own run ended (answer or not)
    // and its last message is no longer streaming or being revealed.
    const answerId = answerRow.kind === "message" ? answerRow.message.id : null;
    const answerRevealing = () => answerId !== null && streamingRevealActive(answerId);
    const answerSettled =
      responseSettled && (answerRow.kind !== "message" || !answerRow.message.streaming);
    if (!viewport || !list) return;
    const finish = () => {
      intent.current.stopped = true;
      onFinished?.(promptMessageId);
    };
    let observedAnswer: Element | null = null;
    let stopAnswerResize: (() => void) | null = null;
    let mountAttempts = 12;
    let frame: number | null = null;
    let previousFrameTime = motionClock.now();
    // The highest position the reveal (or the reader scrolling down) reached.
    let revealTop = viewport.scrollTop;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = () => {
      frame = null;
      const now = motionClock.now();
      const elapsed = Math.min(32, Math.max(1, now - previousFrameTime));
      previousFrameTime = now;
      if (intent.current.stopped) return;
      const measuredState = list.getState();
      const viewportRect = viewport.getBoundingClientRect();
      // A row outside the rendered window is placed from the list's measured
      // positions; scrolling toward it mounts it.
      const rowRect = (rowId: string) => {
        const index = measuredState.indexByKey(rowId);
        if (index === undefined) return null;
        const element = measuredState.elementAtIndex(index);
        if (element?.isConnected && element.getBoundingClientRect().height > 0)
          return {
            element,
            top: element.getBoundingClientRect().top,
            rect: element.getBoundingClientRect(),
          };
        const placed = placeUnmountedRow(measuredState, index, viewportRect.top);
        if (!placed) return null;
        return { element: null, top: placed.top, rect: placed };
      };
      // How far the conversation's real end is below its resting place above
      // the composer, never past the scroll range (nor into reserved space).
      const endBelow = () => {
        const toMax = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        const last = rows[lastIndex];
        const endBox = last ? rowRect(last.id) : null;
        // The reader's queued messages wait after the latest response.
        const queue =
          lastIndex === rows.length - 1 ? viewport.querySelector(QUEUED_RUNS_SELECTOR) : null;
        const end = Math.max(
          endBox?.rect.bottom ?? Number.NEGATIVE_INFINITY,
          queue?.getBoundingClientRect().bottom ?? Number.NEGATIVE_INFINITY,
        );
        const restingBottom = viewportRect.top + viewport.clientHeight - composerInset - END_GAP;
        // The answer is clipped to its revealed lines, so this is the real end:
        // the latest line and what follows it, resting above the composer.
        return Number.isFinite(end) ? Math.min(toMax, end - restingBottom) : toMax;
      };
      const answerBox = rowRect(answerRow.id);
      if (!answerBox) {
        const attemptsLeft = mountAttempts;
        mountAttempts -= 1;
        if (attemptsLeft > 0) frame = requestAnimationFrame(tick);
        return;
      }
      const answer = answerBox.element;
      if (observedAnswer !== answer) {
        stopAnswerResize?.();
        stopAnswerResize = answer ? observeResize(answer, schedule) : null;
        observedAnswer = answer;
      }
      const readingTop = viewportRect.top + CHAT_TIMELINE_ANCHOR_OFFSET;
      const passed =
        intent.current.passed ??
        passedReadingRows(
          rows,
          promptIndex,
          lastIndex,
          (row) => rowRect(row.id)?.top ?? null,
          readingTop,
        );
      intent.current.passed = passed;
      const limit = rows[followLimitIndex(rows, promptIndex, lastIndex, passed)];
      // A reading row the list cannot place yet holds the view where it is.
      const limitTop = limit ? (rowRect(limit.id)?.top ?? readingTop) : null;
      const rect = answerBox.rect;
      const delta = boundedAnswerScrollDelta({
        limitTop,
        answerTop: answerIndex >= 0 ? rect.top : null,
        answerBottom: rect.bottom,
        viewportTop: viewportRect.top,
        viewportBottom: viewportRect.top + viewport.clientHeight - composerInset,
        ...(followResponse ? { endBelow: endBelow() } : {}),
      });
      // The answer is being revealed line by line: each step of it wakes the follow.
      const revealing = followResponse && answerRevealing();
      if (delta <= 0.5) {
        // Nothing to reveal now. More may arrive while the prompt's run works,
        // or while its last lines appear; the reveal ends once they are shown.
        if (answerSettled && !answerRevealing()) finish();
        return;
      }
      // Text being selected in the timeline holds still; the follow resumes when it is cleared.
      const selection = viewport.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && viewport.contains(selection.anchorNode)) {
        intent.current.motion = { velocity: 0, position: null };
        return;
      }
      const before = viewport.scrollTop;
      // Far below (long runs of notes or tool output): skip all but the last
      // screen at once, then ease the rest, instead of a long slow glide.
      const screen = viewport.clientHeight;
      if (!reducedMotion && delta > screen && now >= intent.current.readerInputUntil) {
        viewport.scrollTop += delta - screen;
        revealTop = Math.max(revealTop, viewport.scrollTop);
        frame = requestAnimationFrame(tick);
        return;
      }
      if (followResponse && !reducedMotion && now < intent.current.readerInputUntil) {
        // The reader is scrolling: never write over their scroll in motion. The
        // follow picks up from wherever they end, from rest. A held scrollbar
        // waits for its release instead of checking every frame.
        intent.current.motion = { velocity: 0, position: null };
        revealTop = Math.max(revealTop, viewport.scrollTop);
        if (Number.isFinite(intent.current.readerInputUntil)) frame = requestAnimationFrame(tick);
        return;
      }
      if (followResponse && !reducedMotion) {
        // A followed response drifts with a speed of its own that only changes
        // gradually: it speeds up gently, cruises at a calm top speed however
        // fast text arrives (catching up rather than rushing), and brakes into
        // place. It aims to arrive as the text being revealed finishes showing.
        const motion = intent.current.motion;
        // The view's own position, unless something else moved it.
        if (motion.position === null || Math.abs(viewport.scrollTop - motion.position) > 1.5)
          motion.position = viewport.scrollTop;
        // Braking that arrives, not a creep that never does.
        const cruise = Math.min(FOLLOW_MAX_SPEED, Math.sqrt(2 * FOLLOW_ACCELERATION * delta));
        const change = cruise - motion.velocity;
        const limit = FOLLOW_ACCELERATION * elapsed;
        motion.velocity = Math.max(0, motion.velocity + Math.max(-limit, Math.min(limit, change)));
        const step = Math.min(delta, motion.velocity * elapsed);
        motion.position += step;
        viewport.scrollTop = motion.position;
        revealTop = Math.max(revealTop, viewport.scrollTop);
        // Keep going while there is distance left and the view can still move
        // (the browser may round the position to whole pixels, so allow that).
        // Caught up with lines still appearing, it keeps its speed for their
        // next step rather than starting again from rest.
        const stalled = motion.position - viewport.scrollTop > 2;
        if (delta - step > 0.5 && !stalled) frame = requestAnimationFrame(tick);
        else {
          if (stalled || !revealing) {
            motion.velocity = 0;
            motion.position = viewport.scrollTop;
          }
          // Arrived with the response settled: the next frame finds nothing
          // left to reveal and ends the follow, rather than waiting for some
          // later change to wake it.
          if (!stalled && answerSettled) frame = requestAnimationFrame(tick);
        }
        return;
      }
      // A bounded animation only while content actually needs revealing; never an idle loop.
      const pace = REVEAL_PACE;
      const eased = delta * (1 - Math.exp(-elapsed / pace.easeMs));
      const step = Math.max(0.5, Math.min(elapsed * pace.maxPxPerMs, eased));
      viewport.scrollTop += reducedMotion ? delta : Math.min(delta, step);
      revealTop = Math.max(revealTop, viewport.scrollTop);
      if (Math.abs(viewport.scrollTop - before) > 0.1) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (frame === null && !intent.current.stopped) frame = requestAnimationFrame(tick);
    };
    const cancel = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      finish();
    };
    // Scrolling toward the end keeps the follow, but it yields while that
    // scroll is in motion (and a scrollbar drag lasts until release).
    const yieldToReader = (forMs = READER_INPUT_GRACE_MS) => {
      intent.current.readerInputUntil = Math.max(
        intent.current.readerInputUntil,
        motionClock.now() + forMs,
      );
      schedule();
    };
    const onWheel = (event: WheelEvent) => {
      if (!isTimelineScrollTarget(event.target, viewport, event.deltaY)) return;
      if (event.deltaY < 0) cancel();
      else yieldToReader();
    };
    const onTouchMove = () => yieldToReader();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === viewport) yieldToReader(Number.POSITIVE_INFINITY);
    };
    const onPointerUp = () => {
      if (intent.current.readerInputUntil === Number.POSITIVE_INFINITY) {
        intent.current.readerInputUntil = 0;
        yieldToReader();
      }
    };
    // Any upward movement the reveal did not make (a touch drag, the
    // scrollbar, a key) is the reader scrolling back, which ends the reveal.
    const onScroll = () => {
      // At the very end, a lower position is the end itself moving up (a
      // busy indicator or a collapsed row went away), not the reader.
      const atEnd = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1;
      if (followResponse && atEnd) revealTop = viewport.scrollTop;
      else if (viewport.scrollTop < revealTop - 2) cancel();
      else revealTop = Math.max(revealTop, viewport.scrollTop);
    };
    const onKey = (event: KeyboardEvent) => {
      // Only a key that scrolls the timeline counts (as in ChatView's own key
      // handling): focus in the timeline or nowhere, unmodified, not typing. A
      // key moving through a menu, a dialog or the composer leaves the follow be.
      const target = event.target;
      const document = viewport.ownerDocument;
      if (
        !(target instanceof Node) ||
        (!viewport.contains(target) &&
          target !== document.body &&
          target !== document.documentElement) ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (target instanceof Element &&
          target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
      )
        return;
      // A key scrolling a nested region (tool output) leaves the timeline where it is.
      const direction = ["ArrowUp", "PageUp", "Home"].includes(event.key) ? -1 : 1;
      if (viewport.contains(target) && !isTimelineScrollTarget(target, viewport, direction)) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) cancel();
      else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) yieldToReader();
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: true });
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.ownerDocument.addEventListener("pointerup", onPointerUp);
    viewport.ownerDocument.addEventListener("keydown", onKey);
    viewport.ownerDocument.addEventListener("selectionchange", schedule);
    // A followed response can grow anywhere (a tool's output expanding in place).
    const content = viewport.firstElementChild;
    const stopResize = observeResize(
      followResponse && content ? [viewport, content] : viewport,
      schedule,
    );
    // An answer appearing line by line moves the end without resizing the
    // list, and the follow can end only once its reveal has.
    const unsubscribeReveal = subscribeStreamingReveal(schedule);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      stopResize();
      stopAnswerResize?.();
      unsubscribeReveal();
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.ownerDocument.removeEventListener("pointerup", onPointerUp);
      viewport.ownerDocument.removeEventListener("keydown", onKey);
      viewport.ownerDocument.removeEventListener("selectionchange", schedule);
    };
  }, [
    listRef,
    rows,
    promptMessageId,
    responseSettled,
    suspended,
    composerInset,
    followResponse,
    joined,
    onFinished,
  ]);
  return useStableCallback(() => (intent.current.stopped ? null : intent.current.prompt));
}
