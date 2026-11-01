import type { ComputeCitation, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { resolveAssistantCitationRange } from "~/lib/assistantTextSelection";

const HIGHLIGHT_NAME = "t3-assistant-citation";
const HIGHLIGHT_OPACITY = "--assistant-citation-highlight-opacity";
const HIGHLIGHT_PEAK = 0.45;
const HIGHLIGHT_MS = 2_000;
/** How long a quote's text may take to reach the page before its whole place is marked. */
const LATE_QUOTE_MS = 1_500;
/** How long a slow output may still bring the quote itself. */
const GIVE_UP_MS = 15_000;

interface ComputeQuoteRevealState {
  /** The quote waiting for its surface to show it; the surface may still be loading. */
  readonly pending: ComputeCitation | null;
}

const useComputeQuoteReveal = create<ComputeQuoteRevealState>(() => ({ pending: null }));

let stopWaiting: (() => void) | null = null;

export function requestComputeQuoteReveal(citation: ComputeCitation): void {
  useComputeQuoteReveal.setState({ pending: { ...citation } });
}

export function finishComputeQuoteReveal(citation: ComputeCitation): void {
  useComputeQuoteReveal.setState((state) =>
    state.pending === citation ? { pending: null } : state,
  );
}

/** Another quote was asked for, or the reader left the conversation. */
export function cancelComputeQuoteReveal(): void {
  stopWaiting?.();
  useComputeQuoteReveal.setState({ pending: null });
}

/** The quote waiting in this conversation, as `select` reads it. */
export function usePendingComputeQuote<Selected>(
  thread: ScopedThreadRef,
  select: (citation: ComputeCitation) => Selected | null,
): Selected | null {
  return useComputeQuoteReveal(({ pending }) =>
    pending !== null &&
    pending.environmentId === thread.environmentId &&
    pending.threadId === thread.threadId
      ? select(pending)
      : null,
  );
}

function scrollToArea(area: Range, scroller: HTMLElement): void {
  const top = area.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += top - Math.min(120, scroller.clientHeight / 3);
}

const isInPlace = (range: Range, source: HTMLElement) =>
  !range.collapsed && source.contains(range.startContainer) && source.contains(range.endContainer);

/**
 * Brings the quote into view and marks it. Output loads late and code is redrawn as its cell leaves
 * the editor, so the quote is found again until shown, its whole place is marked if it has not
 * arrived, and a quote landing after that leaves the reader's scroll alone.
 */
export function showComputeQuote(input: {
  readonly source: HTMLElement;
  readonly scroller: HTMLElement;
  readonly citation: ComputeCitation;
}): void {
  const { source, scroller, citation } = input;
  stopWaiting?.();
  const place = source.ownerDocument.createRange();
  place.selectNodeContents(source);
  let quote: Range | null = null;
  let highlight: Highlight | null = null;
  let pulse: Animation | null = null;
  let placeMarked = false;

  const stop = () => {
    observer.disconnect();
    clearTimeout(markPlace);
    clearTimeout(giveUp);
    pulse?.cancel();
    if (stopWaiting === stop) stopWaiting = null;
  };
  const pulseEnded = () => {
    pulse = null;
    if (highlight !== null && CSS.highlights.get(HIGHLIGHT_NAME) === highlight) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
    }
    if (quote !== null) stop();
  };
  const mark = (area: Range) => {
    if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) return;
    highlight = new Highlight(area);
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
    if (pulse !== null) return;
    pulse = source.animate(
      [
        { offset: 0, [HIGHLIGHT_OPACITY]: HIGHLIGHT_PEAK },
        { offset: 0.75, [HIGHLIGHT_OPACITY]: HIGHLIGHT_PEAK },
        { offset: 1, [HIGHLIGHT_OPACITY]: 0 },
      ],
      { duration: HIGHLIGHT_MS, easing: "ease-in-out" },
    );
    pulse.finished.then(pulseEnded, pulseEnded);
  };
  const findQuote = () => {
    const found = resolveAssistantCitationRange(source, citation);
    if (found === null) return;
    if (quote === null && !placeMarked) scrollToArea(found, scroller);
    quote = found;
    mark(found);
  };
  const observer = new MutationObserver(() => {
    if (quote === null || !isInPlace(quote, source)) findQuote();
  });
  const markPlace = setTimeout(() => {
    if (quote !== null) return;
    placeMarked = true;
    mark(place);
  }, LATE_QUOTE_MS);
  const giveUp = setTimeout(stop, GIVE_UP_MS);
  stopWaiting = stop;

  findQuote();
  if (quote === null) scrollToArea(place, scroller);
  observer.observe(source, { childList: true, subtree: true, characterData: true });
}
