/**
 * Destination turns that hold a fork's inherited transcript.
 *
 * SCIENT-OWNED. Revert keeps these turns: a fork's inherited prefix belongs to
 * its source and is immutable in the fork. Events written before the explicit
 * list existed derive it from the copied boundaries and the baseline turn.
 */
import type { ThreadForkedPayload, TurnId } from "@t3tools/contracts";

export function inheritedTurnIdsOf(
  payload: Pick<ThreadForkedPayload, "inheritedTurnIds" | "baselineTurnId" | "copiedBoundaries">,
): ReadonlyArray<TurnId> {
  if (payload.inheritedTurnIds !== undefined && payload.inheritedTurnIds.length > 0) {
    return payload.inheritedTurnIds;
  }
  return [
    ...new Set([
      payload.baselineTurnId,
      ...payload.copiedBoundaries.map((boundary) => boundary.turnId),
    ]),
  ];
}
