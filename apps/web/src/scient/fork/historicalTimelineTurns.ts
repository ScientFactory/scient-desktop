import type { TimelineEntry } from "../../session-logic";

/** Historical turn IDs group inert presentation; they never replace native ownership. */
export function timelineEntryHistoryKey(entry: TimelineEntry): string | null {
  const projected =
    entry.kind === "message" || entry.kind === "event"
      ? entry.projectedItem
      : entry.kind === "work"
        ? entry.entry.projectedItem
        : undefined;
  if (
    !projected ||
    projected.item.runId !== null ||
    projected.item.historyTurnId === undefined ||
    (entry.kind === "message" && entry.message.runId != null) ||
    (entry.kind === "work" && entry.entry.runId != null)
  ) {
    return null;
  }
  return JSON.stringify([projected.item.threadId, projected.item.historyTurnId]);
}
