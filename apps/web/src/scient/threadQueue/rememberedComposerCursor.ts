const rememberedCursors = new Map<string, number>();

/** Most recently used drafts keep their cursor; the oldest of more than 128 is forgotten. */
export function rememberComposerCursor(key: string, cursor: number): void {
  rememberedCursors.delete(key);
  rememberedCursors.set(key, cursor);
  if (rememberedCursors.size > 128) {
    rememberedCursors.delete(rememberedCursors.keys().next().value!);
  }
}

export function rememberedComposerCursor(key: string): number | undefined {
  return rememberedCursors.get(key);
}
