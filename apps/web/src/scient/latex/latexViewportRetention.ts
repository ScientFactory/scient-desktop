/** Retain recent reading views, independently of geometry and source ownership.
 * Weight is a conservative admission estimate, not a measurement of JS heap.
 */
export function createLatexViewportRetention<T>(
  options = {
    maximumEntries: 128,
    maximumWeight: 4 * 1024 * 1024,
  },
) {
  const entries = new Map<T, { weight: number }>();
  return {
    update(visible: ReadonlySet<T>, current: ReadonlySet<T>, weight: (item: T) => number) {
      for (const item of visible) {
        entries.delete(item);
        const cost = weight(item);
        if (current.has(item) && cost <= options.maximumWeight) entries.set(item, { weight: cost });
      }
      let total = 0;
      for (const [item, entry] of entries) {
        if (!current.has(item)) entries.delete(item);
        else {
          entry.weight = weight(item);
          total += entry.weight;
        }
      }
      while (entries.size > options.maximumEntries || total > options.maximumWeight) {
        const oldest = entries.keys().next().value!;
        total -= entries.get(oldest)!.weight;
        entries.delete(oldest);
      }
      return new Set(entries.keys());
    },
    clear() {
      entries.clear();
    },
  };
}
