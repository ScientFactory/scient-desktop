/**
 * One tool call's lifecycle as a single record.
 *
 * V1 recorded a tool call as many work-log rows: `tool.started`, a
 * `tool.updated` for every progress report, and `tool.completed`. Native V2
 * keeps one item per call and updates it in place. This folds the V1 rows of
 * one call into one record without losing content: the last row wins, and any
 * field it lacks, at the top level or inside `data`, comes from the newest
 * earlier row that has it. Pure, so the V2 importer and any other reader of V1
 * rows fold the same way; presentation limits belong to the caller.
 */

export interface ToolLifecycleRow {
  readonly kind: string | null;
  readonly turnId: string | null;
  /** The row's `payload.toolCallId`, when it has one. */
  readonly toolCallId: string | null;
}

export type ToolLifecycleOutcome = "completed" | "failed" | "interrupted";

const LIFECYCLE_KINDS: ReadonlySet<string> = new Set([
  "tool.started",
  "tool.updated",
  "tool.completed",
]);

/**
 * Groups rows, given in chronological order, into tool calls. Lifecycle rows
 * with the same turn and call id join one group, which a `tool.completed`
 * closes: a later row reusing the id starts a new call. Every other row is a
 * group of its own. Groups keep the order of their first row.
 */
export function groupToolLifecycles<R extends ToolLifecycleRow>(
  rows: ReadonlyArray<R>,
): ReadonlyArray<ReadonlyArray<R>> {
  const groups: R[][] = [];
  const open = new Map<string, R[]>();
  for (const row of rows) {
    if (row.kind === null || !LIFECYCLE_KINDS.has(row.kind) || row.toolCallId === null) {
      groups.push([row]);
      continue;
    }
    const key = `${row.turnId ?? ""}\u0000${row.toolCallId}`;
    let group = open.get(key);
    if (group === undefined) {
      group = [];
      groups.push(group);
      open.set(key, group);
    }
    group.push(row);
    if (row.kind === "tool.completed") open.delete(key);
  }
  return groups;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `latest` with every field it does not have filled from `earlier`, newest
 * first. A field that is present wins, even when its value is null. The
 * `nested` object is merged the same way, one level down.
 */
function fillFrom(
  latest: Readonly<Record<string, unknown>>,
  earlier: ReadonlyArray<unknown>,
  nested?: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...latest };
  for (let index = earlier.length - 1; index >= 0; index--) {
    const candidate = earlier[index];
    if (!isRecord(candidate)) continue;
    for (const [key, value] of Object.entries(candidate)) {
      if (key !== nested && !Object.hasOwn(merged, key)) merged[key] = value;
    }
  }
  if (nested !== undefined) {
    const nestedEarlier = earlier.flatMap((candidate) =>
      isRecord(candidate) && Object.hasOwn(candidate, nested) ? [candidate[nested]] : [],
    );
    if (Object.hasOwn(merged, nested)) {
      const own = merged[nested];
      if (isRecord(own)) merged[nested] = fillFrom(own, nestedEarlier);
    } else if (nestedEarlier.length > 0) {
      const newest = nestedEarlier.at(-1);
      merged[nested] = isRecord(newest) ? fillFrom(newest, nestedEarlier.slice(0, -1)) : newest;
    }
  }
  return merged;
}

/**
 * The call's payload: the last row's, completed with what earlier rows
 * reported and it did not repeat (for example the command, a file list, or a
 * tool icon). Payloads are given in chronological order.
 */
export function mergeToolLifecyclePayloads(payloads: ReadonlyArray<unknown>): unknown {
  const latest = payloads.at(-1);
  if (payloads.length < 2 || !isRecord(latest)) return latest;
  return fillFrom(latest, payloads.slice(0, -1), "data");
}

/**
 * How the call ended: failed when any of its rows reported failure, otherwise
 * completed when it has a completion row, and interrupted when it never
 * completed.
 */
export function toolLifecycleOutcome(
  rows: ReadonlyArray<{ readonly kind: string | null; readonly payload: unknown }>,
): ToolLifecycleOutcome {
  if (rows.some((row) => isRecord(row.payload) && row.payload.status === "failed")) return "failed";
  return rows.at(-1)?.kind === "tool.completed" ? "completed" : "interrupted";
}
