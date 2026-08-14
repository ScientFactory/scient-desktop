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
import {
  isActiveLatexBuildState,
  latexSnapshotsEqual,
  toolchainsEqual,
  type LatexBuildStatus,
} from "./scientLatexSurfaceModel";

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
  /**
   * One entry per document watched in this window, kept after its watchers
   * go: reopening a document paints its last known build at once instead of
   * flashing an empty viewer at the reader. A closed document holds one small
   * snapshot and no timers, so nothing is evicted before the window is.
   */
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
  updateEntry(key, (current) => {
    // The report the server sends is rebuilt for every poll, so keeping the
    // one already held whenever the two say the same thing is what lets the
    // equal-snapshot return below fire at all.
    const incoming = snapshot.toolchain;
    const toolchain =
      incoming === null || toolchainsEqual(current.toolchain, incoming)
        ? current.toolchain
        : incoming;
    // Every poll of a running build answers the same thing. Replacing the
    // entry with an equal one would re-render the surface and the PDF beside
    // it once a second for no news.
    const unchanged = current.snapshot !== null && latexSnapshotsEqual(current.snapshot, snapshot);
    if (unchanged && current.error === null && current.toolchain === toolchain) return current;
    return {
      ...current,
      snapshot: unchanged ? current.snapshot : snapshot,
      toolchain,
      error: null,
    };
  });
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
  /**
   * Stamped on every request this loop issues. Only the newest issue may write
   * to the store: a status poll already in flight when a rebuild starts
   * answers with the finished previous build, and adopting that would stop the
   * spinner on a build that is still queued.
   */
  sequence: number;
}

const loops = new Map<string, WatchLoop>();

/**
 * Documents that need a build as soon as anything watches them again. A
 * closing editor flushes its pending save on the way out, so the confirmation
 * can arrive after the last watcher is gone; without this the next open would
 * adopt the PDF built from the text before that save. Keys leave the set the
 * moment their build is issued, so it holds nothing but documents closed
 * mid-save.
 */
const pendingRebuilds = new Set<string>();

/** What a freshly opened document does with the status it reads first. */
type LatexOpenBuild = "none" | "when-idle" | "always";

function issueSequence(loop: WatchLoop): number {
  loop.sequence += 1;
  return loop.sequence;
}

