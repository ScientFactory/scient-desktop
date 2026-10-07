import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { completedAnswerTimestamp } from "@t3tools/shared/orchestrationV2ThreadShell";
import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Shell completion is acknowledged only after its actual answer is on screen. */
export function useAcknowledgeThreadAnswer(
  environmentId: EnvironmentId,
  thread: EnvironmentThreadShell,
  feed: ReadonlyArray<ThreadFeedEntry>,
  visible: boolean,
): void {
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const dispatched = useRef<{ readonly key: string } | null>(null);
  const selectedKey = useRef<string | null>(null);
  const answerId =
    thread.latestCompletedAnswer === undefined
      ? thread.latestRun?.status === "completed"
        ? thread.latestRun.assistantMessageId
        : null
      : thread.latestCompletedAnswer?.messageId;
  const completedAt = completedAnswerTimestamp(thread);
  const loaded = useMemo(
    () =>
      Boolean(
        answerId &&
        feed.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.id === answerId &&
            entry.message.role === "assistant" &&
            !entry.message.streaming &&
            entry.message.text.trim().length > 0,
        ),
      ),
    [answerId, feed],
  );
  const watermark = loaded
    ? completedAt
    : thread.latestRun === null && thread.latestCompletedAnswer == null
      ? thread.createdAt
      : null;
  useEffect(() => {
    const threadKey = `${environmentId}:${thread.id}`;
    if (selectedKey.current !== threadKey) {
      selectedKey.current = threadKey;
      dispatched.current = null;
    }
    if (!visible) {
      dispatched.current = null;
      return;
    }
    if (!watermark || thread.lastVisitedAt === undefined) return;
    const dispatchKey = `${environmentId}:${thread.id}:${answerId ?? "empty"}:${watermark}`;
    const acknowledge = () => {
      if (AppState.currentState !== "active" || dispatched.current?.key === dispatchKey) return;
      const dispatch = { key: dispatchKey };
      dispatched.current = dispatch;
      if (thread.lastVisitedAt && Date.parse(thread.lastVisitedAt) >= Date.parse(watermark)) return;
      void visit({ environmentId, input: { threadId: thread.id, visitedAt: watermark } }).then(
        (result) => {
          if (result._tag === "Failure" && dispatched.current === dispatch)
            dispatched.current = null;
        },
      );
    };
    acknowledge();
    const subscription = AppState.addEventListener("change", acknowledge);
    return () => subscription.remove();
  }, [environmentId, thread.id, thread.lastVisitedAt, watermark, answerId, visible, visit]);
}
