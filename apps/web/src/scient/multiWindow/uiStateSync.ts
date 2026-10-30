import type { StoreApi } from "zustand";

import type { PersistedUiState, UiState } from "../../uiStateStore";
import {
  createCrossWindowStateSync,
  mergeWindowEntries,
  mergeWindowValue,
  onStorageKey,
} from "./crossWindowMerge";

const UI_STATE_FIELDS = [
  "projectExpandedById",
  "projectOrder",
  "sidebarProjectScopeKeys",
  "threadLastVisitedAtById",
  "threadChangedFilesExpandedById",
  "defaultAdvertisedEndpointKey",
  "pullRequestMergeMethod",
] as const satisfies ReadonlyArray<keyof UiState>;

/** A visit in either window counts; marking a thread unread here still saves. */
function resolveThreadVisit(
  local: string | undefined,
  synced: string | undefined,
  stored: string | undefined,
): string | undefined {
  if (local === undefined || stored === undefined) return local;
  const visitedHere = synced === undefined || Date.parse(local) > Date.parse(synced);
  return visitedHere && Date.parse(stored) > Date.parse(local) ? stored : local;
}

function mergeUiState(
  local: UiState,
  synced: UiState,
  stored: UiState,
  localOnlyProjectExpansionKeys: ReadonlySet<string>,
): UiState {
  const merged: UiState = {
    projectExpandedById: mergeWindowEntries(
      local.projectExpandedById,
      synced.projectExpandedById,
      stored.projectExpandedById,
      { isLocalOnly: (key) => localOnlyProjectExpansionKeys.has(key) },
    ),
    projectOrder: mergeWindowValue(local.projectOrder, synced.projectOrder, stored.projectOrder),
    sidebarProjectScopeKeys: mergeWindowValue(
      local.sidebarProjectScopeKeys,
      synced.sidebarProjectScopeKeys,
      stored.sidebarProjectScopeKeys,
    ),
    threadLastVisitedAtById: mergeWindowEntries(
      local.threadLastVisitedAtById,
      synced.threadLastVisitedAtById,
      stored.threadLastVisitedAtById,
      { resolveChanged: resolveThreadVisit },
    ),
    threadChangedFilesExpandedById: mergeWindowEntries(
      local.threadChangedFilesExpandedById,
      synced.threadChangedFilesExpandedById,
      stored.threadChangedFilesExpandedById,
    ),
    defaultAdvertisedEndpointKey: mergeWindowValue(
      local.defaultAdvertisedEndpointKey,
      synced.defaultAdvertisedEndpointKey,
      stored.defaultAdvertisedEndpointKey,
    ),
    pullRequestMergeMethod: mergeWindowValue(
      local.pullRequestMergeMethod,
      synced.pullRequestMergeMethod,
      stored.pullRequestMergeMethod,
    ),
  };
  return UI_STATE_FIELDS.every((field) => merged[field] === local[field]) ? local : merged;
}

function pickUiState(state: UiState): UiState {
  return Object.fromEntries(
    UI_STATE_FIELDS.map((field) => [field, state[field]]),
  ) as unknown as UiState;
}

export function createUiStateWindowSync(options: {
  readonly key: string;
  readonly parse: (persisted: PersistedUiState) => UiState;
  readonly persist: (state: UiState) => void;
  readonly localOnlyProjectExpansionKeys: ReadonlyArray<string>;
}) {
  const localOnlyKeys = new Set(options.localOnlyProjectExpansionKeys);
  const readRaw = (): string | null => {
    try {
      return typeof window === "undefined" ? null : window.localStorage.getItem(options.key);
    } catch {
      return null;
    }
  };
  const sync = createCrossWindowStateSync<UiState>({
    read: () => {
      try {
        const raw = readRaw();
        return raw ? options.parse(JSON.parse(raw) as PersistedUiState) : null;
      } catch {
        return null;
      }
    },
    merge: (local, synced, stored) => mergeUiState(local, synced, stored, localOnlyKeys),
  });

  return {
    persist: (state: UiState): void => {
      const local = pickUiState(state);
      const before = readRaw();
      options.persist(sync.mergeForWrite(local));
      // `persist` swallows write errors (a full quota); a failed write leaves storage as it was.
      if (readRaw() !== before) sync.didWrite(local);
    },
    attach: <S extends UiState>(store: StoreApi<S>): void => {
      sync.setBaseline(pickUiState(store.getState()));
      onStorageKey(options.key, () => {
        const local = pickUiState(store.getState());
        const merged = sync.adoptStored(local);
        if (merged === local) return;
        const patch: Partial<UiState> = {};
        for (const field of UI_STATE_FIELDS) {
          if (merged[field] !== local[field]) Object.assign(patch, { [field]: merged[field] });
        }
        store.setState(patch as Partial<S>);
      });
    },
  };
}