function isCurrentIssue(loop: WatchLoop, issued: number): boolean {
  return !loop.stopped && loop.sequence === issued;
}

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
  buildOnOpen: LatexOpenBuild = "none",
): void {
  if (loop.stopped || loop.timer !== null) return;
  loop.timer = setTimeout(() => {
    loop.timer = null;
    void pollStatus(key, target, loop, buildOnOpen);
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

async function pollStatus(
  key: string,
  target: LatexBuildTarget,
  loop: WatchLoop,
  buildOnOpen: LatexOpenBuild = "none",
): Promise<void> {
  if (loop.stopped) return;
  // A poll that outlives its slot must not silently drop the cadence with it.
  if (loop.polling) {
    schedulePoll(key, target, loop, LATEX_POLL_INTERVAL_MS, buildOnOpen);
    return;
  }
  loop.polling = true;
  const issued = issueSequence(loop);
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
    if (!isCurrentIssue(loop, issued)) return;
    applySnapshot(key, snapshot);
    if (buildOnOpen === "always" || (buildOnOpen === "when-idle" && snapshot.state === "idle")) {
      pendingRebuilds.delete(key);
      runBuild(key, target, loop);
      return;
    }
    scheduleFollowUp(key, target, loop, snapshot);
  } catch (error) {
    if (!isCurrentIssue(loop, issued)) return;
    applyTransportError(key, error);
    // The retry inherits the open's intent: a document opened with a build
    // owed to it still owes that build once the environment answers.
    schedulePoll(key, target, loop, LATEX_OFFLINE_POLL_INTERVAL_MS, buildOnOpen);
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
  const issued = issueSequence(loop);
  setRequesting(key, true);
  try {
    const snapshot = await request();
    if (!isCurrentIssue(loop, issued)) return;
    applySnapshot(key, snapshot);
    scheduleFollowUp(key, target, loop, snapshot);
  } catch (error) {
    if (!isCurrentIssue(loop, issued)) return;
    applyTransportError(key, error);
    schedulePoll(key, target, loop, LATEX_OFFLINE_POLL_INTERVAL_MS);
  } finally {
    setRequesting(key, false);
  }
}

function runBuild(key: string, target: LatexBuildTarget, loop: WatchLoop): void {
  void runRequest(key, target, loop, () =>
    requestLatexBuild(target.environmentId, {
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    }),
  );
}

/**
 * Reads the toolchain endpoint, which answers with the probe result and what
 * this environment can do about a missing engine. A finished install is the
 * one transition worth acting on: the report only says `ready` once the probe
 * behind it has already seen the installed engine, so the document can build.
 */
async function pollToolchain(
  key: string,
  target: LatexBuildTarget,
  refresh = false,
): Promise<void> {
  try {
    const report = await readLatexToolchain(target.environmentId, { refresh });
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
 * Watch one document: read what the environment already has, build only if it
 * has nothing, then keep the snapshot current until every watcher is gone.
 * Repeat calls for the same document share the single loop.
 */
export function startWatchingLatexBuild(target: LatexBuildTarget): () => void {
  const key = latexBuildKey(target);
  const existing = loops.get(key);
  if (existing) {
    existing.watchers += 1;
    return () => releaseWatcher(key, existing);
  }

  const loop: WatchLoop = { watchers: 1, timer: null, polling: false, stopped: false, sequence: 0 };
  loops.set(key, loop);
  // One probe per opened document: the empty state has to know whether this
  // environment can install an engine before any build has run. Every later
  // toolchain read belongs to an install this loop is already watching.
  void pollToolchain(key, target);
  // Status first, so a document the environment built earlier paints its
  // stored PDF at once and a build already running is joined rather than
  // restarted. Only a document with nothing behind it is built on open.
  void pollStatus(key, target, loop, pendingRebuilds.has(key) ? "always" : "when-idle");
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
 * Ask for a fresh build of a document. A build already running is not
 * interrupted: the server queues the rerun and the loop keeps polling. A
 * request for a document nobody watches any more — the save a closing editor
 * flushed on its way out — is remembered for the next watcher instead of
 * being dropped.
 *
 * `reprobeToolchain` belongs to the Rebuild button. Someone who went and
 * installed TeX Live themselves has no other way to tell this environment: the
 * probe's answer is cached for five minutes, the loop is quiet after the build
 * that failed for want of an engine, and nothing else on this client ever asks
 * for a fresh probe. Pressing Rebuild is that request.
 */
export function requestLatexRebuild(
  target: LatexBuildTarget,
  options: { readonly reprobeToolchain?: boolean } = {},
): void {
  const key = latexBuildKey(target);
  const loop = loops.get(key);
  if (!loop) {
    pendingRebuilds.add(key);
    return;
  }
  pendingRebuilds.delete(key);
  const entry = useLatexBuildStore.getState().entries[key] ?? EMPTY_ENTRY;
  if (
    options.reprobeToolchain === true &&
    entry.toolchain !== null &&
    entry.toolchain.kind === null
  ) {
    void reprobeThenBuild(key, target, loop);
    return;
  }
  runBuild(key, target, loop);
}

/** The build waits for the probe: an engine found now is one this build can use. */
async function reprobeThenBuild(
  key: string,
  target: LatexBuildTarget,
  loop: WatchLoop,
): Promise<void> {
  setRequesting(key, true);
  try {
    await pollToolchain(key, target, true);
  } finally {
    setRequesting(key, false);
  }
  if (loop.stopped) return;
  runBuild(key, target, loop);
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
  pendingRebuilds.clear();
  useLatexBuildStore.setState({ entries: {} });
}
