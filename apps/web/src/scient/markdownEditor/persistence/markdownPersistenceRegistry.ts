import {
  DocumentPersistenceCoordinator,
  type DocumentPatchReconciliation,
  type DocumentSourceEdit,
  type DocumentSourceEditOutcome,
  type ReconcileDocument,
} from "@scientfactory/scient-document";
import {
  reconcileMarkdown,
  type MarkdownExternalConflict,
  type MarkdownPersistenceSnapshot,
  type PrepareMarkdownExternalUpdate,
} from "@scientfactory/scient-markdown";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";

import { isScientMarkdownDocumentPath } from "../markdownDocumentPaths";

import {
  createMarkdownPersistenceTransport,
  type MarkdownPersistenceTarget,
  type MarkdownPersistenceTransport,
} from "./markdownPersistenceTransport";

import {
  checkpointHoldsNothing,
  indexedDbMarkdownDrafts,
  MarkdownDraftCheckpointWriter,
  type MarkdownDraftCheckpoint,
  type MarkdownDraftCheckpointStore,
} from "./markdownDraftCheckpoint";

export type { MarkdownPersistenceTarget } from "./markdownPersistenceTransport";

/**
 * How one file's unsaved draft is combined with a verified outside change. The
 * strategy is chosen once per file and stays with it for as long as the file
 * is registered, whichever view or root opened it.
 */
export type DocumentReconcileStrategy = ReconcileDocument<DocumentPatchReconciliation>;

/**
 * Never merge: an outside change over unsaved edits keeps both versions and
 * asks. For formats that have no safe merge yet.
 */
export const keepBothVersions: DocumentReconcileStrategy = () => null;

/**
 * The strategy for each kind of file the registry owns. Only Markdown merges.
 * LaTeX has no merge yet: two changes that are far apart in the text can still
 * depend on each other (a macro and its uses, a label and its references). A
 * file of any other kind is here only as part of a LaTeX document.
 */
export function documentReconcileStrategy(
  target: MarkdownPersistenceTarget,
): DocumentReconcileStrategy | undefined {
  return isScientMarkdownDocumentPath(target.relativePath) ? undefined : keepBothVersions;
}

/**
 * Whether a file's unsaved draft is kept in the session's checkpoint store.
 * A LaTeX document's files are not: their recovery belongs to the Visual
 * editor, which offers recovered work for comparison and never applies it
 * unasked. Two recovery copies of one file would answer that question twice.
 * Bibliographies have no startup recovery UI, so .bib sessions keep unsaved
 * source in memory only; References retains its form until a save is confirmed.
 */
export function documentKeepsCheckpoint(target: MarkdownPersistenceTarget): boolean {
  return isScientMarkdownDocumentPath(target.relativePath);
}

export interface MarkdownPersistenceRegistryState extends MarkdownPersistenceTarget {
  readonly pending: boolean;
  readonly attention: boolean;
}

/** Unconverted editor input belongs to the file owner, but is never published as source. */
export interface DocumentPendingInput {
  readonly message: string;
  readonly payload: unknown;
}

