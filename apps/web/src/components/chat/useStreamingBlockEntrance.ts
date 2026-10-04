import { type RefObject, useLayoutEffect } from "react";

/** The text blocks a streamed answer arrives in (providers send whole paragraphs). */
const STREAMED_BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, table, hr";

// Each block is revealed from the top down, a soft edge moving down at a steady
// pace (about a line at a time), as if it were being written. Masking only:
// nothing moves, so the reveal and scroll measurements are unaffected.
const BLOCK_REVEAL_MASK = "linear-gradient(to bottom, #000 33.3%, transparent 66.6%)";
const BLOCK_REVEAL_KEYFRAMES: Keyframe[] = [
  {
    maskImage: BLOCK_REVEAL_MASK,
    maskSize: "100% 300%",
    maskPosition: "0 100%",
    webkitMaskImage: BLOCK_REVEAL_MASK,
    webkitMaskSize: "100% 300%",
    webkitMaskPosition: "0 100%",
  },
  {
    maskImage: BLOCK_REVEAL_MASK,
    maskSize: "100% 300%",
    maskPosition: "0 0",
    webkitMaskImage: BLOCK_REVEAL_MASK,
    webkitMaskSize: "100% 300%",
    webkitMaskPosition: "0 0",
  },
];
const REVEAL_MS_PER_LINE = 200;
const MIN_REVEAL_MS = 450;
const MAX_REVEAL_MS = 1800;
// Steady through the middle, settling gently at the end.
const REVEAL_EASING = "cubic-bezier(0.3, 0.1, 0.3, 1)";

function revealDuration(block: HTMLElement) {
  const lineHeight = Number.parseFloat(getComputedStyle(block).lineHeight) || 22;
  const lines = Math.max(1, Math.round(block.getBoundingClientRect().height / lineHeight));
  return Math.min(MAX_REVEAL_MS, Math.max(MIN_REVEAL_MS, lines * REVEAL_MS_PER_LINE));
}

/**
 * How many blocks of each streaming message have entered. Kept outside the
 * component: the list remounts rows that scroll out of view and back, and a
 * block that already entered never replays. Bounded, oldest dropped first.
 */
const enteredBlockCounts = new Map<string, number>();
const MAX_TRACKED_MESSAGES = 100;

function streamedBlocks(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(STREAMED_BLOCK_SELECTOR)).filter((block) => {
    // A block inside another (a paragraph in a list item) enters with it.
    const outer = block.parentElement?.closest(STREAMED_BLOCK_SELECTOR);
    return !outer || !root.contains(outer);
  });
}

/**
 * While a message streams, each block that arrives (a paragraph, list item,
 * heading…) is revealed from the top down, line by line, one block after the
 * other, instead of appearing in one frame; the first one too, which arrives
 * with the message's row. Blocks that
 * already entered never replay; finished messages and reduced motion are left
 * alone.
 */
export function useStreamingBlockEntrance(
  rootRef: RefObject<HTMLElement | null>,
  isStreaming: boolean,
  messageId: string | null | undefined,
) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (
      !isStreaming ||
      !root ||
      typeof MutationObserver === "undefined" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    // Without a message id, only blocks arriving from now on enter.
    let entered = messageId
      ? (enteredBlockCounts.get(messageId) ?? 0)
      : streamedBlocks(root).length;
    // Blocks reveal one after the other: a block waits for the one before it.
    let revealEndsAt = 0;
    const enterNewBlocks = () => {
      const blocks = streamedBlocks(root);
      for (const block of blocks.slice(entered)) {
        if (typeof block.animate !== "function") continue;
        const now = performance.now();
        const delay = Math.max(0, revealEndsAt - now);
        const duration = revealDuration(block);
        revealEndsAt = now + delay + duration;
        block.animate(BLOCK_REVEAL_KEYFRAMES, {
          duration,
          delay,
          easing: REVEAL_EASING,
          fill: "backwards",
        });
      }
      entered = Math.max(entered, blocks.length);
      if (!messageId) return;
      enteredBlockCounts.delete(messageId);
      enteredBlockCounts.set(messageId, entered);
      if (enteredBlockCounts.size > MAX_TRACKED_MESSAGES) {
        const oldest = enteredBlockCounts.keys().next().value;
        if (oldest !== undefined) enteredBlockCounts.delete(oldest);
      }
    };
    // Before the first paint: the blocks this row arrived with enter too.
    enterNewBlocks();
    const observer = new MutationObserver(enterNewBlocks);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rootRef, isStreaming, messageId]);
}
