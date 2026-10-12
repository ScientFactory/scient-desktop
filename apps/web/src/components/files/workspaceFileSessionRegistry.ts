import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { ProjectFilePublicationAttention } from "@t3tools/contracts";
import type {
  DocumentRenameIntent,
  MarkdownDraftCheckpointStore,
} from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import type { MarkdownPersistenceTarget } from "~/scient/markdownEditor/persistence/markdownPersistenceTransport";

import {
  FileSaveCoordinator,
  type FileSaveResolutionAction,
  type FileSaveCoordinatorOptions,
} from "./fileSaveCoordinator";

type AtomCommandFailure<A, E> = Extract<AtomCommandResult<A, E>, { readonly _tag: "Failure" }>;

export interface WorkspaceFileSessionCallbacks<A, E> {
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onRestoredSource?: (contents: string) => void;
  readonly onRenameIntentChange?: (intent: DocumentRenameIntent | null) => void;
  readonly onConfirmed?: (contents: string, value: A) => void;
  readonly onFailure?: (contents: string, result: AtomCommandFailure<A, E>) => void;
  readonly onResolutionApplied?: (action: FileSaveResolutionAction) => void;
  readonly onAttentionChange?: (attention: ProjectFilePublicationAttention | null) => void;
  readonly onRecoveryFailure?: (error: unknown) => void;
  readonly onReviewRequiredChange?: (required: boolean) => void;
  readonly onCurrentMissingChange?: (missing: boolean) => void;
}

interface WorkspaceFileSessionTransport<A, E> {
  readonly canPersist?: () => boolean;
  readonly persist: (
    contents: string,
    expectedRevision: string | undefined,
    mutationId: string,
    createOnly?: boolean,
  ) => Promise<AtomCommandResult<A, E>>;
  readonly revisionFromResult: (value: A) => string;
  readonly classifyFailure?: FileSaveCoordinatorOptions<A, E>["classifyFailure"];
  readonly describeAttention?: FileSaveCoordinatorOptions<A, E>["describeAttention"];
  readonly publicationOutcome?: FileSaveCoordinatorOptions<A, E>["publicationOutcome"];
  readonly readForRecovery?: FileSaveCoordinatorOptions<A, E>["readForRecovery"];
  readonly resolveRecovery?: FileSaveCoordinatorOptions<A, E>["resolveRecovery"];
  /** Shared cache publication that must run once per successful write. */
  readonly onPersisted?: (contents: string, value: A) => boolean | void;
}

export interface WorkspaceFileSessionLeaseOptions<A, E> extends WorkspaceFileSessionTransport<
  A,
  E
> {
  readonly key: string;
  readonly debounceMs: number;
  readonly initialRevision: string;
  readonly initialSource: string;
  readonly journalStore: MarkdownDraftCheckpointStore;
  readonly initialAttention?: ProjectFilePublicationAttention;
  readonly callbacks?: WorkspaceFileSessionCallbacks<A, E>;
}

export interface WorkspaceFileSessionLease {
  readonly change: (contents: string) => void;
  readonly getDraftSource: () => string;
  readonly ready: () => Promise<boolean>;
  readonly beginRename: (
    from: MarkdownPersistenceTarget,
    destination: MarkdownPersistenceTarget,
  ) => Promise<DocumentRenameIntent | null>;
  readonly acknowledgeRename: (
    intent: DocumentRenameIntent,
    acknowledgement: NonNullable<DocumentRenameIntent["acknowledgement"]>,
  ) => Promise<boolean>;
  readonly rejectRename: (intent: DocumentRenameIntent, error: unknown) => Promise<boolean>;
  readonly getRenameIntent: () => DocumentRenameIntent | null;
  readonly isRenameCurrent: (intent: DocumentRenameIntent) => boolean;
  readonly flush: () => Promise<boolean>;
  readonly setSuspended: (suspended: boolean) => void;
  readonly syncConfirmedFileRevision: (revision: string, source: string) => void;
  readonly discardPending: (revision: string) => void;
  readonly retryPending: (revision: string) => void;
  readonly observePublicationAttention: (
    attention: ProjectFilePublicationAttention | null | undefined,
  ) => void;
  readonly resolveRetainedAttention: (
    recoveryId: string,
    currentRevision: string | null,
  ) => Promise<boolean>;
  readonly reviewUnchangedRefusal: (currentRevision: string | null) => Promise<boolean>;
  readonly recreateMissingCurrent: (contents?: string) => boolean;
  readonly currentMissing: boolean;
  readonly noteMutationFailure: (error: unknown, mutationId: string) => void;
  readonly publicationAttention: ProjectFilePublicationAttention | null;
  readonly reviewRequired: boolean;
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
  lastFailure:
    | { readonly contents: string; readonly result: AtomCommandFailure<A, E> }
    | { readonly error: unknown }
    | null;
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
  private readonly retiring = new Map<string, Promise<void>>();

