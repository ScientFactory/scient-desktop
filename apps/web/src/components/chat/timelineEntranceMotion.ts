import { useCallback } from "react";
import { DRAFT_HERO_TRANSITION_EASING } from "./draftHeroTransition";

/**
 * Entrances already played. The list remounts rows that scroll out of view
 * and back; a played entrance never replays.
 */
const playedEntrances = new Set<string>();

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
      playedEntrances.add(key);
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
