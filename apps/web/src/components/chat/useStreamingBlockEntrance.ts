import { type RefObject, useLayoutEffect } from "react";
import { DRAFT_HERO_TRANSITION_EASING } from "./draftHeroTransition";

/** The text blocks a streamed answer arrives in (providers send whole paragraphs). */
const STREAMED_BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, table, hr";

// Revealed from the top down while it fades in. The sides reach past the box so
// list markers and table borders are not clipped. Clip and opacity only: nothing moves.
const BLOCK_ENTRANCE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, clipPath: "inset(0 -2em 100% -2em)" },
  { opacity: 1, clipPath: "inset(0 -2em 0 -2em)" },
];
const BLOCK_ENTRANCE_TIMING: KeyframeAnimationOptions = {
  duration: 380,
  easing: DRAFT_HERO_TRANSITION_EASING,
};

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
 * heading…) fades in from the top down instead of appearing in one frame,
 * including the first one, which arrives with the message's row. Blocks that
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
    const enterNewBlocks = () => {
      const blocks = streamedBlocks(root);
      for (const block of blocks.slice(entered)) {
        if (typeof block.animate === "function")
          block.animate(BLOCK_ENTRANCE_KEYFRAMES, BLOCK_ENTRANCE_TIMING);
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
