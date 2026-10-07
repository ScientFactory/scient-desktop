import { RunAttemptId, RunId, type MessageId } from "@t3tools/contracts";

export interface TimelineRunObservation {
  readonly threadKey: string | null;
  readonly hydrated: boolean;
  readonly runId: RunId | null;
}

/** Opening a thread establishes a baseline; only later runs get new-turn framing. */
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

// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
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

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}

/** Exclude reserved anchor padding when deciding whether real content is below the reader. */
export function withRealTimelineEnd<T extends TimelineListMeasurementState>(
  state: T | undefined,
  composerInset: number,
): T | undefined {
  if (!state) return state;
  const bottom = getRowBottom(state, state.data.length - 1);
  return bottom === null ? state : { ...state, contentLength: bottom + composerInset };
}

/**
 * Whether the timeline's real rows extend past the viewport left above the
 * composer. The list's own content length includes the composer inset
 * spacer, so this measures from the last row instead. Unknown row geometry
 * or an unmeasured viewport counts as fitting.
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
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export interface RememberedTimelinePosition {
  readonly rowId: string;
  readonly messageId?: string;
  readonly turnId?: string;
  readonly createdAt?: string;
  readonly neighborMessageIds?: readonly string[];
  readonly anchorMessageId?: string;
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

// Only identifiers and layout metadata are persisted, never message text. Session
// storage survives renderer reloads and remains isolated per window/environment.
const POSITION_STORAGE_KEY = "scient:timeline-reading-position:v1";
const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();
let positionsLoaded = false;
let persistenceTimer: ReturnType<typeof setTimeout> | undefined;

function readDisclosures(
  value: Record<string, unknown>,
): NonNullable<RememberedTimelinePosition["disclosures"]> {
  const strings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((id): id is string => typeof id === "string").slice(0, 1000)
      : [];
  return {
    runs: new Set(strings(value.runs).map((id) => RunId.make(id))),
    workGroups: new Set(strings(value.workGroups)),
    attempts: new Set(strings(value.attempts).map((id) => RunAttemptId.make(id))),
    workGroupState: {
      scrollPositions: new Map(),
      expandedEntries: new Set(strings(value.expandedEntries)),
    },
  };
}

function loadPositions() {
  if (positionsLoaded || typeof sessionStorage === "undefined") return;
  positionsLoaded = true;
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(POSITION_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return;
    for (const entry of stored.slice(-100)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== "string" || !value || typeof value !== "object") continue;
      const p = value as Record<string, unknown>;
      if (
        typeof p.rowId !== "string" ||
        typeof p.offsetWithinRow !== "number" ||
        !Number.isFinite(p.offsetWithinRow) ||
        typeof p.atEnd !== "boolean"
      )
        continue;
      if (
        ["messageId", "turnId", "createdAt", "anchorMessageId"].some(
          (field) => p[field] !== undefined && typeof p[field] !== "string",
        )
      )
        continue;
      if (
        p.neighborMessageIds !== undefined &&
        (!Array.isArray(p.neighborMessageIds) ||
          !p.neighborMessageIds.every((id) => typeof id === "string"))
      )
        continue;
      rememberedTimelinePositions.set(key, {
        rowId: p.rowId,
        offsetWithinRow: p.offsetWithinRow,
        scrollOffset: 0,
        atEnd: p.atEnd,
        ...(typeof p.messageId === "string" ? { messageId: p.messageId } : {}),
        ...(typeof p.turnId === "string" ? { turnId: p.turnId } : {}),
        ...(typeof p.createdAt === "string" ? { createdAt: p.createdAt } : {}),
        ...(typeof p.anchorMessageId === "string" ? { anchorMessageId: p.anchorMessageId } : {}),
        ...(p.disclosures && typeof p.disclosures === "object"
          ? { disclosures: readDisclosures(p.disclosures as Record<string, unknown>) }
          : {}),
        ...(Array.isArray(p.neighborMessageIds)
          ? { neighborMessageIds: p.neighborMessageIds }
          : {}),
      });
    }
  } catch {
    /* Storage may be unavailable or contain an older/corrupt record. */
  }
}

export function readTimelinePosition(threadKey: string) {
  loadPositions();
  return rememberedTimelinePositions.get(threadKey);
}

export function rememberTimelinePosition(threadKey: string, position: RememberedTimelinePosition) {
  loadPositions();
  rememberedTimelinePositions.delete(threadKey);
  rememberedTimelinePositions.set(threadKey, position);
  if (rememberedTimelinePositions.size > 100) {
    const oldest = rememberedTimelinePositions.keys().next().value;
    if (oldest !== undefined) rememberedTimelinePositions.delete(oldest);
  }
  // Capture while this thread still owns the list. Only storage I/O is deferred.
  if (persistenceTimer !== undefined) clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(flushTimelinePositions, 120);
}

/** Persist already captured positions even after the list has switched threads. */
export function flushTimelinePositions() {
  if (persistenceTimer === undefined) return;
  clearTimeout(persistenceTimer);
  persistenceTimer = undefined;
  try {
    sessionStorage.setItem(
      POSITION_STORAGE_KEY,
      JSON.stringify(
        [...rememberedTimelinePositions].map(
          ([key, { disclosures, scrollOffset: _offset, ...value }]) => [
            key,
            {
              ...value,
              ...(disclosures
                ? {
                    disclosures: {
                      runs: [...disclosures.runs],
                      workGroups: [...disclosures.workGroups],
                      attempts: [...disclosures.attempts],
                      expandedEntries: [...disclosures.workGroupState.expandedEntries],
                    },
                  }
                : {}),
            },
          ],
        ),
      ),
    );
  } catch {
    /* In-memory navigation still works when storage is unavailable. */
  }
}
