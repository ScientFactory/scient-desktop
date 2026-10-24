// SCIENT-OWNED: the app's memory of Overleaf links, per workspace. The status
// reads the folder, so it is read once and refreshed after a sync, on window
// focus and when an editor in the folder saves, never once per file header.
import type {
  EnvironmentId,
  ScientOverleafConnectionList,
  ScientOverleafReview,
  ScientOverleafStatus,
  ScientOverleafSyncResult,
} from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { listOverleafConnections, readOverleafStatus, readOverleafToken } from "./client";
import { operationErrorText } from "./overleafModel";

export type OverleafConnection = ScientOverleafConnectionList["connections"][number];

export interface OverleafLastSync {
  readonly result: ScientOverleafSyncResult;
  readonly at: number;
}

export interface OverleafWorkspaceSnapshot {
  /** The first list has answered (or failed). */
  readonly loaded: boolean;
  readonly connections: ReadonlyArray<OverleafConnection>;
  readonly error: string | null;
  readonly statuses: ReadonlyMap<string, ScientOverleafStatus>;
  readonly syncing: ReadonlySet<string>;
  readonly lastSync: ReadonlyMap<string, OverleafLastSync>;
  /** A review built by "See changes" without a sync, by connection. */
  readonly previews: ReadonlyMap<string, ScientOverleafReview>;
  /** Links whose changes are being read for the review tab. */
  readonly previewing: ReadonlySet<string>;
  /** Why the last read of a link's changes failed. */
  readonly previewErrors: ReadonlyMap<string, string>;
}

const EMPTY: OverleafWorkspaceSnapshot = {
  loaded: false,
  connections: [],
  error: null,
  statuses: new Map(),
  syncing: new Set(),
  lastSync: new Map(),
  previews: new Map(),
  previewing: new Set(),
  previewErrors: new Map(),
};

const snapshots = new Map<string, OverleafWorkspaceSnapshot>();
const loadedAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();

const keyOf = (environmentId: EnvironmentId, workspaceRoot: string) =>
  `${environmentId}\u0000${workspaceRoot}`;

function update(
  key: string,
  change: (current: OverleafWorkspaceSnapshot) => OverleafWorkspaceSnapshot,
) {
  snapshots.set(key, change(snapshots.get(key) ?? EMPTY));
  for (const listener of listeners.get(key) ?? []) listener();
}

/** The workspace's state now, without loading anything. */
export function readOverleafWorkspace(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): OverleafWorkspaceSnapshot {
  return snapshots.get(keyOf(environmentId, workspaceRoot)) ?? EMPTY;
}

/** Reads one link's offline status again. */
export async function refreshOverleafStatus(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
): Promise<void> {
  const key = keyOf(environmentId, workspaceRoot);
  try {
    const status = await readOverleafStatus(environmentId, { workspaceRoot, connectionId });
    update(key, (current) => ({
      ...current,
      statuses: new Map(current.statuses).set(connectionId, status),
    }));
  } catch {
    // A status that can't be read keeps the last one; the chip still offers Sync.
  }
}

/** Lists the project's links and reads each one's status. */
export function loadOverleafWorkspace(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  options: { readonly force?: boolean; readonly maxAgeMs?: number } = {},
): Promise<void> {
  const key = keyOf(environmentId, workspaceRoot);
  const running = inflight.get(key);
  if (running) return running;
  const age = Date.now() - (loadedAt.get(key) ?? 0);
  if (!options.force && snapshots.get(key)?.loaded && age < (options.maxAgeMs ?? Infinity)) {
    return Promise.resolve();
  }
  const load = (async () => {
    try {
      const listed = await listOverleafConnections(environmentId, workspaceRoot);
      update(key, (current) => ({
        ...current,
        loaded: true,
        error: null,
        connections: listed.connections,
      }));
      await Promise.all(
        listed.connections.map((connection) =>
          refreshOverleafStatus(environmentId, workspaceRoot, connection.connectionId),
        ),
      );
    } catch (error) {
      // An environment without Overleaf sync, or a folder that isn't a project, has no links.
      update(key, (current) => ({ ...current, loaded: true, error: operationErrorText(error) }));
    } finally {
      loadedAt.set(key, Date.now());
      inflight.delete(key);
    }
  })();
  inflight.set(key, load);
  return load;
}

