import type { MessageId, RunId } from "@t3tools/contracts";

export interface TimelineRunObservation {
  readonly threadKey: string | null;
  readonly hydrated: boolean;
  readonly runId: RunId | null;
}

export function observeTimelineRun(
  previous: TimelineRunObservation | null,
  input: TimelineRunObservation & {
    readonly queued: boolean;
    readonly messageId: MessageId | null;
  },
): { observation: TimelineRunObservation; anchorMessageId: MessageId | null } {
  const observation = {
    threadKey: input.threadKey,
    hydrated: input.hydrated,
    runId: input.queued ? null : input.runId,
  };
  if (previous?.threadKey !== input.threadKey || !previous.hydrated) {
    return { observation, anchorMessageId: null };
  }
  if (
    !input.hydrated ||
    input.runId === null ||
    input.queued ||
    previous.runId === input.runId ||
    input.messageId === null
  ) {
    return { observation: previous, anchorMessageId: null };
  }
  return { observation, anchorMessageId: input.messageId };
}
import type { RunAttemptId } from "@t3tools/contracts";
// SCIENT-FORK:START — reading positions persist in session storage.
import { loadReadingPositions, scheduleReadingPositionFlush } from "./readingPositionStore";
// SCIENT-FORK:END

// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * The list's own content length includes the composer inset spacer, so this
 * measures from the last row instead. Unknown row positions or an unmeasured
 * viewport counts as fitting.
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  input: { readonly composerInset: number; readonly anchorOffset: number },
): boolean {
  if (!state || !state.data || state.data.length === 0) {
    return false;
  }
  const scrollLength = state.scrollLength;
  if (typeof scrollLength !== "number" || !Number.isFinite(scrollLength) || scrollLength <= 0) {
    return false;
  }
  const lastIndex = state.data.length - 1;
  // Overflow can use an unmeasured tail's lower bound.
  const lastTop = state.positionAtIndex(lastIndex);
  const lastBottom =
    getRowBottom(state, lastIndex) ??
    (typeof lastTop === "number" && Number.isFinite(lastTop) ? lastTop + 1 : null);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export interface RememberedTimelinePosition {
  readonly rowId: string;
  // SCIENT-FORK:START — positions are restored by message and run identity
  // (chat/readerScrollPolicy.ts), with the follow a reader left (chat/responseFollow.ts).
  readonly messageId?: string;
  readonly turnId?: string;
  readonly createdAt?: string;
  readonly neighborMessageIds?: readonly string[];
  readonly anchorMessageId?: string;
  /** The prompt whose response the reader was following when they left. */
  readonly followingPromptId?: string;
  // SCIENT-FORK:END
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
  readonly atEnd: boolean;
  readonly disclosures?: {
    readonly runs: ReadonlySet<RunId>;
    readonly workGroups: ReadonlySet<string>;
    readonly attempts: ReadonlySet<RunAttemptId>;
    readonly workGroupState: {
      scrollPositions: Map<string, { readonly entryId: string; readonly offset: number }>;
      expandedEntries: Set<string>;
    };
  };
}

const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();

export function readTimelinePosition(threadKey: string) {
  // SCIENT-FORK:START — positions survive renderer reloads (chat/readingPositionStore.ts).
  loadReadingPositions(rememberedTimelinePositions);
  // SCIENT-FORK:END
  return rememberedTimelinePositions.get(threadKey);
}

export function rememberTimelinePosition(threadKey: string, position: RememberedTimelinePosition) {
  // SCIENT-FORK:START — positions survive renderer reloads (chat/readingPositionStore.ts).
  loadReadingPositions(rememberedTimelinePositions);
  // SCIENT-FORK:END
  rememberedTimelinePositions.delete(threadKey);
  rememberedTimelinePositions.set(threadKey, position);
  if (rememberedTimelinePositions.size > 100) {
    const oldest = rememberedTimelinePositions.keys().next().value;
    if (oldest !== undefined) rememberedTimelinePositions.delete(oldest);
  }
  // SCIENT-FORK:START — captured now, while this thread still owns the list;
  // only the storage write is deferred.
  scheduleReadingPositionFlush(rememberedTimelinePositions);
  // SCIENT-FORK:END
}

// SCIENT-FORK:START — the reader scroll policy measures the same list state.
export { getRowBottom, type TimelineListMeasurementState };
// SCIENT-FORK:END
