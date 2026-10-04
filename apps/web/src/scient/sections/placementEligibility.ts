import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";

import { resolveSidebarThreadStatus } from "../../components/Sidebar.logic";
import { hasUnreadAnswer } from "../answerAttention/completion";

export function placementEligible(
  thread: Pick<
    EnvironmentThreadShell,
    | "runtime"
    | "latestRun"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "latestCompletedAnswer"
    | "snoozedUntil"
    | "snoozedAt"
  >,
  visitedAt: string | undefined,
  now: string,
): boolean {
  const wokeAt = threadWokeAt(thread, { now });
  const woke =
    wokeAt !== null &&
    (!visitedAt ||
      !Number.isFinite(Date.parse(visitedAt)) ||
      Date.parse(wokeAt) > Date.parse(visitedAt));
  return (
    resolveSidebarThreadStatus(thread) !== "ready" || hasUnreadAnswer(thread, visitedAt) || woke
  );
}
