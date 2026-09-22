import type { EnvironmentId, ScientLatexResolveResult } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { requestLatexResolution } from "./client";

export interface LatexDocumentResolutionState {
  readonly pending: boolean;
  readonly result: ScientLatexResolveResult | null;
  readonly error: string | null;
}

const INITIAL_STATE: LatexDocumentResolutionState = {
  pending: true,
  result: null,
  error: null,
};

export function useLatexDocumentResolution(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly sourceRelativePath: string;
  readonly sourceRevision: string;
  readonly contextRootRelativePath?: string;
}): LatexDocumentResolutionState {
  const requestRef = useRef(0);
  const [state, setState] = useState<LatexDocumentResolutionState>(INITIAL_STATE);

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setState((current) => ({ ...current, pending: true, error: null }));
    void requestLatexResolution(input.environmentId, {
      workspaceRoot: input.workspaceRoot,
      sourceRelativePath: input.sourceRelativePath,
      ...(input.contextRootRelativePath === undefined
        ? {}
        : { contextRootRelativePath: input.contextRootRelativePath }),
    })
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setState({ pending: false, result, error: null });
      })
      .catch((error: unknown) => {
        if (requestRef.current !== requestId) return;
        setState({
          pending: false,
          result: null,
          error: error instanceof Error ? error.message : "LaTeX document resolution failed.",
        });
      });
    return () => {
      if (requestRef.current === requestId) requestRef.current += 1;
    };
  }, [
    input.contextRootRelativePath,
    input.environmentId,
    input.sourceRelativePath,
    input.sourceRevision,
    input.workspaceRoot,
  ]);

  return state;
}
