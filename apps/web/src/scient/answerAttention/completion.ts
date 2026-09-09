import type { OrchestrationLatestTurn, ScientCompletedAnswer } from "@t3tools/contracts";

export interface AnswerSource {
  readonly latestCompletedAnswer?: ScientCompletedAnswer | null | undefined;
  readonly latestTurn?: OrchestrationLatestTurn | null | undefined;
}

/** An explicit null from a new server must not resurrect a reverted answer. */
export function completedAnswer(
  source: AnswerSource | null | undefined,
): ScientCompletedAnswer | null {
  if (!source) return null;
  if (source.latestCompletedAnswer !== undefined) return source.latestCompletedAnswer;
  const turn = source.latestTurn;
  return turn?.state === "completed" && turn.completedAt && turn.assistantMessageId
    ? { turnId: turn.turnId, messageId: turn.assistantMessageId, completedAt: turn.completedAt }
    : null;
}

export function hasUnreadAnswer(source: AnswerSource, lastVisitedAt: string | undefined): boolean {
  const answer = completedAnswer(source);
  if (!answer || !lastVisitedAt) return false;
  const completed = Date.parse(answer.completedAt);
  const visited = Date.parse(lastVisitedAt);
  return Number.isFinite(completed) && (!Number.isFinite(visited) || completed > visited);
}
