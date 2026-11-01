import { useLayoutEffect } from "react";
// @effect-diagnostics globalTimers:off -- One zero-delay turn distinguishes Strict Mode rehearsal from final unmount.
import { useEffect, useRef } from "react";

/**
 * Finalizes an abandoned editor instance after one browser task. A same-
 * instance React Strict Mode effect reactivation cancels the pending task;
 * discarded rehearsal instances and real unmounts release their resources.
 */
export function useFinalUnmount(finalize: () => void): void {
  const finalizeRef = useRef(finalize);
  const finalizerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps finalizeRef holding the latest finalizer
  useLayoutEffect(() => {
    finalizeRef.current = finalize;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the finalizer on a deferred timer after the final unmount, cancelled if remounted
  useEffect(() => {
    if (finalizerTimerRef.current !== null) {
      clearTimeout(finalizerTimerRef.current);
      finalizerTimerRef.current = null;
    }
    return () => {
      finalizerTimerRef.current = setTimeout(() => {
        finalizerTimerRef.current = null;
        finalizeRef.current();
      }, 0);
    };
  }, []);
}
