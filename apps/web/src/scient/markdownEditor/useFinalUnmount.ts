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
  finalizeRef.current = finalize;

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
