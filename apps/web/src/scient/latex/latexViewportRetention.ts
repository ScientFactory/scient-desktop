/** Retain recent reading views, independently of geometry and source ownership.
 * Weight is a conservative admission estimate, not a measurement of JS heap.
 */
export function createLatexViewportRetention<T>(
  options = {
    maximumEntries: Number.POSITIVE_INFINITY,
    maximumWeight: 64 * 1024 * 1024,
  },
) {
  const entries = new Map<T, { weight: number; read: boolean }>();
  const background = new Set<T>();
  let total = 0;
  return {
    update(
      visible: ReadonlySet<T>,
      current: ReadonlySet<T>,
      weight: (item: T) => number,
      completed: ReadonlySet<T> = new Set(),
    ) {
      for (const item of visible) {
        entries.delete(item);
        background.delete(item);
        const cost = weight(item);
        if (current.has(item) && cost <= options.maximumWeight)
          entries.set(item, { weight: cost, read: true });
      }
      total = 0;
      for (const [item, entry] of entries) {
        if (!current.has(item)) {
          entries.delete(item);
          background.delete(item);
        } else {
          entry.weight = weight(item);
          total += entry.weight;
        }
      }
      while (entries.size > options.maximumEntries || total > options.maximumWeight) {
        const oldest = background.values().next().value ?? entries.keys().next().value!;
        total -= entries.get(oldest)!.weight;
        entries.delete(oldest);
        background.delete(oldest);
      }
      // Background completion uses spare capacity. It must not evict a page
      // the reader visited, or churn already admitted background DOM each tick.
      for (const item of completed) {
        if (entries.has(item) || !current.has(item)) continue;
        const cost = weight(item);
        if (entries.size < options.maximumEntries && total + cost <= options.maximumWeight) {
          entries.set(item, { weight: cost, read: false });
          background.add(item);
          total += cost;
        }
      }
      return new Set(entries.keys());
    },
    canAdmit(weight: number, reserved = 0) {
      return (
        entries.size < options.maximumEntries && total + reserved + weight <= options.maximumWeight
      );
    },
    statistics() {
      return { bytes: total, entries: entries.size, maximumBytes: options.maximumWeight };
    },
    clear() {
      entries.clear();
      background.clear();
      total = 0;
    },
  };
}
