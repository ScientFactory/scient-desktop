import {
  DocumentPersistenceCoordinator,
  type DocumentPatchReconciliation,
  type DocumentPersistenceCurrentReview,
  type DocumentPersistenceOptions,
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

import { randomUUID } from "~/lib/utils";
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
  type DocumentRenameIntent,
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

/** Markdown retains its existing reconciliation; native documents keep both versions. */
export function documentReconcileStrategy(
  target: MarkdownPersistenceTarget,
): DocumentReconcileStrategy | undefined {
  return isScientMarkdownDocumentPath(target.relativePath) ? undefined : keepBothVersions;
}

/**
 * Whether ordinary unsaved draft copies are kept in the session's store.
 * Native editors own their draft recovery. Every format still journals the
 * exact publication intent here before transport admission, and clears that
 * journal only after the coordinator has a known acknowledgement.
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
  /** Follows the document: after an in-place rename this is the new path. */
  readonly target: MarkdownPersistenceTarget;
  /** Stable for the open document, including across an in-place rename. */
  readonly documentId: string;
  /** Who acquired this lease; an in-place rename needs every lease to share one owner. */
  readonly owner: object | undefined;
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
  readonly recreateMissingCurrent: () => Promise<boolean>;
  readonly retry: () => Promise<boolean>;
  readonly refresh: () => Promise<boolean>;
  readonly noteMutationFailure: (error: unknown, mutationId?: string) => void;
  readonly getRenameIntent: () => DocumentRenameIntent | null;
  readonly resolveRetainedAttention: (
    recoveryId: string,
    currentRevision: string | null,
  ) => Promise<boolean>;
  readonly reviewRetainedCurrent: (
    recoveryId: string,
  ) => Promise<DocumentPersistenceCurrentReview | null>;
  readonly reviewUnchangedRefusal: (currentRevision: string | null) => Promise<boolean>;
  readonly resolveWithLocal: (revision: string) => Promise<boolean>;
  readonly resolveWithDisk: () => Promise<boolean>;
  readonly restoreRecovery: () => boolean;
  readonly holdForRename: () => (() => void) | null;
  /** Removes only a clean ordinary recovery copy; never a pending namespace intent. */
  readonly settleRecoveryCopy?: () => Promise<boolean>;
  /**
   * Starts an in-place rename to `destination`, or null when this document
   * cannot move in place (the caller then renames the ordinary way).
   */
  readonly beginMove: (
    destination: MarkdownPersistenceTarget,
  ) => MarkdownPersistenceMoveTransaction | null;
  readonly registerExternalProjection: (prepare: PrepareMarkdownExternalUpdate) => () => void;
  readonly resumeExternalUpdates: () => void;
  readonly release: () => void;
}

