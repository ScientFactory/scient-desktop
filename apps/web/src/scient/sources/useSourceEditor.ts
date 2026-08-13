import type {
  EnvironmentId,
  ScientSourceMetadataUpdateRequest,
  ScientSourceMetadataUpdateResult,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

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
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setSaving(false);
    setError(null);
    setResult(null);
    return () => {
      generation.current += 1;
    };
  }, [input.environmentId, input.root, input.sourceId]);

  const save = useCallback(
    async (
      expectedRevision: number,
      metadata: ScientSourceMetadataUpdateRequest["metadata"],
      allowPossibleMetadataMatch = false,
    ) => {
      const request = ++generation.current;
      setSaving(true);
      setError(null);
      setResult(null);
      try {
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
      } catch (cause) {
        if (generation.current === request) {
          setError(scientSourcesErrorMessage(cause, import.meta.env.DEV));
        }
        return null;
      } finally {
        if (generation.current === request) setSaving(false);
      }
    },
    [input.environmentId, input.root, input.sourceId],
  );

  return {
    error,
    result,
    save,
    saving,
    clearResult: () => setResult(null),
  } as const;
}
