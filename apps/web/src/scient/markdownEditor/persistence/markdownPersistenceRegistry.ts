import {
  MarkdownPersistenceCoordinator,
  reconcileMarkdown,
  type MarkdownExternalConflict,
  type MarkdownPersistenceSnapshot,
  type PrepareMarkdownExternalUpdate,
} from "@scientfactory/scient-markdown";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";

import {
  createMarkdownPersistenceTransport,
  type MarkdownPersistenceTarget,
  type MarkdownPersistenceTransport,
} from "./markdownPersistenceTransport";

import {
  indexedDbMarkdownDrafts,
  MarkdownDraftCheckpointWriter,
  type MarkdownDraftCheckpoint,
  type MarkdownDraftCheckpointStore,
} from "./markdownDraftCheckpoint";

export type { MarkdownPersistenceTarget } from "./markdownPersistenceTransport";

export interface MarkdownPersistenceRegistryState extends MarkdownPersistenceTarget {
  readonly pending: boolean;
  readonly attention: boolean;
}

export interface MarkdownPersistenceLease {
  readonly target: MarkdownPersistenceTarget;
  readonly getSnapshot: () => MarkdownPersistenceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly change: (source: string, basedOnVersion: number) => boolean;
  readonly noteFreshnessHint: (reason?: string) => void;
  readonly flushNow: () => Promise<boolean>;
  readonly retry: () => Promise<boolean>;
  readonly refresh: () => Promise<boolean>;
  readonly resolveWithLocal: (revision: string) => Promise<boolean>;
  readonly resolveWithDisk: () => Promise<boolean>;
  readonly restoreRecovery: () => boolean;
  readonly holdForRename: () => (() => void) | null;
  readonly registerExternalProjection: (prepare: PrepareMarkdownExternalUpdate) => () => void;
  readonly resumeExternalUpdates: () => void;
  readonly release: () => void;
}

interface RegistryEntry {
  readonly target: MarkdownPersistenceTarget;
  readonly coordinator: MarkdownPersistenceCoordinator;
  readonly transport: MarkdownPersistenceTransport;
  readonly leases: Set<object>;
  readonly projections: Map<object, PrepareMarkdownExternalUpdate>;
  readonly unsubscribe: () => void;
  readonly checkpoint: MarkdownDraftCheckpointWriter | undefined;
  stopWatching: (() => void) | undefined;
  lastUsed: number;
  evictionTimer: ReturnType<typeof setTimeout> | undefined;
}

