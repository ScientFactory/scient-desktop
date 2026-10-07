import { useCallback, useMemo } from "react";
import { DRAFT_HERO_TRANSITION_EASING } from "./draftHeroTransition";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { WorkingRowExit } from "./workingRowExit";
import { useMediaQuery } from "../../hooks/useMediaQuery";

/**
 * Entrances already played. The list remounts rows that scroll out of view
 * and back; a played entrance never replays. Bounded: the oldest are dropped,
 * long after their rows could still be entering.
 */
const playedEntrances = new Set<string>();
const MAX_PLAYED_ENTRANCES = 200;
function markPlayed(key: string) {
  playedEntrances.add(key);
  if (playedEntrances.size <= MAX_PLAYED_ENTRANCES) return;
  const oldest = playedEntrances.values().next().value;
  if (oldest !== undefined) playedEntrances.delete(oldest);
}

/**
 * A ref callback that plays an entrance on the element the first time `key`
 * mounts, unless the reader prefers reduced motion. A null key plays nothing.
 */
export function useEntranceMotion(
  key: string | null,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
) {
  // Pass module constants for the keyframes and options, so the callback is stable.
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element || key === null || playedEntrances.has(key)) return;
      markPlayed(key);
      if (
        typeof element.animate !== "function" ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      )
        return;
      element.animate(keyframes, {
        // The composer's curve, so the send choreography moves as one.
        easing: DRAFT_HERO_TRANSITION_EASING,
        fill: "backwards",
        ...options,
      });
    },
    [key, keyframes, options],
  );
}

// A thread's first prompt is revealed from the top down as the composer lands.
// Clip and opacity only: a transform would shift where the reveal measures it.
const PROMPT_ENTRANCE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, clipPath: "inset(0 0 100% 0)" },
  { opacity: 1, clipPath: "inset(0 0 0 0)" },
];
const PROMPT_ENTRANCE_TIMING: KeyframeAnimationOptions = { duration: 300, delay: 100 };

/** A ref callback for a prompt's bubble: it plays the entrance while that prompt is entering. */
export function usePromptEntrance(promptId: string, enteringPromptId: string | null) {
  return useEntranceMotion(
    enteringPromptId === promptId ? `prompt:${promptId}` : null,
    PROMPT_ENTRANCE_KEYFRAMES,
    PROMPT_ENTRANCE_TIMING,
  );
}

/** The send motion rows read from the timeline (see `useTimelineSendMotion`). */
export interface TimelineSendMotion {
  /** A thread's first prompt while it is being placed: it plays its entrance. */
  readonly enteringPromptId: string | null;
  /** The answer right above the live "Thinking" row, if any: it hides while that text appears. */
  readonly thinkingFollowsAnswerId: string | null;
  /** The working header's exit (chat/workingRowExit.ts). */
  readonly workingRowExit: WorkingRowExit;
}

export function useTimelineSendMotion(input: {
  rows: readonly MessagesTimelineRow[];
  /** Only a first prompt is placed with pending positioning (later ones are revealed). */
  timelinePositioningPending: boolean;
  anchorMessageId: string | null;
  workingRowExit: WorkingRowExit;
}): TimelineSendMotion {
  const { rows, workingRowExit } = input;
  const enteringPromptId = input.timelinePositioningPending ? input.anchorMessageId : null;
  const thinkingFollowsAnswerId = useMemo(() => {
    const index = rows.findIndex((row) => row.kind === "thinking");
    const previous = index > 0 ? rows[index - 1] : undefined;
    return previous?.kind === "message" && previous.message.role === "assistant"
      ? previous.message.id
      : null;
  }, [rows]);
  return useMemo(
    () => ({ enteringPromptId, thinkingFollowsAnswerId, workingRowExit }),
    [enteringPromptId, thinkingFollowsAnswerId, workingRowExit],
  );
}

/** The composer's move between the draft hero and the thread: quick, continuous. */
const DRAFT_HERO_TRANSITION_DURATION_MS = 260;

/**
 * The draft composer's move to the thread always animates (not only with the
 * opt-in panel animation setting), unless the reader prefers reduced motion.
 */
export function useDraftHeroMotion() {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  return { animate: !reducedMotion, durationMs: DRAFT_HERO_TRANSITION_DURATION_MS };
}
