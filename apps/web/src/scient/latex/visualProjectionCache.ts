import type { LatexVisualDocument } from "./latexVisualDocument";

/** Reopening can reuse parsing only for an exact source and setup pair. */
export function createVisualProjectionCache(maxEntries = 4, maxBytes = 8 * 1024 * 1024) {
  const entries: {
    source: string;
    setup: string;
    projection: LatexVisualDocument;
    bytes: number;
  }[] = [];
  let bytes = 0;
  return {
    get(source: string, setup: string): LatexVisualDocument | null {
      const index = entries.findIndex((entry) => entry.source === source && entry.setup === setup);
      if (index < 0) return null;
      const entry = entries.splice(index, 1)[0]!;
      entries.push(entry);
      return entry.projection;
    },
    put(source: string, setup: string, projection: LatexVisualDocument) {
      if (projection.source !== source) return;
      const index = entries.findIndex((entry) => entry.source === source && entry.setup === setup);
      if (index >= 0) bytes -= entries.splice(index, 1)[0]!.bytes;
      const size = 2 * (source.length + setup.length + JSON.stringify(projection).length);
      if (size > maxBytes) return;
      entries.push({ source, setup, projection, bytes: size });
      bytes += size;
      while (entries.length > maxEntries || bytes > maxBytes) bytes -= entries.shift()!.bytes;
    },
  };
}

export const visualProjectionCache = createVisualProjectionCache();
