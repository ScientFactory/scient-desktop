/**
 * Per-document LaTeX build state and the poll loop that keeps it current.
 *
 * The server owns the build; this store owns one watcher per open document.
 * A watcher starts a build, then polls the status endpoint on a self-scheduling
 * timeout while the server still has work to do, and goes quiet the moment the
 * build reaches a terminal state so an idle document costs nothing.
 */
import type { EnvironmentId, ScientLatexBuildSnapshot } from "@t3tools/contracts";
import { create } from "zustand";

import {
  readLatexBuildStatus,
  readLatexToolchain,
  requestLatexBuild,
  requestLatexCancel,
  requestLatexToolchainInstall,
} from "./client";
import { isActiveLatexInstall } from "./latexToolchainSetupModel";
import { isActiveLatexBuildState, type LatexBuildStatus } from "./scientLatexSurfaceModel";

export const LATEX_POLL_INTERVAL_MS = 1_500;
/** A transport failure backs the loop off so an unreachable environment is not hammered. */
export const LATEX_OFFLINE_POLL_INTERVAL_MS = 5_000;

export interface LatexBuildTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

const EMPTY_ENTRY: LatexBuildStatus = {
  snapshot: null,
  toolchain: null,
  canInstallManaged: false,
  managedInstall: null,
  installRequesting: false,
  error: null,
  requesting: false,
};

export function latexBuildKey(target: LatexBuildTarget): string {
  return `${target.environmentId}\0${target.cwd}\0${target.relativePath}`;
}

interface LatexBuildStoreState {
  readonly entries: Readonly<Record<string, LatexBuildStatus>>;
}

const useLatexBuildStore = create<LatexBuildStoreState>()(() => ({ entries: {} }));

export function useLatexBuild(target: LatexBuildTarget): LatexBuildStatus {
  const key = latexBuildKey(target);
  return useLatexBuildStore((state) => state.entries[key] ?? EMPTY_ENTRY);
}

export function readLatexBuild(target: LatexBuildTarget): LatexBuildStatus {
  return useLatexBuildStore.getState().entries[latexBuildKey(target)] ?? EMPTY_ENTRY;
}

function updateEntry(key: string, update: (current: LatexBuildStatus) => LatexBuildStatus): void {
  useLatexBuildStore.setState((state) => {
    const current = state.entries[key] ?? EMPTY_ENTRY;
    const next = update(current);
    return next === current ? state : { entries: { ...state.entries, [key]: next } };
  });
}

function applySnapshot(key: string, snapshot: ScientLatexBuildSnapshot): void {
  updateEntry(key, (current) => ({
    ...current,
    snapshot,
    toolchain: snapshot.toolchain ?? current.toolchain,
    error: null,
  }));
}

function applyTransportError(key: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "The LaTeX build could not be reached.";
  updateEntry(key, (current) => ({ ...current, error: message }));
}

function setRequesting(key: string, requesting: boolean): void {
  updateEntry(key, (current) =>
    current.requesting === requesting ? current : { ...current, requesting },
  );
}

interface WatchLoop {
  watchers: number;
  timer: ReturnType<typeof setTimeout> | null;
  polling: boolean;
  stopped: boolean;
}

const loops = new Map<string, WatchLoop>();

function clearTimer(loop: WatchLoop): void {
  if (loop.timer === null) return;
  clearTimeout(loop.timer);
  loop.timer = null;
}

function schedulePoll(
  key: string,
  target: LatexBuildTarget,
  loop: WatchLoop,
  delayMs: number,
): void {
  if (loop.stopped || loop.timer !== null) return;
  loop.timer = setTimeout(() => {
    loop.timer = null;
    void pollStatus(key, target, loop);
  }, delayMs);
}

/** An install this loop still has to watch, whoever on this client started it. */
function installUnderway(key: string): boolean {
  const entry = useLatexBuildStore.getState().entries[key] ?? EMPTY_ENTRY;
  return entry.installRequesting || isActiveLatexInstall(entry.managedInstall);
}

function scheduleFollowUp(
  key: string,
  target: LatexBuildTarget,
  loop: WatchLoop,
  snapshot: ScientLatexBuildSnapshot,
): void {
  // The coordinator re-arms a coalesced rerun after writing the terminal
  // state, so a terminal snapshot with pendingRerun still has work coming.
  if (!isActiveLatexBuildState(snapshot.state) && !snapshot.pendingRerun && !installUnderway(key)) {
    return;
  }
  schedulePoll(key, target, loop, LATEX_POLL_INTERVAL_MS);
}

async function pollStatus(key: string, target: LatexBuildTarget, loop: WatchLoop): Promise<void> {
  if (loop.stopped || loop.polling) return;
  loop.polling = true;
  try {
    // An install running on the environment is watched by the same loop, one
    // poll ahead of the build status so a finished install rebuilds at once.
    if (installUnderway(key)) {
      await pollToolchain(key, target);
      if (loop.stopped) return;
    }
    const snapshot = await readLatexBuildStatus(target.environmentId, {
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    });
    if (loop.stopped) return;
    applySnapshot(key, snapshot);
    scheduleFollowUp(key, target, loop, snapshot);
  } catch (error) {
    if (loop.stopped) return;
    applyTransportError(key, error);
    schedulePoll(key, target, loop, LATEX_OFFLINE_POLL_INTERVAL_MS);
  } finally {
    loop.polling = false;
  }
}

