import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { FileSaveCoordinator, type FileSaveResolutionAction } from "./fileSaveCoordinator";

type AtomCommandFailure<A, E> = Extract<AtomCommandResult<A, E>, { readonly _tag: "Failure" }>;

export interface WorkspaceFileSessionCallbacks<A, E> {
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onConfirmed?: (contents: string, value: A) => void;
  readonly onFailure?: (contents: string, result: AtomCommandFailure<A, E>) => void;
  readonly onResolutionApplied?: (action: FileSaveResolutionAction) => void;
}

interface WorkspaceFileSessionTransport<A, E> {
  readonly persist: (
    contents: string,
    expectedRevision: string,
  ) => Promise<AtomCommandResult<A, E>>;
  readonly revisionFromResult: (value: A) => string;
  /** Shared cache publication that must run once per successful write. */
  readonly onPersisted?: (contents: string, value: A) => void;
}

export interface WorkspaceFileSessionLeaseOptions<A, E> extends WorkspaceFileSessionTransport<
  A,
  E
> {
  readonly key: string;
  readonly debounceMs: number;
  readonly initialRevision: string;
  readonly callbacks?: WorkspaceFileSessionCallbacks<A, E>;
}

export interface WorkspaceFileSessionLease {
  readonly change: (contents: string) => void;
  readonly setSuspended: (suspended: boolean) => void;
  readonly syncConfirmedFileRevision: (revision: string) => void;
  readonly discardPending: (revision: string) => void;
  readonly retryPending: (revision: string) => void;
  readonly release: () => void;
}

interface LeaseRecord<A, E> {
  readonly id: symbol;
  readonly callbacks: WorkspaceFileSessionCallbacks<A, E>;
  readonly transport: WorkspaceFileSessionTransport<A, E>;
  readonly debounceMs: number;
  lastObservedRevision: string;
  active: boolean;
  suspended: boolean;
}

interface SessionEntry<A, E> {
  readonly key: string;
  coordinator: FileSaveCoordinator<A, E>;
  readonly leases: Map<symbol, LeaseRecord<A, E>>;
  readonly pendingCallbacks: Set<(pending: boolean) => void>;
  fallbackTransport: WorkspaceFileSessionTransport<A, E>;
  persistTransport: WorkspaceFileSessionTransport<A, E> | null;
  pending: boolean;
  lastFailure: { readonly contents: string; readonly result: AtomCommandFailure<A, E> } | null;
  resolutionFingerprint: string | null;
  generation: number;
}

function lastLease<A, E>(entry: SessionEntry<A, E>): LeaseRecord<A, E> | null {
  let result: LeaseRecord<A, E> | null = null;
  for (const lease of entry.leases.values()) result = lease;
  return result;
}

function activeTransport<A, E>(entry: SessionEntry<A, E>): WorkspaceFileSessionTransport<A, E> {
  return lastLease(entry)?.transport ?? entry.fallbackTransport;
}

function broadcast<A, E>(
  entry: SessionEntry<A, E>,
  notify: (callbacks: WorkspaceFileSessionCallbacks<A, E>) => void,
): void {
  for (const lease of entry.leases.values()) {
    if (lease.active) notify(lease.callbacks);
  }
}

/**
 * Owns one serial persistence pipeline for every logical workspace file key.
 * React surfaces acquire leases; the last release flushes, but an in-flight
 * session remains reusable until it is clean so remounts cannot race a second
 * writer against it.
 */
export class WorkspaceFileSessionRegistry<A = unknown, E = unknown> {
  private readonly entries = new Map<string, SessionEntry<A, E>>();

  acquire(options: WorkspaceFileSessionLeaseOptions<A, E>): WorkspaceFileSessionLease {
    let entry = this.entries.get(options.key);
    const transport: WorkspaceFileSessionTransport<A, E> = {
      persist: options.persist,
      revisionFromResult: options.revisionFromResult,
      ...(options.onPersisted === undefined ? {} : { onPersisted: options.onPersisted }),
    };
    if (entry === undefined) {
      entry = this.createEntry(options.key, options.debounceMs, options.initialRevision, transport);
      this.entries.set(options.key, entry);
    } else {
      entry.generation += 1;
      entry.fallbackTransport = transport;
    }

    const record: LeaseRecord<A, E> = {
      id: Symbol(options.key),
      callbacks: options.callbacks ?? {},
      transport,
      debounceMs: options.debounceMs,
      lastObservedRevision: options.initialRevision,
      active: true,
      suspended: false,
    };
    entry.leases.set(record.id, record);
    if (entry.pending && record.callbacks.onPendingChange !== undefined) {
      const callback = record.callbacks.onPendingChange;
      if (!entry.pendingCallbacks.has(callback)) {
        entry.pendingCallbacks.add(callback);
        callback(true);
      }
    }
    if (entry.lastFailure !== null) {
      record.callbacks.onFailure?.(entry.lastFailure.contents, entry.lastFailure.result);
    }

    const currentEntry = entry;
    const ifActive = (action: () => void): void => {
      if (record.active) action();
    };
    return {
      change: (contents) =>
        ifActive(() => {
          currentEntry.lastFailure = null;
          currentEntry.resolutionFingerprint = null;
          currentEntry.coordinator.change(contents, record.debounceMs);
        }),
      setSuspended: (suspended) =>
        ifActive(() => {
          if (record.suspended === suspended) return;
          record.suspended = suspended;
          currentEntry.coordinator.setSuspended(
            [...currentEntry.leases.values()].some((lease) => lease.active && lease.suspended),
          );
        }),
      syncConfirmedFileRevision: (revision) =>
        ifActive(() => {
          // Acquiring a second view must not let its possibly stale initial
          // render regress the revision already owned by the shared session.
          // Only a revision change observed after this lease joined is new
          // evidence from the authoritative file query.
          if (record.lastObservedRevision === revision) return;
          record.lastObservedRevision = revision;
          currentEntry.coordinator.syncConfirmedFileRevision(revision);
        }),
      discardPending: (revision) => ifActive(() => this.resolve(currentEntry, "discard", revision)),
      retryPending: (revision) => ifActive(() => this.resolve(currentEntry, "retry", revision)),
      release: () => this.release(currentEntry, record),
    };
  }

