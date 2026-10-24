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
import {
  actionableDecisions,
  connectionForPath,
  decidableFiles,
  operationErrorText,
  reviewIdentity,
  type OverleafFileDecision,
} from "./overleafModel";

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
  /**
   * Per-file decisions waiting for the next sync, by connection. Kept here, not
   * in the tab, so opening a file (which replaces the tab) doesn't lose them.
   */
  readonly fileDecisions: ReadonlyMap<string, ReadonlyMap<string, OverleafFileDecision>>;
  /** The decisions a sync carried when it stopped at a conflict, with the review it returned. */
  readonly submittedDecisions: ReadonlyMap<
    string,
    { readonly review: string; readonly decisions: ReadonlyMap<string, OverleafFileDecision> }
  >;
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
  fileDecisions: new Map(),
  submittedDecisions: new Map(),
};

/** What one workspace view lists: its links and their status as this workspace reads them. */
type WorkspacePart = Pick<
  OverleafWorkspaceSnapshot,
  "loaded" | "connections" | "error" | "statuses"
>;
/**
 * Everything about a link's syncs, reviews and decisions: one state per link
 * (environment and connection ID), shared by every workspace view of it, so a
 * decision made in a worktree's view counts in the main one and a sync that
 * applies anywhere clears it everywhere.
 */
type Lifecycle = Omit<OverleafWorkspaceSnapshot, keyof WorkspacePart>;

const EMPTY_PART: WorkspacePart = {
  loaded: false,
  connections: [],
  error: null,
  statuses: new Map(),
};
const EMPTY_LIFECYCLE: Lifecycle = {
  syncing: new Set(),
  lastSync: new Map(),
  reviews: new Map(),
  syncedAt: new Map(),
  previewing: new Set(),
  previewErrors: new Map(),
  fileDecisions: new Map(),
  submittedDecisions: new Map(),
};

const snapshots = new Map<string, WorkspacePart>();
/** Lifecycle maps by environment; inside, every map is keyed by connection ID. */
const lifecycles = new Map<EnvironmentId, Lifecycle>();
/** Each workspace view, merged and kept stable until either part changes. */
const views = new Map<string, OverleafWorkspaceSnapshot>();
const loadedAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();

const keyOf = (environmentId: EnvironmentId, workspaceRoot: string) =>
  `${environmentId}\u0000${workspaceRoot}`;
const environmentOf = (key: string) => key.slice(0, key.indexOf("\u0000")) as EnvironmentId;

function viewOf(key: string): OverleafWorkspaceSnapshot {
  let view = views.get(key);
  if (view === undefined) {
    view = {
      ...(snapshots.get(key) ?? EMPTY_PART),
      ...(lifecycles.get(environmentOf(key)) ?? EMPTY_LIFECYCLE),
    };
    views.set(key, view);
  }
  return view;
}

function notify(key: string) {
  views.delete(key);
  for (const listener of listeners.get(key) ?? []) listener();
}

/** Changes one workspace view's own part: its list and statuses. */
function update(key: string, change: (current: WorkspacePart) => WorkspacePart) {
  snapshots.set(key, change(snapshots.get(key) ?? EMPTY_PART));
  notify(key);
}

/** Changes a link's lifecycle, seen by every workspace view of its environment. */
function updateLifecycle(environmentId: EnvironmentId, change: (current: Lifecycle) => Lifecycle) {
  lifecycles.set(environmentId, change(lifecycles.get(environmentId) ?? EMPTY_LIFECYCLE));
  for (const key of new Set([...snapshots.keys(), ...listeners.keys(), ...views.keys()]))
    if (environmentOf(key) === environmentId) notify(key);
}

