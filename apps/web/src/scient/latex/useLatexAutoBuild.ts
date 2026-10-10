import { useEffect, useRef } from "react";

/** Interim open-PDF trigger. Timed builds belong to the shared scheduler. */
export function useLatexAutoBuild(input: {
  visible: boolean;
  needsBuild: boolean;
  blocked: boolean;
  busy: boolean;
  toolchainReady: boolean;
  sourceKey: string;
  requestBuild: () => void;
}) {
  const attempted = useRef<string | null>(null);
  const wasVisible = useRef(false);
  const openingPending = useRef(false);
  useEffect(() => {
    const opening = input.visible && !wasVisible.current;
    wasVisible.current = input.visible;
    if (!input.visible) {
      attempted.current = null;
      openingPending.current = false;
      return;
    }
    if (opening) {
      attempted.current = null;
      openingPending.current = true;
    }
    if (!input.needsBuild && !input.blocked && !input.busy) openingPending.current = false;
    if (
      !openingPending.current ||
      !input.needsBuild ||
      input.blocked ||
      input.busy ||
      !input.toolchainReady ||
      attempted.current === input.sourceKey
    )
      return;
    const timer = setTimeout(() => {
      openingPending.current = false;
      attempted.current = input.sourceKey;
      input.requestBuild();
    }, 0);
    return () => clearTimeout(timer);
  }, [
    input.visible,
    input.needsBuild,
    input.blocked,
    input.busy,
    input.toolchainReady,
    input.sourceKey,
    input.requestBuild,
  ]);
}
