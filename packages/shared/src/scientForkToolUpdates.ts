/**
 * SCIENT-OWNED. Which tool progress rows a fork leaves behind.
 *
 * A provider reports one tool call as a run of `tool.updated` rows, many of
 * them exact repeats, and then usually a result. The timeline folds a run into
 * one entry. A row between two rows identical to it adds nothing to that fold:
 * the row before it already contributed the same fields, and the row after it
 * supplies the entry's final identity. A fork does not copy such rows.
 *
 * Copied rows have no origin sequence, so rows at the same instant have no
 * fixed order in the fork. A row is left behind only when the three rows are
 * the only ones of their call at their times, so they stay adjacent.
 */

export interface ForkToolRow {
  readonly id: string;
  readonly kind: string;
  readonly tone: string;
  readonly summary: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly payload: unknown;
}

function toolCallOf(row: ForkToolRow): string | undefined {
  if (row.kind !== "tool.updated" && row.kind !== "tool.completed" && row.kind !== "tool.denied") {
    return undefined;
  }
  const payload = row.payload;
  const toolCallId =
    typeof payload === "object" && payload !== null && "toolCallId" in payload
      ? payload.toolCallId
      : undefined;
  // The same provider id in another turn is another call.
  return typeof toolCallId === "string" ? `${row.turnId ?? ""}\u001f${toolCallId}` : undefined;
}

const contentOf = (row: ForkToolRow) =>
  JSON.stringify([row.kind, row.tone, row.summary, row.payload]);

export function withoutRepeatedToolUpdates<Row extends ForkToolRow>(
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

  const repeated = new Set<string>();
  for (const callRows of rowsByCall.values()) {
    const ordered = [...callRows].sort((left, right) =>
      left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
    );
    const time = (index: number) => ordered[index]?.createdAt;
    const contents = ordered.map((row) => (row.kind === "tool.updated" ? contentOf(row) : null));
    for (let index = 1; index < ordered.length - 1; index++) {
      const content = contents[index];
      const before = time(index - 2);
      const after = time(index + 2);
      if (
        content !== null &&
        contents[index - 1] === content &&
        contents[index + 1] === content &&
        (before === undefined || before < time(index - 1)!) &&
        time(index - 1)! < time(index)! &&
        time(index)! < time(index + 1)! &&
        (after === undefined || time(index + 1)! < after)
      ) {
        repeated.add(ordered[index]!.id);
      }
    }
  }
  return repeated.size === 0 ? rows : rows.filter((row) => !repeated.has(row.id));
}
