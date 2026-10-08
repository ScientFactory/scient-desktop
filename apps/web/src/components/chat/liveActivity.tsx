import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/**
 * Live activity: what tells the reader the agent is working, kept calm.
 *
 * - Only the current activity sweeps: the latest live row (Thinking, the
 *   running-tool bar, an active compaction or a running worktree setup).
 *   Other work in progress (earlier groups still running, expanded entries)
 *   stays still, so the page never shimmers all over.
 * - The working header carries a small breathing dot instead of a sweep; its
 *   label sweeps only while it is the activity itself (compacting, or
 *   preparing a worktree before that has a row of its own).
 * - The sweep moves at one pace for any label length and rests between
 *   passes (scient/presentation/scient-live-activity.css).
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
          (candidate.kind === "worktree-setup" && candidate.snapshot.phase === "running"),
      );
      return owner?.id ?? rows.find((candidate) => candidate.kind === "working")?.id ?? null;
    }
    if (
      row.kind === "thinking" ||
      (row.kind === "work-live" && row.active) ||
      (row.kind === "context-compaction" && row.active) ||
      (row.kind === "worktree-setup" && row.snapshot.phase === "running")
    )
      return row.id;
  }
  return null;
}

/** The light's speed across a label, in CSS pixels per second. */
const SWEEP_PX_PER_SECOND = 160;
/** The band's width (the CSS --live-activity-focus-width), in rem. */
const SWEEP_BAND_REM = 7;
/** The pass takes this share of each cycle; the rest is a pause between passes. */
const SWEEP_PASS_SHARE = 0.8;

/** A label's sweep cycle, in seconds: the same pace for any width. */
export function liveActivitySweepSeconds(labelWidthPx: number, remPx: number): number {
  // The light travels the label plus its own width on both sides.
  const travelPx = labelWidthPx + 2 * SWEEP_BAND_REM * remPx;
  return travelPx / SWEEP_PX_PER_SECOND / SWEEP_PASS_SHARE;
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
    element.style.setProperty("--live-activity-duration", `${seconds.toFixed(2)}s`);
  };
  measure();
  const onPassEnd = (event: AnimationEvent) => {
    if (event.animationName === "scient-live-activity-sweep") measure();
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
