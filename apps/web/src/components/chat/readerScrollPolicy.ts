import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { RememberedTimelinePosition } from "./timelineScrollAnchoring";

export function canApplySendAnchor(input: {
  atEnd: boolean;
  threadKey: string;
  currentThreadKey: string;
  navigationGeneration: number;
  currentNavigationGeneration: number;
}) {
  return (
    input.atEnd &&
    input.threadKey === input.currentThreadKey &&
    input.navigationGeneration === input.currentNavigationGeneration
  );
}

export function readingRowTurnId(row: MessagesTimelineRow): string | undefined {
  if ("message" in row) return row.message.turnId ?? undefined;
  if ("turnId" in row) return row.turnId ?? undefined;
  if (row.kind === "work-live") return row.entry.turnId ?? undefined;
  if (row.kind === "work") return row.groupedEntries[0]?.turnId ?? undefined;
  return undefined;
}

function isDurableRow(row: MessagesTimelineRow) {
  return (
    row.kind !== "working" &&
    row.kind !== "thinking" &&
    !(row.kind === "activity-group" && row.active) &&
    row.kind !== "worktree-setup"
  );
}

/** Render-only indicators belong to their turn, never to a reusable UI row ID. */
export function readingIdentity(
  rows: readonly MessagesTimelineRow[],
  index: number,
  runningTurnId?: string | null,
) {
  const row = rows[index];
  if (!row) return null;
  const neighbors: Array<{ id: string; turnId: string | null }> = [];
  for (let distance = 0; neighbors.length < 8 && distance < rows.length; distance++) {
    for (const i of distance === 0 ? [index] : [index - distance, index + distance]) {
      const candidate = rows[i];
      if (candidate?.kind === "message")
        neighbors.push({ id: candidate.message.id, turnId: candidate.message.turnId });
    }
  }
  const turnId =
    readingRowTurnId(row) ??
    (!isDurableRow(row) ? runningTurnId : undefined) ??
    neighbors.find((neighbor) => neighbor.turnId)?.turnId ??
    undefined;
  return {
    rowId: isDurableRow(row) ? row.id : "",
    ...("message" in row ? { messageId: row.message.id } : {}),
    ...(turnId ? { turnId } : {}),
    ...("createdAt" in row && row.createdAt ? { createdAt: row.createdAt } : {}),
    neighborMessageIds: neighbors.slice(0, 8).map((neighbor) => neighbor.id),
  };
}

/** Exact content first; a missing render wrapper can fall back within its turn. */
export function resolveReadingRow(
  rows: readonly MessagesTimelineRow[],
  position: RememberedTimelinePosition,
  allowNeighbor: boolean,
): { index: number; exact: boolean } | null {
  let index = rows.findIndex(
    (row) =>
      isDurableRow(row) &&
      (position.messageId
        ? "message" in row && row.message.id === position.messageId
        : row.id === position.rowId &&
          (!position.turnId || readingRowTurnId(row) === position.turnId)),
  );
  if (index >= 0) return { index, exact: true };
  if (position.turnId) {
    // Prefer the final answer to a disappearing working indicator, then the prompt/fold.
    index = rows.findIndex(
      (row) =>
        row.kind === "message" &&
        row.message.role === "assistant" &&
        row.message.turnId === position.turnId,
    );
    if (index < 0)
      index = rows.findIndex(
        (row) => isDurableRow(row) && readingRowTurnId(row) === position.turnId,
      );
    if (index >= 0) return { index, exact: false };
  }
  if (allowNeighbor) {
    for (const id of position.neighborMessageIds ?? []) {
      index = rows.findIndex((row) => row.kind === "message" && row.message.id === id);
      if (index >= 0) return { index, exact: false };
    }
  }
  return null;
}
