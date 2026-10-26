import { useEffect, useRef } from "react";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/**
 * Only the latest live activity sweeps; earlier in-progress rows stay still to avoid page-wide
 * shimmer. The header uses a breathing dot unless it is itself the current compaction/worktree
 * activity. Keep sweep speed independent of label length.
 */

/**
 * The row whose activity sweeps: the latest live activity row, if any. While
 * a compaction or worktree preparation has no row of its own yet, the
 * Thinking row stands empty and the working header's own label
 * ("Compacting…", "Setting up worktree…") is the activity instead.
 */
export function currentLiveActivityRowId(
  rows: readonly MessagesTimelineRow[],
  activityInHeader = false,
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (row.kind === "thinking" && activityInHeader) {
      // The Thinking row stands empty: a compaction or setup row of its own
      // is the activity once it exists, until then the header's label.
      const owner = rows.findLast(
        (candidate) =>
          (candidate.kind === "context-compaction" && candidate.active) ||
          (candidate.kind === "worktree-setup" &&
            candidate.snapshot.phase === "running" &&
            candidate.snapshot.stages.some((stage) => stage.status === "running")),
      );
      return owner?.id ?? rows.find((candidate) => candidate.kind === "working")?.id ?? null;
    }
    if (row.kind === "worktree-setup" && row.snapshot.phase === "running") {
      // Until a stage runs (the setup has just begun), the header's
      // "Setting up worktree…" is the activity.
      return row.snapshot.stages.some((stage) => stage.status === "running")
        ? row.id
        : (rows.find((candidate) => candidate.kind === "working")?.id ?? row.id);
    }
    if (
      row.kind === "thinking" ||
      (row.kind === "work-live" && row.active) ||
      (row.kind === "context-compaction" && row.active) ||
      // A running compaction that owns the working row has no divider of its own yet.
      (row.kind === "working" && row.compacting !== undefined)
    )
      return row.id;
  }
  return null;
}

/** The light's speed across a label, in CSS pixels per second. */
const SWEEP_PX_PER_SECOND = 160;
/** The band's width (the CSS --live-activity-focus-width), in rem. */
const SWEEP_BAND_REM = 7;
const SWEEP_ANIMATION_NAMES = new Set([
  "scient-live-activity-sweep",
  "scient-live-activity-sweep-counter",
]);

/** A label's sweep cycle, in seconds: the same pace for any width. */
export function liveActivitySweepSeconds(labelWidthPx: number, remPx: number): number {
  // The light travels from just before the label to just past it (the label
  // plus its own width), and the next pass starts right away.
  const travelPx = labelWidthPx + SWEEP_BAND_REM * remPx;
  return travelPx / SWEEP_PX_PER_SECOND;
}

/**
 * A ref for a sweeping label's container: sets its sweep cycle from its width,
 * and pauses it off screen. The width is measured again between passes (the
 * light is then past the label), so a new label keeps the pace and a ticking
 * timer never jolts a pass in progress.
 */
export function observeLiveActivitySweep(element: HTMLElement | null) {
  if (element === null) return;
  const measure = () => {
    const remPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const seconds = liveActivitySweepSeconds(element.getBoundingClientRect().width, remPx);
    const value = `${seconds.toFixed(2)}s`;
    if (element.style.getPropertyValue("--live-activity-duration") === value) return false;
    element.style.setProperty("--live-activity-duration", value);
    return true;
  };
  measure();
  const onPassEnd = (event: AnimationEvent) => {
    if (event.animationName !== "scient-live-activity-sweep" || !measure()) return;
    // A new duration keeps the time already played, which would land the
    // light midway across the label: start the new cycle (and its counter
    // motion) from the beginning, as the old one ended.
    for (const animation of element.getAnimations({ subtree: true })) {
      if (animation instanceof CSSAnimation && SWEEP_ANIMATION_NAMES.has(animation.animationName))
        animation.currentTime = 0;
    }
  };
  element.addEventListener("animationiteration", onPassEnd);
  const stopObserving = observeVisibleAnimation(element);
  return () => {
    element.removeEventListener("animationiteration", onPassEnd);
    stopObserving?.();
  };
}

/** The working header's steady cue: a small dot that gently breathes. */
export function LiveActivityDot() {
  return <span aria-hidden ref={observeVisibleAnimation} className="live-activity-dot" />;
}

/** A step this young shows no timer: only one that runs long needs to prove it is alive. */
const LIVE_STEP_TIMER_AFTER_MS = 10_000;

function liveStepElapsedSuffix(startedAt: string, formatElapsed: (startedAt: string) => string) {
  const elapsedMs = Date.now() - Date.parse(startedAt);
  return Number.isFinite(elapsedMs) && elapsedMs >= LIVE_STEP_TIMER_AFTER_MS
    ? ` · ${formatElapsed(startedAt)}`
    : "";
}

/**
 * How long a step that is still running has run ("· 12s"), once it has run
 * long enough to wonder. Ticks through DOM writes, like the turn's own timer,
 * whose format it takes (`formatElapsed`, the timeline's working-timer text).
 */
export function LiveStepElapsed({
  startedAt,
  formatElapsed,
}: {
  startedAt: string;
  formatElapsed: (startedAt: string) => string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = liveStepElapsedSuffix(startedAt, formatElapsed);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = liveStepElapsedSuffix(startedAt, formatElapsed);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [startedAt, formatElapsed]);

  return (
    <span ref={textRef} className="shrink-0 whitespace-pre tabular-nums">
      {initialText}
    </span>
  );
}
