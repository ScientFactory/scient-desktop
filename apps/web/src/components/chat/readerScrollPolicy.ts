import { type MessagesTimelineRow, resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import {
  getRowBottom,
  type RememberedTimelinePosition,
  type TimelineListMeasurementState,
  withRealTimelineEnd,
} from "./timelineScrollAnchoring";

/** Where a row's readable content ends; trailing file lists and controls come after it. */
const READING_END_SELECTOR = '[data-reading-end], [data-user-message-body="true"]';

/** Rows that only show that the agent is busy; they are not content to read. */
const INDICATOR_ROW_KINDS: ReadonlySet<MessagesTimelineRow["kind"]> = new Set([
  "working",
  "thinking",
  "worktree-setup",
  "assistant-meta",
]);

/**
 * The row whose text marks the end of the conversation. While the latest
 * turn is unfinished (running, or it ended interrupted or with an error),
 * everything it produced after your latest message is new content, so the
 * end is its latest row (an answer as it streams, a note, a tool step), or
 * your message itself before anything arrives; busy indicators never count.
 * Once a turn completed normally, the end is its answer (the agent's message
 * or plan): what trails it (changed files, tool summaries, your own later
 * message, sent or queued) doesn't count as unread. Before any answer
 * exists, your latest message is the end. -1 when there is none.
 */
function readingEndRowIndex(rows: readonly MessagesTimelineRow[], turnUnfinished = false): number {
  if (turnUnfinished) {
    // The last row that isn't a busy indicator: the turn's latest content,
    // or your latest message when nothing has arrived after it yet.
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row && !INDICATOR_ROW_KINDS.has(row.kind)) return index;
    }
    return -1;
  }
  const isAnswer = (row: MessagesTimelineRow | undefined) =>
    row?.kind === "proposed-plan" || (row?.kind === "message" && row.message.role === "assistant");
  let promptIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.role === "user") {
      promptIndex = index;
      break;
    }
  }
  // The completed latest turn's own answer, or its latest content if it
  // wrote none: both are new below your message.
  let turnContent = -1;
  for (let index = rows.length - 1; index > promptIndex; index -= 1) {
    const row = rows[index];
    if (isAnswer(row)) return index;
    if (turnContent < 0 && row && !INDICATOR_ROW_KINDS.has(row.kind)) turnContent = index;
  }
  if (turnContent >= 0) return turnContent;
  // Nothing after your latest message: the latest answer above it, or your
  // message itself before any answer exists.
  for (let index = promptIndex - 1; index >= 0; index -= 1) if (isAnswer(rows[index])) return index;
  return promptIndex;
}

/** How many of the answer's last lines may be hidden while the reader counts as at the end. */
const READING_END_HIDDEN_LINES = 3;
/** The tolerance never falls below the timeline's inherited 40px end band. */
const READING_END_MIN_ALLOWANCE_PX = 40;

/**
 * How far below the visible area the answer's text may end while the reader
 * still counts as at the end: its last three lines, in its own line height
 * so it holds at any text size. With no answer yet, the inherited 40px band.
 */
export function readingEndAllowance(
  state: {
    readonly data: readonly unknown[];
    readonly elementAtIndex?: (index: number) => Element | null | undefined;
  },
  turnUnfinished = false,
): number {
  if (!state.data) return READING_END_MIN_ALLOWANCE_PX;
  const rows = state.data as readonly MessagesTimelineRow[];
  const index = readingEndRowIndex(rows, turnUnfinished);
  // Before any answer exists, the end is the reader's own message and keeps
  // the inherited band.
  const row = rows[index];
  if (row?.kind === "message" && row.message.role === "user") return READING_END_MIN_ALLOWANCE_PX;
  const element = index < 0 ? undefined : state.elementAtIndex?.(index);
  const bodies = element?.isConnected ? element.querySelectorAll(".chat-markdown") : [];
  const body = bodies.length > 0 ? bodies[bodies.length - 1] : undefined;
  const lineHeight = body ? Number.parseFloat(getComputedStyle(body).lineHeight) : Number.NaN;
  return Number.isFinite(lineHeight) && lineHeight > 0
    ? Math.max(READING_END_MIN_ALLOWANCE_PX, lineHeight * READING_END_HIDDEN_LINES)
    : READING_END_MIN_ALLOWANCE_PX;
}

/**
 * How far the end of the last message's text sits below the visible area
 * above the composer, measured on screen (negative when it is in view). Uses
 * the rendered rows directly, so it holds while the list's own position
 * bookkeeping catches up. Null when that row is not rendered.
 */
