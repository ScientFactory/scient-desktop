type Entries<V> = Readonly<Record<string, V>>;

function sameValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** A value this window has not changed since `synced` takes what another window stored. */
export function mergeWindowValue<V>(local: V, synced: V, stored: V): V {
  return sameValue(local, synced) && !sameValue(local, stored) ? stored : local;
}

/**
 * Per-entry `mergeWindowValue`; an entry this window changed goes through `resolveChanged`.
 * Returns `local` itself when no entry differs, so callers can skip a state update.
 */
export function mergeWindowEntries<V>(
  local: Entries<V>,
  synced: Entries<V>,
  stored: Entries<V>,
  options: {
    readonly resolveChanged?: (
      local: V | undefined,
      synced: V | undefined,
      stored: V | undefined,
    ) => V | undefined;
    readonly isLocalOnly?: (key: string) => boolean;
  } = {},
): Entries<V> {
  let next: Record<string, V> | null = null;
  for (const key of new Set([...Object.keys(local), ...Object.keys(stored)])) {
    if (options.isLocalOnly?.(key)) continue;
    const own = Object.hasOwn(local, key) ? local[key] : undefined;
    const base = Object.hasOwn(synced, key) ? synced[key] : undefined;
    const theirs = Object.hasOwn(stored, key) ? stored[key] : undefined;
    const value = sameValue(own, base)
      ? theirs
      : options.resolveChanged
        ? options.resolveChanged(own, base, theirs)
        : own;
    if (sameValue(value, own)) continue;
    next ??= { ...local };
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next ?? local;
}

/**
 * App windows share localStorage but each keeps its own memory copy. `synced` is the stored
 * state this window's memory reflects; whatever differs from it is this window's own change.
 * Writes keep stored values for everything else, and another window's write is adopted
 * except where this window has an unsaved change.
 */
export function createCrossWindowStateSync<T>(options: {
  readonly read: () => T | null;
  readonly merge: (local: T, synced: T, stored: T) => T;
}) {
  let synced: T | null = null;
  return {
    setBaseline: (state: T): void => {
      synced = state;
    },
    mergeForWrite: (local: T): T => {
      if (synced === null) return local;
      const stored = options.read();
      return stored === null ? local : options.merge(local, synced, stored);
    },
    // Values this write took from storage stay unadopted in memory until the storage event
    // for the other window's write arrives, so `synced` follows memory, not the bytes written.
    didWrite: (local: T): void => {
      synced = local;
    },
    adoptStored: (local: T): T => {
      const stored = options.read();
      if (stored === null || synced === null) return local;
      const merged = options.merge(local, synced, stored);
      synced = stored;
      return merged;
    },
  };
}
