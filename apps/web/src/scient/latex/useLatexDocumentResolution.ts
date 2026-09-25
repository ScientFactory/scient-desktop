import type { EnvironmentId, ScientLatexResolveResult } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { requestLatexResolution } from "./client";

interface StoredLatexDocumentResolution {
  readonly requestKey: string;
  readonly result: ScientLatexResolveResult | null;
  readonly error: string | null;
}

export interface LatexDocumentResolutionState extends Omit<
  StoredLatexDocumentResolution,
  "requestKey"
> {
  readonly pending: boolean;
}

export function useLatexDocumentResolution(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly sourceRelativePath: string;
  readonly sourceRevision: string;
  readonly contextRootRelativePath?: string;
}): LatexDocumentResolutionState {
  const requestRef = useRef(0);
  const [state, setState] = useState<StoredLatexDocumentResolution | null>(null);
  const request = useMemo(
    () => ({
      environmentId: input.environmentId,
      key: JSON.stringify([
        input.environmentId,
        input.workspaceRoot,
        input.sourceRelativePath,
        input.sourceRevision,
        input.contextRootRelativePath ?? null,
      ]),
      payload: {
        workspaceRoot: input.workspaceRoot,
        sourceRelativePath: input.sourceRelativePath,
        ...(input.contextRootRelativePath === undefined
          ? {}
          : { contextRootRelativePath: input.contextRootRelativePath }),
      },
    }),
    [
      input.contextRootRelativePath,
      input.environmentId,
      input.sourceRelativePath,
      input.sourceRevision,
      input.workspaceRoot,
    ],
  );

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    void requestLatexResolution(request.environmentId, request.payload)
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setState({ requestKey: request.key, result, error: null });
      })
      .catch((error: unknown) => {
        if (requestRef.current !== requestId) return;
        setState({
          requestKey: request.key,
          result: null,
          error: error instanceof Error ? error.message : "LaTeX document resolution failed.",
        });
      });
    return () => {
      if (requestRef.current === requestId) requestRef.current += 1;
    };
  }, [request]);

  const current = state?.requestKey === request.key ? state : null;
  return {
    pending: current === null,
    result: current?.result ?? null,
    error: current?.error ?? null,
  };
}
