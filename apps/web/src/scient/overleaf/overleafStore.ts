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
import { connectionForPath, operationErrorText } from "./overleafModel";

export type OverleafConnection = ScientOverleafConnectionList["connections"][number];

export interface OverleafLastSync {
  readonly result: ScientOverleafSyncResult;
  readonly at: number;
}

export interface OverleafShownReview {
  readonly review: ScientOverleafReview;
  /** A sync applied it; otherwise it is still to run (a read, or a conflict waiting). */
  readonly applied: boolean;
  /** It applied, and Overleaf accepted the send. */
  readonly sent: boolean;
}

export interface OverleafWorkspaceSnapshot {
  /** The first list has answered (or failed). */
  readonly loaded: boolean;
  readonly connections: ReadonlyArray<OverleafConnection>;
  readonly error: string | null;
  readonly statuses: ReadonlyMap<string, ScientOverleafStatus>;
  readonly syncing: ReadonlySet<string>;
  /** The latest operation's result, whatever it was: what the result lines describe. */
  readonly lastSync: ReadonlyMap<string, OverleafLastSync>;
  /**
   * The review the Overleaf tab shows, by connection: from a sync that applied
   * or stopped at a conflict, or from a read of the changes. An operation that
   * brings no review (cancelled, refused) leaves it as it is.
   */
  readonly reviews: ReadonlyMap<string, OverleafShownReview>;
  /** When a sync last applied, by connection. */
  readonly syncedAt: ReadonlyMap<string, number>;
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
  reviews: new Map(),
  syncedAt: new Map(),
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

/**
 * Each read is numbered when it starts. A response is used only if no read
 * started after it, so a read from before a sync can't answer after the
 * sync's own refresh (and leave the chip on "Syncing…").
 */
const statusReads = new Map<string, number>();
/** When each link's status was last read, and links a save has made stale since. */
const statusReadAt = new Map<string, number>();
const staleStatuses = new Set<string>();
/** Status reads still waiting for their answer, by link. */
const statusInflight = new Map<string, number>();
const listReads = new Map<string, number>();
let readCounter = 0;

/** Reads one link's offline status again. */
export async function refreshOverleafStatus(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
): Promise<void> {
  const key = keyOf(environmentId, workspaceRoot);
  const read = ++readCounter;
  const readKey = `${key}\u0000${connectionId}`;
  statusReads.set(readKey, read);
  statusInflight.set(readKey, (statusInflight.get(readKey) ?? 0) + 1);
  try {
    const status = await readOverleafStatus(environmentId, { workspaceRoot, connectionId });
    if (statusReads.get(readKey) !== read) return;
    statusReadAt.set(readKey, Date.now());
    staleStatuses.delete(readKey);
    update(key, (current) => ({
      ...current,
      statuses: new Map(current.statuses).set(connectionId, status),
    }));
  } catch {
    // A status that can't be read keeps the last one; the chip still offers Sync.
  } finally {
    const left = (statusInflight.get(readKey) ?? 1) - 1;
    if (left > 0) statusInflight.set(readKey, left);
    else statusInflight.delete(readKey);
  }
}

/** How long saves settle before the status is read again: a burst of saves reads once. */
const SAVE_REFRESH_DELAY_MS = 400;
const scheduledRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

/** Reads one link's status again shortly, once for any number of calls meanwhile. */
function scheduleOverleafStatusRefresh(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
): void {
  const key = `${keyOf(environmentId, workspaceRoot)}\u0000${connectionId}`;
  const pending = scheduledRefreshes.get(key);
  if (pending !== undefined) clearTimeout(pending);
  scheduledRefreshes.set(
    key,
    setTimeout(() => {
      scheduledRefreshes.delete(key);
      void refreshOverleafStatus(environmentId, workspaceRoot, connectionId);
    }, SAVE_REFRESH_DELAY_MS),
  );
}

/**
 * A file was saved: every known link whose folder holds it reads its status
 * again shortly, and until then counts as stale. Called for the app's
 * lifetime by `overleafSaveWatch`, whether or not a chip is on screen.
 */
export function noteOverleafFileSaved(target: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}): void {
  const snapshot = snapshots.get(keyOf(target.environmentId, target.cwd));
  if (!snapshot) return;
  for (const connection of snapshot.connections) {
    if (connectionForPath([connection], target.relativePath) === null) continue;
    staleStatuses.add(`${keyOf(target.environmentId, target.cwd)}\u0000${connection.connectionId}`);
    scheduleOverleafStatusRefresh(target.environmentId, target.cwd, connection.connectionId);
  }
}

/** Reads a link's status again if a save made it stale or it is older than `maxAgeMs`. */
export function revalidateOverleafStatus(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
  maxAgeMs: number,
): void {
  const readKey = `${keyOf(environmentId, workspaceRoot)}\u0000${connectionId}`;
  const readAt = statusReadAt.get(readKey);
  // A read already on its way answers for this one, unless a save came after it started.
  if (statusInflight.has(readKey) && !staleStatuses.has(readKey)) return;
  if (staleStatuses.has(readKey) || readAt === undefined || Date.now() - readAt > maxAgeMs)
    void refreshOverleafStatus(environmentId, workspaceRoot, connectionId);
}

