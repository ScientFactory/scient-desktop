import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * A streaming answer is revealed as one continuous flow, even though providers
 * send it a paragraph at a time: lines appear top to bottom at a steady pace,
 * a little lighter, and the full tone follows one line behind. The first lines
 * wait a moment, so the next paragraphs are usually in hand and the flow never
 * stops and starts. Masking only (`.streamed-reveal`): nothing moves.
 */
const REVEAL_BUFFER_MS = 1000;
const REVEAL_LINES_PER_SECOND = 4;
/** More than this many lines waiting and the reveal speeds up to catch up. */
const REVEAL_MAX_LAG_LINES = 8;

/**
 * How far each streaming message has been revealed, in pixels from its top.
 * Kept outside the component: the list remounts rows that scroll out of view
 * and back, and text already revealed never replays. Bounded, oldest first.
 */
const revealedHeights = new Map<string, number>();
const MAX_TRACKED_MESSAGES = 100;

function rememberRevealed(messageId: string, height: number) {
  revealedHeights.delete(messageId);
  revealedHeights.set(messageId, height);
  if (revealedHeights.size > MAX_TRACKED_MESSAGES) {
    const oldest = revealedHeights.keys().next().value;
    if (oldest !== undefined) revealedHeights.delete(oldest);
  }
}

/**
 * How much of a message is revealed so far (pixels from its top), while it is
 * still being revealed; null once it is all shown. The follow scroll keeps up
 * with this edge rather than the text still hidden below it.
 */
export function streamingRevealedHeight(messageId: string): number | null {
  return revealedHeights.get(messageId) ?? null;
}

/**
 * Reveals a streaming message line by line (see above). A message that was
 * never revealed here (finished before it mounted), and reduced motion, are
 * shown as they are.
 */
export function useStreamingBlockEntrance(
  rootRef: RefObject<HTMLElement | null>,
  isStreaming: boolean,
  messageId: string | null | undefined,
) {
  const streamingRef = useRef(isStreaming);
  useLayoutEffect(() => {
    streamingRef.current = isStreaming;
  });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (
      !root ||
      !messageId ||
      typeof window === "undefined" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const known = revealedHeights.get(messageId);
    // A finished message never revealed here is simply shown.
    if (!isStreaming && known === undefined) return;
    const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 22;
    let front = known ?? 0;
    // Text arriving with the message waits briefly; a remounted reveal continues.
    const startsAt = performance.now() + (known === undefined ? REVEAL_BUFFER_MS : 0);
    let last = performance.now();
    let frame: number | null = null;
    const apply = () => {
      root.style.setProperty("--reveal-front", `${front}px`);
      root.style.setProperty("--reveal-line", `${lineHeight}px`);
    };
    const clear = () => {
      root.classList.remove("streamed-reveal");
      root.style.removeProperty("--reveal-front");
      root.style.removeProperty("--reveal-line");
    };
    root.classList.add("streamed-reveal");
    apply();
    rememberRevealed(messageId, front);
    const tick = (now: number) => {
      frame = null;
      const elapsed = Math.min(50, now - last);
      last = now;
      const height = root.scrollHeight;
      // The full tone trails the appearing text by a line; both finish together.
      const end = height + lineHeight;
      if (now >= startsAt && front < end) {
        const waitingLines = (height - front) / lineHeight;
        const speed =
          ((REVEAL_LINES_PER_SECOND * lineHeight) / 1000) *
          Math.max(1, waitingLines / REVEAL_MAX_LAG_LINES);
        front = Math.min(end, front + speed * elapsed);
        apply();
      }
      if (!streamingRef.current && front >= end) {
        revealedHeights.delete(messageId);
        clear();
        return;
      }
      rememberRevealed(messageId, front);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      clear();
    };
  }, [rootRef, isStreaming, messageId]);
}