export interface MarkdownPersistenceLease {
  readonly target: MarkdownPersistenceTarget;
  readonly getSnapshot: () => MarkdownPersistenceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getPendingInput: () => DocumentPendingInput | null;
  readonly canEditPendingInput: (editorOwner?: object) => boolean;
  readonly claimPendingInput: (editorOwner?: object) => boolean;
  readonly releasePendingInputClaim: (editorOwner?: object) => void;
  readonly retainPendingInput: (
    input: DocumentPendingInput | null,
    editorOwner?: object,
  ) => boolean;
  readonly change: (source: string, basedOnVersion: number) => boolean;
  /** A planned edit; refused with a reason, and the draft untouched, when it no longer fits. */
  readonly applyEdit: (edit: DocumentSourceEdit) => DocumentSourceEditOutcome;
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
  readonly coordinator: DocumentPersistenceCoordinator<DocumentPatchReconciliation>;
  readonly reconcile: DocumentReconcileStrategy;
  readonly transport: MarkdownPersistenceTransport;
  readonly leases: Set<object>;
  readonly projections: Map<object, PrepareMarkdownExternalUpdate>;
  readonly unsubscribe: () => void;
  readonly checkpoint: MarkdownDraftCheckpointWriter | undefined;
  pendingInput: DocumentPendingInput | null;
  pendingInputOwner: object | null;
  pendingInputOwnerLease: object | null;
  releasePendingHold: (() => void) | null;
  pendingInputTransition: boolean;
  readonly inputListeners: Set<() => void>;
  stopWatching: (() => void) | undefined;
  lastUsed: number;
  evictionTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Raised whenever a registry built from older code could not serve this code:
 * a new lease method, a new rule for which strategy or checkpoint a file gets.
 */
const REGISTRY_GENERATION = 6;

export class MarkdownPersistenceRegistry {
  readonly generation = REGISTRY_GENERATION;
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly initializing = new Map<
    string,
    Promise<{
      initial: ProjectReadFileResult;
      transport: MarkdownPersistenceTransport;
      checkpoint: MarkdownDraftCheckpoint | undefined;
    }>
  >();
  /**
   * A renamed document's recovery copy still being removed from its old path.
   * Admission at that path waits, so a new file there never meets the old copy.
   */
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private state: readonly MarkdownPersistenceRegistryState[] = [];

