import type {
  EnvironmentId,
  ScientSourceMetadataUpdateRequest,
  ScientSourceMetadataUpdateResult,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { updateScientSourceMetadata } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";

export function useSourceEditor(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceId: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScientSourceMetadataUpdateResult | null>(null);
  const generation = useRef<symbol | null>(null);

  const [previousContext, setPreviousContext] = useState({
    environmentId: input.environmentId,
    root: input.root,
    sourceId: input.sourceId,
  });
  if (
    previousContext.environmentId !== input.environmentId ||
    previousContext.root !== input.root ||
    previousContext.sourceId !== input.sourceId
  ) {
    setPreviousContext({
      environmentId: input.environmentId,
      root: input.root,
      sourceId: input.sourceId,
    });
    setSaving(false);
    setError(null);
    setResult(null);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rotates the generation token so stale editor completions from a previous context are ignored
  useEffect(() => {
    const context = `${previousContext.environmentId}\0${previousContext.root}\0${previousContext.sourceId}`;
    generation.current = Symbol(context);
    return () => {
      generation.current = null;
    };
  }, [previousContext.environmentId, previousContext.root, previousContext.sourceId]);

  const save = async (
    expectedRevision: number,
    metadata: ScientSourceMetadataUpdateRequest["metadata"],
    allowPossibleMetadataMatch = false,
  ) => {
    const request = Symbol();
    generation.current = request;
    setSaving(true);
    setError(null);
    setResult(null);
    return await (async () => {
      const next = await updateScientSourceMetadata(input.environmentId, {
        root: input.root,
        sourceId: input.sourceId,
        expectedRevision,
        metadata,
        allowPossibleMetadataMatch,
      });
      if (generation.current !== request) return null;
      setResult(next);
      return next;
    })()
      .catch(async (cause) => {
        if (generation.current === request) {
          setError(scientSourcesErrorMessage(cause, import.meta.env.DEV));
        }
        return null;
      })
      .finally(() => {
        if (generation.current === request) setSaving(false);
      });
  };

  return {
    error,
    result,
    save,
    saving,
    clearResult: () => setResult(null),
  } as const;
}
