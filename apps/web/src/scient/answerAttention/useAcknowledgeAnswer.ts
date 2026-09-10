import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";
import { useUiStateStore } from "../../uiStateStore";
import { completedAnswer } from "./completion";

/** A selected background conversation is not a read conversation. */
export function useAcknowledgeAnswer(thread: EnvironmentThread | null | undefined): void {
  const answer = completedAnswer(thread);
  const key = thread ? scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) : null;
  const loaded =
    !!answer &&
    !!thread?.messages.some(
      (message) =>
        message.id === answer.messageId && message.role === "assistant" && !message.streaming,
    );
  const completedAt = loaded ? answer?.completedAt : undefined;
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
