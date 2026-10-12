import { useEffect, useRef } from "react";
import {
  DEFAULT_LATEX_COMPILATION,
  LATEX_AUTO_COMPILE_DELAY_MS,
  type LatexCompilationMode,
} from "./latexCompilation";

/** Schedule a settled document; the existing build coordinator owns execution and reruns. */
export function useLatexAutoBuild(input: {
  mode?: LatexCompilationMode;
  documentKey?: string;
  visible: boolean;
  needsBuild: boolean;
  blocked: boolean;
  busy: boolean;
  toolchainReady: boolean;
  sourceKey: string;
  requestBuild: () => void;
}) {
  const {
    visible,
    needsBuild,
    blocked,
    busy,
    toolchainReady,
    sourceKey,
    requestBuild,
    documentKey,
  } = input;
  const mode = input.mode ?? DEFAULT_LATEX_COMPILATION;
  const attempted = useRef<string | null>(null);
  const wasVisible = useRef(false);
  const openingPending = useRef(false);
  const policy = useRef("");
  useEffect(() => {
    const nextPolicy = `${documentKey ?? ""}\0${mode}`;
    if (policy.current !== nextPolicy) {
      policy.current = nextPolicy;
      attempted.current = null;
      wasVisible.current = false;
      openingPending.current = false;
    }
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (mode === "manual") return;
    if (mode === "on-save" && !visible) {
      attempted.current = null;
      openingPending.current = false;
      return;
    }
    if (mode === "on-save" && opening) {
      attempted.current = null;
      openingPending.current = true;
    }
    if (!needsBuild && !blocked && !busy) {
      openingPending.current = false;
      // A later outside edit can make this PDF stale without changing the selected file.
      attempted.current = null;
    }
    if (
      (mode === "on-save" && !openingPending.current) ||
      !needsBuild ||
      blocked ||
      busy ||
      !toolchainReady ||
      attempted.current === sourceKey
    )
      return;
    const timer = setTimeout(
      () => {
        openingPending.current = false;
        attempted.current = sourceKey;
        requestBuild();
      },
      mode === "auto" ? LATEX_AUTO_COMPILE_DELAY_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [
    visible,
    mode,
    documentKey,
    needsBuild,
    blocked,
    busy,
    toolchainReady,
    sourceKey,
    requestBuild,
  ]);
}
