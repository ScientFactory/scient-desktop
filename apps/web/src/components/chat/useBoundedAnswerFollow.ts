import { useLayoutEffect, useRef, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";

/** Reveal growth only while the sent prompt's text remains visible. */
export function boundedAnswerScrollDelta(input: {
  promptTextTop: number;
  answerBottom: number;
  viewportTop: number;
  viewportBottom: number;
}) {
  const roomAbove = Math.max(
    0,
    input.promptTextTop - input.viewportTop - CHAT_TIMELINE_ANCHOR_OFFSET,
  );
  const hiddenBelow = Math.max(0, input.answerBottom - input.viewportBottom);
  return Math.min(roomAbove, hiddenBelow);
}

export function useBoundedAnswerFollow({
  listRef,
  rows,
  promptMessageId,
  suspended,
  composerInset,
}: {
  listRef: RefObject<LegendListRef | null>;
  rows: readonly MessagesTimelineRow[];
  promptMessageId: string | null;
  suspended: boolean;
  composerInset: number;
}) {
  const intent = useRef<{ prompt: string | null; answer: string | null; stopped: boolean }>({
    prompt: null,
    answer: null,
    stopped: false,
  });
  useLayoutEffect(() => {
    if (intent.current.prompt !== promptMessageId)
      intent.current = { prompt: promptMessageId, answer: null, stopped: false };
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
      if (
        row.message.role === "assistant" &&
        row.message.text.trim() &&
        (!intent.current.answer || row.message.id === intent.current.answer)
      ) {
        answerIndex = i;
        intent.current.answer = row.message.id;
        break;
      }
    }

    const list = listRef.current;
    const viewport = list?.getScrollableNode();
    const promptRow = rows[promptIndex]!;
    const answerRow = rows[answerIndex] ?? promptRow;
    if (!viewport || !list) return;
    let observedAnswer: Element | null = null;
    let mountAttempts = 12;
    let frame: number | null = null;
    let previousFrameTime = performance.now();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = () => {
      frame = null;
      const now = performance.now();
      const elapsed = Math.min(32, Math.max(1, now - previousFrameTime));
      previousFrameTime = now;
      if (intent.current.stopped) return;
      const measuredState = list.getState();
      const measuredIndex = measuredState.indexByKey(answerRow.id);
      const answer =
        measuredIndex === undefined ? null : measuredState.elementAtIndex(measuredIndex);
      if (!answer || !answer.isConnected || answer.getBoundingClientRect().height <= 0) {
        if (mountAttempts-- > 0) frame = requestAnimationFrame(tick);
        return;
      }
      if (observedAnswer !== answer) {
        if (observedAnswer) observer.unobserve(observedAnswer);
        observer.observe(answer);
        observedAnswer = answer;
      }
      const promptIndexNow = measuredState.indexByKey(promptRow.id);
      const prompt =
        promptIndexNow === undefined ? null : measuredState.elementAtIndex(promptIndexNow);
      const promptText = prompt?.querySelector('[data-user-message-body="true"]') ?? prompt;
      if (!promptText || !promptText.isConnected) return;
      const promptTextTop = promptText.getBoundingClientRect().top;
      const rect = answer.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const delta = boundedAnswerScrollDelta({
        promptTextTop,
        answerBottom: rect.bottom,
        viewportTop: viewportRect.top,
        viewportBottom: viewportRect.top + viewport.clientHeight - composerInset,
      });
      if (promptTextTop <= viewportRect.top + CHAT_TIMELINE_ANCHOR_OFFSET + 1) {
        intent.current.stopped = true;
        return;
      }
      if (delta <= 0.5) {
        if (answerIndex >= 0 && answerRow.kind === "message" && !answerRow.message.streaming)
          intent.current.stopped = true;
        return;
      }
      const before = viewport.scrollTop;
      // A bounded animation only while content actually needs revealing; never an idle loop.
      const eased = delta * (1 - Math.exp(-elapsed / 90));
      viewport.scrollTop += reducedMotion
        ? delta
        : Math.min(delta, Math.max(0.5, Math.min(elapsed * 1.2, eased)));
      if (Math.abs(viewport.scrollTop - before) > 0.1) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (frame === null && !intent.current.stopped) frame = requestAnimationFrame(tick);
    };
    const cancel = () => {
      intent.current.stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      )
        cancel();
    };
    viewport.addEventListener("wheel", cancel, { passive: true });
    viewport.addEventListener("touchmove", cancel, { passive: true });
    viewport.addEventListener("pointerdown", cancel, { passive: true });
    viewport.ownerDocument.addEventListener("keydown", onKey);
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("wheel", cancel);
      viewport.removeEventListener("touchmove", cancel);
      viewport.removeEventListener("pointerdown", cancel);
      viewport.ownerDocument.removeEventListener("keydown", onKey);
    };
  }, [listRef, rows, promptMessageId, suspended, composerInset]);
}
