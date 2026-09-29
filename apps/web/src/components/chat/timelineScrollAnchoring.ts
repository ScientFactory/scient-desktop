import { TurnId } from "@t3tools/contracts";

// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
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
    readonly turns: ReadonlySet<TurnId>;
    readonly workGroups: ReadonlySet<string>;
    readonly spawnEntries: ReadonlySet<string>;
    readonly reasoningMessages: ReadonlySet<string>;
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

function readDisclosures(
  value: Record<string, unknown>,
): NonNullable<RememberedTimelinePosition["disclosures"]> {
  const strings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((id): id is string => typeof id === "string").slice(0, 1000)
      : [];
  return {
    turns: new Set(strings(value.turns).map((id) => TurnId.make(id))),
    workGroups: new Set(strings(value.workGroups)),
    spawnEntries: new Set(strings(value.spawnEntries)),
    reasoningMessages: new Set(strings(value.reasoningMessages)),
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
                      turns: [...disclosures.turns],
                      workGroups: [...disclosures.workGroups],
                      spawnEntries: [...disclosures.spawnEntries],
                      reasoningMessages: [...disclosures.reasoningMessages],
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
