import type { StateStorage } from "../../lib/storage";

type Entries<V> = Readonly<Record<string, V>>;

const jsonByObject = new WeakMap<object, string>();

function sortKeys(_key: string, value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).toSorted(([left], [right]) => (left < right ? -1 : 1)),
      )
    : value;
}

/**
 * JSON with sorted keys, since key order differs between windows. Cached per object, so
 * persisted state must not be mutated once compared.
 */
export function stableJson(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  let json = jsonByObject.get(value);
  if (json === undefined) {
    json = JSON.stringify(value, sortKeys);
    jsonByObject.set(value, json);
  }
  return json;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return left === right || stableJson(left) === stableJson(right);
}

/** The `state` of a zustand persist value saved at `version`, or null. */
export function parseStoredState(raw: unknown, version: number): object | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; version?: unknown } | null;
    return parsed?.version === version && typeof parsed.state === "object" && parsed.state !== null
      ? parsed.state
      : null;
  } catch {
    return null;
  }
}

export function readStoredState(
  storage: Pick<StateStorage, "getItem">,
  key: string,
  version: number,
): object | null {
  try {
    return parseStoredState(storage.getItem(key), version);
  } catch {
    return null;
  }
}

/** Calls `handler` when another window of this origin writes `key`. */
export function onStorageKey(key: string, handler: () => void): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("storage", (event) => {
    if (event.key === key) handler();
  });
}

/** A value this window has not changed since `synced` takes what another window stored. */
export function mergeWindowValue<V>(local: V, synced: V, stored: V): V {
  return sameJson(local, synced) && !sameJson(local, stored) ? stored : local;
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
    const value = sameJson(own, base)
      ? theirs
      : options.resolveChanged
        ? options.resolveChanged(own, base, theirs)
        : own;
    if (sameJson(value, own)) continue;
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
  /** Merges another window's save into memory; `merge` when absent. */
  readonly adopt?: (local: T, synced: T, stored: T) => T;
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
    // Call it only once the write has landed.
    didWrite: (local: T): void => {
      synced = local;
    },
    adoptStored: (local: T): T => {
      const stored = options.read();
      if (stored === null || synced === null) return local;
      const merged = (options.adopt ?? options.merge)(local, synced, stored);
      synced = stored;
      return merged;
    },
  };
}

type CrossWindowStateSync<T> = ReturnType<typeof createCrossWindowStateSync<T>>;

/**
 * `storage` whose saves of `key`, a zustand persist value, merge through `sync`. `lens` picks
 * the merged part of the persisted state; without it the whole state merges.
 */
export function createMergingStorage<T, S = T>(
  storage: StateStorage,
  key: string,
  sync: CrossWindowStateSync<T>,
  lens?: { readonly get: (state: S) => T; readonly set: (state: S, merged: T) => S },
): StateStorage {
  const get = lens?.get ?? ((state: S) => state as unknown as T);
  const set = lens?.set ?? ((_state: S, merged: T) => merged as unknown as S);
  return {
    getItem: (name) => storage.getItem(name),
    removeItem: (name) => storage.removeItem(name),
    setItem: (name, value) => {
      if (name !== key) return storage.setItem(name, value);
      const persisted = JSON.parse(value) as { state: S };
      const local = get(persisted.state);
      const merged = sync.mergeForWrite(local);
      const result = storage.setItem(
        name,
        merged === local
          ? value
          : JSON.stringify({ ...persisted, state: set(persisted.state, merged) }),
      );
      sync.didWrite(local);
      return result;
    },
  };
}
