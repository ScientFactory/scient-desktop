import * as DateTime from "effect/DateTime";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { latestCompletedAnswerFromProjection } from "@t3tools/shared/orchestrationV2ThreadShell";
import { useEffect, useMemo, useRef } from "react";
import { useUiStateStore } from "../../uiStateStore";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Only loaded completed answers in a visible, focused conversation are read. */
export function useAcknowledgeAnswer(thread: EnvironmentThread | null | undefined): void {
  const projection = thread?.projection ?? null;
  const runs = projection?.runs;
  const messages = projection?.messages;
  const nodes = projection?.nodes;
  const answer = useMemo(
    () =>
      runs && messages && nodes
        ? latestCompletedAnswerFromProjection({ runs, messages, nodes })
        : null,
    [runs, messages, nodes],
  );
  // Opening an empty conversation establishes visited metadata without consuming
  // a future answer or a still-loading completion.
  const watermark =
    answer?.completedAt ??
    (projection?.runs.length === 0 ? DateTime.formatIso(projection.thread.createdAt) : null);
  const threadId = projection?.thread.id;
  const environmentId = thread?.environmentId;
  const visitedAt = projection?.thread.lastVisitedAt;
  const key =
    threadId && environmentId ? scopedThreadKey(scopeThreadRef(environmentId, threadId)) : null;
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const dispatched = useRef<{ readonly key: string } | null>(null);
  const selectedKey = useRef<string | null>(null);
  useEffect(() => {
    if (selectedKey.current !== key) {
      selectedKey.current = key;
      dispatched.current = null;
    }
    if (!key) return;
    if (!threadId || !environmentId || !watermark) return;
    const dispatchKey = `${key}:${answer?.messageId ?? "empty"}:${watermark}`;
    const acknowledge = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (dispatched.current?.key === dispatchKey) return;
      const dispatch = { key: dispatchKey };
      dispatched.current = dispatch;
      useUiStateStore.getState().markThreadVisited(key, watermark);
      if (
        visitedAt !== undefined &&
        (visitedAt === null || DateTime.toEpochMillis(visitedAt) < Date.parse(watermark))
      ) {
        void visit({ environmentId, input: { threadId, visitedAt: watermark } }).then((result) => {
          // Retry only on a later focus/visibility signal, not an effect loop.
          if (result._tag === "Failure" && dispatched.current === dispatch)
            dispatched.current = null;
        });
      }
    };
    acknowledge();
    window.addEventListener("focus", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    return () => {
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
  }, [key, threadId, environmentId, watermark, answer?.messageId, visitedAt, visit]);
}