interface RegistryEntry {
  readonly id: string;
  /** Changes only through an in-place rename (`beginMove`). */
  target: MarkdownPersistenceTarget;
  readonly coordinator: DocumentPersistenceCoordinator<DocumentPatchReconciliation>;
  readonly reconcile: DocumentReconcileStrategy;
  transport: MarkdownPersistenceTransport;
  /** Each lease token and the owner it was acquired for. */
  readonly leases: Map<object, object | undefined>;
  readonly projections: Map<object, PrepareMarkdownExternalUpdate>;
  readonly unsubscribe: () => void;
  checkpoint: MarkdownDraftCheckpointWriter | undefined;
  renameIntent: DocumentRenameIntent | null;
  settlingRename: boolean;
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

/** An open document moved to a new path without being reopened. */
export interface MarkdownPersistenceMove {
  readonly documentId: string;
  readonly from: MarkdownPersistenceTarget;
  readonly to: MarkdownPersistenceTarget;
}

/**
 * An in-place rename of one open document, from `beginMove` to `finish`. The
 * document is held (no saves, no edits) for the whole transaction.
 */
export interface MarkdownPersistenceMoveTransaction {
  readonly documentId: string;
  /**
   * Whether the destination has no recovery copy. `unknown` (storage could not
   * be read) counts as not empty.
   */
  readonly preflight: () => Promise<"empty" | "occupied" | "unknown">;
  /** Strict durable admission; returns the original identity when replaying. */
  readonly admitRename: (options?: {
    readonly removeEmptyFolders?: true;
  }) => Promise<DocumentRenameIntent>;
  /** Rechecked synchronously at dispatch after strict storage admission resolves. */
  readonly isCurrent: () => boolean;
  /** Journals an exact authoritative receipt before any local path changes. */
  readonly acknowledgeRename: (acknowledgement: {
    readonly destinationRelativePath: string;
    readonly revision: string;
  }) => Promise<boolean>;
  /** Clears only an authoritative definitive refusal, preserving ordinary input. */
  readonly rejectRename: () => Promise<void>;
  /** Moves the acknowledged journal and document together; CAS failure leaves input held. */
  readonly commit: () => Promise<boolean>;
  /** Ends the transaction: releases the hold and reservations. Idempotent. */
  readonly finish: () => void;
}

let nextDocumentId = 1;

/**
 * The open document's identity for keys that must survive an in-place rename.
 * A registry from older code (kept after a hot reload) has no document ids;
 * its documents are known by path, as before.
 */
export function documentIdentity(lease: MarkdownPersistenceLease): string {
  return typeof lease.documentId === "string"
    ? lease.documentId
    : projectFileOperationKey(lease.target);
}

/** Whether this lease can move its document in place (not from older code). */
export function canMoveInPlace(lease: MarkdownPersistenceLease): boolean {
  return typeof lease.beginMove === "function" && typeof lease.documentId === "string";
}

/**
 * Raised whenever a registry built from older code could not serve this code:
 * a new lease method, a new rule for which strategy or checkpoint a file gets.
 */
const REGISTRY_GENERATION = 15;

class CheckpointAdmissionError extends Error {}

export class MarkdownPersistenceRegistry {
  readonly generation = REGISTRY_GENERATION;
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly initializing = new Map<
    string,
    Promise<{
      initial: ProjectReadFileResult;
      transport: MarkdownPersistenceTransport;
      checkpoint: MarkdownDraftCheckpoint | undefined;
      currentMissing: boolean;
    }>
  >();
  /**
   * A renamed document's recovery copy still being removed from its old path.
   * Admission at that path waits, so a new file there never meets the old copy.
   */
  private readonly retiring = new Map<string, Promise<void>>();
  /**
   * Each path's document id. It outlives eviction, so a file reopened later is
   * the same document to its views (Source keeps its undo, as it did by path),
   * and it moves with an in-place rename.
   */
  private readonly documentIds = new Map<string, string>();
  /** Paths an in-place rename is using; admission there waits for it to end. */
  private readonly reserved = new Map<string, Promise<void>>();
  private readonly moveListeners = new Set<(move: MarkdownPersistenceMove) => void>();
  private readonly listeners = new Set<() => void>();
  private state: readonly MarkdownPersistenceRegistryState[] = [];

