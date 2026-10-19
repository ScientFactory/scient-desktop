/** Formula markup and reusable geometry share an estimated byte budget. The
 * authoritative source/model and mounted editors have separate lifetimes.
 */
export function createLatexReadingCacheBudget(maximumBytes: number) {
  const entries = new Map<string, { value: unknown; bytes: number; reading: boolean }>();
  const background = new Set<string>();
  let bytes = 0;
  let evictions = 0;
  let rejections = 0;
  let capacityRejections = 0;
  let peakBytes = 0;
  return {
    statistics: () => ({
      bytes,
      entries: entries.size,
      maximumBytes,
      evictions,
      rejections,
      capacityRejections,
      peakBytes,
    }),
    cache<T>(namespace: string) {
      const keyFor = (key: string) => `${namespace}:${key}`;
      const weightFor = (key: string, valueBytes: number) =>
        valueBytes + keyFor(key).length * 2 + 256;
      return {
        canRetain(key: string, valueBytes: number) {
          const weight = weightFor(key, valueBytes);
          return Number.isFinite(weight) && weight >= 256 && weight <= maximumBytes;
        },
        peek(key: string): T | undefined {
          return entries.get(keyFor(key))?.value as T | undefined;
        },
        delete(key: string) {
          const id = keyFor(key);
          const entry = entries.get(id);
          if (entry) {
            bytes -= entry.bytes;
            entries.delete(id);
            background.delete(id);
          }
        },
        get(key: string, reading = false): T | undefined {
          const id = keyFor(key);
          const entry = entries.get(id);
          if (!entry) return;
          entry.reading ||= reading;
          entries.delete(id);
          entries.set(id, entry);
          background.delete(id);
          if (!entry.reading) background.add(id);
          return entry.value as T;
        },
        put(
          key: string,
          value: T,
          valueBytes: number,
          reading = false,
          admission: "replace" | "available" = "replace",
        ) {
          const id = keyFor(key);
          // Account for keys and map/object overhead too; many short formulas
          // must not turn into an unbounded cache or hit an arbitrary 512 cap.
          const weight = weightFor(key, valueBytes);
          const previous = entries.get(id);
          if (!Number.isFinite(weight) || weight < 256 || weight > maximumBytes) {
            rejections++;
            return false;
          }
          if (admission === "available" && bytes - (previous?.bytes ?? 0) + weight > maximumBytes) {
            rejections++;
            capacityRejections++;
            return false;
          }
          if (previous) bytes -= previous.bytes;
          entries.delete(id);
          background.delete(id);
          const protectedReading = reading || !!previous?.reading;
          entries.set(id, { value, bytes: weight, reading: protectedReading });
          if (!protectedReading) background.add(id);
          bytes += weight;
          while (bytes > maximumBytes) {
            const oldest = background.values().next().value ?? entries.keys().next().value!;
            bytes -= entries.get(oldest)!.bytes;
            entries.delete(oldest);
            background.delete(oldest);
            evictions++;
          }
          peakBytes = Math.max(peakBytes, bytes);
          return true;
        },
      };
    },
  };
}

export const latexReadingCacheBudget = createLatexReadingCacheBudget(24 * 1024 * 1024);
