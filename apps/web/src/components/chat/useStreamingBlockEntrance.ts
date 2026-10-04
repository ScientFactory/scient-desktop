import { type RefObject, useLayoutEffect } from "react";

/** The text blocks a streamed answer arrives in (providers send whole paragraphs). */
const STREAMED_BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, table, hr";

// Each block shows at once, lighter, and is inked in line by line: a soft dark
// edge runs across each line from left to right and the text stays dark behind
// it, one block after the other. Masking only (`.streamed-ink`): nothing moves.
const INK_MS_PER_LINE = 300;
/** A long block inks faster per line, so it never takes longer than this. */
const MAX_INK_MS = 2400;
const REVEAL_LEAD_MS = 150;

/** One sweep per line: the edge crosses line i, then line i + 1 starts. */
function inkKeyframes(lines: number): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let line = 0; line < lines; line += 1) {
    frames.push({ offset: line / lines, "--ink-line": line, "--ink-x": 0 });
    frames.push({ offset: (line + 1) / lines - 1e-4, "--ink-line": line, "--ink-x": 1 });
  }
  frames.push({ offset: 1, "--ink-line": lines, "--ink-x": 0 });
  return frames;
}

function blockLines(block: HTMLElement) {
  const lineHeight = Number.parseFloat(getComputedStyle(block).lineHeight) || 22;
  const lines = Math.max(1, Math.round(block.getBoundingClientRect().height / lineHeight));
  return { lineHeight, lines };
}

/**
 * When the streamed text being revealed now will be fully shown
 * (performance.now() time). The follow scroll paces itself to arrive then,
 * moving continuously with the reveal instead of hopping to each block.
 */
let latestRevealEndsAt = 0;
export function streamingRevealEndsAt() {
  return latestRevealEndsAt;
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
 * heading…) shows at once, lighter, and is inked in line by line from left to
 * right, one block after the other, instead of appearing in one frame; the
 * first one too, which arrives with the message's row. Blocks that
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
    // Blocks ink in one after the other: a block waits for the one before it.
    let revealEndsAt = 0;
    const enterNewBlocks = () => {
      const blocks = streamedBlocks(root);
      for (const block of blocks.slice(entered)) {
        if (typeof block.animate !== "function") continue;
        const now = performance.now();
        // A short lead: the follow scroll is already moving when it starts showing.
        const delay = Math.max(REVEAL_LEAD_MS, revealEndsAt - now);
        const { lineHeight, lines } = blockLines(block);
        const duration = Math.min(MAX_INK_MS, lines * INK_MS_PER_LINE);
        revealEndsAt = now + delay + duration;
        latestRevealEndsAt = Math.max(latestRevealEndsAt, revealEndsAt);
        block.style.setProperty("--ink-lh", `${lineHeight}px`);
        block.classList.add("streamed-ink");
        const ink = block.animate(inkKeyframes(lines), {
          duration,
          delay,
          easing: "linear",
          fill: "backwards",
        });
        const inked = () => block.classList.remove("streamed-ink");
        ink.finished.then(inked, inked);
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
