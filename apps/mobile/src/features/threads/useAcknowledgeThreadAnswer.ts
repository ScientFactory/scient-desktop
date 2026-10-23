import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";
import { completedAnswerTimestamp } from "@t3tools/shared/orchestrationV2ThreadShell";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [wakeNow, setWakeNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const now = Date.now();
      setWakeNow(new Date(now).toISOString());
      clearTimeout(timer);
      const delay = thread.snoozedUntil == null ? NaN : Date.parse(thread.snoozedUntil) - now;
      // Long snoozes must not overflow the native timer and immediately wake.
      if (Number.isFinite(delay) && delay > 0)
        timer = setTimeout(refresh, Math.min(delay + 50, 2_147_483_647));
    };
    refresh();
    const subscription = AppState.addEventListener("change", refresh);
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [visible, thread.snoozedUntil]);
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
  const answerWatermark = loaded
    ? completedAt
    : thread.latestRun === null && thread.latestCompletedAnswer == null
      ? thread.createdAt
      : null;
  const wokeAt = threadWokeAt(thread, { now: wakeNow });
  // A wake without an answer is readable; a wake must never acknowledge an
  // answer whose exact, settled body has not reached this visible feed.
  const canReadWake = loaded || (answerId == null && completedAt == null);
  const watermark =
    canReadWake && wokeAt && (!answerWatermark || Date.parse(wokeAt) > Date.parse(answerWatermark))
      ? wokeAt
      : answerWatermark;
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
