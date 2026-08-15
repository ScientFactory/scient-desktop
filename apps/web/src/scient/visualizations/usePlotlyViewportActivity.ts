import { useEffect, useRef, useState } from "react";

import { plotlyWebGlActivityPool } from "./plotlyWebGlActivityPool";

export const PLOTLY_WEBGL_RELEASE_DELAY_MS = 1_500;

export function plotlyViewportDecision(input: {
  readonly everActivated: boolean;
  readonly hasWebGl: boolean;
  readonly nearViewport: boolean;
}): "activate" | "ignore" | "schedule-release" {
  if (input.nearViewport) return "activate";
  return input.hasWebGl && input.everActivated ? "schedule-release" : "ignore";
}

/**
 * SVG figures stay mounted after first use. WebGL figures release their contexts
 * after leaving the viewport margin and remount before becoming visible again.
 */
export function usePlotlyViewportActivity(
  hasWebGl: boolean,
  onDeactivate?: (() => void) | undefined,
  forceActive = false,
  suspend = false,
): {
  readonly active: boolean;
  readonly ref: (node: HTMLDivElement | null) => void;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);
  const everActivatedRef = useRef(false);
  const onDeactivateRef = useRef(onDeactivate);
  onDeactivateRef.current = onDeactivate;

  useEffect(() => {
    if (element == null) return;
    const webGlRegistration = hasWebGl
      ? plotlyWebGlActivityPool.register({
          activate: () => setActive(true),
          deactivate: () => {
            onDeactivateRef.current?.();
            setActive(false);
          },
        })
      : null;
    if (suspend) {
      if (webGlRegistration == null) setActive(false);
      else webGlRegistration.setNearViewport(false);
      return () => webGlRegistration?.unregister();
    }
    if (typeof IntersectionObserver === "undefined") {
      everActivatedRef.current = true;
      if (webGlRegistration == null) setActive(true);
      else webGlRegistration.setNearViewport(true);
      return () => webGlRegistration?.unregister();
    }
    if (forceActive) {
      everActivatedRef.current = true;
      if (webGlRegistration == null) setActive(true);
      else webGlRegistration.setNearViewport(true);
      return () => webGlRegistration?.unregister();
    }

    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const clearReleaseTimer = () => {
      if (releaseTimer == null) return;
      clearTimeout(releaseTimer);
      releaseTimer = null;
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const near = entries.some((entry) => entry.isIntersecting);
        const decision = plotlyViewportDecision({
          everActivated: everActivatedRef.current,
          hasWebGl,
          nearViewport: near,
        });
        if (decision === "activate") {
          clearReleaseTimer();
          everActivatedRef.current = true;
          if (webGlRegistration == null) setActive(true);
          else webGlRegistration.setNearViewport(true);
          return;
        }
        if (decision === "ignore") return;
        clearReleaseTimer();
        releaseTimer = setTimeout(() => {
          releaseTimer = null;
          webGlRegistration?.setNearViewport(false);
        }, PLOTLY_WEBGL_RELEASE_DELAY_MS);
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(element);
    return () => {
      clearReleaseTimer();
      observer.disconnect();
      webGlRegistration?.unregister();
    };
  }, [element, forceActive, hasWebGl, suspend]);

  return { active, ref: setElement };
}
