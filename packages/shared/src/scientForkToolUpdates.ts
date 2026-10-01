/**
 * SCIENT-OWNED. Which tool progress rows a fork leaves behind.
 *
 * A provider reports one tool call as a run of `tool.updated` rows and then,
 * usually, a `tool.completed` row. The timeline folds a run into one entry: a
 * later row's value replaces an earlier one, and a field only an earlier row
 * has is kept. Copying every progress row made a fork of a tool-heavy thread
 * several times larger than what it shows.
 *
 * A progress row is left behind only when the next kept row of its run carries
 * everything it has, so the folded entry is the same without it. Always kept:
 * the first row of a run (it places the entry), the row that ends it, results
 * and denials, and any row with something no later row carries.
 */

export interface ForkToolRow {
  readonly id: string;
  readonly kind: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Everything in `earlier` is in `later`, unchanged. `later` may have more. */
function containedIn(earlier: unknown, later: unknown): boolean {
  if (earlier === null || earlier === undefined) return true;
  if (isRecord(earlier)) {
    return (
      isRecord(later) &&
      Object.entries(earlier).every(([key, value]) => containedIn(value, later[key]))
    );
  }
  return Array.isArray(earlier) ? sameJson(earlier, later) : earlier === later;
}

/**
 * The timeline shows a row's own fields (status, title, detail) from the latest
 * row that has them, so a later value may differ. What sits under `data` is
 * accumulated across the run (the files a call touched), so it must be carried
 * unchanged.
 */
function carriesNothingNew(earlier: unknown, later: unknown): boolean {
  if (!isRecord(earlier)) return earlier === null || earlier === undefined;
  if (!isRecord(later)) return false;
  return Object.entries(earlier).every(([key, value]) =>
    key === "data"
      ? containedIn(value, later.data)
      : value === null || value === undefined || typeof value === typeof later[key],
  );
}

function toolCallOf(row: ForkToolRow): string | undefined {
  if (row.kind !== "tool.updated" && row.kind !== "tool.completed" && row.kind !== "tool.denied") {
    return undefined;
  }
  const toolCallId = isRecord(row.payload) ? row.payload.toolCallId : undefined;
  // The same provider id in another turn is another call.
  return typeof toolCallId === "string" ? `${row.turnId ?? ""}\u001f${toolCallId}` : undefined;
}

// A copied row has no origin sequence, so the fork's timeline orders it by time
// and, at the same instant, a progress row before a result.
function compareAsForkTimeline(left: ForkToolRow, right: ForkToolRow): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return Number(left.kind !== "tool.updated") - Number(right.kind !== "tool.updated");
}

export function withoutSupersededToolUpdates<Row extends ForkToolRow>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row> {
  const rowsByCall = new Map<string, Row[]>();
  for (const row of rows) {
    const call = toolCallOf(row);
    if (call === undefined) continue;
    const callRows = rowsByCall.get(call);
    if (callRows === undefined) rowsByCall.set(call, [row]);
    else callRows.push(row);
  }

  const superseded = new Set<string>();
  for (const callRows of rowsByCall.values()) {
    const ordered = [...callRows].sort(compareAsForkTimeline);
    let nextKept: Row | undefined;
    for (let index = ordered.length - 1; index >= 0; index--) {
      const row = ordered[index]!;
      const continuesRun = index > 0 && ordered[index - 1]!.kind === "tool.updated";
      if (
        row.kind === "tool.updated" &&
        continuesRun &&
        nextKept !== undefined &&
        // A denial is its own entry; progress does not fold into it.
        nextKept.kind !== "tool.denied" &&
        carriesNothingNew(row.payload, nextKept.payload)
      ) {
        superseded.add(row.id);
      } else {
        nextKept = row;
      }
    }
  }
  return superseded.size === 0 ? rows : rows.filter((row) => !superseded.has(row.id));
}
