import type { StoreApi } from "zustand";

import type { StateStorage } from "../../lib/storage";
import type { ThreadPanelVisibility, ThreadRightPanelState } from "../../rightPanelStore";
import {
  createCrossWindowStateSync,
  createMergingStorage,
  mergeWindowEntries,
  onStorageKey,
  readStoredState,
  stableJson,
} from "./crossWindowMerge";

type Entries<V> = Readonly<Record<string, V>>;
type ThreadPanel = ThreadRightPanelState;

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

const NO_ENTRY: ThreadPanel = { isOpen: false, activeSurfaceId: null, surfaces: [] };

/** Each window's view of a thread's tabs; the rest of the entry is shared. */
function splitView(entry: ThreadPanel | undefined) {
  const { isOpen, activeSurfaceId, maximized = false, ...tabs } = entry ?? NO_ENTRY;
  return { view: { isOpen, activeSurfaceId, maximized }, tabs };
}

const tabsKey = (entry: ThreadPanel | undefined) => stableJson(splitView(entry).tabs);
const NO_TABS = tabsKey(undefined);

const entryKey = (entry: ThreadPanel | undefined) =>
  entry === undefined ? "" : stableJson(splitView(entry));

/** `theirs`'s tabs as `own` showed them; a tab closed elsewhere gives way to its neighbour. */
function withOwnView(
  own: ThreadPanel | undefined,
  theirs: ThreadPanel | undefined,
): ThreadPanel | undefined {
  if (tabsKey(theirs) === NO_TABS) return undefined;
  const { view: theirView, tabs } = splitView(theirs);
  const { surfaces } = tabs;
  const exists = (id: string | null): id is string =>
    id !== null && surfaces.some((surface) => surface.id === id);
  const ownActive = own?.activeSurfaceId ?? null;
  const ownIndex = own?.surfaces.findIndex((surface) => surface.id === ownActive) ?? -1;
  const activeSurfaceId = exists(ownActive)
    ? ownActive
    : ownIndex >= 0 && surfaces.length > 0
      ? surfaces[Math.min(ownIndex, surfaces.length - 1)]!.id
      : exists(theirView.activeSurfaceId)
        ? theirView.activeSurfaceId
        : (surfaces[0]?.id ?? null);
  return {
    ...tabs,
    isOpen: (own?.isOpen ?? false) && surfaces.length > 0,
    activeSurfaceId,
    ...(own?.maximized ? { maximized: true as const } : {}),
  };
}

function resolveThreadPanel(
  own: ThreadPanel | undefined,
  base: ThreadPanel | undefined,
  theirs: ThreadPanel | undefined,
  adopting: boolean,
): ThreadPanel | undefined {
  if (!adopting && entryKey(own) === entryKey(base)) return theirs;
  if (tabsKey(own) !== tabsKey(base)) return own;
  return withOwnView(own, theirs);
}

function mergeThreadPanels(
  local: Entries<ThreadPanel>,
  synced: Entries<ThreadPanel>,
  stored: Entries<ThreadPanel>,
  adopting: boolean,
): Entries<ThreadPanel> {
  let next: Record<string, ThreadPanel> | null = null;
  for (const key of new Set([...Object.keys(local), ...Object.keys(stored)])) {
    const own = Object.hasOwn(local, key) ? local[key] : undefined;
    const value = resolveThreadPanel(
      own,
      Object.hasOwn(synced, key) ? synced[key] : undefined,
      Object.hasOwn(stored, key) ? stored[key] : undefined,
      adopting,
    );
    if (entryKey(value) === entryKey(own)) continue;
    next ??= { ...local };
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next ?? local;
}

function mergeRightPanelState(
  local: PersistedRightPanelState,
  synced: PersistedRightPanelState,
  stored: PersistedRightPanelState,
  adopting: boolean,
): PersistedRightPanelState {
  const byThreadKey = mergeThreadPanels(
    local.byThreadKey,
    synced.byThreadKey,
    stored.byThreadKey,
    adopting,
  );
  const threadPanelVisibilityByThreadKey = adopting
    ? local.threadPanelVisibilityByThreadKey
    : mergeWindowEntries(
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
 * App windows share each thread's side panel tabs, while each window keeps its own view of them:
 * the selected tab, whether the panel is open or maximized, and the thread details panel. A save
 * keeps what other windows changed, and a window adopts other windows' tab changes.
 */
export function createRightPanelWindowSync(options: {
  readonly key: string;
  readonly version: number;
  readonly storage: StateStorage;
}) {
  const read = (): PersistedRightPanelState | null => {
    const state: Partial<PersistedRightPanelState> | null = readStoredState(
      options.storage,
      options.key,
      options.version,
    );
    return state === null
      ? null
      : {
          byThreadKey: state.byThreadKey ?? {},
          threadPanelVisibilityByThreadKey: state.threadPanelVisibilityByThreadKey ?? {},
        };
  };
  const sync = createCrossWindowStateSync<PersistedRightPanelState>({
    read,
    merge: (local, synced, stored) => mergeRightPanelState(local, synced, stored, false),
    adopt: (local, synced, stored) => mergeRightPanelState(local, synced, stored, true),
  });

  return {
    storage: createMergingStorage(options.storage, options.key, sync),
    attach: <S extends RightPanelMemory>(store: PersistedStore<S>): void => {
      const toPersisted = (state: S) => {
        const partialize = store.persist.getOptions().partialize;
        return (partialize ? partialize(state) : state) as PersistedRightPanelState;
      };
      sync.setBaseline(read() ?? toPersisted(store.getState()));
      onStorageKey(options.key, () => {
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