/** The workspace's state now, without loading anything. */
export function readOverleafWorkspace(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): OverleafWorkspaceSnapshot {
  return viewOf(keyOf(environmentId, workspaceRoot));
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

/**
 * After an operation on a link, every other workspace view that lists it reads
 * its status again, so a view that read "busy" during a sync started elsewhere
 * doesn't stay on "Syncing…". The caller's own view reloads itself.
 */
export function refreshOverleafStatusElsewhere(
  environmentId: EnvironmentId,
  exceptWorkspaceRoot: string,
  connectionId: string,
): void {
  const except = keyOf(environmentId, exceptWorkspaceRoot);
  for (const [key, snapshot] of snapshots) {
    if (key === except || environmentOf(key) !== environmentId) continue;
    if (!snapshot.connections.some((connection) => connection.connectionId === connectionId))
      continue;
    void refreshOverleafStatus(environmentId, key.slice(key.indexOf("\u0000") + 1), connectionId);
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
  connectionId: string,
  syncing: boolean,
): void {
  updateLifecycle(environmentId, (current) => {
    const next = new Set(current.syncing);
    if (syncing) next.add(connectionId);
    else next.delete(connectionId);
    return { ...current, syncing: next };
  });
}

/**
 * The connection's pending decisions, reconciled with the review shown: only
 * those it still lists and allows. What every sync carries, and what the tab
 * shows.
 */
export function pendingOverleafDecisions(
  snapshot: Pick<OverleafWorkspaceSnapshot, "reviews" | "submittedDecisions" | "fileDecisions">,
  connectionId: string,
): ReadonlyMap<string, OverleafFileDecision> {
  return actionableDecisions(
    decidableFiles(
      snapshot.reviews.get(connectionId) ?? null,
      snapshot.submittedDecisions.get(connectionId) ?? null,
    ),
    snapshot.fileDecisions.get(connectionId) ?? NO_FILE_DECISIONS,
  );
}

const NO_FILE_DECISIONS: ReadonlyMap<string, OverleafFileDecision> = new Map();

/**
 * A fresh review was accepted for the connection: decisions it no longer
 * lists or allows are dropped for good, so a file recreated later doesn't
 * bring back an old decision.
 */
function pruneDecisions(snapshot: Lifecycle, connectionId: string): Lifecycle["fileDecisions"] {
  const current = snapshot.fileDecisions.get(connectionId);
  if (current === undefined) return snapshot.fileDecisions;
  const kept = pendingOverleafDecisions(snapshot, connectionId);
  if (kept === current) return snapshot.fileDecisions;
  const next = new Map(snapshot.fileDecisions);
  if (kept.size === 0) next.delete(connectionId);
  else next.set(connectionId, kept);
  return next;
}

/**
 * Records a sync's result. `carried` is what that sync sent as per-file
 * decisions: a review it returned at a conflict already encodes them.
 */
export function recordOverleafSync(
  environmentId: EnvironmentId,
  connectionId: string,
  result: ScientOverleafSyncResult,
  carried: ReadonlyMap<string, OverleafFileDecision> = NO_FILE_DECISIONS,
): void {
  const at = Date.now();
  updateLifecycle(environmentId, (current) => {
    const reviews = new Map(current.reviews);
    const syncedAt = new Map(current.syncedAt);
    // A result with its own review replaces the shown one; a cancel or refusal doesn't.
    if (result._tag === "synced" || result._tag === "needs-decision") {
      const versionKey = reviewKeyOf(environmentId, connectionId);
      reviewVersions.set(versionKey, (reviewVersions.get(versionKey) ?? 0) + 1);
    }
    let { fileDecisions, submittedDecisions } = current;
    if (result._tag === "synced") {
      // Applied: the decisions it carried are spent.
      const spentDecisions = new Map(fileDecisions);
      spentDecisions.delete(connectionId);
      fileDecisions = spentDecisions;
      const spentSubmitted = new Map(submittedDecisions);
      spentSubmitted.delete(connectionId);
      submittedDecisions = spentSubmitted;
      reviews.set(connectionId, {
        review: result.review,
        applied: true,
        sent: result.publication._tag === "accepted",
      });
      syncedAt.set(connectionId, at);
    } else if (result._tag === "needs-decision") {
      reviews.set(connectionId, { review: result.review, applied: false, sent: false });
      const record = new Map(submittedDecisions);
      if (carried.size > 0)
        record.set(connectionId, { review: reviewIdentity(result.review), decisions: carried });
      else record.delete(connectionId);
      submittedDecisions = record;
    }
    const next = {
      ...current,
      reviews,
      syncedAt,
      fileDecisions,
      submittedDecisions,
      lastSync: new Map(current.lastSync).set(connectionId, { result, at }),
    };
    return result._tag === "needs-decision"
      ? { ...next, fileDecisions: pruneDecisions(next, connectionId) }
      : next;
  });
}

/** Makes, changes or takes back one file's decision for the link's next sync. */
export function setOverleafFileDecision(
  environmentId: EnvironmentId,
  connectionId: string,
  path: string,
  decision: OverleafFileDecision | null,
): void {
  updateLifecycle(environmentId, (current) => {
    const decisions = new Map(current.fileDecisions.get(connectionId) ?? []);
    if (decision === null) decisions.delete(path);
    else decisions.set(path, decision);
    return {
      ...current,
      fileDecisions: new Map(current.fileDecisions).set(connectionId, decisions),
    };
  });
}

/**
 * The connection was disconnected, relinked or connected again (an archive
 * keeps its ID): its review, pending decisions and carried-decision record are
 * forgotten in every workspace view, and a read already on its way is dropped.
 */
export function forgetOverleafConnection(environmentId: EnvironmentId, connectionId: string): void {
  const versionKey = reviewKeyOf(environmentId, connectionId);
  reviewVersions.set(versionKey, (reviewVersions.get(versionKey) ?? 0) + 1);
  updateLifecycle(environmentId, (current) => {
    const without = <V>(map: ReadonlyMap<string, V>) => {
      const next = new Map(map);
      next.delete(connectionId);
      return next;
    };
    return {
      ...current,
      reviews: without(current.reviews),
      fileDecisions: without(current.fileDecisions),
      submittedDecisions: without(current.submittedDecisions),
      lastSync: without(current.lastSync),
      previewErrors: without(current.previewErrors),
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
const reviewKeyOf = (environmentId: EnvironmentId, connectionId: string) =>
  `${environmentId}\u0000${connectionId}`;

/** A read of a link's changes starts; returns what its answer must still match. */
export function beginOverleafPreview(environmentId: EnvironmentId, connectionId: string): number {
  updateLifecycle(environmentId, (current) => ({
    ...current,
    previewing: new Set(current.previewing).add(connectionId),
  }));
  return reviewVersions.get(reviewKeyOf(environmentId, connectionId)) ?? 0;
}

/** A read of a link's changes answered with a review, or failed. A superseded answer is dropped. */
export function finishOverleafPreview(
  environmentId: EnvironmentId,
  connectionId: string,
  startedAt: number,
  outcome:
    | { readonly _tag: "review"; readonly review: ScientOverleafReview }
    | { readonly _tag: "failed"; readonly message: string },
): void {
  const versionKey = reviewKeyOf(environmentId, connectionId);
  const current = reviewVersions.get(versionKey) ?? 0;
  const superseded = current !== startedAt;
  if (!superseded && outcome._tag === "review") reviewVersions.set(versionKey, current + 1);
  updateLifecycle(environmentId, (snapshot) => {
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
    const next = { ...snapshot, previewing, previewErrors, reviews };
    return outcome._tag === "review"
      ? { ...next, fileDecisions: pruneDecisions(next, connectionId) }
      : next;
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
    () => (key === null ? EMPTY : viewOf(key)),
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
  lifecycles.clear();
  views.clear();
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
