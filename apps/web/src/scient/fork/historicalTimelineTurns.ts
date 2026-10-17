import { RunId } from "@t3tools/contracts";

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

/** The start of an imported turn's fold, keyed like a runless prompt's response. */
export interface HistoricalFoldBoundary {
  key: RunId;
  createdAt: string;
}

/**
 * Each imported turn's fold starts at its own first prompt. Reuse the existing
 * runless disclosure key, not an executable historical run. Match the prompt by
 * provenance because queued users can precede all answers.
 */
export function historicalFoldBoundaries(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  startsResponse: (entry: TimelineEntry) => boolean,
): Map<string, HistoricalFoldBoundary> {
  const historicalBoundaries = new Map<string, HistoricalFoldBoundary>();
  for (const entry of timelineEntries) {
    const historyKey = timelineEntryHistoryKey(entry);
    if (historyKey !== null && startsResponse(entry) && !historicalBoundaries.has(historyKey)) {
      historicalBoundaries.set(historyKey, {
        key: RunId.make(`runless:${entry.id}`),
        createdAt: entry.createdAt,
      });
    }
  }
  return historicalBoundaries;
}

/**
 * The fold boundary of an imported entry: undefined when the entry is not
 * imported, null when its turn's prompt is unknown. Unknown historical prompts
 * remain visible rather than borrowing another turn.
 */
export function historicalFoldBoundary(
  boundaries: ReadonlyMap<string, HistoricalFoldBoundary>,
  entry: TimelineEntry,
): HistoricalFoldBoundary | null | undefined {
  const historyKey = timelineEntryHistoryKey(entry);
  if (historyKey === null) return undefined;
  return boundaries.get(historyKey) ?? null;
}
