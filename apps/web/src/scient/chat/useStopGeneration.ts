import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface StopRequest {
  readonly targetKey: string;
}

/** Acknowledges Stop for its captured thread/attempt while the server finishes cancellation. */
export function useStopGeneration(input: {
  readonly threadKey: string | null;
  readonly runId: RunId | null;
  readonly canInterrupt: boolean;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly operation: () => Promise<boolean | undefined>;
}) {
  const run = input.projection?.runs.find((run) => run.id === input.runId);
  const ownedRunId = run?.id;
  const rootNodeId = run?.rootNodeId;
  const turnItems = input.projection?.turnItems;
  const targetKey =
    input.canInterrupt && input.threadKey !== null
      ? JSON.stringify([input.threadKey, input.runId, run?.activeAttemptId ?? null])
      : null;
  const [requested, setRequested] = useState<StopRequest | null>(null);
  const submitting = useRef<StopRequest | null>(null);
  const serverRequested = useMemo(() => {
    if (ownedRunId === undefined || turnItems === undefined) return false;
    let requested = false;
    for (const item of turnItems) {
      if (item.runId !== ownedRunId || item.nodeId !== rootNodeId) continue;
      if (item.type === "run_interrupt_result") return false;
      if (item.type === "run_interrupt_request") requested = true;
    }
    return requested;
  }, [ownedRunId, rootNodeId, turnItems]);

  useEffect(() => {
    setRequested((previous) => (previous?.targetKey === targetKey ? previous : null));
  }, [targetKey]);

  const onInterrupt = useCallback(async () => {
    if (targetKey === null || submitting.current?.targetKey === targetKey) return;
    const request = { targetKey };
    submitting.current = request;
    setRequested(request);
    const clearOwnedRequest = () =>
      setRequested((current) => (current === request ? null : current));
    try {
      if ((await input.operation()) !== true) clearOwnedRequest();
    } catch (error) {
      clearOwnedRequest();
      throw error;
    } finally {
      if (submitting.current === request) submitting.current = null;
    }
  }, [input.operation, targetKey]);
  return {
    isStopping: targetKey !== null && (requested?.targetKey === targetKey || serverRequested),
    onInterrupt,
  };
}