  constructor(
    private readonly options: {
      readonly createTransport?: (
        target: MarkdownPersistenceTarget,
      ) => MarkdownPersistenceTransport;
      readonly checkpointStore?: MarkdownDraftCheckpointStore;
      /** Files whose unsaved draft is not kept in the checkpoint store. All are kept by default. */
      readonly keepsCheckpoint?: (target: MarkdownPersistenceTarget) => boolean;
      /** The merge strategy for a file; Markdown's block merge where it names none. */
      readonly reconcile?: (
        target: MarkdownPersistenceTarget,
      ) => DocumentReconcileStrategy | undefined;
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

  private checkpointStoreFor(
    target: MarkdownPersistenceTarget,
  ): MarkdownDraftCheckpointStore | undefined {
    return this.options.keepsCheckpoint?.(target) === false
      ? undefined
      : this.options.checkpointStore;
  }

  private strategyFor(target: MarkdownPersistenceTarget): DocumentReconcileStrategy {
    return this.options.reconcile?.(target) ?? reconcileMarkdown;
  }

  has(target: MarkdownPersistenceTarget): boolean {
    return this.entries.has(projectFileOperationKey(target));
  }

  /** Read current ownership without admitting a second writer for a clean dependency. */
  getTargetSnapshot(target: MarkdownPersistenceTarget): MarkdownPersistenceSnapshot | null {
    return this.entries.get(projectFileOperationKey(target))?.coordinator.getSnapshot() ?? null;
  }

  isOpening(target: MarkdownPersistenceTarget): boolean {
    return this.initializing.has(projectFileOperationKey(target));
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
        const store = this.checkpointStoreFor(target);
        opening = Promise.all([
          transport.read(),
          (this.retiring.get(key) ?? Promise.resolve())
            .then(() => store?.read(key))
            .then(async (checkpoint) => {
              if (store === undefined || checkpoint === undefined) return checkpoint;
              if (!checkpointHoldsNothing(checkpoint)) return checkpoint;
              // Nothing to recover: remove it rather than admit it. If removal fails it
              // is passed on only so this file's own copies can take over its token.
              const removed = await store
                .replace(key, checkpoint.token, undefined)
                .catch(() => false);
              return removed ? undefined : checkpoint;
            })
            .catch((error: unknown) => {
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
          if (
            checkpoint &&
            !checkpointHoldsNothing(checkpoint) &&
            checkpoint.draftSource !== initial.contents
          ) {
            const combined =
              checkpoint.baselineSource === initial.contents ||
              checkpoint.publicationSource === initial.contents
                ? checkpoint.draftSource
                : checkpoint.baselineSource === checkpoint.draftSource
                  ? undefined
                  : // The same strategy that will own the file once it is open.
                    this.strategyFor(target)(
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
    const reconcile = this.strategyFor(target);
    const coordinator = new DocumentPersistenceCoordinator<DocumentPatchReconciliation>({
      ...(initialConflict === undefined ? {} : { initialConflict }),
      reconcile,
      source: initial.contents,
      revision: initial.revision,
      ...(draftSource === undefined ? {} : { draftSource }),
      write: transport.write,
      read: transport.read,
      classifyFailure: transport.classifyFailure,
      prepareExternalUpdate: (update) => {
        if (entry.pendingInput !== null) return "defer";
        const prepared = [...projections.values()].map((prepare) => prepare(update));
        if (prepared.includes("defer")) return "defer";
        if (prepared.includes(null)) return null;
        return () => {
          for (const apply of prepared) if (typeof apply === "function") apply();
        };
      },
      ...(this.options.debounceMs === undefined ? {} : { debounceMs: this.options.debounceMs }),
    });
    const checkpointStore = this.checkpointStoreFor(target);
    const entry: RegistryEntry = {
      target,
      coordinator,
      reconcile,
      transport,
      leases: new Set(),
      projections,
      unsubscribe: coordinator.subscribe(() => this.changed(entry)),
      checkpoint: checkpointStore
        ? new MarkdownDraftCheckpointWriter(
            projectFileOperationKey(target),
            checkpointStore,
            checkpoint,
          )
        : undefined,
      pendingInput: null,
      pendingInputOwner: null,
      pendingInputOwnerLease: null,
      releasePendingHold: null,
      pendingInputTransition: false,
      inputListeners: new Set(),
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
    // One view may hold several projections on a lease (a source pane and a
    // rendered pane). Each registration is its own participant.
    const registrations = new Set<object>();
    let active = true;
    ownedEntry.leases.add(token);
    ownedEntry.lastUsed = Date.now();
    this.changed(ownedEntry);
    const isActive = () => active && this.entries.get(key) === ownedEntry;
    const guarded = (action: () => Promise<boolean>) =>
      isActive() ? action() : Promise.resolve(false);
    const notifyInput = () => {
      this.changed(ownedEntry);
      for (const listener of ownedEntry.inputListeners) {
        try {
          listener();
        } catch (error) {
          console.error("Document pending-input observer failed:", error);
        }
      }
    };
    return {
      target: entry.target,
      getSnapshot: entry.coordinator.getSnapshot,
      subscribe: (listener) => {
        const unsubscribe = ownedEntry.coordinator.subscribe(listener);
        ownedEntry.inputListeners.add(listener);
        return () => {
          unsubscribe();
          ownedEntry.inputListeners.delete(listener);
        };
      },
      getPendingInput: () => ownedEntry.pendingInput,
      canEditPendingInput: (editorOwner = token) =>
        isActive() &&
        (ownedEntry.pendingInput === null ||
          ownedEntry.pendingInputOwner === null ||
          (ownedEntry.pendingInputOwner === editorOwner &&
            ownedEntry.pendingInputOwnerLease === token)),
      claimPendingInput: (editorOwner = token) => {
        if (!isActive()) return false;
        if (
          ownedEntry.pendingInput === null ||
          (ownedEntry.pendingInputOwner === editorOwner &&
            ownedEntry.pendingInputOwnerLease === token)
        )
          return true;
        if (ownedEntry.pendingInputOwner !== null) return false;
        ownedEntry.pendingInputOwner = editorOwner;
        ownedEntry.pendingInputOwnerLease = token;
        notifyInput();
        return true;
      },
      releasePendingInputClaim: (editorOwner = token) => {
        if (
          !isActive() ||
          ownedEntry.pendingInputOwner !== editorOwner ||
          ownedEntry.pendingInputOwnerLease !== token
        )
          return;
        ownedEntry.pendingInputOwner = null;
        ownedEntry.pendingInputOwnerLease = null;
        notifyInput();
      },
      retainPendingInput: (input, editorOwner = token) => {
        if (
          !isActive() ||
          ownedEntry.pendingInputTransition ||
          (ownedEntry.pendingInput !== null &&
            (ownedEntry.pendingInputOwner !== editorOwner ||
              ownedEntry.pendingInputOwnerLease !== token))
        )
          return false;
        if (ownedEntry.pendingInput === input) return true;
        const acquireHold = input !== null && ownedEntry.pendingInput === null;
        const releasePreviousHold = input === null ? ownedEntry.releasePendingHold : null;
        if (input === null) ownedEntry.releasePendingHold = null;
        ownedEntry.pendingInput = input;
        ownedEntry.pendingInputOwner = input === null ? null : editorOwner;
        ownedEntry.pendingInputOwnerLease = input === null ? null : token;
        if (acquireHold) {
          // The coordinator publishes while acquiring the hold. Readers see
          // the new input, but cannot replace it before its release is owned.
          ownedEntry.pendingInputTransition = true;
          try {
            ownedEntry.releasePendingHold = ownedEntry.coordinator.suspendExternalUpdates();
          } finally {
            ownedEntry.pendingInputTransition = false;
          }
        }
        notifyInput();
        if (input === null) {
          releasePreviousHold?.();
          ownedEntry.coordinator.resumeExternalUpdates();
        }
        return true;
      },
      release: () => {
        if (!active) return;
        active = false;
        ownedEntry.leases.delete(token);
        if (ownedEntry.pendingInputOwnerLease === token) {
          ownedEntry.pendingInputOwner = null;
          ownedEntry.pendingInputOwnerLease = null;
          notifyInput();
        }
        for (const registration of registrations) ownedEntry.projections.delete(registration);
        registrations.clear();
        ownedEntry.coordinator.resumeExternalUpdates();
        ownedEntry.lastUsed = Date.now();
        this.changed(ownedEntry);
      },
      change: (source, basedOnVersion) =>
        isActive() &&
        ownedEntry.pendingInput === null &&
        ownedEntry.coordinator.change(source, basedOnVersion),
      applyEdit: (edit) =>
        isActive() && ownedEntry.pendingInput === null
          ? ownedEntry.coordinator.applyEdit(edit)
          : { accepted: false, reason: "unavailable" },
      noteFreshnessHint: (reason) => {
        if (isActive()) ownedEntry.coordinator.noteFreshnessHint(reason);
      },
      flushNow: () =>
        guarded(() =>
          ownedEntry.pendingInput === null
            ? ownedEntry.coordinator.flushNow()
            : Promise.resolve(false),
        ),
      retry: () =>
        guarded(() =>
          ownedEntry.pendingInput === null
            ? ownedEntry.coordinator.retry()
            : Promise.resolve(false),
        ),
      refresh: () => guarded(() => ownedEntry.coordinator.refresh()),
      resolveWithLocal: (revision) =>
        guarded(() =>
          ownedEntry.pendingInput === null
            ? ownedEntry.coordinator.resolveWithLocal(revision)
            : Promise.resolve(false),
        ),
      resolveWithDisk: () =>
        guarded(() =>
          ownedEntry.pendingInput === null
            ? ownedEntry.coordinator.resolveWithDisk()
            : Promise.resolve(false),
        ),
      restoreRecovery: () =>
        isActive() && ownedEntry.pendingInput === null && ownedEntry.coordinator.restoreRecovery(),
      holdForRename: () =>
        isActive() && ownedEntry.pendingInput === null
          ? ownedEntry.coordinator.holdForRename()
          : null,
      registerExternalProjection: (prepare) => {
        const registration = {};
        if (isActive()) {
          registrations.add(registration);
          ownedEntry.projections.set(registration, prepare);
        }
        return () => {
          registrations.delete(registration);
          ownedEntry.projections.delete(registration);
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
    const outcomes = await Promise.all(
      entries.map((entry) =>
        entry.pendingInput === null ? entry.coordinator.flushNow() : Promise.resolve(false),
      ),
    );
    return outcomes.every(Boolean);
  }

  flushTarget(target: MarkdownPersistenceTarget): Promise<boolean> {
    if (this.entries.get(projectFileOperationKey(target))?.pendingInput)
      return Promise.resolve(false);
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
    if (entry.pendingInput !== null) return false;
    if (!entry.coordinator.retireClean()) return false;
    if (entry.evictionTimer !== undefined) clearTimeout(entry.evictionTimer);
    this.stopWatching(entry);
    entry.unsubscribe();
    this.entries.delete(key);
    if (entry.checkpoint !== undefined) this.retireCheckpoint(key, entry.checkpoint);
    this.publish();
    return true;
  }

  private retireCheckpoint(key: string, checkpoint: MarkdownDraftCheckpointWriter): void {
    const previous = this.retiring.get(key) ?? Promise.resolve();
    const retired: Promise<void> = previous
      .then(() => checkpoint.retire())
      .finally(() => {
        if (this.retiring.get(key) === retired) this.retiring.delete(key);
      });
    this.retiring.set(key, retired);
  }

  /** Removals still running in a registry this one replaces after a hot reload. */
  adoptRetirements(retiring: ReadonlyMap<string, Promise<void>> | undefined): void {
    for (const [key, done] of retiring ?? []) {
      const adopted: Promise<void> = done.finally(() => {
        if (this.retiring.get(key) === adopted) this.retiring.delete(key);
      });
      this.retiring.set(key, adopted);
    }
  }

  private changed(entry: RegistryEntry): void {
    if (this.entries.get(projectFileOperationKey(entry.target)) !== entry) return;
    const snapshot = entry.coordinator.getSnapshot();
    entry.checkpoint?.update(snapshot, entry.coordinator.pendingOnlyForRename());
    try {
      entry.transport.project(snapshot);
    } catch (error) {
      // Presentation must never prevent the synchronous departure guard from
      // learning that this retained document owns unsaved bytes.
      console.error("Markdown cache projection failed:", error);
    }
    const retain =
      entry.leases.size > 0 ||
      entry.pendingInput !== null ||
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
          candidate.pendingInput === null &&
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
    if (entry.leases.size !== 0 || entry.pendingInput !== null || !entry.coordinator.dispose())
      return;
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
        pending: snapshot.pending || entry.pendingInput !== null,
        attention:
          entry.pendingInput !== null || snapshot.error !== null || snapshot.conflict !== null,
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

/**
 * The registry this renderer keeps across hot reloads and view remounts. One
 * built from older code is replaced only while it owns no file; while it owns
 * any, it stays the single owner and the caller is told it is not current.
 */
export function adoptRendererRegistry(
  existing: MarkdownPersistenceRegistry | undefined,
  create: () => MarkdownPersistenceRegistry,
): { readonly registry: MarkdownPersistenceRegistry; readonly current: boolean } {
  if (existing === undefined) return { registry: create(), current: true };
  if (existing.generation === REGISTRY_GENERATION) return { registry: existing, current: true };
  // Older code may predate any public way to ask, so its maps are read directly.
  const owned = existing as unknown as {
    readonly entries?: ReadonlyMap<string, unknown>;
    readonly initializing?: ReadonlyMap<string, unknown>;
    readonly retiring?: ReadonlyMap<string, Promise<void>>;
  };
  if (owned.entries?.size !== 0 || owned.initializing?.size !== 0)
    return { registry: existing, current: false };
  const registry = create();
  registry.adoptRetirements(owned.retiring);
  return { registry, current: true };
}

const registryKey = Symbol.for("scient.markdown-persistence-registry.v1");
const renderer = globalThis as typeof globalThis & { [registryKey]?: MarkdownPersistenceRegistry };
const adopted = adoptRendererRegistry(
  renderer[registryKey],
  () =>
    new MarkdownPersistenceRegistry({
      reconcile: documentReconcileStrategy,
      keepsCheckpoint: documentKeepsCheckpoint,
      ...(typeof indexedDB === "undefined" ? {} : { checkpointStore: indexedDbMarkdownDrafts }),
    }),
);
renderer[registryKey] = adopted.registry;
if (!adopted.current)
  console.warn("Document saving was updated while files were open. Reload the window to use it.");

/** HMR and view remounts keep the same owner and the same scheduled transport lane. */
export const markdownPersistenceRegistry = adopted.registry;
/**
 * False only after a hot reload that left an older registry in charge. Formats
 * that registry would merge as Markdown stay read-only until the window reloads.
 */
export const documentSessionIsCurrent = adopted.current;