  get entryCount(): number {
    return this.entries.size;
  }

  /** Test-only cleanup for registries whose fake persistence never settles. */
  clear(): void {
    for (const entry of this.entries.values()) entry.coordinator.dispose();
    this.entries.clear();
  }

  private createEntry(
    key: string,
    debounceMs: number,
    initialRevision: string,
    transport: WorkspaceFileSessionTransport<A, E>,
  ): SessionEntry<A, E> {
    const entry: SessionEntry<A, E> = {
      key,
      coordinator: null as unknown as FileSaveCoordinator<A, E>,
      leases: new Map<symbol, LeaseRecord<A, E>>(),
      pendingCallbacks: new Set<(pending: boolean) => void>(),
      fallbackTransport: transport,
      persistTransport: null,
      pending: false,
      lastFailure: null,
      resolutionFingerprint: null,
      generation: 0,
    };
    entry.coordinator = new FileSaveCoordinator({
      debounceMs,
      initialRevision,
      persist: (contents, expectedRevision) => {
        const selected = activeTransport(entry);
        entry.persistTransport = selected;
        return selected.persist(contents, expectedRevision);
      },
      revisionFromResult: (value) =>
        (entry.persistTransport ?? activeTransport(entry)).revisionFromResult(value),
      onPendingChange: (pending) => {
        entry.pending = pending;
        if (pending) {
          for (const lease of entry.leases.values()) {
            const callback = lease.callbacks.onPendingChange;
            if (!lease.active || callback === undefined || entry.pendingCallbacks.has(callback))
              continue;
            entry.pendingCallbacks.add(callback);
            callback(true);
          }
        } else {
          for (const callback of entry.pendingCallbacks) callback(false);
          entry.pendingCallbacks.clear();
        }
      },
      onConfirmed: (contents, value) => {
        const selected = entry.persistTransport ?? activeTransport(entry);
        entry.persistTransport = null;
        entry.lastFailure = null;
        selected.onPersisted?.(contents, value);
        broadcast(entry, (callbacks) => callbacks.onConfirmed?.(contents, value));
      },
      onFailure: (contents, result) => {
        entry.persistTransport = null;
        entry.resolutionFingerprint = null;
        entry.lastFailure = { contents, result };
        broadcast(entry, (callbacks) => callbacks.onFailure?.(contents, result));
      },
      onResolutionApplied: (action) => {
        if (action === "discard") entry.lastFailure = null;
        broadcast(entry, (callbacks) => callbacks.onResolutionApplied?.(action));
      },
    });
    return entry;
  }

  private resolve(
    entry: SessionEntry<A, E>,
    action: FileSaveResolutionAction,
    revision: string,
  ): void {
    const fingerprint = `${action}\0${revision}`;
    if (entry.resolutionFingerprint === fingerprint) return;
    entry.resolutionFingerprint = fingerprint;
    if (action === "discard") entry.coordinator.discardPending(revision);
    else entry.coordinator.retryPending(revision);
  }

  private release(entry: SessionEntry<A, E>, record: LeaseRecord<A, E>): void {
    if (!record.active) return;
    record.active = false;
    entry.fallbackTransport = record.transport;
    entry.leases.delete(record.id);
    entry.generation += 1;
    if (record.suspended) {
      entry.coordinator.setSuspended(
        [...entry.leases.values()].some((lease) => lease.active && lease.suspended),
      );
    }
    if (entry.leases.size !== 0) return;

    const generation = entry.generation;
    void Promise.resolve().then(async () => {
      if (
        entry.leases.size !== 0 ||
        entry.generation !== generation ||
        this.entries.get(entry.key) !== entry
      )
        return;
      const clean = await entry.coordinator.flush();
      if (
        !clean ||
        entry.leases.size !== 0 ||
        entry.generation !== generation ||
        this.entries.get(entry.key) !== entry
      )
        return;
      entry.coordinator.dispose();
      this.entries.delete(entry.key);
    });
  }
}
