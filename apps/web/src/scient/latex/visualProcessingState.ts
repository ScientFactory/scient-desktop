import type { LatexVisualDocument } from "./latexVisualDocument";
import type { JSONContent } from "@tiptap/core";
import type { VisualChangeDelta, VisualChangeInput } from "./visualProcessingProtocol";

/** Send only changed immutable blocks once this worker owns the accepted base. */
export function visualChangeDelta(
  input: VisualChangeInput,
  base: number,
  baseContent: JSONContent = input.projection.content,
): VisualChangeDelta | null {
  if (input.source !== input.projection.source) return null;
  const before = baseContent.content ?? [];
  const after = input.content.content ?? [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  // Independently parsed content has no reusable block identities yet.
  if (prefix + suffix === 0) return null;
  return {
    kind: "change-delta",
    base,
    prefix,
    suffix,
    content: { ...input.content, content: after.slice(prefix, after.length - suffix) },
    rootSource: input.rootSource,
    allowRootUpdates: input.allowRootUpdates,
  };
}

/** Bounded worker-owned bases; eviction requests a full input, never guesses. */
export function createVisualProcessingState(maxEntries = 4, maxBytes = 8 * 1024 * 1024) {
  const bases = new Map<number, { projection: LatexVisualDocument; bytes: number }>();
  let bytes = 0;
  return {
    retain(id: number, projection: LatexVisualDocument) {
      const size = JSON.stringify(projection).length * 2;
      const previous = bases.get(id);
      if (previous) {
        bytes -= previous.bytes;
        bases.delete(id);
      }
      if (size > maxBytes) return;
      bases.set(id, { projection, bytes: size });
      bytes += size;
      while (bases.size > maxEntries || bytes > maxBytes) {
        const [key, value] = bases.entries().next().value!;
        bases.delete(key);
        bytes -= value.bytes;
      }
    },
    expand(delta: VisualChangeDelta): VisualChangeInput | null {
      const entry = bases.get(delta.base);
      if (!entry) return null;
      const content = entry.projection.content.content ?? [];
      if (
        !Number.isInteger(delta.prefix) ||
        !Number.isInteger(delta.suffix) ||
        delta.prefix < 0 ||
        delta.suffix < 0 ||
        delta.prefix + delta.suffix > content.length
      )
        return null;
      bases.delete(delta.base);
      bases.set(delta.base, entry);
      return {
        kind: "change",
        source: entry.projection.source,
        projection: entry.projection,
        content: {
          ...delta.content,
          content: [
            ...content.slice(0, delta.prefix),
            ...(delta.content.content ?? []),
            ...content.slice(content.length - delta.suffix),
          ],
        },
        rootSource: delta.rootSource,
        allowRootUpdates: delta.allowRootUpdates,
      };
    },
  };
}
