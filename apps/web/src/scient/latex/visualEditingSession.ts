import { visualRuns, type VisualRun } from "@t3tools/shared/latexVisual";

export interface SourceChange {
  readonly from: number;
  readonly to: number;
  readonly insertedLength: number;
}

export interface VisualMatch {
  readonly run: VisualRun;
  readonly offset: number;
}

export function sourceChange(before: string, after: string): SourceChange {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let suffix = 0;
  while (
    suffix < before.length - from &&
    suffix < after.length - from &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  return {
    from,
    to: before.length - suffix,
    insertedLength: after.length - from - suffix,
  };
}

function mapSourceOffset(
  offset: number,
  changes: readonly SourceChange[],
  affinity: "before" | "after" | "nearest",
): number {
  let mapped = offset;
  for (const change of changes) {
    if (mapped < change.from || (mapped === change.from && affinity === "before")) continue;
    if (mapped > change.to || (mapped === change.to && affinity === "after")) {
      mapped += change.insertedLength - (change.to - change.from);
      continue;
    }
    mapped =
      affinity === "before"
        ? change.from
        : affinity === "after"
          ? change.from + change.insertedLength
          : change.from + Math.min(mapped - change.from, change.insertedLength);
  }
  return mapped;
}

/** Rebase a match from the pinned compiled source through Visual's minimal source edits. */
export function rebaseVisualMatch(
  match: VisualMatch,
  source: string,
  changes: readonly SourceChange[],
): VisualMatch | null {
  if (changes.length === 0) return match;
  const mappedFrom = mapSourceOffset(match.run.from, changes, "before");
  const mappedTo = mapSourceOffset(match.run.to, changes, "after");
  const clickedSource = match.run.boundaries[match.offset];
  if (clickedSource === undefined) return null;
  const mappedClick = mapSourceOffset(clickedSource, changes, "nearest");
  const run = visualRuns(source).find(
    (candidate) =>
      candidate.from <= mappedClick &&
      candidate.to >= mappedClick &&
      candidate.from <= mappedTo &&
      candidate.to >= mappedFrom,
  );
  if (!run) return null;
  let offset = run.boundaries.findIndex((boundary) => boundary >= mappedClick);
  if (offset < 0) offset = run.text.length;
  return { run, offset };
}
