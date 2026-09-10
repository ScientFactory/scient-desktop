import { useEffect, useRef, useState } from "react";
import { advanceDownloadProgress, normalizeDownloadProgress } from "./scientDownloadProgress";

/** Never use this value for updater actions or completion decisions. */
export function useScientDownloadProgress({
  status,
  version,
  percent,
  reducedMotion,
}: {
  readonly status: string | undefined;
  readonly version: string | null | undefined;
  readonly percent: number | null;
  readonly reducedMotion: boolean;
}): number | null {
  const target = normalizeDownloadProgress(percent);
  const key = JSON.stringify([status, version]);
  const [display, setDisplay] = useState({ key, target, value: target });
  const engine = useRef({ key, target, value: target, velocity: 0 });

  useEffect(() => {
    let request: number | undefined;
    let disposed = false;
    let previousTime = performance.now();
    const current = engine.current;
    const snap = () => {
      engine.current = { key, target, value: target, velocity: 0 };
      setDisplay({ key, target, value: target });
    };
    if (
      status !== "downloading" ||
      reducedMotion ||
      target === null ||
      current.key !== key ||
      current.value === null ||
      current.target === null ||
      target < current.target ||
      document.hidden
    ) {
      snap();
    } else {
      current.target = target;
    }

    const tick = (now: number) => {
      if (disposed || target === null || engine.current.value === null) return;
      const next = advanceDownloadProgress(
        { value: engine.current.value, velocity: engine.current.velocity },
        target,
        now - previousTime,
      );
      previousTime = now;
      engine.current = { key, target, ...next };
      setDisplay({ key, target, value: next.value });
      if (next.value < target) request = requestAnimationFrame(tick);
    };
    const onVisibilityChange = () => {
      if (request !== undefined) cancelAnimationFrame(request);
      // Resuming a hidden window should show current facts, not stale animation.
      snap();
    };
    if (status === "downloading" && !reducedMotion && target !== null && !document.hidden) {
      if (engine.current.value !== null && engine.current.value < target) {
        request = requestAnimationFrame(tick);
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (request !== undefined) cancelAnimationFrame(request);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [key, target, status, reducedMotion]);

  // Clamp during render too: effects must never leave one frame above a correction.
  if (
    status !== "downloading" ||
    reducedMotion ||
    target === null ||
    display.key !== key ||
    display.value === null ||
    (display.target !== null && target < display.target)
  )
    return target;
  return Math.min(target, display.value);
}
