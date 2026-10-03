import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";
import { useUiStateStore } from "../../uiStateStore";

/**
 * V2's counterpart of the shell's `latestCompletedAnswer`: the newest root run
 * that actually completed. Runs land before their assistant message, so the
 * answer only counts as read once a settled assistant row is also present.
 */
function latestCompletedAnswerAt(projection: OrchestrationV2ThreadProjection): string | undefined {
  let completedAt: string | undefined;
  for (const run of projection.runs) {
    if (run.status !== "completed" || run.completedAt === null) continue;
    const candidate = DateTime.formatIso(run.completedAt);
    if (completedAt === undefined || Date.parse(candidate) > Date.parse(completedAt)) {
      completedAt = candidate;
    }
  }
  if (completedAt === undefined) return undefined;
  const answered = projection.messages.some(
    (message) => message.role === "assistant" && !message.streaming,
  );
  return answered ? completedAt : undefined;
}

/** A selected background conversation is not a read conversation. */
export function useAcknowledgeAnswer(thread: EnvironmentThread | null | undefined): void {
  const projection = thread?.projection ?? null;
  const completedAt = projection ? latestCompletedAnswerAt(projection) : undefined;
  const key = thread
    ? scopedThreadKey(scopeThreadRef(thread.environmentId, thread.projection.thread.id))
    : null;
  useEffect(() => {
    if (!key || !completedAt) return;
    const acknowledge = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        useUiStateStore.getState().markThreadVisited(key, completedAt);
      }
    };
    acknowledge();
    window.addEventListener("focus", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    return () => {
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
  }, [key, completedAt]);
}
