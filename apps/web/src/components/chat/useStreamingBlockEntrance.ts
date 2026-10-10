import { type RefObject, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { motionClock } from "./motionClock";

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
/** The blank space between blocks is crossed this much faster: no pause between paragraphs. */
const REVEAL_GAP_SPEEDUP = 5;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** A message's content height and its blocks' vertical extents, from its top. */
interface RevealGeometry {
  readonly height: number;
  readonly blocks: ReadonlyArray<readonly [top: number, bottom: number]>;
}

function measureGeometry(root: HTMLElement): RevealGeometry {
  const top = root.getBoundingClientRect().top;
  const blocks: Array<readonly [number, number]> = [];
  for (const child of root.children) {
    const rect = child.getBoundingClientRect();
    if (rect.height > 0) blocks.push([rect.top - top, rect.bottom - top]);
  }
  return { height: root.scrollHeight, blocks };
}

/** Whether the front is in the blank space before or between the message's blocks. */
function inBlankGap(geometry: RevealGeometry, front: number) {
  let previousBottom = 0;
  for (const [top, bottom] of geometry.blocks) {
    if (front < top) return front >= previousBottom;
    previousBottom = bottom;
    if (front < previousBottom) return false;
  }
  return false;
}

/**
 * Messages whose lines are appearing right now (past the short wait, not yet
 * all shown, and mounted). The live "Thinking" row stays out of the way while
 * they do.
 */
const appearing = new Set<string>();
const appearingListeners = new Set<() => void>();
/** Anything a reveal changed: a front advancing, or a message starting or ending its reveal. */
const revealListeners = new Set<() => void>();
function notifyReveal() {
  for (const listener of revealListeners) listener();
}
function setAppearing(messageId: string, isAppearing: boolean) {
  if (appearing.has(messageId) === isAppearing) return;
  if (isAppearing) appearing.add(messageId);
  else appearing.delete(messageId);
  for (const listener of appearingListeners) listener();
  notifyReveal();
}
function subscribeAppearing(listener: () => void) {
  appearingListeners.add(listener);
  return () => appearingListeners.delete(listener);
}
/** Messages with a reveal under way here: waiting to start, appearing, or caught up. */
const revealing = new Set<string>();
/** Whether this message is being revealed here (mounted, not yet all shown). */
export function streamingRevealActive(messageId: string): boolean {
  return revealing.has(messageId);
}
/** Whether this message's lines are appearing right now. */
export function streamingTextAppearing(messageId: string): boolean {
  return appearing.has(messageId);
}
/** Whether this message's lines are appearing right now, as React state. */
export function useStreamingTextAppearing(messageId: string | null): boolean {
  return useSyncExternalStore(
    subscribeAppearing,
    () => messageId !== null && appearing.has(messageId),
    () => false,
  );
}
/** Calls `listener` whenever a reveal advances, starts or ends. */
export function subscribeStreamingReveal(listener: () => void) {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

/**
 * How far each streaming message has been revealed, in pixels from its top.
 * Kept outside the component: the list remounts rows that scroll out of view
 * and back, and text already revealed never replays. Bounded, oldest first.
 */
const revealedHeights = new Map<string, number>();
const MAX_TRACKED_MESSAGES = 100;

function trackRevealed(messageId: string, height: number) {
  revealedHeights.delete(messageId);
  revealedHeights.set(messageId, height);
  if (revealedHeights.size <= MAX_TRACKED_MESSAGES) return;
  const oldest = revealedHeights.keys().next().value;
  if (oldest === undefined) return;
  revealedHeights.delete(oldest);
  setAppearing(oldest, false);
}

/**
 * Reveals a streaming message line by line (see above). A message that was
 * never revealed here (finished before it mounted), and reduced motion, are
 * shown as they are. Once the reveal has caught up with a message still
 * streaming, it rests until the message's content or width changes.
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
    if (!root || !messageId || typeof window === "undefined") return;
    const reducedMotion = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (reducedMotion?.matches) return;
    const known = revealedHeights.get(messageId);
    // A finished message never revealed here is simply shown.
    if (!isStreaming && known === undefined) return;
    const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 22;
    let front = known ?? 0;
    // Text arriving with the message waits briefly; a remounted reveal continues.
    const startsAt = motionClock.now() + (known === undefined ? REVEAL_BUFFER_MS : 0);
    let last = motionClock.now();
    let frame: number | null = null;
    let geometry: RevealGeometry | null = null;
    let width = root.getBoundingClientRect().width;
    const apply = () => {
      root.style.setProperty("--reveal-front", `${front}px`);
      root.style.setProperty("--reveal-line", `${lineHeight}px`);
    };
    const clear = () => {
      root.classList.remove("streamed-reveal");
      root.style.removeProperty("--reveal-front");
      root.style.removeProperty("--reveal-line");
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (revealing.delete(messageId)) notifyReveal();
      mutations.disconnect();
      resizes.disconnect();
      root.removeEventListener("load", onContentChange, true);
      reducedMotion?.removeEventListener?.("change", onMotionPreference);
    };
    const finish = () => {
      stop();
      revealedHeights.delete(messageId);
      setAppearing(messageId, false);
      clear();
    };
    const tick = () => {
      frame = null;
      const now = motionClock.now();
      const elapsed = Math.min(50, Math.max(0, now - last));
      last = now;
      // The short wait reads no layout; it only counts down.
      if (now < startsAt) {
        frame = requestAnimationFrame(tick);
        return;
      }
      geometry ??= measureGeometry(root);
      // The full tone trails the appearing text by a line; both finish together.
      const end = geometry.height + lineHeight;
      if (front < end) {
        const waitingLines = (geometry.height - front) / lineHeight;
        const speed =
          ((REVEAL_LINES_PER_SECOND * lineHeight) / 1000) *
          Math.max(1, waitingLines / REVEAL_MAX_LAG_LINES) *
          (inBlankGap(geometry, front) ? REVEAL_GAP_SPEEDUP : 1);
        front = Math.min(end, front + speed * elapsed);
        apply();
        revealedHeights.set(messageId, front);
        setAppearing(messageId, front > 0);
        notifyReveal();
      }
      if (front < end) frame = requestAnimationFrame(tick);
      else if (!streamingRef.current) finish();
      // Caught up while the message still streams: rest until it changes.
    };
    const wake = () => {
      if (frame !== null) return;
      last = motionClock.now();
      frame = requestAnimationFrame(tick);
    };
    function onContentChange() {
      geometry = null;
      wake();
    }
    function onMotionPreference() {
      if (reducedMotion?.matches) finish();
    }
    const mutations = new MutationObserver(onContentChange);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    // The revealed height changes every frame; only a new width reflows the text.
    const resizes = new ResizeObserver(() => {
      const next = root.getBoundingClientRect().width;
      if (Math.abs(next - width) < 0.5) return;
      width = next;
      onContentChange();
    });
    resizes.observe(root);
    // Images and diagrams inside the answer change its height when they load.
    root.addEventListener("load", onContentChange, true);
    reducedMotion?.addEventListener?.("change", onMotionPreference);
    revealing.add(messageId);
    root.classList.add("streamed-reveal");
    apply();
    trackRevealed(messageId, front);
    // A remounted reveal is still appearing: say so before the next paint.
    if (known !== undefined) setAppearing(messageId, front > 0);
    frame = requestAnimationFrame(tick);
    return () => {
      stop();
      // Unmounted or restarted: no longer appearing; its progress is kept.
      setAppearing(messageId, false);
      clear();
    };
  }, [rootRef, isStreaming, messageId]);
}