export class MarkdownPersistenceRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly initializing = new Map<
    string,
    Promise<{
      initial: ProjectReadFileResult;
      transport: MarkdownPersistenceTransport;
      checkpoint: MarkdownDraftCheckpoint | undefined;
    }>
  >();
  private readonly listeners = new Set<() => void>();
  private state: readonly MarkdownPersistenceRegistryState[] = [];

  constructor(
    private readonly options: {
      readonly createTransport?: (
        target: MarkdownPersistenceTarget,
      ) => MarkdownPersistenceTransport;
      readonly checkpointStore?: MarkdownDraftCheckpointStore;
      readonly cleanTtlMs?: number;
      readonly cleanLimit?: number;
      readonly debounceMs?: number;
    } = {},
  ) {}

  readonly getSnapshot = (): readonly MarkdownPersistenceRegistryState[] => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  has(target: MarkdownPersistenceTarget): boolean {
    return this.entries.has(projectFileOperationKey(target));
  }

  /** New documents are admitted from an ordered read, never an SWR/optimistic cache. */
  async open(target: MarkdownPersistenceTarget): Promise<MarkdownPersistenceLease> {
    const key = projectFileOperationKey(target);
    if (!this.entries.has(key)) {
      let opening = this.initializing.get(key);
      if (opening === undefined) {
        const transport = (this.options.createTransport ?? createMarkdownPersistenceTransport)(
          target,
        );
        opening = Promise.all([
          transport.read(),
          this.options.checkpointStore?.read(key).catch((error: unknown) => {
            console.error("Markdown recovery checkpoint could not be loaded:", error);
            return undefined;
          }),
        ]).then(([disk, checkpoint]) => {
          if (disk.truncated || disk.readOnly) {
            throw new Error(
              disk.truncated
                ? "This file is too large to edit completely."
                : "This file is read-only.",
            );
          }
          return {
            initial: {
              relativePath: target.relativePath,
              contents: disk.source,
              revision: disk.revision,
              byteLength: new TextEncoder().encode(disk.source).byteLength,
              truncated: false,
            },
            transport,
            checkpoint,
          };
        });
        this.initializing.set(key, opening);
      }
      try {
        const { initial, transport, checkpoint } = await opening;
        // Creating the entry and acquiring its first lease are synchronous.
        // No clean-limit sweep can observe an unleased bootstrap entry.
        if (!this.entries.has(key)) {
          let baseline = initial;
          let draft: string | undefined;
          let conflict: MarkdownExternalConflict | undefined;
          if (checkpoint && checkpoint.draftSource !== initial.contents) {
            const combined =
              checkpoint.baselineSource === initial.contents ||
              checkpoint.publicationSource === initial.contents
                ? checkpoint.draftSource
                : checkpoint.baselineSource === checkpoint.draftSource
                  ? undefined
                  : reconcileMarkdown(
                      checkpoint.baselineSource,
                      checkpoint.draftSource,
                      initial.contents,
                    )?.source;
            if (combined !== undefined) draft = combined;
            else {
              baseline = {
                ...initial,
                contents: checkpoint.baselineSource,
                revision: checkpoint.baselineRevision,
              };
              draft = checkpoint.draftSource;
              conflict = { externalSource: initial.contents, externalRevision: initial.revision };
            }
          }
          this.createEntry(target, baseline, draft, transport, checkpoint, conflict);
        }
        return this.acquire(target, null)!;
      } finally {
        if (this.initializing.get(key) === opening) this.initializing.delete(key);
      }
    }
    const lease = this.acquire(target, null);
    if (lease === null) throw new Error("The Markdown document could not be opened for editing.");
    return lease;
  }

  private createEntry(
    target: MarkdownPersistenceTarget,
    initial: ProjectReadFileResult,
    draftSource?: string,
    transport = (this.options.createTransport ?? createMarkdownPersistenceTransport)(target),
    checkpoint?: MarkdownDraftCheckpoint,
    initialConflict?: MarkdownExternalConflict,
  ): RegistryEntry {
    const projections = new Map<object, PrepareMarkdownExternalUpdate>();
    const coordinator = new MarkdownPersistenceCoordinator({
      ...(initialConflict === undefined ? {} : { initialConflict }),
      source: initial.contents,
      revision: initial.revision,
      ...(draftSource === undefined ? {} : { draftSource }),
      write: transport.write,
      read: transport.read,
      classifyFailure: transport.classifyFailure,
      prepareExternalUpdate: (update) => {
        const prepared = [...projections.values()].map((prepare) => prepare(update));
        if (prepared.includes("defer")) return "defer";
        if (prepared.includes(null)) return null;
        return () => {
          for (const apply of prepared) if (typeof apply === "function") apply();
        };
      },
      ...(this.options.debounceMs === undefined ? {} : { debounceMs: this.options.debounceMs }),
    });
    const entry: RegistryEntry = {
      target,
      coordinator,
      transport,
      leases: new Set(),
      projections,
      unsubscribe: coordinator.subscribe(() => this.changed(entry)),
      checkpoint: this.options.checkpointStore
        ? new MarkdownDraftCheckpointWriter(
            projectFileOperationKey(target),
            this.options.checkpointStore,
            checkpoint,
          )
        : undefined,
      stopWatching: undefined,
      lastUsed: Date.now(),
      evictionTimer: undefined,
    };
    this.entries.set(projectFileOperationKey(target), entry);
    return entry;
  }

  /** Acquire after a view commits, never during React render. */
  acquire(
    target: MarkdownPersistenceTarget,
    initial: ProjectReadFileResult | null,
    draftSource?: string,
  ): MarkdownPersistenceLease | null {
    const key = projectFileOperationKey(target);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      if (initial === null || initial.truncated || initial.readOnly) return null;
      entry = this.createEntry(target, initial, draftSource);
    }
    const ownedEntry = entry;
    const token = {};
    let active = true;
    ownedEntry.leases.add(token);
    ownedEntry.lastUsed = Date.now();
    this.changed(ownedEntry);
    const isActive = () => active && this.entries.get(key) === ownedEntry;
    const guarded = (action: () => Promise<boolean>) =>
      isActive() ? action() : Promise.resolve(false);
    return {
      target: entry.target,
      getSnapshot: entry.coordinator.getSnapshot,
      subscribe: entry.coordinator.subscribe,
      release: () => {
        if (!active) return;
        active = false;
        ownedEntry.leases.delete(token);
        ownedEntry.projections.delete(token);
        ownedEntry.coordinator.resumeExternalUpdates();
        ownedEntry.lastUsed = Date.now();
        this.changed(ownedEntry);
      },
      change: (source, basedOnVersion) =>
        isActive() && ownedEntry.coordinator.change(source, basedOnVersion),
      noteFreshnessHint: (reason) => {
        if (isActive()) ownedEntry.coordinator.noteFreshnessHint(reason);
      },
      flushNow: () => guarded(() => ownedEntry.coordinator.flushNow()),
      retry: () => guarded(() => ownedEntry.coordinator.retry()),
      refresh: () => guarded(() => ownedEntry.coordinator.refresh()),
      resolveWithLocal: (revision) =>
        guarded(() => ownedEntry.coordinator.resolveWithLocal(revision)),
      resolveWithDisk: () => guarded(() => ownedEntry.coordinator.resolveWithDisk()),
      restoreRecovery: () => isActive() && ownedEntry.coordinator.restoreRecovery(),
      holdForRename: () => (isActive() ? ownedEntry.coordinator.holdForRename() : null),
      registerExternalProjection: (prepare) => {
        if (isActive()) ownedEntry.projections.set(token, prepare);
        return () => {
          if (ownedEntry.projections.get(token) === prepare) ownedEntry.projections.delete(token);
          ownedEntry.coordinator.resumeExternalUpdates();
        };
      },
      resumeExternalUpdates: () => {
        if (isActive()) ownedEntry.coordinator.resumeExternalUpdates();
      },
    };
  }

  async flushWorkspace(environmentId: EnvironmentId, cwd: string): Promise<boolean> {
    const entries = [...this.entries.values()].filter(
      (entry) => entry.target.environmentId === environmentId && entry.target.cwd === cwd,
    );
    const outcomes = await Promise.all(entries.map((entry) => entry.coordinator.flushNow()));
    return outcomes.every(Boolean);
  }

  flushTarget(target: MarkdownPersistenceTarget): Promise<boolean> {
    return (
      this.entries.get(projectFileOperationKey(target))?.coordinator.flushNow() ??
      Promise.resolve(true)
    );
  }

  /** Only after a successful rename: the old path is no longer this document's identity. */
  forgetClean(target: MarkdownPersistenceTarget): boolean {
    const key = projectFileOperationKey(target);
    const entry = this.entries.get(key);
    if (entry === undefined) return true;
    if (!entry.coordinator.retireClean()) return false;
    if (entry.evictionTimer !== undefined) clearTimeout(entry.evictionTimer);
    this.stopWatching(entry);
    entry.unsubscribe();
    this.entries.delete(key);
    this.publish();
    return true;
  }

  private changed(entry: RegistryEntry): void {
    if (this.entries.get(projectFileOperationKey(entry.target)) !== entry) return;
    const snapshot = entry.coordinator.getSnapshot();
    entry.checkpoint?.update(snapshot);
    try {
      entry.transport.project(snapshot);
    } catch (error) {
      // Presentation must never prevent the synchronous departure guard from
      // learning that this retained document owns unsaved bytes.
      console.error("Markdown cache projection failed:", error);
    }
    const retain =
      entry.leases.size > 0 ||
      snapshot.pending ||
      snapshot.reading ||
      snapshot.retrying ||
      snapshot.error !== null ||
      snapshot.conflict !== null;
    if (retain) {
      if (entry.evictionTimer !== undefined) clearTimeout(entry.evictionTimer);
      entry.evictionTimer = undefined;
      if (entry.stopWatching === undefined) {
        // A subscribe callback can publish synchronously, so install a sentinel first.
        entry.stopWatching = () => {};
        try {
          entry.stopWatching = entry.transport.subscribe({
            hint: (reason) => entry.coordinator.noteFreshnessHint(reason),
            connected: (connected) => entry.coordinator.setConnected(connected),
          });
        } catch (error) {
          entry.stopWatching = undefined;
          console.error("Markdown freshness subscription failed:", error);
        }
      }
    } else {
      this.stopWatching(entry);
      if (entry.evictionTimer === undefined) {
        entry.evictionTimer = setTimeout(() => {
          entry.evictionTimer = undefined;
          this.evict(entry);
        }, this.options.cleanTtlMs ?? 60_000);
      }
    }
    this.publish();
    // A retained entry cannot add to the clean eviction pool. Avoid scanning
    // and sorting all open documents on every keystroke.
    if (retain) return;
    const clean = [...this.entries.values()]
      .filter((candidate) => {
        const value = candidate.coordinator.getSnapshot();
        return (
          candidate.leases.size === 0 &&
          !value.pending &&
          !value.reading &&
          !value.retrying &&
          value.error === null &&
          value.conflict === null
        );
      })
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const candidate of clean.slice(
      0,
      Math.max(0, clean.length - (this.options.cleanLimit ?? 128)),
    )) {
      this.evict(candidate);
    }
  }

  private evict(entry: RegistryEntry): void {
    if (entry.leases.size !== 0 || !entry.coordinator.dispose()) return;
    if (entry.evictionTimer !== undefined) clearTimeout(entry.evictionTimer);
    this.stopWatching(entry);
    entry.unsubscribe();
    this.entries.delete(projectFileOperationKey(entry.target));
    this.publish();
  }

  private stopWatching(entry: RegistryEntry): void {
    const stop = entry.stopWatching;
    entry.stopWatching = undefined;
    try {
      stop?.();
    } catch (error) {
      console.error("Markdown freshness cleanup failed:", error);
    }
  }

  private publish(): void {
    const next = [...this.entries.values()].map((entry) => {
      const snapshot = entry.coordinator.getSnapshot();
      return {
        ...entry.target,
        pending: snapshot.pending,
        attention: snapshot.error !== null || snapshot.conflict !== null,
      };
    });
    if (
      next.length === this.state.length &&
      next.every((entry, index) => {
        const previous = this.state[index]!;
        return (
          projectFileOperationKey(entry) === projectFileOperationKey(previous) &&
          entry.pending === previous.pending &&
          entry.attention === previous.attention
        );
      })
    )
      return;
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Markdown persistence observer failed:", error);
      }
    }
  }
}

const registryKey = Symbol.for("scient.markdown-persistence-registry.v1");
const renderer = globalThis as typeof globalThis & { [registryKey]?: MarkdownPersistenceRegistry };
/** HMR and view remounts keep the same owner and the same scheduled transport lane. */
export const markdownPersistenceRegistry = (renderer[registryKey] ??=
  new MarkdownPersistenceRegistry(
    typeof indexedDB === "undefined" ? {} : { checkpointStore: indexedDbMarkdownDrafts },
  ));
