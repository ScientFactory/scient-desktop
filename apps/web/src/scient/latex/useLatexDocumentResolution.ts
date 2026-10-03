import type { EnvironmentId, ScientLatexResolveResult } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { requestLatexResolution } from "./client";

interface StoredLatexDocumentResolution {
  readonly requestKey: string;
  readonly documentKey: string;
  readonly result: ScientLatexResolveResult | null;
  readonly error: string | null;
}

export interface LatexDocumentResolutionState extends Omit<
  StoredLatexDocumentResolution,
  "requestKey" | "documentKey"
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
      documentKey: JSON.stringify([
        input.environmentId,
        input.workspaceRoot,
        input.sourceRelativePath,
        input.contextRootRelativePath ?? null,
      ]),
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
        setState({
          requestKey: request.key,
          documentKey: request.documentKey,
          result,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (requestRef.current !== requestId) return;
        setState({
          requestKey: request.key,
          documentKey: request.documentKey,
          result: null,
          error: error instanceof Error ? error.message : "LaTeX document resolution failed.",
        });
      });
    return () => {
      if (requestRef.current === requestId) requestRef.current += 1;
    };
  }, [request]);

  // Saving a chapter changes its revision, not its document identity. Keep the
  // established root visible while refreshing that resolution.
  const current = state?.documentKey === request.documentKey ? state : null;
  return {
    pending: current?.requestKey !== request.key,
    result: current?.result ?? null,
    error: current?.error ?? null,
  };
}
