import type { OrchestrationLatestTurn, ScientCompletedAnswer } from "@t3tools/contracts";

export interface AnswerSource {
  readonly latestCompletedAnswer?: ScientCompletedAnswer | null | undefined;
  readonly latestTurn?: OrchestrationLatestTurn | null | undefined;
}

/** The native projection owns the latest answer, including clearing it after a revert. */
export function completedAnswer(
  source: AnswerSource | null | undefined,
): ScientCompletedAnswer | null {
  return source?.latestCompletedAnswer ?? null;
}

export function hasUnreadAnswer(source: AnswerSource, lastVisitedAt: string | undefined): boolean {
  const answer = completedAnswer(source);
  if (!answer || !lastVisitedAt) return false;
  const completed = Date.parse(answer.completedAt);
  const visited = Date.parse(lastVisitedAt);
  return Number.isFinite(completed) && (!Number.isFinite(visited) || completed > visited);
}
