import type { TimelineEntry } from "~/session-logic";

// Placed refusals are recognised by identity in the same derivation pass.
const placedRefusals = new WeakSet<TimelineEntry>();

/**
 * An error whose parent is a user message, such as a steer the provider-input limit refused,
 * is about that message: it sits right after it and stays out of the work that folds around it.
 */
export function placeMessageRefusals(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  let refusalsByParentId: Map<string, Array<TimelineEntry>> | undefined;
  for (const entry of entries) {
    const item = entry.kind === "work" ? entry.entry.projectedItem?.item : undefined;
    if (item?.type !== "error" || item.parentItemId === null) continue;
    refusalsByParentId ??= new Map();
    const refusals = refusalsByParentId.get(item.parentItemId) ?? [];
    refusals.push(entry);
    refusalsByParentId.set(item.parentItemId, refusals);
  }
  if (refusalsByParentId === undefined) return entries;
  const parentIds = new Set<string>();
  for (const entry of entries) {
    const parentId = userMessageItemId(entry);
    if (parentId !== null && refusalsByParentId.has(parentId)) parentIds.add(parentId);
  }
  if (parentIds.size === 0) return entries;
  const placed = new Set(
    [...parentIds].flatMap((parentId) => refusalsByParentId.get(parentId) ?? []),
  );
  const result: Array<TimelineEntry> = [];
  for (const entry of entries) {
    if (placed.has(entry)) continue;
    result.push(entry);
    const parentId = userMessageItemId(entry);
    if (parentId === null || !parentIds.has(parentId)) continue;
    for (const refusal of refusalsByParentId.get(parentId) ?? []) {
      placedRefusals.add(refusal);
      result.push(refusal);
    }
  }
  return result;
}

export function isPlacedMessageRefusal(entry: TimelineEntry): boolean {
  return placedRefusals.has(entry);
}

function userMessageItemId(entry: TimelineEntry): string | null {
  return entry.kind === "message" &&
    entry.message.role === "user" &&
    entry.projectedItem?.item.type === "user_message"
    ? entry.projectedItem.item.id
    : null;
}
