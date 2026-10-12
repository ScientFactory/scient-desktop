/** Sum presentation gaps inside a source block without scanning every page per paragraph. */
export function latexGapHeightIndex(gaps: readonly { position: number; height: number }[]) {
  const ordered = [...gaps].sort((a, b) => a.position - b.position);
  const totals = [0];
  for (const gap of ordered) totals.push(totals[totals.length - 1]! + gap.height);
  const bound = (position: number, inclusive: boolean) => {
    let low = 0,
      high = ordered.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (
        ordered[middle]!.position < position ||
        (inclusive && ordered[middle]!.position === position)
      )
        low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return (from: number, to: number) =>
    to <= from ? 0 : totals[bound(to, false)]! - totals[bound(from, true)]!;
}
