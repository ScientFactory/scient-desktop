import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** How long a finished turn's working header takes to fade out and close its space. */
export const WORKING_ROW_EXIT_MS = 320;
/** A finished turn's working header closes evenly, without a fast start. */
const WORKING_ROW_EXIT_EASING = "cubic-bezier(0.45, 0, 0.55, 1)";
/**
 * An exit ends when its row's animation does. This only clears an exit whose
 * row was never on screen to play it (outside the rendered window).
 */
const UNPLAYED_EXIT_TIMEOUT_MS = 1000;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

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
  if (!previous.last) {
    return previous.exiting && !input.animate ? { ...previous, exiting: null } : previous;
  }
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
  return [...rows.slice(0, index), exiting.row, ...rows.slice(index)];
}

/** What the working header row needs to play its exit. */
export interface WorkingRowExit {
  /** The listed header is a finished turn's, closing. */
  readonly exiting: boolean;
  /** The row's exit finished: the header leaves the rows. */
  readonly onExitEnd: () => void;
}

/**
 * Keeps a finished turn's working header in the rows while it closes its
 * space, instead of leaving in one frame (which would snap the answer below
 * it up). Returns the rows to list and the header's exit state.
 */
export function useWorkingRowExit(
  rows: readonly MessagesTimelineRow[],
  threadKey: string,
): { rows: readonly MessagesTimelineRow[]; exit: WorkingRowExit } {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const current = useMemo(() => findWorkingRow(rows), [rows]);
  const [state, setState] = useState<WorkingRowExitState>(() => ({
    threadKey,
    last: current,
    exiting: null,
  }));
  const next = nextWorkingRowExit(state, { threadKey, current, animate: !reducedMotion });
  if (next !== state) setState(next);
  const exiting = next.exiting;
  const onExitEnd = useCallback(
    () => setState((previous) => (previous.exiting ? { ...previous, exiting: null } : previous)),
    [],
  );
  useEffect(() => {
    if (!exiting) return;
    const timeout = window.setTimeout(onExitEnd, UNPLAYED_EXIT_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [exiting, onExitEnd]);
  const listed = useMemo(() => withExitingWorkingRow(rows, exiting), [rows, exiting]);
  const exit = useMemo(() => ({ exiting: exiting !== null, onExitEnd }), [exiting, onExitEnd]);
  return { rows: listed, exit };
}

/**
 * Plays the working header's exit on its root element: it fades while its
 * space closes, and the negative margin takes the row's bottom padding along,
 * so nothing is left to snap when it leaves. The animation is cancelled (its
 * fill removed) when the row becomes a running turn's header again, unmounts,
 * or reduced motion turns on.
 */
export function useWorkingRowExitAnimation({ exiting, onExitEnd }: WorkingRowExit) {
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!exiting || !root) return;
    if (reducedMotion || typeof root.animate !== "function") {
      onExitEnd();
      return;
    }
    const animation = root.animate(
      [
        { height: `${root.getBoundingClientRect().height}px`, opacity: 1, marginBottom: "0px" },
        { height: "0px", opacity: 0, marginBottom: "-6px" },
      ],
      { duration: WORKING_ROW_EXIT_MS, easing: WORKING_ROW_EXIT_EASING, fill: "forwards" },
    );
    let current = true;
    animation.finished.then(
      () => {
        if (current) onExitEnd();
      },
      () => {},
    );
    return () => {
      current = false;
      animation.cancel();
    };
  }, [exiting, reducedMotion, onExitEnd]);
  return rootRef;
}