  constructor(
    private readonly options: {
      readonly createTransport?: (
        target: MarkdownPersistenceTarget,
      ) => MarkdownPersistenceTransport;
      readonly checkpointStore?: MarkdownDraftCheckpointStore;
      /** Files whose ordinary drafts use this store; exact publication intents always do. */
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

  private checkpointSnapshot(entry: RegistryEntry): MarkdownPersistenceSnapshot {
    const snapshot = entry.coordinator.getSnapshot();
    if (
      entry.renameIntent ||
      snapshot.authorizedCurrentReview !== null ||
      snapshot.attention !== null ||
      snapshot.currentMissing ||
      this.options.keepsCheckpoint?.(entry.target) !== false
    )
      return snapshot;
    // The native editor owns any newer draft. This journal recovers only the
    // source associated with the exact publication identity.
    return {
      ...snapshot,
      draftSource: snapshot.publicationIntent?.source ?? snapshot.baselineSource,
      pending: snapshot.publicationIntent !== null,
    };
  }

  private publicationIo(
    getEntry: () => RegistryEntry,
    transport: MarkdownPersistenceTransport,
  ): Pick<
    DocumentPersistenceOptions,
    "write" | "classifyFailure" | "persistAuthorizedCurrentReview"
  > {
    return {
      persistAuthorizedCurrentReview: async (snapshot) => {
        const entry = getEntry();
        const writer = entry.checkpoint;
        if (
          !writer ||
          entry.transport !== transport ||
          this.entries.get(projectFileOperationKey(entry.target)) !== entry
        )
          throw new CheckpointAdmissionError(
            "This reviewed current no longer owns its recovery journal.",
          );
        await writer.flushAuthorizedCurrentReview(snapshot);
        if (
          entry.checkpoint !== writer ||
          entry.transport !== transport ||
          this.entries.get(projectFileOperationKey(entry.target)) !== entry
        )
          throw new CheckpointAdmissionError(
            "This reviewed current moved during durable admission.",
          );
      },
      write: async (intent) => {
        const entry = getEntry();
        const writer = entry.checkpoint;
        try {
          if (!writer)
            throw new Error("Durable file publication requires available recovery storage.");
          if (
            entry.renameIntent &&
            (!entry.renameIntent.acknowledgement ||
              projectFileOperationKey(entry.renameIntent.destination) !==
                projectFileOperationKey(entry.target))
          )
            throw new Error(
              "A pending rename must be acknowledged or reviewed before publishing source.",
            );
          if (
            entry.transport !== transport ||
            this.entries.get(projectFileOperationKey(entry.target)) !== entry
          )
            throw new Error("This file publication no longer belongs to the current document.");
          const snapshot = this.checkpointSnapshot(entry);
          if (snapshot.publicationIntent !== intent)
            throw new Error("The file publication identity changed before admission.");
          await writer.flushPublication(snapshot);
          if (
            entry.checkpoint !== writer ||
            entry.transport !== transport ||
            this.entries.get(projectFileOperationKey(entry.target)) !== entry
          )
            throw new Error("This file publication moved before durable admission.");
        } catch (cause) {
          throw new CheckpointAdmissionError(
            cause instanceof Error
              ? cause.message
              : "The publication checkpoint could not be committed.",
            { cause },
          );
        }
        return transport.write(intent);
      },
      classifyFailure: (error) =>
        error instanceof CheckpointAdmissionError ? "terminal" : transport.classifyFailure(error),
    };
  }

  private async finishRenameReview(entry: RegistryEntry, accepted: boolean): Promise<boolean> {
    if (!accepted || !entry.renameIntent) return accepted;
    const intent = entry.renameIntent;
    if (
      intent.acknowledgement &&
      projectFileOperationKey(intent.destination) === projectFileOperationKey(entry.target)
    )
      return accepted;
    try {
      if (!entry.checkpoint) return false;
      await entry.checkpoint.clearRename(this.checkpointSnapshot(entry), intent.mutationId);
      if (entry.renameIntent !== intent) return false;
      entry.renameIntent = null;
      this.changed(entry);
      return true;
    } catch (cause) {
      entry.coordinator.noteMutationFailure(cause, intent.mutationId);
      return false;
    }
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
  /** Told synchronously when an open document moves to a new path in place. */
  readonly onMoved = (listener: (move: MarkdownPersistenceMove) => void): (() => void) => {
    this.moveListeners.add(listener);
    return () => this.moveListeners.delete(listener);
  };

  /** New documents are admitted from an ordered read, never an SWR/optimistic cache. */
  async open(target: MarkdownPersistenceTarget, owner?: object): Promise<MarkdownPersistenceLease> {
    const key = projectFileOperationKey(target);
    // An in-place rename is using this path; admit only once it has ended.
    for (let wait = this.reserved.get(key); wait !== undefined; wait = this.reserved.get(key))
      await wait;
    if (!this.entries.has(key)) {
      let opening = this.initializing.get(key);
      if (opening === undefined) {
        const transport = (this.options.createTransport ?? createMarkdownPersistenceTransport)(
          target,
        );
        const store = this.options.checkpointStore;
        opening = Promise.all([
          transport.readForReview?.() ?? transport.read(),
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
          if (disk.missing) {
            if (!checkpoint)
              throw new Error(
                "The current file is missing. Open a retained version or supply a local draft before editing.",
              );
            const publicationAttention =
              disk.publicationAttention ?? checkpoint.publicationAttention;
            return {
              initial: {
                relativePath: target.relativePath,
                contents: checkpoint.baselineSource,
                revision: checkpoint.baselineRevision,
                byteLength: new TextEncoder().encode(checkpoint.baselineSource).byteLength,
                truncated: false,
                ...(publicationAttention ? { publicationAttention } : {}),
              },
              transport,
              checkpoint,
              currentMissing: true,
            };
          }
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
              ...(disk.publicationAttention
                ? { publicationAttention: disk.publicationAttention }
                : {}),
            },
            transport,
            checkpoint,
            currentMissing: false,
          };
        });
        this.initializing.set(key, opening);
      }
      try {
        const { initial, transport, checkpoint, currentMissing } = await opening;
        // Creating the entry and acquiring its first lease are synchronous.
        // No clean-limit sweep can observe an unleased bootstrap entry.
        if (!this.entries.has(key)) {
          let baseline = initial;
          let draft: string | undefined;
          let conflict: MarkdownExternalConflict | undefined;
          const renameAtDestination =
            checkpoint?.renameIntent?.acknowledgement &&
            projectFileOperationKey(checkpoint.renameIntent.destination) === key;
          const checkpointAttention =
            checkpoint?.attention &&
            (!renameAtDestination ||
              checkpoint.publicationIntent ||
              checkpoint.attentionMutationId !== checkpoint.renameIntent?.mutationId);
          if (
            checkpoint &&
            (checkpointAttention ||
              checkpoint.publicationIntent ||
              (checkpoint.renameIntent && !renameAtDestination) ||
              currentMissing)
          ) {
            baseline = {
              ...initial,
              contents: checkpoint.baselineSource,
              revision: checkpoint.baselineRevision,
            };
            draft = checkpoint.draftSource;
          }
          if (
            checkpoint &&
            !currentMissing &&
            !checkpointHoldsNothing(checkpoint) &&
            !checkpoint.publicationIntent &&
            (!checkpoint.renameIntent || renameAtDestination) &&
            !checkpointAttention &&
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
          this.createEntry(
            target,
            baseline,
            draft,
            transport,
            checkpoint,
            conflict,
            currentMissing,
          );
        }
        return this.acquire(target, null, undefined, owner)!;
      } finally {
        if (this.initializing.get(key) === opening) this.initializing.delete(key);
      }
    }
    const lease = this.acquire(target, null, undefined, owner);
    if (lease === null) throw new Error("The Markdown document could not be opened for editing.");
    lease.noteFreshnessHint("reopen");
    return lease;
  }

  private createEntry(
    target: MarkdownPersistenceTarget,
    initial: ProjectReadFileResult,
    draftSource?: string,
    transport = (this.options.createTransport ?? createMarkdownPersistenceTransport)(target),
    checkpoint?: MarkdownDraftCheckpoint,
    initialConflict?: MarkdownExternalConflict,
    initialCurrentMissing = false,
  ): RegistryEntry {
    const projections = new Map<object, PrepareMarkdownExternalUpdate>();
    const reconcile = this.strategyFor(target);
    const renamePending =
      checkpoint?.renameIntent &&
      (!checkpoint.renameIntent.acknowledgement ||
        projectFileOperationKey(checkpoint.renameIntent.destination) !==
          projectFileOperationKey(target))
        ? checkpoint.renameIntent
        : null;
    const namespaceAttention =
      checkpoint?.renameIntent?.acknowledgement &&
      !renamePending &&
      !checkpoint.publicationIntent &&
      checkpoint.attentionMutationId === checkpoint.renameIntent.mutationId;
    const coordinator = new DocumentPersistenceCoordinator<DocumentPatchReconciliation>({
      ...(initialConflict === undefined ? {} : { initialConflict }),
      ...(initialCurrentMissing ? { initialCurrentMissing: true } : {}),
      ...(renamePending
        ? {
            initialAttention: checkpoint?.attention ?? "outcome_unknown",
            initialAttentionMutationId: renamePending.mutationId,
          }
        : checkpoint?.attention && !namespaceAttention
          ? { initialAttention: checkpoint.attention }
          : {}),
      ...(checkpoint?.publicationOutcome && !namespaceAttention
        ? { initialPublicationOutcome: checkpoint.publicationOutcome }
        : {}),
      ...(!renamePending && !namespaceAttention && checkpoint?.attentionMutationId
        ? { initialAttentionMutationId: checkpoint.attentionMutationId }
        : {}),
      ...(initial.publicationAttention
        ? { initialPublicationAttention: initial.publicationAttention }
        : checkpoint?.publicationAttention && !namespaceAttention
          ? { initialPublicationAttention: checkpoint.publicationAttention }
          : {}),
      ...(checkpoint?.publicationIntent
        ? { initialPublication: checkpoint.publicationIntent }
        : {}),
      ...(checkpoint?.authorizedCurrentReview && !renamePending && !namespaceAttention
        ? { initialAuthorizedCurrentReview: checkpoint.authorizedCurrentReview }
        : {}),
      reconcile,
      source: initial.contents,
      revision: initial.revision,
      ...(draftSource === undefined ? {} : { draftSource }),
      ...this.publicationIo(() => entry, transport),
      read: transport.read,
      ...(transport.readForReview ? { readForReview: transport.readForReview } : {}),
      ...(transport.resolve ? { resolve: transport.resolve } : {}),
      ...(transport.describeAttention ? { describeAttention: transport.describeAttention } : {}),
      ...(transport.describeOutcome ? { describeOutcome: transport.describeOutcome } : {}),
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
    const checkpointStore = this.options.checkpointStore;
    const entryKey = projectFileOperationKey(target);
    let id = this.documentIds.get(entryKey);
    if (id === undefined) this.documentIds.set(entryKey, (id = `document-${nextDocumentId++}`));
    const entry: RegistryEntry = {
      id,
      target,
      coordinator,
      reconcile,
      transport,
      leases: new Map(),
      projections,
      unsubscribe: coordinator.subscribe(() => this.changed(entry)),
      checkpoint: checkpointStore
        ? new MarkdownDraftCheckpointWriter(
            projectFileOperationKey(target),
            checkpointStore,
            checkpoint,
          )
        : undefined,
      renameIntent: checkpoint?.renameIntent ?? null,
      settlingRename: false,
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
    owner?: object,
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
    ownedEntry.leases.set(token, owner);
    ownedEntry.lastUsed = Date.now();
    this.changed(ownedEntry);
    // By identity, not by the path it was acquired at: the document may move.
    const isActive = () =>
      active && this.entries.get(projectFileOperationKey(ownedEntry.target)) === ownedEntry;
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
      get target() {
        return ownedEntry.target;
      },
      documentId: ownedEntry.id,
      owner,
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
      getRenameIntent: () =>
        ownedEntry.renameIntent?.acknowledgement &&
        projectFileOperationKey(ownedEntry.renameIntent.destination) ===
          projectFileOperationKey(ownedEntry.target)
          ? null
          : ownedEntry.renameIntent,
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
      noteMutationFailure: (error, mutationId) => {
        if (isActive()) ownedEntry.coordinator.noteMutationFailure(error, mutationId);
      },
      recreateMissingCurrent: () =>
        guarded(() =>
          ownedEntry.pendingInput === null
            ? ownedEntry.coordinator.recreateMissingCurrent()
            : Promise.resolve(false),
        ),
      reviewUnchangedRefusal: (currentRevision) =>
        guarded(async () =>
          this.finishRenameReview(
            ownedEntry,
            ownedEntry.pendingInput === null &&
              (await ownedEntry.coordinator.reviewUnchangedRefusal(currentRevision)),
          ),
        ),
      reviewRetainedCurrent: (recoveryId) =>
        isActive() && ownedEntry.pendingInput === null
          ? ownedEntry.coordinator.reviewRetainedCurrent(recoveryId)
          : Promise.resolve(null),
      resolveRetainedAttention: (recoveryId, currentRevision) =>
        guarded(async () =>
          this.finishRenameReview(
            ownedEntry,
            ownedEntry.pendingInput === null &&
              (await ownedEntry.coordinator.resolveRetainedAttention(recoveryId, currentRevision)),
          ),
        ),
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
      settleRecoveryCopy: () =>
        guarded(() => ownedEntry.checkpoint?.settle() ?? Promise.resolve(true)),
      beginMove: (destination) =>
        isActive() ? this.beginMove(ownedEntry, owner, destination, isActive) : null,
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

  private beginMove(
    entry: RegistryEntry,
    owner: object | undefined,
    destination: MarkdownPersistenceTarget,
    leaseActive: () => boolean,
  ): MarkdownPersistenceMoveTransaction | null {
    const from = entry.target;
    const fromKey = projectFileOperationKey(from);
    const toKey = projectFileOperationKey(destination);
    if (
      owner === undefined ||
      fromKey === toKey ||
      destination.environmentId !== from.environmentId ||
      destination.cwd !== from.cwd ||
      this.entries.get(fromKey) !== entry ||
      // Every view of this document must belong to the one renaming it.
      [...entry.leases.values()].some((leaseOwner) => leaseOwner !== owner) ||
      entry.pendingInput !== null ||
      // Same kind of document: same merge rule at both paths.
      this.strategyFor(destination) !== entry.reconcile ||
      this.options.keepsCheckpoint?.(destination) !== this.options.keepsCheckpoint?.(from) ||
      this.entries.has(toKey) ||
      this.initializing.has(toKey) ||
      this.reserved.has(fromKey) ||
      this.reserved.has(toKey) ||
      this.retiring.has(toKey)
    )
      return null;
    const release = entry.renameIntent
      ? entry.coordinator.holdForRecoveredRename(
          entry.renameIntent.mutationId,
          entry.renameIntent.expectedRevision,
        )
      : entry.coordinator.holdForRename();
    if (release === null) return null;
    let finishReservation!: () => void;
    const reservation = new Promise<void>((done) => (finishReservation = done));
    this.reserved.set(fromKey, reservation);
    this.reserved.set(toKey, reservation);
    let committed = false;
    let finished = false;
    const store = this.options.checkpointStore;
    let destinationCheckpoint: MarkdownDraftCheckpoint | undefined;
    let admitted: DocumentRenameIntent | null = null;
    const stillOwned = () =>
      !finished &&
      leaseActive() &&
      this.entries.get(fromKey) === entry &&
      this.reserved.get(fromKey) === reservation &&
      this.reserved.get(toKey) === reservation;
    return {
      documentId: entry.id,
      isCurrent: stillOwned,
      preflight: async () => {
        if (!stillOwned() || !store || !entry.checkpoint) return "unknown";
        try {
          destinationCheckpoint = await store.read(toKey);
          if (!stillOwned()) return "unknown";
          if (!destinationCheckpoint) return "empty";
          return entry.renameIntent?.acknowledgement &&
            destinationCheckpoint.renameIntent?.mutationId === entry.renameIntent.mutationId &&
            projectFileOperationKey(destinationCheckpoint.renameIntent.from) === fromKey &&
            projectFileOperationKey(destinationCheckpoint.renameIntent.destination) === toKey
            ? "empty"
            : "occupied";
        } catch {
          return "unknown";
        }
      },
      admitRename: async (options) => {
        if (!stillOwned() || !entry.checkpoint)
          throw new Error("This rename no longer owns its document or recovery storage.");
        const snapshot = entry.coordinator.getSnapshot();
        const intent = entry.renameIntent ?? {
          mutationId: randomUUID(),
          from: { ...from },
          destination: { ...destination },
          expectedRevision: snapshot.baselineRevision,
          baselineSource: snapshot.baselineSource,
          source: snapshot.baselineSource,
          draftSource: snapshot.draftSource,
          ...(options?.removeEmptyFolders ? { removeEmptyFolders: true as const } : {}),
        };
        if (
          projectFileOperationKey(intent.from) !== fromKey ||
          projectFileOperationKey(intent.destination) !== toKey
        )
          throw new Error("A pending rename must replay its original source and destination.");
        await entry.checkpoint.flushRename(this.checkpointSnapshot(entry), intent);
        entry.renameIntent = intent;
        if (!stillOwned()) throw new Error("This rename lease retired during durable admission.");
        admitted = intent;
        return intent;
      },
      acknowledgeRename: async (acknowledgement) => {
        if (
          !stillOwned() ||
          !admitted ||
          !entry.checkpoint ||
          acknowledgement.destinationRelativePath !== admitted.destination.relativePath ||
          acknowledgement.revision !== admitted.expectedRevision
        )
          return false;
        const intent = { ...admitted, acknowledgement: { ...acknowledgement } };
        await entry.checkpoint.flushRename(this.checkpointSnapshot(entry), intent);
        entry.renameIntent = intent;
        admitted = intent;
        return stillOwned();
      },
      rejectRename: async () => {
        if (!stillOwned() || !admitted || !entry.checkpoint)
          throw new Error("This rename no longer owns its durable intent.");
        await entry.checkpoint.clearRename(this.checkpointSnapshot(entry), admitted.mutationId);
        entry.renameIntent = null;
        admitted = null;
      },
      commit: async () => {
        if (committed || !stillOwned() || !admitted?.acknowledgement || !store || !entry.checkpoint)
          return false;
        if (this.entries.has(toKey) || this.initializing.has(toKey)) return false;
        let transport: MarkdownPersistenceTransport;
        try {
          transport = (this.options.createTransport ?? createMarkdownPersistenceTransport)(
            destination,
          );
        } catch (error) {
          console.error("The renamed document could not be moved in place:", error);
          return false;
        }
        const destinationWriter = new MarkdownDraftCheckpointWriter(
          toKey,
          store,
          destinationCheckpoint,
        );
        // Keep the old authoritative identity until the destination owns the
        // exact receipt and every newer working byte in its durable journal.
        await destinationWriter.flushRename(this.checkpointSnapshot(entry), admitted);
        if (!stillOwned()) return false;
        if (!entry.coordinator.acknowledgeRecoveredRename(release, admitted.mutationId))
          return false;
        if (
          !entry.coordinator.replaceIo(release, {
            ...this.publicationIo(() => entry, transport),
            read: transport.read,
            ...(transport.readForReview ? { readForReview: transport.readForReview } : {}),
            ...(transport.resolve ? { resolve: transport.resolve } : {}),
            ...(transport.describeAttention
              ? { describeAttention: transport.describeAttention }
              : {}),
            ...(transport.describeOutcome ? { describeOutcome: transport.describeOutcome } : {}),
          })
        )
          return false;
        committed = true;
        this.stopWatching(entry);
        this.entries.delete(fromKey);
        this.entries.set(toKey, entry);
        this.documentIds.delete(fromKey);
        this.documentIds.set(toKey, entry.id);
        entry.target = destination;
        entry.transport = transport;
        const previousCheckpoint = entry.checkpoint;
        entry.checkpoint = destinationWriter;
        const retired = previousCheckpoint
          .clearRename(this.checkpointSnapshot(entry), admitted.mutationId)
          .then(() => previousCheckpoint.retire())
          .catch((cause: unknown) => {
            console.error("The acknowledged rename's source journal was preserved:", cause);
          })
          .finally(() => {
            if (this.retiring.get(fromKey) === retired) this.retiring.delete(fromKey);
          });
        this.retiring.set(fromKey, retired);
        // Newer native working bytes retain the acknowledged namespace receipt
        // until source publication confirms them; ordinary native checkpoints
        // must not discard that transfer recovery during a disconnected follow.
        const snapshot = entry.coordinator.getSnapshot();
        if (snapshot.draftSource === snapshot.baselineSource) {
          await destinationWriter.clearRename(this.checkpointSnapshot(entry), admitted.mutationId);
          entry.renameIntent = null;
        }
        const move = { documentId: entry.id, from, to: destination };
        for (const listener of this.moveListeners) {
          try {
            listener(move);
          } catch (error) {
            console.error("Document move observer failed:", error);
          }
        }
        this.changed(entry);
        return true;
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (this.reserved.get(fromKey) === reservation) this.reserved.delete(fromKey);
        if (this.reserved.get(toKey) === reservation) this.reserved.delete(toKey);
        finishReservation();
        release();
      },
    };
  }

  /** Only after a successful rename: the old path is no longer this document's identity. */
  forgetClean(target: MarkdownPersistenceTarget): boolean {
    const key = projectFileOperationKey(target);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.documentIds.delete(key);
      return true;
    }
    const snapshot = entry.coordinator.getSnapshot();
    if (
      entry.pendingInput !== null ||
      entry.renameIntent !== null ||
      snapshot.currentMissing ||
      (snapshot.pending && !entry.coordinator.pendingOnlyForRename())
    )
      return false;
    if (!entry.coordinator.retireClean()) return false;
    if (entry.evictionTimer !== undefined) clearTimeout(entry.evictionTimer);
    this.stopWatching(entry);
    entry.unsubscribe();
    this.entries.delete(key);
    this.documentIds.delete(key);
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
    entry.checkpoint?.update(
      this.checkpointSnapshot(entry),
      entry.coordinator.pendingOnlyForRename(),
    );
    if (
      entry.renameIntent?.acknowledgement &&
      !entry.settlingRename &&
      entry.checkpoint &&
      projectFileOperationKey(entry.renameIntent.destination) ===
        projectFileOperationKey(entry.target) &&
      !snapshot.pending &&
      !snapshot.reading &&
      snapshot.error === null
    ) {
      const intent = entry.renameIntent;
      entry.settlingRename = true;
      const release = entry.coordinator.holdForRename();
      if (release === null) entry.settlingRename = false;
      else {
        void entry.checkpoint
          .clearRename(this.checkpointSnapshot(entry), intent.mutationId)
          .then(
            () => {
              if (entry.renameIntent === intent) entry.renameIntent = null;
            },
            (cause: unknown) => entry.coordinator.noteMutationFailure(cause, intent.mutationId),
          )
          .finally(() => {
            entry.settlingRename = false;
            release();
            this.changed(entry);
          });
      }
    }
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
      entry.renameIntent !== null ||
      snapshot.pending ||
      snapshot.currentMissing ||
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
          !value.currentMissing &&
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
    const snapshot = entry.coordinator.getSnapshot();
    if (
      entry.leases.size !== 0 ||
      entry.pendingInput !== null ||
      snapshot.pending ||
      snapshot.currentMissing ||
      !entry.coordinator.dispose()
    )
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
      checkpointStore: indexedDbMarkdownDrafts,
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
