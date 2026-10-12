/** Formula markup and reusable geometry share an estimated byte budget. The
 * authoritative source/model and mounted editors have separate lifetimes.
 */
export function createLatexReadingCacheBudget(maximumBytes: number) {
  const entries = new Map<string, { value: unknown; bytes: number; reading: boolean }>();
  let bytes = 0;
  return {
    statistics: () => ({ bytes, entries: entries.size, maximumBytes }),
    cache<T>(namespace: string) {
      const keyFor = (key: string) => `${namespace}:${key}`;
      return {
        delete(key: string) {
          const id = keyFor(key);
          const entry = entries.get(id);
          if (entry) {
            bytes -= entry.bytes;
            entries.delete(id);
          }
        },
        get(key: string, reading = false): T | undefined {
          const id = keyFor(key);
          const entry = entries.get(id);
          if (!entry) return;
          entry.reading ||= reading;
          entries.delete(id);
          entries.set(id, entry);
          return entry.value as T;
        },
        put(key: string, value: T, valueBytes: number, reading = false) {
          const id = keyFor(key);
          // Account for keys and map/object overhead too; many short formulas
          // must not turn into an unbounded cache or hit an arbitrary 512 cap.
          const weight = valueBytes + id.length * 2 + 256;
          if (!Number.isFinite(weight) || weight < 256 || weight > maximumBytes) return;
          const previous = entries.get(id);
          if (previous) bytes -= previous.bytes;
          entries.delete(id);
          entries.set(id, { value, bytes: weight, reading: reading || !!previous?.reading });
          bytes += weight;
          while (bytes > maximumBytes) {
            const oldest =
              [...entries].find(([, item]) => !item.reading) ?? entries.entries().next().value!;
            bytes -= oldest[1].bytes;
            entries.delete(oldest[0]);
          }
        },
      };
    },
  };
}

export const latexReadingCacheBudget = createLatexReadingCacheBudget(24 * 1024 * 1024);
const contexts = latexReadingCacheBudget.cache<number>("layout-context");
let contextSequence = 0;

/** Exact context interning avoids repeating the full reference/font setup in
 * every paragraph key. Eviction creates a new identity, never a false match.
 */
export function latexReadingContextIdentity(context: string) {
  const previous = contexts.get(context, true);
  if (previous !== undefined) return previous;
  const identity = ++contextSequence;
  contexts.put(context, identity, 8, true);
  return identity;
}