  acquire(options: WorkspaceFileSessionLeaseOptions<A, E>): WorkspaceFileSessionLease {
    let entry = this.entries.get(options.key);
    const transport: WorkspaceFileSessionTransport<A, E> = {
      ...(options.canPersist === undefined ? {} : { canPersist: options.canPersist }),
      persist: options.persist,
      revisionFromResult: options.revisionFromResult,
      ...(options.classifyFailure === undefined
        ? {}
        : { classifyFailure: options.classifyFailure }),
      ...(options.describeAttention === undefined
        ? {}
        : { describeAttention: options.describeAttention }),
      ...(options.publicationOutcome === undefined
        ? {}
        : { publicationOutcome: options.publicationOutcome }),
      ...(options.readForRecovery === undefined
        ? {}
        : { readForRecovery: options.readForRecovery }),
      ...(options.resolveRecovery === undefined
        ? {}
        : { resolveRecovery: options.resolveRecovery }),
      ...(options.onPersisted === undefined ? {} : { onPersisted: options.onPersisted }),
    };
    if (entry === undefined) {
      entry = this.createEntry(options, transport);
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
      if ("result" in entry.lastFailure) {
        record.callbacks.onFailure?.(entry.lastFailure.contents, entry.lastFailure.result);
      } else record.callbacks.onRecoveryFailure?.(entry.lastFailure.error);
    }
    if (entry.coordinator.publicationAttention !== null) {
      record.callbacks.onAttentionChange?.(entry.coordinator.publicationAttention);
    }
    record.callbacks.onReviewRequiredChange?.(entry.coordinator.reviewRequired);
    record.callbacks.onCurrentMissingChange?.(entry.coordinator.currentMissing);

    const currentEntry = entry;
    const ifActive = (action: () => void): void => {
      if (record.active) action();
    };
    return {
      get publicationAttention() {
        return currentEntry.coordinator.publicationAttention;
      },
      getRenameIntent: () => currentEntry.coordinator.getRenameIntent(),
      getDraftSource: () => currentEntry.coordinator.getDraftSource(),
      isRenameCurrent: (intent) =>
        record.active && currentEntry.coordinator.isRenameCurrent(intent),
      beginRename: async (from, destination) => {
        if (!record.active) return null;
        const intent = await currentEntry.coordinator.beginRename(from, destination);
        return record.active ? intent : null;
      },
      acknowledgeRename: async (intent, acknowledgement) => {
        if (!record.active) return false;
        const settled = await currentEntry.coordinator.acknowledgeRename(intent, acknowledgement);
        if (settled && this.entries.get(currentEntry.key) === currentEntry) {
          this.entries.delete(currentEntry.key);
          currentEntry.pending = false;
          for (const callback of currentEntry.pendingCallbacks) callback(false);
          currentEntry.pendingCallbacks.clear();
        }
        return settled && record.active;
      },
      rejectRename: (intent, error) =>
        record.active
          ? currentEntry.coordinator.rejectRename(intent, error)
          : Promise.resolve(false),
      ready: () => (record.active ? currentEntry.coordinator.ready() : Promise.resolve(false)),
      get reviewRequired() {
        return currentEntry.coordinator.reviewRequired;
      },
      get currentMissing() {
        return currentEntry.coordinator.currentMissing;
      },
      recreateMissingCurrent: (contents) =>
        record.active && currentEntry.coordinator.recreateMissingCurrent(contents),
      flush: () => (record.active ? currentEntry.coordinator.flush() : Promise.resolve(false)),
      change: (contents) =>
        ifActive(() => {
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
      syncConfirmedFileRevision: (revision, source) =>
        ifActive(() => {
          // Acquiring a second view must not let its possibly stale initial
          // render regress the revision already owned by the shared session.
          // Only a revision change observed after this lease joined is new
          // evidence from the authoritative file query.
          if (record.lastObservedRevision === revision) return;
          record.lastObservedRevision = revision;
          currentEntry.coordinator.syncConfirmedFileRevision(revision, source);
        }),
      discardPending: (revision) => ifActive(() => this.resolve(currentEntry, "discard", revision)),
      retryPending: (revision) => ifActive(() => this.resolve(currentEntry, "retry", revision)),
      observePublicationAttention: (attention) =>
        ifActive(() => currentEntry.coordinator.observePublicationAttention(attention)),
      resolveRetainedAttention: (recoveryId, currentRevision) =>
        record.active
          ? currentEntry.coordinator.resolveRetainedAttention(recoveryId, currentRevision)
          : Promise.resolve(false),
      reviewUnchangedRefusal: (currentRevision) =>
        record.active
          ? currentEntry.coordinator.reviewUnchangedRefusal(currentRevision)
          : Promise.resolve(false),
      noteMutationFailure: (error, mutationId) =>
        ifActive(() => currentEntry.coordinator.noteMutationFailure(error, mutationId)),
      release: () => this.release(currentEntry, record),
    };
  }

  get entryCount(): number {
    return this.entries.size;
  }

  /** Test-only cleanup for registries whose fake persistence never settles. */
  clear(): void {
    for (const entry of this.entries.values()) entry.coordinator.retire();
    this.entries.clear();
  }

  private createEntry(
    options: WorkspaceFileSessionLeaseOptions<A, E>,
    transport: WorkspaceFileSessionTransport<A, E>,
  ): SessionEntry<A, E> {
    const { key, debounceMs, initialRevision, initialSource, journalStore } = options;
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
      initialSource,
      journal: {
        key,
        store: {
          read: async (at) => {
            await this.retiring.get(at);
            return journalStore.read(at);
          },
          replace: (at, expected, next) => journalStore.replace(at, expected, next),
        },
      },
      ...(options.initialAttention === undefined
        ? {}
        : { initialAttention: options.initialAttention }),
      onRenameIntentChange: (intent) =>
        broadcast(entry, (callbacks) => callbacks.onRenameIntentChange?.(intent)),
      onRestoredSource: (contents) =>
        broadcast(entry, (callbacks) => callbacks.onRestoredSource?.(contents)),
      canPersist: () => activeTransport(entry).canPersist?.() !== false,
      persist: (contents, expectedRevision, mutationId, createOnly) => {
        const selected = activeTransport(entry);
        entry.persistTransport = selected;
        return createOnly
          ? selected.persist(contents, undefined, mutationId, true)
          : selected.persist(contents, expectedRevision, mutationId);
      },
      classifyFailure: (error) =>
        (entry.persistTransport ?? activeTransport(entry)).classifyFailure?.(error) ?? "terminal",
      describeAttention: (error, mutationId) =>
        (entry.persistTransport ?? activeTransport(entry)).describeAttention?.(error, mutationId) ??
        null,
      publicationOutcome: (error) =>
        (entry.persistTransport ?? activeTransport(entry)).publicationOutcome?.(error) ?? null,
      readForRecovery: () => {
        const read = activeTransport(entry).readForRecovery;
        if (!read) return Promise.reject(new Error("Retained file recovery is unavailable."));
        return read();
      },
      resolveRecovery: (review) => {
        const resolve = activeTransport(entry).resolveRecovery;
        if (!resolve) return Promise.reject(new Error("Retained file recovery is unavailable."));
        return resolve(review);
      },
      onAttentionChange: (attention) => {
        if (attention === null) {
          entry.lastFailure = null;
          entry.resolutionFingerprint = null;
        }
        broadcast(entry, (callbacks) => callbacks.onAttentionChange?.(attention));
      },
      onRecoveryFailure: (error) => {
        entry.lastFailure = { error };
        entry.resolutionFingerprint = null;
        broadcast(entry, (callbacks) => callbacks.onRecoveryFailure?.(error));
      },
      onReviewRequiredChange: (required) =>
        broadcast(entry, (callbacks) => callbacks.onReviewRequiredChange?.(required)),
      onCurrentMissingChange: (missing) =>
        broadcast(entry, (callbacks) => callbacks.onCurrentMissingChange?.(missing)),
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
        const confirmed = selected.onPersisted?.(contents, value) !== false;
        broadcast(entry, (callbacks) => callbacks.onConfirmed?.(contents, value));
        return confirmed;
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
    if (entry.coordinator.requiresRecovery) return;
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
        entry.coordinator.hasRecoveryReceipt ||
        entry.leases.size !== 0 ||
        entry.generation !== generation ||
        this.entries.get(entry.key) !== entry
      )
        return;
      const retirement = entry.coordinator.retireCleanJournal();
      this.entries.delete(entry.key);
      this.retiring.set(entry.key, retirement);
      void retirement.finally(() => {
        if (this.retiring.get(entry.key) === retirement) this.retiring.delete(entry.key);
      });
    });
  }
}