export function readingEndGapOnScreen(
  state: {
    readonly data: readonly unknown[];
    readonly elementAtIndex?: (index: number) => Element | null | undefined;
  },
  viewport: Element,
  composerInset: number,
  turnUnfinished = false,
): number | null {
  if (!state.data) return null;
  const index = readingEndRowIndex(state.data as readonly MessagesTimelineRow[], turnUnfinished);
  if (index < 0) return null;
  const element = state.elementAtIndex?.(index);
  if (!element?.isConnected) return null;
  const markers = element.querySelectorAll(READING_END_SELECTOR);
  const end = (markers.length > 0 ? markers[markers.length - 1]! : element).getBoundingClientRect()
    .bottom;
  const view = viewport.getBoundingClientRect();
  return end - (view.top + viewport.clientHeight - composerInset);
}

/**
 * The timeline state with its end at the reading end (readingEndRowIndex):
 * an unfinished turn's latest content, or the latest turn's answer. What trails
 * a finished answer (changed-file lists, tool groups, timestamps) and busy
 * indicators never decide whether the reader is at the bottom. Falls back to
 * the last row (excluding reserved anchor padding) while unmeasured.
 */
export function withReadingEnd<
  T extends TimelineListMeasurementState & {
    readonly elementAtIndex?: (index: number) => Element | null | undefined;
  },
>(state: T | undefined, composerInset: number, turnUnfinished = false): T | undefined {
  if (!state?.data) return state;
  const index = readingEndRowIndex(state.data as readonly MessagesTimelineRow[], turnUnfinished);
  const top = index < 0 ? undefined : state.positionAtIndex(index);
  const bottom = index < 0 ? null : getRowBottom(state, index);
  if (top === undefined || bottom === null) return withRealTimelineEnd(state, composerInset);
  const element = state.elementAtIndex?.(index);
  const markers = element?.isConnected ? element.querySelectorAll(READING_END_SELECTOR) : [];
  const marker = markers.length > 0 ? markers[markers.length - 1] : undefined;
  const end =
    element && marker
      ? top + marker.getBoundingClientRect().bottom - element.getBoundingClientRect().top
      : bottom;
  return { ...state, contentLength: Math.min(end, bottom) + composerInset };
}

/**
 * Whether the reader is at the end: the end's text is in view, except at
 * most its last three lines (see readingEndRowIndex: an unfinished turn's
 * latest content, otherwise the latest turn's answer). The one rule for
 * the end control, sending, navigation and saved positions.
 */
export function readerAtReadingEnd<
  T extends TimelineListMeasurementState & {
    readonly elementAtIndex?: (index: number) => Element | null | undefined;
  },
>(state: T | undefined, composerInset: number, turnUnfinished = false): boolean | undefined {
  if (!state) return undefined;
  return resolveTimelineIsAtEnd(
    withReadingEnd(state, composerInset, turnUnfinished),
    readingEndAllowance(state, turnUnfinished),
  );
}

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

function readingRowTurnId(row: MessagesTimelineRow): string | undefined {
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

/** The server delivers a queued prompt under this message id prefix (threadQueue Worker). */
const QUEUED_PROMPT_ID_PREFIX = "queue:";

/**
 * Whether a newly arrived prompt gets the same reveal as a direct send: only
 * a queued prompt the server delivered (not one sent from another window),
 * as the new latest prompt of the same thread, while the reader was at the
 * end before it arrived.
 */
export function shouldRevealArrivedPrompt(input: {
  previous: { threadKey: string | null; id: string | null } | null;
  threadKey: string | null;
  latestPromptId: string | null;
  sentHere: boolean;
  readerAtEnd: boolean;
}) {
  const { previous } = input;
  return (
    input.latestPromptId !== null &&
    input.latestPromptId.startsWith(QUEUED_PROMPT_ID_PREFIX) &&
    previous !== null &&
    previous.threadKey === input.threadKey &&
    previous.id !== null &&
    previous.id !== input.latestPromptId &&
    !input.sentHere &&
    input.readerAtEnd
  );
}

/** Whether the reader crossed the end ("reached"/"left"); null when nothing changed. */
export function endTransition(wasAtEnd: boolean, isAtEnd: boolean): "reached" | "left" | null {
  if (wasAtEnd === isAtEnd) return null;
  return isAtEnd ? "reached" : "left";
}

/** A thread returned to mid-history starts away from the end, so its end control shows at once. */
export function savedPositionIsAtEnd(position: { readonly atEnd?: boolean } | null | undefined) {
  return position?.atEnd !== false;
}
