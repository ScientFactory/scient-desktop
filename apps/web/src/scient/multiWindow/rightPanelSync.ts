import type { StoreApi } from "zustand";

import type { StateStorage } from "../../lib/storage";
import type { ThreadPanelVisibility, ThreadRightPanelState } from "../../rightPanelStore";
import { createCrossWindowStateSync, mergeWindowEntries } from "./crossWindowMerge";

type Entries<V> = Readonly<Record<string, V>>;

interface PersistedRightPanelState {
  readonly byThreadKey: Entries<ThreadRightPanelState>;
  readonly threadPanelVisibilityByThreadKey: Entries<ThreadPanelVisibility>;
}

interface RightPanelMemory {
  readonly byThreadKey: Record<string, ThreadRightPanelState>;
  readonly threadPanelVisibilityByThreadKey: Record<string, ThreadPanelVisibility>;
}

type PersistedStore<S> = StoreApi<S> & {
  readonly persist: { readonly getOptions: () => { readonly partialize?: (state: S) => unknown } };
};

function mergeRightPanelState(
  local: PersistedRightPanelState,
  synced: PersistedRightPanelState,
  stored: PersistedRightPanelState,
): PersistedRightPanelState {
  const byThreadKey = mergeWindowEntries(local.byThreadKey, synced.byThreadKey, stored.byThreadKey);
  const threadPanelVisibilityByThreadKey = mergeWindowEntries(
    local.threadPanelVisibilityByThreadKey,
    synced.threadPanelVisibilityByThreadKey,
    stored.threadPanelVisibilityByThreadKey,
  );
  return byThreadKey === local.byThreadKey &&
    threadPanelVisibilityByThreadKey === local.threadPanelVisibilityByThreadKey
    ? local
    : { byThreadKey, threadPanelVisibilityByThreadKey };
}

/** Applies the persisted entries that `merged` changed to the in-memory record. */
function patchEntries<V>(
  memory: Record<string, V>,
  local: Entries<V>,
  merged: Entries<V>,
): Record<string, V> {
  if (merged === local) return memory;
  const next = { ...memory };
  for (const key of new Set([...Object.keys(local), ...Object.keys(merged)])) {
    const value = merged[key];
    if (value === local[key]) continue;
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * App windows share the side panel's per-thread state. A save keeps the threads other windows
 * changed, and a window adopts other windows' saves, so a thread's tabs match in every window.
 */
export function createRightPanelWindowSync(options: {
  readonly key: string;
  readonly version: number;
  readonly storage: StateStorage;
}) {
  const read = (): PersistedRightPanelState | null => {
    try {
      const raw = options.storage.getItem(options.key);
      if (typeof raw !== "string") return null;
      const parsed = JSON.parse(raw) as {
        state?: Partial<PersistedRightPanelState>;
        version?: unknown;
      } | null;
      if (parsed?.version !== options.version || !parsed.state) return null;
      return {
        byThreadKey: parsed.state.byThreadKey ?? {},
        threadPanelVisibilityByThreadKey: parsed.state.threadPanelVisibilityByThreadKey ?? {},
      };
    } catch {
      return null;
    }
  };
  const sync = createCrossWindowStateSync<PersistedRightPanelState>({
    read,
    merge: mergeRightPanelState,
  });

  const storage: StateStorage = {
    getItem: (name) => options.storage.getItem(name),
    removeItem: (name) => options.storage.removeItem(name),
    setItem: (name, value) => {
      if (name !== options.key) return options.storage.setItem(name, value);
      const persisted = JSON.parse(value) as { state: PersistedRightPanelState; version: number };
      const local = persisted.state;
      const merged = sync.mergeForWrite(local);
      const result = options.storage.setItem(
        name,
        merged === local ? value : JSON.stringify({ ...persisted, state: merged }),
      );
      sync.didWrite(local);
      return result;
    },
  };

  return {
    storage,
    attach: <S extends RightPanelMemory>(
      store: PersistedStore<S>,
      eventTarget: Partial<Pick<EventTarget, "addEventListener">> | undefined,
    ): void => {
      const toPersisted = (state: S) => {
        const partialize = store.persist.getOptions().partialize;
        return (partialize ? partialize(state) : state) as PersistedRightPanelState;
      };
      sync.setBaseline(read() ?? toPersisted(store.getState()));
      if (typeof eventTarget?.addEventListener !== "function") return;
      eventTarget.addEventListener("storage", (event) => {
        if ((event as Partial<StorageEvent>).key !== options.key) return;
        const state = store.getState();
        const local = toPersisted(state);
        const merged = sync.adoptStored(local);
        if (merged === local) return;
        store.setState({
          byThreadKey: patchEntries(state.byThreadKey, local.byThreadKey, merged.byThreadKey),
          threadPanelVisibilityByThreadKey: patchEntries(
            state.threadPanelVisibilityByThreadKey,
            local.threadPanelVisibilityByThreadKey,
            merged.threadPanelVisibilityByThreadKey,
          ),
        } as Partial<S>);
      });
    },
  };
}
