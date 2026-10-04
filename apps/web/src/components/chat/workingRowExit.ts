import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** How long a finished turn's working header takes to fade out and close its space. */
export const WORKING_ROW_EXIT_MS = 320;

type WorkingRow = Extract<MessagesTimelineRow, { kind: "working" }>;

/** The working header and the row it follows. */
export interface WorkingRowPlacement {
  readonly row: WorkingRow;
  readonly afterId: string | null;
}

export interface WorkingRowExitState {
  readonly threadKey: string;
  /** The working header as last shown. */
  readonly last: WorkingRowPlacement | null;
  /** A header leaving: kept in place, closing, until its exit ends. */
  readonly exiting: WorkingRowPlacement | null;
}

export function findWorkingRow(rows: readonly MessagesTimelineRow[]): WorkingRowPlacement | null {
  const index = rows.findIndex((row) => row.kind === "working");
  if (index < 0) return null;
  return { row: rows[index] as WorkingRow, afterId: rows[index - 1]?.id ?? null };
}

/**
 * The next exit state. When the working header leaves the rows (its turn
 * finished), it is kept as an exiting row instead of disappearing in one
 * frame; a new header, a thread change or reduced motion ends that at once.
 * Returns `previous` itself when nothing changed.
 */
export function nextWorkingRowExit(
  previous: WorkingRowExitState,
  input: { threadKey: string; current: WorkingRowPlacement | null; animate: boolean },
): WorkingRowExitState {
  const { current } = input;
  if (previous.threadKey !== input.threadKey)
    return { threadKey: input.threadKey, last: current, exiting: null };
  if (current) {
    const same =
      previous.last?.row === current.row &&
      previous.last.afterId === current.afterId &&
      previous.exiting === null;
    return same ? previous : { threadKey: input.threadKey, last: current, exiting: null };
  }
  if (!previous.last) return previous;
  return {
    threadKey: input.threadKey,
    last: null,
    exiting: input.animate ? previous.last : null,
  };
}

/** The rows with an exiting working header back in its place. */
export function withExitingWorkingRow(
  rows: readonly MessagesTimelineRow[],
  exiting: WorkingRowPlacement | null,
): readonly MessagesTimelineRow[] {
  if (!exiting || rows.some((row) => row.kind === "working")) return rows;
  const index =
    exiting.afterId === null ? 0 : rows.findIndex((row) => row.id === exiting.afterId) + 1;
  if (index <= 0 && exiting.afterId !== null) return rows;
  return [...rows.slice(0, index), { ...exiting.row, exiting: true }, ...rows.slice(index)];
}
