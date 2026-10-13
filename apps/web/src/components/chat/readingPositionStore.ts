import { RunAttemptId, RunId } from "@t3tools/contracts";
import type { RememberedTimelinePosition } from "./timelineScrollAnchoring";

/**
 * Scient keeps reading positions across renderer reloads: upstream's
 * in-memory map (timelineScrollAnchoring.ts) is loaded from and written to
 * session storage here. Only identifiers and layout metadata are persisted,
 * never message text. Session storage survives renderer reloads and remains
 * isolated per window/environment.
 */
const POSITION_STORAGE_KEY = "scient:timeline-reading-position:v1";
let positionsLoaded = false;
let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPositions: ReadonlyMap<string, RememberedTimelinePosition> | undefined;

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

/** Fills the in-memory positions from session storage, once per renderer. */
export function loadReadingPositions(positions: Map<string, RememberedTimelinePosition>) {
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
      positions.set(key, {
        rowId: p.rowId,
        offsetWithinRow: p.offsetWithinRow,
        scrollOffset: 0,
        atEnd: p.atEnd,
        // The followed prompt, kept with the position.
        ...(typeof p.followingPromptId === "string"
          ? { followingPromptId: p.followingPromptId }
          : {}),
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

/**
 * Writes the positions to session storage shortly. Positions are captured
 * while their thread still owns the list; only storage I/O is deferred.
 */
export function scheduleReadingPositionFlush(
  positions: ReadonlyMap<string, RememberedTimelinePosition>,
) {
  pendingPositions = positions;
  if (persistenceTimer !== undefined) clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(flushTimelinePositions, 120);
}

/** Persist already captured positions even after the list has switched threads. */
export function flushTimelinePositions() {
  if (persistenceTimer === undefined) return;
  clearTimeout(persistenceTimer);
  persistenceTimer = undefined;
  const positions = pendingPositions;
  if (positions === undefined) return;
  try {
    sessionStorage.setItem(
      POSITION_STORAGE_KEY,
      JSON.stringify(
        [...positions].map(([key, { disclosures, scrollOffset: _offset, ...value }]) => [
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
        ]),
      ),
    );
  } catch {
    /* In-memory navigation still works when storage is unavailable. */
  }
}
