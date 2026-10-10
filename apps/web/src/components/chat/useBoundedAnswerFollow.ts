import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { observeResize } from "~/lib/observeResize";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { isTimelineScrollTarget } from "./timelineScrollTarget";
import { motionClock } from "./motionClock";
import { streamingRevealActive, subscribeStreamingReveal } from "./useStreamingBlockEntrance";

/** How much of a newly arrived message the reveal shows: its first lines. */
const FIRST_LINES_PX = 48;
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
 * How far the reveal may scroll now. Growth is revealed only while the sent
 * prompt's text keeps room above it. When traces and tool rows push the
 * latest message below the fold, the reveal continues past the prompt just
 * far enough to show that message's first lines, and never scrolls the
 * message itself above the reading margin: the answer is read from its
 * beginning, not followed to its end.
 */
export function boundedAnswerScrollDelta(input: {
  promptTextTop: number;
  answerTop: number | null;
  answerBottom: number;
  viewportTop: number;
  viewportBottom: number;
  /**
   * For a later prompt: how far the conversation's end is below the view.
   * Its whole response (traces, tool rows and messages) is then followed,
   * keeping the view at the end, instead of only the answer's growth.
   */
  endBelow?: number;
}) {
  const readingTop = input.viewportTop + CHAT_TIMELINE_ANCHOR_OFFSET;
  const promptRoom = Math.max(0, input.promptTextTop - readingTop);
  const hiddenBelow = Math.max(0, input.endBelow ?? input.answerBottom - input.viewportBottom);
  const growth = Math.min(promptRoom, hiddenBelow);
  if (input.answerTop === null) return growth;
  const firstLinesHidden = Math.max(
    0,
    Math.min(input.answerTop + FIRST_LINES_PX, input.answerBottom) - input.viewportBottom,
  );
  const answerRoom = Math.max(0, input.answerTop - readingTop);
  return Math.max(growth, Math.min(firstLinesHidden, answerRoom));
}

/**
 * After an eligible send, reveals the prompt and then the start of its
 * response. The response's latest assistant message is the target, so the
 * reveal moves past progress notes and trace runs to the message the agent is
 * writing now. For a later prompt (`followResponse`), the whole response is
 * followed at a calmer pace, keeping the view at the conversation's end, until
 * the prompt reaches the top margin. It stops once the prompt's own run has
 * ended and its last message is revealed, or when the reader scrolls back up.
 * Scrolling down, clicks, text selection and scrolling inside nested output
 * never cancel it. It moves only while there is something to reveal, and
 * otherwise rests until the content, the view or a reveal changes.
 *
 * Returns a reader for the prompt it is following right now (not cancelled,
 * not finished), for saving with the reading position.
 */
export function useBoundedAnswerFollow({
  listRef,
  rows,
  promptMessageId,
  responseSettled,
  suspended,
  composerInset,
  followResponse = false,
  onFinished,
}: {
  listRef: RefObject<LegendListRef | null>;
  rows: readonly MessagesTimelineRow[];
  promptMessageId: string | null;
  /** The prompt's own run has ended, so no more of its response will arrive. */
  responseSettled: boolean;
  suspended: boolean;
  composerInset: number;
  /** A later prompt: follow its whole response to the end, not only its answer. */
  followResponse?: boolean;
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
  }>({
    prompt: null,
    stopped: false,
    motion: { velocity: 0, position: null },
    readerInputUntil: 0,
  });
  useLayoutEffect(() => {
    if (intent.current.prompt !== promptMessageId)
      intent.current = {
        prompt: promptMessageId,
        stopped: false,
        motion: { velocity: 0, position: null },
        readerInputUntil: 0,
      };
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
        // A row never rendered has no measured size yet: place it from its
        // position (or right after the row before it) with the list's estimate.
        const previous = index > 0 ? index - 1 : undefined;
        const position =
          measuredState.positionAtIndex(index) ??
          (previous === undefined
            ? undefined
            : (measuredState.positionAtIndex(previous) ?? NaN) +
              (measuredState.sizeAtIndex(previous) ?? NaN));
        const size = measuredState.sizeAtIndex(index) ?? ESTIMATED_ROW_SIZE;
        if (position === undefined || !Number.isFinite(position)) return null;
        const top = viewportRect.top + position - measuredState.scroll;
        return { element: null, top, rect: { top, bottom: top + size } };
      };
      // How far the conversation's real end is below its resting place above
      // the composer, never past the scroll range (nor into reserved space).
      const endBelow = () => {
        const toMax = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        const last = rows[promptResponseLastIndex(rows, promptIndex)];
        const endBox = last ? rowRect(last.id) : null;
        const restingBottom = viewportRect.top + viewport.clientHeight - composerInset - END_GAP;
        // The answer is clipped to its revealed lines, so this is the real end:
        // the latest line and what follows it, resting above the composer.
        return endBox ? Math.min(toMax, endBox.rect.bottom - restingBottom) : toMax;
      };
      const answerBox = rowRect(answerRow.id);
      if (!answerBox) {
        if (mountAttempts-- > 0) frame = requestAnimationFrame(tick);
        return;
      }
      const answer = answerBox.element;
      if (answer && observedAnswer !== answer) {
        if (observedAnswer) observer.unobserve(observedAnswer);
        observer.observe(answer);
        observedAnswer = answer;
      }
      const promptBox = rowRect(promptRow.id);
      const promptText =
        promptBox?.element?.querySelector('[data-user-message-body="true"]') ?? promptBox?.element;
      const promptTextTop = promptText?.isConnected
        ? promptText.getBoundingClientRect().top
        : (promptBox?.top ?? viewportRect.top);
      const rect = answerBox.rect;
      const delta = boundedAnswerScrollDelta({
        promptTextTop,
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
        else if (stalled || !revealing) {
          motion.velocity = 0;
          motion.position = viewport.scrollTop;
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
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true]")
      )
        return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) cancel();
      else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) yieldToReader();
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: true });
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.ownerDocument.addEventListener("pointerup", onPointerUp);
    viewport.ownerDocument.addEventListener("keydown", onKey);
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
      unsubscribeReveal();
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.ownerDocument.removeEventListener("pointerup", onPointerUp);
      viewport.ownerDocument.removeEventListener("keydown", onKey);
    };
  }, [
    listRef,
    rows,
    promptMessageId,
    responseSettled,
    suspended,
    composerInset,
    followResponse,
    onFinished,
  ]);
  return useCallback(() => (intent.current.stopped ? null : intent.current.prompt), []);
}
