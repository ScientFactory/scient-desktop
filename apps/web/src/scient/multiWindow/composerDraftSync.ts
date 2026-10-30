import type { StoreApi } from "zustand";

import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { resolveStorage, type StateStorage } from "../../lib/storage";
import { onStorageKey, parseStoredState, sameJson } from "./crossWindowMerge";

const KEYED_SECTIONS = [
  "draftsByThreadKey",
  "draftThreadsByThreadKey",
  "logicalProjectDraftThreadKeyByLogicalProjectKey",
] as const;
const WHOLE_SECTIONS = [
  "stickyModelSelectionByProvider",
  "stickyOptionsByModelByProvider",
  "stickyActiveProvider",
] as const;
type KeyedSection = (typeof KEYED_SECTIONS)[number];
type WholeSection = (typeof WHOLE_SECTIONS)[number];

type ComposerDraftPersistedSections = {
  readonly [Section in KeyedSection]: Readonly<Record<string, unknown>>;
} & { readonly [Section in WholeSection]?: unknown };

interface ComposerDraftMemorySections extends ComposerDraftPersistedSections {
  readonly draftsByThreadKey: Readonly<Record<string, ComposerThreadDraftState>>;
  readonly logicalProjectDraftThreadKeyByLogicalProjectKey: Readonly<Record<string, string>>;
}

type ComposerDraftSyncStore<S> = StoreApi<S> & {
  readonly persist: {
    readonly onFinishHydration: (listener: (state: S) => void) => () => void;
    readonly getOptions: () => {
      readonly merge?: ((persisted: unknown, current: S) => S) | undefined;
    };
  };
};

type Entries = Readonly<Record<string, unknown>>;

function entriesOf(value: unknown): Entries {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Entries)
    : {};
}

function revokeBlobUrl(url: string): void {
  if (url.startsWith("blob:") && typeof URL !== "undefined") URL.revokeObjectURL(url);
}

/** Keeps this window's in-memory attachment objects for entries another window still has. */
function reconcileRemoteComposerDraft(
  previous: ComposerThreadDraftState | undefined,
  next: ComposerThreadDraftState | undefined,
): ComposerThreadDraftState | undefined {
  const nextImageIds = new Set(next?.images.map((image) => image.id));
  for (const image of previous?.images ?? []) {
    if (!nextImageIds.has(image.id)) revokeBlobUrl(image.previewUrl);
  }
  if (!previous || !next) return next;
  const previousImages = new Map(previous.images.map((image) => [image.id, image]));
  const previousFiles = new Map(previous.files.map((file) => [file.id, file]));
  return {
    ...next,
    images: next.images.map((image) => previousImages.get(image.id) ?? image),
    files: next.files.map((file) => {
      const local = previousFiles.get(file.id)?.file;
      return local && !file.file ? { ...file, file: local } : file;
    }),
    ...(previous.contextThreadId && !next.contextThreadId
      ? { contextThreadId: previous.contextThreadId }
      : {}),
  };
}

/**
 * App windows share one localStorage but each holds its own draft store. Writes merge
 * per entry: entries this window changed since it last synced take its value, all
 * others keep what storage holds. Other windows' writes are applied to entries this
 * window has not changed, so an entry being edited here is never replaced.
 */
export function createComposerDraftCrossWindowSync<
  P extends ComposerDraftPersistedSections,