export function setOverleafSyncing(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
  syncing: boolean,
): void {
  update(keyOf(environmentId, workspaceRoot), (current) => {
    const next = new Set(current.syncing);
    if (syncing) next.add(connectionId);
    else next.delete(connectionId);
    return { ...current, syncing: next };
  });
}

export function recordOverleafSync(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
  result: ScientOverleafSyncResult,
): void {
  update(keyOf(environmentId, workspaceRoot), (current) => {
    const previews = new Map(current.previews);
    previews.delete(connectionId);
    return {
      ...current,
      previews,
      lastSync: new Map(current.lastSync).set(connectionId, { result, at: Date.now() }),
    };
  });
}

/** A read of a link's changes started, finished with a review, or failed. */
export function recordOverleafPreview(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
  outcome:
    | { readonly _tag: "reading" }
    | { readonly _tag: "review"; readonly review: ScientOverleafReview }
    | { readonly _tag: "failed"; readonly message: string },
): void {
  update(keyOf(environmentId, workspaceRoot), (current) => {
    const previewing = new Set(current.previewing);
    const previewErrors = new Map(current.previewErrors);
    const previews = new Map(current.previews);
    if (outcome._tag === "reading") previewing.add(connectionId);
    else previewing.delete(connectionId);
    if (outcome._tag === "failed") previewErrors.set(connectionId, outcome.message);
    else previewErrors.delete(connectionId);
    if (outcome._tag === "review") previews.set(connectionId, outcome.review);
    return { ...current, previewing, previewErrors, previews };
  });
}

/** The workspace's links and their status; loads them the first time it is used. */
export function useOverleafWorkspace(
  environmentId: EnvironmentId | null,
  workspaceRoot: string | null,
): OverleafWorkspaceSnapshot {
  const key = environmentId && workspaceRoot ? keyOf(environmentId, workspaceRoot) : null;
  const snapshot = useSyncExternalStore(
    (listener) => {
      if (key === null) return () => {};
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => set.delete(listener);
    },
    () => (key === null ? EMPTY : (snapshots.get(key) ?? EMPTY)),
  );
  useEffect(() => {
    if (environmentId === null || workspaceRoot === null) return;
    void loadOverleafWorkspace(environmentId, workspaceRoot);
    // Coming back to the window may mean edits elsewhere: read again, at most every 10 s.
    const onFocus = () =>
      void loadOverleafWorkspace(environmentId, workspaceRoot, { maxAgeMs: 10_000 });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [environmentId, workspaceRoot]);
  return snapshot;
}

type TokenState = { readonly loaded: boolean; readonly saved: boolean };
const tokens = new Map<EnvironmentId, TokenState>();
const tokenListeners = new Set<() => void>();
const UNKNOWN_TOKEN: TokenState = { loaded: false, saved: false };

export function setOverleafTokenSaved(environmentId: EnvironmentId, saved: boolean): void {
  tokens.set(environmentId, { loaded: true, saved });
  for (const listener of tokenListeners) listener();
}

/** Whether an Overleaf token is saved for this environment. */
export function useOverleafTokenSaved(environmentId: EnvironmentId | null): TokenState {
  const state = useSyncExternalStore(
    (listener) => {
      tokenListeners.add(listener);
      return () => tokenListeners.delete(listener);
    },
    () => (environmentId === null ? UNKNOWN_TOKEN : (tokens.get(environmentId) ?? UNKNOWN_TOKEN)),
  );
  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    readOverleafToken(environmentId).then(
      (status) => {
        if (!cancelled) setOverleafTokenSaved(environmentId, status.saved);
      },
      () => {
        if (!cancelled) setOverleafTokenSaved(environmentId, false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);
  return state;
}

/** Tests only: forget every workspace. */
export function resetOverleafStoreForTests(): void {
  snapshots.clear();
  loadedAt.clear();
  inflight.clear();
  tokens.clear();
}
