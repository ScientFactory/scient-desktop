import { useLayoutEffect, useRef, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { isTimelineScrollTarget } from "./timelineScrollTarget";
import { streamingRevealedHeight } from "./useStreamingBlockEntrance";

/** How much of a newly arrived message the reveal shows: its first lines. */
const FIRST_LINES_PX = 48;
/** The timeline's estimated row height, for a row not yet measured. */
const ESTIMATED_ROW_SIZE = 90;
/** How the reveal moves: a top speed and how gently it eases to a stop. */
const REVEAL_PACE = { maxPxPerMs: 1.2, easeMs: 90 };
/** The gap the timeline keeps between its last row and the composer at the end. */
const END_GAP = 16;
/** A followed response's drift: a calm top speed, gentle acceleration and braking. */
const FOLLOW_MAX_SPEED = 1; // px per ms
const FOLLOW_ACCELERATION = 0.004; // px per ms², so ~250ms to top speed

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
 * the prompt reaches the top margin. It stops once the response has settled
 * and its last message is revealed, or when the reader scrolls back up.
 * Scrolling down, clicks, text selection and scrolling inside nested output
 * never cancel it.
 */
export function useBoundedAnswerFollow({
  listRef,
  rows,
  promptMessageId,
  responseRunning,
  suspended,
  composerInset,
  followResponse = false,
  onFinished,
}: {
  listRef: RefObject<LegendListRef | null>;
  rows: readonly MessagesTimelineRow[];
  promptMessageId: string | null;
  /** Whether the thread is still working, so later messages may still arrive. */
  responseRunning: boolean;
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
    sawRunning: boolean;
    /** A followed response's motion, kept across updates so its speed never jumps. */
    motion: { velocity: number; position: number | null };
  }>({
    prompt: null,
    stopped: false,
    sawRunning: false,
    motion: { velocity: 0, position: null },
  });
  useLayoutEffect(() => {
    if (intent.current.prompt !== promptMessageId)
      intent.current = {
        prompt: promptMessageId,
        stopped: false,
        sawRunning: false,
        motion: { velocity: 0, position: null },
      };
    if (responseRunning) intent.current.sawRunning = true;
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
    // A followed response has settled once the thread worked on it and is done,
    // answer or not; right after the send it may not have started yet.
    const answerSettled = followResponse
      ? (intent.current.sawRunning || answerIndex >= 0) &&
        !responseRunning &&
        (answerRow.kind !== "message" || !answerRow.message.streaming)
      : answerIndex >= 0 &&
        !responseRunning &&
        answerRow.kind === "message" &&
        !answerRow.message.streaming;
    if (!viewport || !list) return;
    const finish = () => {
      intent.current.stopped = true;
      onFinished?.(promptMessageId);
    };
    let observedAnswer: Element | null = null;
    let mountAttempts = 12;
    let frame: number | null = null;
    let previousFrameTime = performance.now();
    // The highest position the reveal (or the reader scrolling down) reached.
    let revealTop = viewport.scrollTop;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = () => {
      frame = null;
      const now = performance.now();
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
      // How much of the answer has been revealed so far, while it is being revealed.
      const revealedHeight = () =>
        answerRow.kind === "message" ? streamingRevealedHeight(answerRow.message.id) : null;
      const endBelow = () => {
        const toMax = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        const last = rows.at(-1);
        const endBox = last ? rowRect(last.id) : null;
        const restingBottom = viewportRect.top + viewport.clientHeight - composerInset - END_GAP;
        const end = endBox ? Math.min(toMax, endBox.rect.bottom - restingBottom) : toMax;
        // While the answer is revealed line by line, keep up with the lines
        // shown so far, never the text still hidden below them.
        const revealed = revealedHeight();
        const text =
          revealed === null ? null : answerBox?.element?.querySelector(".streamed-reveal");
        if (revealed === null || !text) return end;
        return Math.min(end, text.getBoundingClientRect().top + revealed - restingBottom);
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
      const revealing = followResponse && revealedHeight() !== null;
      if (delta <= 0.5) {
        // Nothing to reveal now. Later messages may still arrive while the
        // thread works; the reveal ends once the settled response is shown.
        // While its lines are still being revealed, keep up with them.
        if (revealing) frame = requestAnimationFrame(tick);
        else if (answerSettled) finish();
        return;
      }
      const before = viewport.scrollTop;
      // Far below (long runs of notes or tool output): skip all but the last
      // screen at once, then ease the rest, instead of a long slow glide.
      const screen = viewport.clientHeight;
      if (!reducedMotion && delta > screen) {
        viewport.scrollTop += delta - screen;
        revealTop = Math.max(revealTop, viewport.scrollTop);
        frame = requestAnimationFrame(tick);
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
        const stalled = motion.position - viewport.scrollTop > 2;
        if ((delta - step > 0.5 || revealing) && !stalled) frame = requestAnimationFrame(tick);
        else {
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
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && isTimelineScrollTarget(event.target, viewport, event.deltaY))
        cancel();
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
        ["ArrowUp", "PageUp", "Home"].includes(event.key) &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      )
        cancel();
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.ownerDocument.addEventListener("keydown", onKey);
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    // A followed response can grow anywhere (a tool's output expanding in place).
    const content = viewport.firstElementChild;
    if (followResponse && content) observer.observe(content);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("scroll", onScroll);
      viewport.ownerDocument.removeEventListener("keydown", onKey);
    };
  }, [
    listRef,
    rows,
    promptMessageId,
    responseRunning,
    suspended,
    composerInset,
    followResponse,
    onFinished,
  ]);
}