>(options: {
  readonly storage: Partial<StateStorage> | null | undefined;
  readonly key: string;
  readonly version: number;
}) {
  const baseStorage = resolveStorage(options.storage);
  const dirty = Object.fromEntries(
    KEYED_SECTIONS.map((section) => [section, new Set<string>()]),
  ) as Record<KeyedSection, Set<string>>;
  // Entries hydration dropped; deleted on the next write unless another window changes them first.
  const droppedOnHydration = Object.fromEntries(
    KEYED_SECTIONS.map((section) => [section, new Set<string>()]),
  ) as Record<KeyedSection, Set<string>>;
  const dirtyWhole = new Set<WholeSection>();
  // The persisted value each untouched entry in memory reflects.
  const synced = Object.fromEntries(
    KEYED_SECTIONS.map((section) => [section, new Map<string, unknown>()]),
  ) as Record<KeyedSection, Map<string, unknown>>;
  const syncedWhole = new Map<WholeSection, unknown>();
  // Partialize can drop an entry without its memory reference changing (an open preview closed).
  let lastOurs: P | null = null;
  let attached = false;
  let lastSeen: { raw: string; state: P | null } | null = null;
  let pendingWrite: {
    ours: P;
    merged: P;
    full: boolean;
    dirty: Record<KeyedSection, string[]>;
    dirtyWhole: WholeSection[];
  } | null = null;

  function readStored(): P | null {
    let raw: unknown;
    try {
      raw = baseStorage.getItem(options.key);
    } catch {
      return null;
    }
    if (typeof raw !== "string") return null;
    if (lastSeen?.raw === raw) return lastSeen.state;
    const state = parseStoredState(raw, options.version) as P | null;
    lastSeen = { raw, state };
    return state;
  }

  function markThreadKey(threadKey: string | undefined): void {
    if (threadKey === undefined) return;
    for (const section of ["draftsByThreadKey", "draftThreadsByThreadKey"] as const) {
      dirty[section].add(threadKey);
      droppedOnHydration[section].delete(threadKey);
    }
  }

  function clearSyncState(): void {
    for (const section of KEYED_SECTIONS) {
      dirty[section].clear();
      droppedOnHydration[section].clear();
      synced[section].clear();
    }
    dirtyWhole.clear();
    syncedWhole.clear();
  }

  function takeBaseline(ours: P): void {
    clearSyncState();
    const stored = readStored();
    for (const section of KEYED_SECTIONS) {
      const own = entriesOf(ours[section]);
      const persisted = entriesOf(stored?.[section]);
      for (const [key, value] of Object.entries(persisted)) {
        synced[section].set(key, value);
        if (!Object.hasOwn(own, key)) {
          dirty[section].add(key);
          droppedOnHydration[section].add(key);
        }
      }
      for (const key of Object.keys(own)) {
        if (!stored || !Object.hasOwn(persisted, key)) dirty[section].add(key);
      }
    }
    for (const section of WHOLE_SECTIONS) syncedWhole.set(section, stored?.[section]);
    lastOurs = ours;
  }

  function locallyChangedKeys(ours: P, section: KeyedSection): string[] {
    const keys = new Set(dirty[section]);
    const own = entriesOf(ours[section]);
    const previous = entriesOf(lastOurs?.[section]);
    for (const key of new Set([...Object.keys(own), ...Object.keys(previous)])) {
      if (Object.hasOwn(own, key) !== Object.hasOwn(previous, key)) keys.add(key);
    }
    return [...keys];
  }

  function mergeForWrite(ours: P): P {
    if (!attached) return ours;
    const stored = readStored();
    const snapshot = {
      dirty: Object.fromEntries(
        KEYED_SECTIONS.map((section) => [section, locallyChangedKeys(ours, section)]),
      ) as Record<KeyedSection, string[]>,
      dirtyWhole: [...dirtyWhole],
    };
    if (!stored) {
      pendingWrite = { ours, merged: ours, full: true, ...snapshot };
      return ours;
    }
    const merged: Record<string, unknown> = { ...ours };
    for (const section of KEYED_SECTIONS) {
      const own = entriesOf(ours[section]);
      const next: Record<string, unknown> = { ...entriesOf(stored[section]) };
      for (const key of snapshot.dirty[section]) {
        if (Object.hasOwn(own, key)) next[key] = own[key];
        else delete next[key];
      }
      merged[section] = next;
    }
    for (const section of WHOLE_SECTIONS) {
      merged[section] = dirtyWhole.has(section) ? ours[section] : stored[section];
    }
    pendingWrite = { ours, merged: merged as P, full: false, ...snapshot };
    return merged as P;
  }

  function commitWrite(write: NonNullable<typeof pendingWrite>, raw: string): void {
    lastSeen = { raw, state: write.merged };
    lastOurs = write.ours;
    for (const section of KEYED_SECTIONS) {
      const own = entriesOf(write.ours[section]);
      const keys = write.full
        ? new Set([...synced[section].keys(), ...dirty[section], ...Object.keys(own)])
        : write.dirty[section];
      for (const key of keys) {
        dirty[section].delete(key);
        droppedOnHydration[section].delete(key);
        if (Object.hasOwn(own, key)) synced[section].set(key, own[key]);
        else synced[section].delete(key);
      }
    }
    for (const section of write.full ? WHOLE_SECTIONS : write.dirtyWhole) {
      dirtyWhole.delete(section);
      syncedWhole.set(section, write.ours[section]);
    }
  }

  const storage: StateStorage = {
    getItem: (name) => baseStorage.getItem(name),
    setItem: (name, value) => {
      const write = name === options.key ? pendingWrite : null;
      pendingWrite = null;
      baseStorage.setItem(name, value);
      if (write) commitWrite(write, value);
    },
    removeItem: (name) => {
      baseStorage.removeItem(name);
      if (name === options.key) {
        lastSeen = null;
        pendingWrite = null;
      }
    },
  };

  function attach<S extends ComposerDraftMemorySections>(
    store: ComposerDraftSyncStore<S>,
    partialize: (state: S) => P,
  ): void {
    const hydrate = (persisted: unknown, current: S): S =>
      store.persist.getOptions().merge?.(persisted, current) ?? current;
    let applyingRemote = false;

    const pullFromStorage = (): void => {
      const stored = readStored();
      if (!stored) return;
      const before = partialize(store.getState());
      for (const section of KEYED_SECTIONS) {
        for (const key of locallyChangedKeys(before, section)) dirty[section].add(key);
      }
      lastOurs = before;
      const changed = Object.fromEntries(
        KEYED_SECTIONS.map((section) => [section, [] as string[]]),
      ) as Record<KeyedSection, string[]>;
      let anyChanged = false;
      for (const section of KEYED_SECTIONS) {
        const remote = entriesOf(stored[section]);
        for (const key of new Set([...Object.keys(remote), ...synced[section].keys()])) {
          if (sameJson(remote[key], synced[section].get(key))) continue;
          if (dirty[section].has(key)) {
            if (!droppedOnHydration[section].has(key)) continue;
            dirty[section].delete(key);
            droppedOnHydration[section].delete(key);
          }
          changed[section].push(key);
          anyChanged = true;
        }
      }
      const changedWhole = WHOLE_SECTIONS.filter(
        (section) =>
          !dirtyWhole.has(section) && !sameJson(stored[section], syncedWhole.get(section)),
      );
      if (!anyChanged && changedWhole.length === 0) return;

      const current = store.getState();
      const remoteDrafts = entriesOf(stored.draftsByThreadKey);
      const hydrated = hydrate(
        {
          ...stored,
          draftsByThreadKey: Object.fromEntries(
            changed.draftsByThreadKey.flatMap((key) =>
              Object.hasOwn(remoteDrafts, key) ? [[key, remoteDrafts[key]]] : [],
            ),
          ),
        },
        current,
      );
      const patch: Record<string, unknown> = {};
      for (const section of KEYED_SECTIONS) {
        if (changed[section].length === 0) continue;
        const next: Record<string, unknown> = { ...current[section] };
        for (const key of changed[section]) {
          const value =
            section === "draftsByThreadKey"
              ? reconcileRemoteComposerDraft(
                  current.draftsByThreadKey[key],
                  hydrated.draftsByThreadKey[key],
                )
              : hydrated[section][key];
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        patch[section] = next;
      }
      for (const section of changedWhole) patch[section] = hydrated[section];
      applyingRemote = true;
      try {
        store.setState(patch as Partial<S>);
      } finally {
        applyingRemote = false;
      }
      lastOurs = partialize(store.getState());
      for (const section of KEYED_SECTIONS) {
        const remote = entriesOf(stored[section]);
        for (const key of changed[section]) {
          if (Object.hasOwn(remote, key)) synced[section].set(key, remote[key]);
          else synced[section].delete(key);
        }
      }
      for (const section of changedWhole) syncedWhole.set(section, stored[section]);
    };

    const markChangedKeys = (
      next: Entries,
      previous: Entries,
      mark: (key: string, nextValue: unknown, previousValue: unknown) => void,
    ): void => {
      if (next === previous) return;
      for (const key of new Set([...Object.keys(next), ...Object.keys(previous)])) {
        if (next[key] !== previous[key]) mark(key, next[key], previous[key]);
      }
    };

    // Drafts track changes by identity; stringifying image data URLs per change costs too much.
    store.subscribe((next, previous) => {
      if (applyingRemote) return;
      markChangedKeys(next.draftsByThreadKey, previous.draftsByThreadKey, markThreadKey);
      markChangedKeys(
        next.draftThreadsByThreadKey,
        previous.draftThreadsByThreadKey,
        markThreadKey,
      );
      markChangedKeys(
        next.logicalProjectDraftThreadKeyByLogicalProjectKey,
        previous.logicalProjectDraftThreadKeyByLogicalProjectKey,
        (key, nextValue, previousValue) => {
          dirty.logicalProjectDraftThreadKeyByLogicalProjectKey.add(key);
          droppedOnHydration.logicalProjectDraftThreadKeyByLogicalProjectKey.delete(key);
          // A mapping decides whether partialize keeps its draft session.
          markThreadKey(typeof nextValue === "string" ? nextValue : undefined);
          markThreadKey(typeof previousValue === "string" ? previousValue : undefined);
        },
      );
      for (const section of WHOLE_SECTIONS) {
        if (next[section] !== previous[section]) dirtyWhole.add(section);
      }
    });
    store.persist.onFinishHydration((state) => takeBaseline(partialize(state)));
    onStorageKey(options.key, pullFromStorage);
    takeBaseline(partialize(store.getState()));
    attached = true;
  }

  return { storage, mergeForWrite, attach };
}
