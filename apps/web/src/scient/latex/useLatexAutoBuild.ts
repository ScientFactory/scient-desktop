import { useEffect, useRef } from "react";

/** PDF visibility owns compilation; status polling remains observational. */
export function useLatexAutoBuild(input: {
  visible: boolean;
  needsBuild: boolean;
  blocked: boolean;
  busy: boolean;
  toolchainReady: boolean;
  sourceKey: string;
  lastEditAt: number;
  requestBuild: () => void;
}) {
  const attempted = useRef<string | null>(null);
  const wasVisible = useRef(false);
  useEffect(() => {
    const opening = input.visible && !wasVisible.current;
    wasVisible.current = input.visible;
    if (!input.visible) {
      attempted.current = null;
      return;
    }
    if (opening) attempted.current = null;
    if (
      !input.needsBuild ||
      input.blocked ||
      input.busy ||
      !input.toolchainReady ||
      attempted.current === input.sourceKey
    )
      return;
    const delay = opening ? 0 : Math.max(0, 2500 - (Date.now() - input.lastEditAt));
    const timer = setTimeout(() => {
      attempted.current = input.sourceKey;
      input.requestBuild();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    input.visible,
    input.needsBuild,
    input.blocked,
    input.busy,
    input.toolchainReady,
    input.sourceKey,
    input.lastEditAt,
    input.requestBuild,
  ]);
}
