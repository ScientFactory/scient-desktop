import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  getRowBottom,
  type RememberedTimelinePosition,
  type TimelineListMeasurementState,
  withRealTimelineEnd,
} from "./timelineScrollAnchoring";

/** Where a row's readable content ends; trailing file lists and controls come after it. */
const READING_END_SELECTOR = '[data-reading-end], [data-user-message-body="true"]';

function isReadingRow(row: MessagesTimelineRow | undefined) {
  return (
    (row?.kind === "message" &&
      (row.message.role === "assistant" || row.message.role === "user")) ||
    row?.kind === "proposed-plan"
  );
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
): number | null {
  const rows = state.data as readonly MessagesTimelineRow[];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (!isReadingRow(rows[index])) continue;
    const element = state.elementAtIndex?.(index);
    if (!element?.isConnected) return null;
    const markers = element.querySelectorAll(READING_END_SELECTOR);
    const end = (
      markers.length > 0 ? markers[markers.length - 1]! : element
    ).getBoundingClientRect().bottom;
    const view = viewport.getBoundingClientRect();
    return end - (view.top + viewport.clientHeight - composerInset);
  }
  return null;
}

/**
 * The timeline state with its end at the last conversational content: the
 * text of the last message or plan. Trailing changed-file lists, tool groups,
 * timestamps and working indicators are not something the reader has left to
 * read, so they never decide whether the reader is at the bottom. Falls back
 * to the last row (excluding reserved anchor padding) while unmeasured.
 */
export function withReadingEnd<
  T extends TimelineListMeasurementState & {
    readonly elementAtIndex?: (index: number) => Element | null | undefined;
  },
>(state: T | undefined, composerInset: number): T | undefined {
  if (!state?.data) return state;
  const rows = state.data as readonly MessagesTimelineRow[];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (!isReadingRow(rows[index])) continue;
    const top = state.positionAtIndex(index);
    const bottom = getRowBottom(state, index);
    if (top === undefined || bottom === null) break;
    const element = state.elementAtIndex?.(index);
    const markers = element?.isConnected ? element.querySelectorAll(READING_END_SELECTOR) : [];
    const marker = markers.length > 0 ? markers[markers.length - 1] : undefined;
    const end =
      element && marker
        ? top + marker.getBoundingClientRect().bottom - element.getBoundingClientRect().top
        : bottom;
    return { ...state, contentLength: Math.min(end, bottom) + composerInset };
  }
  return withRealTimelineEnd(state, composerInset);
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

/** Send intent tolerates two body-text lines; other end controls retain their existing band. */
export function readSendScrollAllowance(
  viewport: HTMLElement | null | undefined,
): number | undefined {
  const bodies = viewport?.querySelectorAll<HTMLElement>(
    '[data-timeline-row-kind="message"] .chat-markdown',
  );
  // Virtualized containers can be recycled out of DOM order.
  const body = bodies
    ? Array.from(bodies).reduce<HTMLElement | undefined>(
        (last, candidate) =>
          !last || candidate.getBoundingClientRect().top > last.getBoundingClientRect().top
            ? candidate
            : last,
        undefined,
      )
    : undefined;
  if (!body) return undefined;
  const lineHeight = Number.parseFloat(getComputedStyle(body).lineHeight);
  return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight * 2 : undefined;
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
