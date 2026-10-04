import { type RefObject, useEffect } from "react";
import { DRAFT_HERO_TRANSITION_EASING } from "./draftHeroTransition";

/** The text blocks that arrive whole while an answer streams in. */
const STREAMED_BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, table, hr";

// Revealed from the top down while it fades in. The sides reach past the box so
// list markers and table borders are not clipped.
const BLOCK_ENTRANCE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, clipPath: "inset(0 -2em 100% -2em)" },
  { opacity: 1, clipPath: "inset(0 -2em 0 -2em)" },
];
const BLOCK_ENTRANCE_TIMING: KeyframeAnimationOptions = {
  duration: 380,
  easing: DRAFT_HERO_TRANSITION_EASING,
};

/**
 * While a message streams, each new block (a paragraph, list item, heading…)
 * fades in from the top down instead of appearing in one frame. Only blocks
 * appended at the end while streaming play it: text already shown, a message
 * mounted mid-stream and finished messages never do. Reduced motion skips it.
 */
export function useStreamingBlockEntrance(
  rootRef: RefObject<HTMLElement | null>,
  isStreaming: boolean,
) {
  useEffect(() => {
    const root = rootRef.current;
    if (
      !isStreaming ||
      !root ||
      typeof MutationObserver === "undefined" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const observer = new MutationObserver((records) => {
      const added = new Set<Node>();
      for (const record of records) for (const node of record.addedNodes) added.add(node);
      for (const node of added) {
        if (!(node instanceof HTMLElement) || typeof node.animate !== "function") continue;
        // A block inside another new block enters with it.
        let parent = node.parentElement;
        let nested = false;
        while (parent && parent !== root) {
          if (added.has(parent)) nested = true;
          parent = parent.parentElement;
        }
        if (nested || !node.matches(STREAMED_BLOCK_SELECTOR)) continue;
        // Only content arriving at the end; a block re-rendered in place is not new.
        if (node.nextElementSibling) continue;
        node.animate(BLOCK_ENTRANCE_KEYFRAMES, BLOCK_ENTRANCE_TIMING);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rootRef, isStreaming]);
}