/** Lists the project's links and reads each one's status. */
export function loadOverleafWorkspace(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  options: { readonly force?: boolean; readonly maxAgeMs?: number } = {},
): Promise<void> {
  const key = keyOf(environmentId, workspaceRoot);
  const running = inflight.get(key);
  // A forced load (after an operation) starts afresh; the earlier one's answers are stale.
  if (running && !options.force) return running;
  const age = Date.now() - (loadedAt.get(key) ?? 0);
  if (!options.force && snapshots.get(key)?.loaded && age < (options.maxAgeMs ?? Infinity)) {
    return Promise.resolve();
  }
  const read = ++readCounter;
  listReads.set(key, read);
  const load = (async () => {
    try {
      const listed = await listOverleafConnections(environmentId, workspaceRoot);
      if (listReads.get(key) !== read) return;
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
      if (listReads.get(key) !== read) return;
      // An environment without Overleaf sync, or a folder that isn't a project, has no links.
      update(key, (current) => ({ ...current, loaded: true, error: operationErrorText(error) }));
    } finally {
      if (listReads.get(key) === read) {
        loadedAt.set(key, Date.now());
        inflight.delete(key);
      }
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
  const at = Date.now();
  update(keyOf(environmentId, workspaceRoot), (current) => {
    const reviews = new Map(current.reviews);
    const syncedAt = new Map(current.syncedAt);
    // A result with its own review replaces the shown one; a cancel or refusal doesn't.
    if (result._tag === "synced" || result._tag === "needs-decision") {
      const versionKey = reviewKeyOf(environmentId, workspaceRoot, connectionId);
      reviewVersions.set(versionKey, (reviewVersions.get(versionKey) ?? 0) + 1);
    }
    if (result._tag === "synced") {
      reviews.set(connectionId, {
        review: result.review,
        applied: true,
        sent: result.publication._tag === "accepted",
      });
      syncedAt.set(connectionId, at);
    } else if (result._tag === "needs-decision") {
      reviews.set(connectionId, { review: result.review, applied: false, sent: false });
    }
    return {
      ...current,
      reviews,
      syncedAt,
      lastSync: new Map(current.lastSync).set(connectionId, { result, at }),
    };
  });
}

/**
 * Each change to a link's shown review is numbered. A read of the changes
 * remembers the number it started at, and its answer is used only if no sync
 * replaced the review meanwhile: a late read never brings back obsolete
 * conflicts over a sync that applied.
 */
const reviewVersions = new Map<string, number>();
const reviewKeyOf = (environmentId: EnvironmentId, workspaceRoot: string, connectionId: string) =>
  `${keyOf(environmentId, workspaceRoot)}\u0000${connectionId}`;

/** A read of a link's changes starts; returns what its answer must still match. */
export function beginOverleafPreview(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
): number {
  update(keyOf(environmentId, workspaceRoot), (current) => ({
    ...current,
    previewing: new Set(current.previewing).add(connectionId),
  }));
  return reviewVersions.get(reviewKeyOf(environmentId, workspaceRoot, connectionId)) ?? 0;
}

/** A read of a link's changes answered with a review, or failed. A superseded answer is dropped. */
export function finishOverleafPreview(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
  startedAt: number,
  outcome:
    | { readonly _tag: "review"; readonly review: ScientOverleafReview }
    | { readonly _tag: "failed"; readonly message: string },
): void {
  const versionKey = reviewKeyOf(environmentId, workspaceRoot, connectionId);
  const current = reviewVersions.get(versionKey) ?? 0;
  const superseded = current !== startedAt;
  if (!superseded && outcome._tag === "review") reviewVersions.set(versionKey, current + 1);
  update(keyOf(environmentId, workspaceRoot), (snapshot) => {
    const previewing = new Set(snapshot.previewing);
    previewing.delete(connectionId);
    if (superseded) return { ...snapshot, previewing };
    const previewErrors = new Map(snapshot.previewErrors);
    const reviews = new Map(snapshot.reviews);
    if (outcome._tag === "failed") previewErrors.set(connectionId, outcome.message);
    else {
      previewErrors.delete(connectionId);
      // Replaced only by a successful read: a failed one leaves the shown review.
      reviews.set(connectionId, { review: outcome.review, applied: false, sent: false });
    }
    return { ...snapshot, previewing, previewErrors, reviews };
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
  statusReads.clear();
  statusReadAt.clear();
  staleStatuses.clear();
  statusInflight.clear();
  reviewVersions.clear();
  for (const timer of scheduledRefreshes.values()) clearTimeout(timer);
  scheduledRefreshes.clear();
  listReads.clear();
  inflight.clear();
  tokens.clear();
}
