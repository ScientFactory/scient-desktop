import { useLayoutEffect, useRef, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { isTimelineScrollTarget } from "./timelineScrollTarget";

/** How much of a newly arrived message the reveal shows: its first lines. */
const FIRST_LINES_PX = 48;
/** The timeline's estimated row height, for a row not yet measured. */
const ESTIMATED_ROW_SIZE = 90;
/** How the reveal moves: a top speed and how gently it eases to a stop. */
const REVEAL_PACE = { maxPxPerMs: 1.2, easeMs: 90 };
/** The gap the timeline keeps between its last row and the composer at the end. */
const END_GAP = 16;
const FOLLOW_PACE = { maxPxPerMs: 0.6, easeMs: 180 };

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
  const intent = useRef<{ prompt: string | null; stopped: boolean }>({
    prompt: null,
    stopped: false,
  });
  useLayoutEffect(() => {
    if (intent.current.prompt !== promptMessageId)
      intent.current = { prompt: promptMessageId, stopped: false };
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
    // A followed response has settled once the thread is done, answer or not.
    const answerSettled = followResponse
      ? !responseRunning && (answerRow.kind !== "message" || !answerRow.message.streaming)
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
      const endBelow = () => {
        const toMax = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        const last = rows.at(-1);
        const endBox = last ? rowRect(last.id) : null;
        const restingBottom = viewportRect.top + viewport.clientHeight - composerInset - END_GAP;
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
      if (delta <= 0.5) {
        // Nothing to reveal now. Later messages may still arrive while the
        // thread works; the reveal ends once the settled response is shown.
        if (answerSettled) finish();
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
      // A bounded animation only while content actually needs revealing; never an idle loop.
      // A followed response moves at a calmer pace, so bursts of steps read as one drift.
      const pace = followResponse ? FOLLOW_PACE : REVEAL_PACE;
      const eased = delta * (1 - Math.exp(-elapsed / pace.easeMs));
      viewport.scrollTop += reducedMotion
        ? delta
        : Math.min(delta, Math.max(0.5, Math.min(elapsed * pace.maxPxPerMs, eased)));
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
