// FILE: terminalRuntimeTypes.ts
// Purpose: Shared types and stable identity helpers for persistent terminal runtimes.
// Layer: Terminal runtime infrastructure

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalEvent } from "@synara/contracts";
import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import { Terminal, type IDisposable } from "@xterm/xterm";
import type { TerminalLinkMatch } from "../../terminal-links";

export interface TerminalRuntimeCallbacks {
  onSessionExited: () => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onTerminalRuntimeStatusChange?: (terminalId: string, status: TerminalRuntimeStatus) => void;
}

export function buildTerminalRuntimeKey(threadId: string, terminalId: string): string {
  return `${threadId}::${terminalId}`;
}

export interface TerminalRuntimeConfig {
  runtimeKey: string;
  threadId: string;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind?: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  callbacks: TerminalRuntimeCallbacks;
}

export interface TerminalRuntimeViewState {
  autoFocus: boolean;
  isVisible: boolean;
}

export interface TerminalPendingWrite {
  data: string;
  byteLength: number;
  queuedAt: number;
}

export type TerminalOutputEvent = Extract<TerminalEvent, { type: "output" }>;

export interface TerminalSnapshotCaptureState {
  snapshotReconcileActive: boolean;
  snapshotBufferedOutputEvents: TerminalOutputEvent[];
  snapshotReconcileQueued: boolean;
  snapshotReconcileRequestId: number;
}

/** Coalesces an open-state reconcile signal instead of dropping it behind an active capture. */
export function requestTerminalSnapshotReconcile(state: TerminalSnapshotCaptureState): boolean {
  if (!state.snapshotReconcileActive) {
    state.snapshotReconcileQueued = false;
    return true;
  }
  state.snapshotReconcileQueued = true;
  return false;
}

/** Finishes one capture and reports whether a coalesced replacement must now run. */
export function finishTerminalSnapshotReconcile(state: TerminalSnapshotCaptureState): boolean {
  state.snapshotReconcileActive = false;
  const shouldRetry = state.snapshotReconcileQueued;
  state.snapshotReconcileQueued = false;
  return shouldRetry;
}

/**
 * A clear/restart/start event is authoritative and causally supersedes an
 * in-flight snapshot. Cancel that capture so its older history can never be
 * painted after the control event.
 */
export function supersedeTerminalSnapshotCapture(state: TerminalSnapshotCaptureState): boolean {
  if (!state.snapshotReconcileActive) return false;
  supersedeTerminalSnapshotCaptureAndTakeBuffered(state);
  return true;
}

/** Invalidates one capture and returns its buffered output for ordered flush or explicit ACK. */
export function supersedeTerminalSnapshotCaptureAndTakeBuffered(
  state: TerminalSnapshotCaptureState,
): TerminalOutputEvent[] {
  if (!state.snapshotReconcileActive) return [];
  state.snapshotReconcileActive = false;
  state.snapshotReconcileQueued = false;
  state.snapshotReconcileRequestId += 1;
  return state.snapshotBufferedOutputEvents.splice(0);
}

export type TerminalRuntimeStatus = "connecting" | "replaying" | "ready" | "error";

export interface TerminalOutputBarrier {
  lastOutputEpoch: string | null;
  lastOutputSequence: number;
}

/** Advances a live-output barrier, resetting its sequence namespace after a server restart. */
export function acceptTerminalOutputSequence(
  barrier: TerminalOutputBarrier,
  outputEpoch: string,
  outputSequence: number,
): boolean {
  if (outputEpoch !== barrier.lastOutputEpoch) {
    barrier.lastOutputEpoch = outputEpoch;
    barrier.lastOutputSequence = 0;
  }
  if (outputSequence <= barrier.lastOutputSequence) return false;
  barrier.lastOutputSequence = outputSequence;
  return true;
}

/** Applies an authoritative snapshot unless a newer event in the same epoch already arrived. */
export function acceptTerminalSnapshotBarrier(
  barrier: TerminalOutputBarrier,
  outputEpoch: string,
  outputSequence: number,
): boolean {
  if (outputEpoch !== barrier.lastOutputEpoch) {
    barrier.lastOutputEpoch = outputEpoch;
    barrier.lastOutputSequence = 0;
  }
  if (outputSequence < barrier.lastOutputSequence) return false;
  barrier.lastOutputSequence = outputSequence;
  return true;
}

export interface TerminalRuntimeEntry {
  runtimeKey: string;
  threadId: string;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  callbacks: TerminalRuntimeCallbacks;
  wrapper: HTMLDivElement;
  container: HTMLDivElement | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  webglAddon: WebglAddon | null;
  titleInputBuffer: string;
  hasHandledExit: boolean;
  runtimeStatus: TerminalRuntimeStatus;
  opened: boolean;
  disposed: boolean;
  resizeObserver: ResizeObserver | null;
  resizeDispatchTimer: number | null;
  visualResizeFrame: number | null;
  visualResizeTimer: number | null;
  lastVisualResizeAt: number;
  lastSentResize: { cols: number; rows: number } | null;
  pendingResize: { cols: number; rows: number } | null;
  writeRafHandle: number | null;
  writeFlushTimeout: number | null;
  pendingWrites: TerminalPendingWrite[];
  pendingWriteLength: number;
  pendingWriteBytes: number;
  linkMatchCache: Map<string, TerminalLinkMatch[]>;
  lastOutputEpoch: string | null;
  lastOutputSequence: number;
  snapshotReconcileActive: boolean;
  snapshotBufferedOutputEvents: TerminalOutputEvent[];
  snapshotReconcileQueued: boolean;
  snapshotReconcileRequestId: number;
  snapshotReconcileTimer: number | null;
  webglLoadFrame: number | null;
  themeRefreshFrame: number;
  themeObserver: MutationObserver | null;
  visibilityCleanup: (() => void) | null;
  terminalDisposables: IDisposable[];
  attachDisposables: Array<() => void>;
  persistentDisposables: Array<() => void>;
  querySuppressionDispose: (() => void) | null;
  viewState: TerminalRuntimeViewState;
  unsubscribeTerminalEvents: (() => void) | null;
}