async function runRequest(
  key: string,
  target: LatexBuildTarget,
  loop: WatchLoop,
  request: () => Promise<ScientLatexBuildSnapshot>,
): Promise<void> {
  if (loop.stopped) return;
  clearTimer(loop);
  setRequesting(key, true);
  try {
    const snapshot = await request();
    if (loop.stopped) return;
    applySnapshot(key, snapshot);
    scheduleFollowUp(key, target, loop, snapshot);
  } catch (error) {
    if (loop.stopped) return;
    applyTransportError(key, error);
    schedulePoll(key, target, loop, LATEX_OFFLINE_POLL_INTERVAL_MS);
  } finally {
    setRequesting(key, false);
  }
}

/**
 * Reads the toolchain endpoint, which answers with the probe result and what
 * this environment can do about a missing engine. A finished install is the
 * one transition worth acting on: the report only says `ready` once the probe
 * behind it has already seen the installed engine, so the document can build.
 */
async function pollToolchain(key: string, target: LatexBuildTarget): Promise<void> {
  try {
    const report = await readLatexToolchain(target.environmentId, { refresh: false });
    const managedInstall = report.managedInstall ?? null;
    const justInstalled =
      managedInstall?.state === "ready" &&
      (useLatexBuildStore.getState().entries[key] ?? EMPTY_ENTRY).managedInstall?.state !== "ready";
    updateEntry(key, (current) => ({
      ...current,
      toolchain: report,
      canInstallManaged: report.canInstallManaged,
      managedInstall: managedInstall ?? current.managedInstall,
    }));
    if (justInstalled) requestLatexRebuild(target);
  } catch {
    // Build snapshots carry the toolchain too; a failed probe is not a build failure.
  }
}

/**
 * Watch one document: start a build, then keep the snapshot current until every
 * watcher is gone. Repeat calls for the same document share the single loop.
 */
export function startWatchingLatexBuild(target: LatexBuildTarget): () => void {
  const key = latexBuildKey(target);
  const existing = loops.get(key);
  if (existing) {
    existing.watchers += 1;
    return () => releaseWatcher(key, existing);
  }

  const loop: WatchLoop = { watchers: 1, timer: null, polling: false, stopped: false };
  loops.set(key, loop);
  void pollToolchain(key, target);
  void runRequest(key, target, loop, () =>
    requestLatexBuild(target.environmentId, {
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    }),
  );
  return () => releaseWatcher(key, loop);
}

function releaseWatcher(key: string, loop: WatchLoop): void {
  if (loop.stopped) return;
  loop.watchers -= 1;
  if (loop.watchers > 0) return;
  loop.stopped = true;
  clearTimer(loop);
  if (loops.get(key) === loop) loops.delete(key);
}

/**
 * Ask for a fresh build of a watched document. A build already running is not
 * interrupted: the server queues the rerun and the loop keeps polling.
 */
export function requestLatexRebuild(target: LatexBuildTarget): void {
  const key = latexBuildKey(target);
  const loop = loops.get(key);
  if (!loop) return;
  void runRequest(key, target, loop, () =>
    requestLatexBuild(target.environmentId, {
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    }),
  );
}

/**
 * Ask the environment to install the LaTeX distribution Scient pins. The
 * server answers with the state it left behind and the watch loop takes it
 * from there, so this returns as soon as the install is under way.
 */
export function requestManagedLatexInstall(target: LatexBuildTarget): void {
  const key = latexBuildKey(target);
  const loop = loops.get(key);
  if (!loop) return;
  void runInstallRequest(key, target, loop);
}

async function runInstallRequest(
  key: string,
  target: LatexBuildTarget,
  loop: WatchLoop,
): Promise<void> {
  if (loop.stopped) return;
  clearTimer(loop);
  updateEntry(key, (current) => ({ ...current, installRequesting: true, error: null }));
  try {
    const managedInstall = await requestLatexToolchainInstall(target.environmentId);
    if (loop.stopped) return;
    updateEntry(key, (current) => ({ ...current, managedInstall, installRequesting: false }));
    schedulePoll(key, target, loop, LATEX_POLL_INTERVAL_MS);
  } catch (error) {
    if (loop.stopped) return;
    updateEntry(key, (current) => ({ ...current, installRequesting: false }));
    applyTransportError(key, error);
    schedulePoll(key, target, loop, LATEX_OFFLINE_POLL_INTERVAL_MS);
  } finally {
    updateEntry(key, (current) =>
      current.installRequesting ? { ...current, installRequesting: false } : current,
    );
  }
}

export function cancelLatexBuild(target: LatexBuildTarget): void {
  const key = latexBuildKey(target);
  const loop = loops.get(key);
  if (!loop) return;
  void runRequest(key, target, loop, () =>
    requestLatexCancel(target.environmentId, {
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    }),
  );
}

export function resetLatexBuildsForTests(): void {
  for (const [key, loop] of loops) {
    loop.stopped = true;
    clearTimer(loop);
    loops.delete(key);
  }
  useLatexBuildStore.setState({ entries: {} });
}
