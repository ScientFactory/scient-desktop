import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { ProjectFilePublicationAttention } from "@t3tools/contracts";
import type {
  DocumentPersistenceFailureKind,
  DocumentPublicationOutcome,
} from "@scientfactory/scient-document";
import { randomUUID } from "~/lib/utils";
import type {
  DocumentRenameIntent,
  MarkdownDraftCheckpoint,
  MarkdownDraftCheckpointStore,
} from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import { checkpointHoldsNothing } from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import type { MarkdownPersistenceTarget } from "~/scient/markdownEditor/persistence/markdownPersistenceTransport";
import { renameOutcomeAttention } from "~/scient/markdownEditor/persistence/renameOpenDocument";

type AtomCommandFailure<A, E> = Extract<AtomCommandResult<A, E>, { readonly _tag: "Failure" }>;

export type FileSaveRecoveryRead =
  | {
      readonly source: string;
      readonly revision: string;
      readonly missing?: false;
      readonly publicationAttention?: ProjectFilePublicationAttention | null;
    }
  | {
      readonly missing: true;
      readonly revision: null;
      readonly publicationAttention?: ProjectFilePublicationAttention | null;
    };

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly canPersist?: () => boolean;
  readonly initialRevision: string;
  readonly initialSource: string;
  readonly journal: { readonly key: string; readonly store: MarkdownDraftCheckpointStore };
  readonly onRestoredSource?: (contents: string) => void;
  readonly onRenameIntentChange?: (intent: DocumentRenameIntent | null) => void;
  readonly initialAttention?: ProjectFilePublicationAttention;
  readonly persist: (
    contents: string,
    expectedRevision: string | undefined,
    mutationId: string,
    createOnly?: boolean,
  ) => Promise<AtomCommandResult<A, E>>;
  readonly classifyFailure?: (error: unknown) => DocumentPersistenceFailureKind;
  readonly describeAttention?: (
    error: unknown,
    mutationId: string,
  ) => ProjectFilePublicationAttention | null;
  readonly publicationOutcome?: (error: unknown) => "unchanged" | "retained-attention" | null;
  readonly readForRecovery?: () => Promise<FileSaveRecoveryRead>;
  readonly resolveRecovery?: (review: {
    readonly recoveryId: string;
    readonly currentRevision: string | null;
  }) => Promise<{ readonly revision: string | null }>;
  readonly revisionFromResult: (value: A) => string;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string, value: A) => boolean | void;
  readonly onFailure?: (contents: string, result: AtomCommandFailure<A, E>) => void;
  readonly onAttentionChange?: (attention: ProjectFilePublicationAttention | null) => void;
  readonly onRecoveryFailure?: (error: unknown) => void;
  readonly onReviewRequiredChange?: (required: boolean) => void;
  readonly onCurrentMissingChange?: (missing: boolean) => void;
  readonly onResolutionApplied?: (action: FileSaveResolutionAction) => void;
}

export type FileSaveResolutionAction = "discard" | "retry";
type PendingResolution = { readonly _tag: FileSaveResolutionAction; readonly revision: string };
interface OwnedIntent {
  readonly contents: string;
  readonly editRevision: number;
  readonly expectedRevision: string | undefined;
  readonly createOnly?: boolean;
  readonly mutationId: string;
}

/** One owned write intent survives an ambiguous transport outcome, including newer edits. */
export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedEditRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private suspended = false;
  private disposed = false;
  private pendingResolution: PendingResolution | null = null;
  private activePersist: Promise<void> | null = null;
  private activeRecovery: Promise<boolean> | null = null;
  private activeRecoveryReview: {
    readonly recoveryId: string | null;
    readonly currentRevision: string | null;
  } | null = null;
  private intent: OwnedIntent | null = null;
  private failureKind: DocumentPersistenceFailureKind | null = null;
  private failureMutationId: string | null = null;
  private outcome: DocumentPublicationOutcome | null = null;
  private attention: ProjectFilePublicationAttention | null;
  private recoveryReceiptPending = false;
  private resolvedRecoveryId: string | null = null;
  private authorizedRecovery: {
    readonly recoveryId: string;
    readonly currentRevision: string | null;
  } | null = null;
  private debounceMs: number;
  private recoveryAcceptedHold = false;
  private unchangedRefusal = false;
  private confirmedFileRevision: string;
  private missingCurrent = false;
  private baselineSource: string;
  private observedCurrent: { readonly source: string; readonly revision: string };
  private journalToken: string | undefined;
  private journalLane: Promise<void> = Promise.resolve();
  private journalBlocked = false;
  private retired = false;
  private retainedRenameIntent: DocumentRenameIntent | null = null;
  private completedRenameReceipt: DocumentRenameIntent | null = null;
  private pendingReview: {
    readonly recoveryId: string | null;
    readonly currentRevision: string | null;
  } | null = null;
  private readonly initialization: Promise<void>;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {
    this.debounceMs = options.debounceMs;
    this.confirmedFileRevision = options.initialRevision;
    this.baselineSource = options.initialSource;
    this.latestContents = options.initialSource;
    this.observedCurrent = { source: options.initialSource, revision: options.initialRevision };
    this.attention = options.initialAttention ?? null;
    this.initialization = this.restoreJournal().catch((error: unknown) => this.blockJournal(error));
  }

  /** Renderer reconstruction claims the durable journal before any publication. */
  async ready(): Promise<boolean> {
    await this.initialization;
    await this.journalLane;
    return !this.journalBlocked && !this.retired;
  }

  getRenameIntent(): DocumentRenameIntent | null {
    return this.retainedRenameIntent ?? null;
  }
  getDraftSource(): string {
    return this.latestContents;
  }

  isRenameCurrent(intent: DocumentRenameIntent): boolean {
    return (
      !this.retired &&
      !this.disposed &&
      !this.journalBlocked &&
      this.options.canPersist?.() !== false &&
      this.retainedRenameIntent?.mutationId === intent.mutationId &&
      projectFileOperationKey(intent.from) === this.options.journal.key
    );
  }

  /** Freeze and commit the rename identity before its caller can dispatch it. */
  async beginRename(
    from: MarkdownPersistenceTarget,
    destination: MarkdownPersistenceTarget,
  ): Promise<DocumentRenameIntent | null> {
    if (
      !(await this.ready()) ||
      this.disposed ||
      this.suspended ||
      this.activeRecovery !== null ||
      this.options.canPersist?.() === false
    )
      return null;
    if (
      projectFileOperationKey(from) !== this.options.journal.key ||
      from.environmentId !== destination.environmentId ||
      from.cwd !== destination.cwd
    )
      return null;
    if (this.retainedRenameIntent != null) {
      const intent = this.retainedRenameIntent;
      if (
        projectFileOperationKey(intent.from) !== projectFileOperationKey(from) ||
        projectFileOperationKey(intent.destination) !== projectFileOperationKey(destination)
      )
        return null;
      try {
        await this.checkpoint();
      } catch {
        return null;
      }
      return !this.retired && !this.journalBlocked ? intent : null;
    }
    if (this.requiresRecovery || this.reviewRequired) return null;
    if (!(await this.flush()) || this.disposed || this.suspended) return null;
    if (this.retainedRenameIntent != null) return this.beginRename(from, destination);
    this.clearTimer();
    const intent: DocumentRenameIntent = {
      mutationId: randomUUID(),
      from,
      destination,
      expectedRevision: this.confirmedFileRevision,
      baselineSource: this.baselineSource,
      source: this.baselineSource,
      draftSource: this.latestContents,
    };
    this.retainedRenameIntent = intent;
    try {
      await this.checkpoint();
    } catch {
      return null;
    }
    this.options.onRenameIntentChange?.(intent);
    return !this.retired && !this.journalBlocked ? intent : null;
  }

  async rejectRename(intent: DocumentRenameIntent, error: unknown): Promise<boolean> {
    if (!(await this.ready()) || this.retainedRenameIntent?.mutationId !== intent.mutationId)
      return false;
    const outcome = this.options.publicationOutcome?.(error) ?? null;
    const definitive =
      outcome !== "retained-attention" &&
      (outcome === "unchanged" || renameOutcomeAttention(error) === null);
    // Once acknowledged, no later refusal can authorize abandoning the move.
    if (!definitive || this.retainedRenameIntent.acknowledgement !== undefined) {
      this.noteMutationFailure(error, intent.mutationId);
      try {
        await this.checkpoint();
      } catch {
        return false;
      }
      return !this.retired && !this.journalBlocked;
    }
    const clear = this.journalLane.then(async () => {
      if (
        this.retired ||
        this.journalBlocked ||
        this.retainedRenameIntent?.mutationId !== intent.mutationId
      )
        throw new Error("The rename recovery owner is unavailable.");
      // Do not release the in-memory identity until its durable CAS commits.
      // Recovery belonging to a different publication is not rename failure state.
      const relatedFailure =
        this.intent === null &&
        (this.failureKind === null || this.failureMutationId === intent.mutationId) &&
        (this.attention === null || this.attention.mutationId === intent.mutationId) &&
        !this.recoveryReceiptPending &&
        this.authorizedRecovery === null &&
        this.pendingReview === null &&
        !this.missingCurrent &&
        !this.recoveryAcceptedHold;
      const current = this.journalSnapshot();
      const next: MarkdownDraftCheckpoint = {
        ...current,
        renameIntent: null,
        ...(relatedFailure
          ? {
              publicationAttention: null,
              publicationOutcome: null,
              attentionMutationId: null,
              conflict: false,
              genericSaveState: {
                ...current.genericSaveState!,
                failureKind: null,
                unchangedRefusal: false,
              },
            }
          : {}),
      };
      if (
        !(await this.options.journal.store.replace(
          this.options.journal.key,
          this.journalToken,
          next,
        ))
      )
        throw new Error("Another editor owns this file's durable recovery journal.");
      this.journalToken = next.token;
      this.retainedRenameIntent = null;
      if (relatedFailure) {
        const hadAttention = this.attention !== null;
        this.attention = null;
        this.failureKind = null;
        this.failureMutationId = null;
        this.outcome = null;
        this.unchangedRefusal = false;
        if (hadAttention) this.options.onAttentionChange?.(null);
        this.options.onReviewRequiredChange?.(this.reviewRequired);
      }
      this.options.onRenameIntentChange?.(null);
    });
    this.journalLane = clear.catch((cause: unknown) => this.blockJournal(cause));
    try {
      await clear;
    } catch {
      return false;
    }
    return !this.retired && !this.journalBlocked;
  }

  async acknowledgeRename(
    intent: DocumentRenameIntent,
    acknowledgement: NonNullable<DocumentRenameIntent["acknowledgement"]>,
  ): Promise<boolean> {
    if (
      !(await this.ready()) ||
      this.retainedRenameIntent?.mutationId !== intent.mutationId ||
      acknowledgement.destinationRelativePath !==
        this.retainedRenameIntent.destination.relativePath ||
      acknowledgement.revision !== this.retainedRenameIntent.expectedRevision
    )
      return false;
    intent = this.retainedRenameIntent;
    this.retainedRenameIntent = { ...intent, acknowledgement };
    try {
      // The old path remains a durable replay receipt until the new path owns
      // both the acknowledged baseline and all input typed during the rename.
      await this.checkpoint();
      this.options.onRenameIntentChange?.(this.retainedRenameIntent);
      const destinationKey = projectFileOperationKey(intent.destination);
      const destinationToken = `rename:${intent.mutationId}`;
      const existing = await this.options.journal.store.read(destinationKey);
      if (existing !== undefined && existing.token !== destinationToken) {
        const receipt = existing.renameIntent;
        if (
          receipt?.mutationId !== intent.mutationId ||
          projectFileOperationKey(receipt.from) !== this.options.journal.key ||
          projectFileOperationKey(receipt.destination) !== destinationKey ||
          receipt.source !== intent.source ||
          receipt.expectedRevision !== intent.expectedRevision ||
          receipt.acknowledgement?.destinationRelativePath !==
            acknowledgement.destinationRelativePath ||
          receipt.acknowledgement.revision !== acknowledgement.revision
        )
          return false;
        // A destination owner has already claimed this exact completed move.
        // Its current baseline and newer input are authoritative; never replace it.
        this.retire();
        return true;
      }
      let expectedToken = existing?.token;
      while (!this.retired && !this.journalBlocked) {
        await this.checkpoint();
        const editRevision = this.latestRevision;
        const current = this.journalSnapshot();
        const next: MarkdownDraftCheckpoint = {
          ...current,
          token: destinationToken,
          baselineSource: intent.source,
          baselineRevision: acknowledgement.revision,
          publicationIntent: null,
          publicationSource: null,
          publicationAttention: null,
          publicationOutcome: null,
          attentionMutationId: null,
          conflict: false,
          currentMissing: false,
          renameIntent: this.retainedRenameIntent,
          genericSaveState: {
            ...current.genericSaveState!,
            failureKind: null,
            acceptedMissingHold: false,
            unchangedRefusal: false,
            recoveryReceiptPending: false,
            resolvedRecoveryId: null,
            authorizedRecovery: null,
            pendingReview: null,
          },
        };
        if (!(await this.options.journal.store.replace(destinationKey, expectedToken, next)))
          return false;
        expectedToken = destinationToken;
        if (this.retired || this.journalBlocked) return false;
        if (editRevision !== this.latestRevision) continue;
        // Retire synchronously with the final destination commit so a stale
        // source callback cannot queue input behind the old-path deletion.
        this.retire();
        await this.journalLane;
        // Namespace ACK and destination admission are authoritative. The old
        // path is only a retirement receipt now; failed cleanup cannot undo adoption.
        try {
          if (
            await this.options.journal.store.replace(
              this.options.journal.key,
              this.journalToken,
              undefined,
            )
          )
            this.journalToken = undefined;
        } catch {
          // Keep the exact source ACK for later settlement, including storage failures.
        }
        return true;
      }
      return false;
    } catch (error) {
      this.blockJournal(error);
      return false;
    }
  }

  /** Unlike final-lease flush, owner retirement admits no more writes or callbacks. */
  retire(): void {
    this.retired = true;
    this.disposed = true;
    this.clearTimer();
  }

  /** Final clean-lease teardown releases storage only after retiring its CAS owner. */
  async retireCleanJournal(): Promise<void> {
    await this.ready();
    const removable =
      !this.journalBlocked &&
      !this.hasPendingChanges &&
      this.latestContents === this.baselineSource &&
      this.intent === null &&
      this.attention === null &&
      this.failureKind === null &&
      !this.recoveryAcceptedHold &&
      !this.recoveryReceiptPending &&
      this.authorizedRecovery === null &&
      this.pendingReview === null &&
      this.retainedRenameIntent == null &&
      this.completedRenameReceipt === null;
    this.retire();
    await this.journalLane;
    if (!removable || this.journalToken === undefined) return;
    try {
      if (
        await this.options.journal.store.replace(
          this.options.journal.key,
          this.journalToken,
          undefined,
        )
      )
        this.journalToken = undefined;
    } catch (error) {
      console.error("The clean file journal could not be removed; its copy is preserved.", error);
    }
  }

  private blockJournal(error: unknown): void {
    this.journalBlocked = true;
    this.clearTimer();
    if (!this.retired) this.options.onRecoveryFailure?.(error);
  }

  private journalSnapshot(): MarkdownDraftCheckpoint {
    return {
      token: randomUUID(),
      baselineSource: this.baselineSource,
      baselineRevision: this.confirmedFileRevision,
      draftSource: this.latestContents,
      publicationSource: this.intent?.contents ?? null,
      publicationIntent:
        this.intent === null
          ? null
          : {
              mutationId: this.intent.mutationId,
              source: this.intent.contents,
              editVersion: this.intent.editRevision,
              expectedRevision: this.intent.expectedRevision ?? this.confirmedFileRevision,
              ...(this.intent.createOnly ? { createOnly: true } : {}),
            },
      publicationAttention: this.attention,
      publicationOutcome: this.outcome ?? (this.attention !== null ? "retained-attention" : null),
      attentionMutationId: this.failureMutationId,
      currentMissing: this.missingCurrent,
      conflict: this.failureKind === "conflict",
      renameIntent: this.retainedRenameIntent ?? this.completedRenameReceipt,
      genericSaveState: {
        editRevision: this.latestRevision,
        confirmedEditRevision: this.confirmedEditRevision,
        failureKind: this.failureKind,
        acceptedMissingHold: this.recoveryAcceptedHold,
        unchangedRefusal: this.unchangedRefusal,
        recoveryReceiptPending: this.recoveryReceiptPending,
        resolvedRecoveryId: this.resolvedRecoveryId,
        authorizedRecovery: this.authorizedRecovery,
        pendingReview: this.pendingReview,
      },
    };
  }

  private async replaceJournal(): Promise<void> {
    if (this.retired || this.journalBlocked)
      throw new Error("This file's durable recovery owner is unavailable.");
    const next = this.journalSnapshot();
    if (
      !(await this.options.journal.store.replace(this.options.journal.key, this.journalToken, next))
    )
      throw new Error("Another editor owns this file's durable recovery journal.");
    this.journalToken = next.token;
    if (this.retired)
      throw new Error("This file's durable recovery owner retired during admission.");
  }

  private checkpoint(): Promise<void> {
    const write = this.journalLane.then(async () => {
      await this.initialization;
      await this.replaceJournal();
    });
    this.journalLane = write.catch((error: unknown) => this.blockJournal(error));
    return write;
  }

  private copyDraft(): void {
    void this.checkpoint().catch(() => undefined);
  }

  private async restoreJournal(): Promise<void> {
    let copy = await this.options.journal.store.read(this.options.journal.key);
    if (this.retired) throw new Error("This file's durable recovery owner has retired.");
    this.journalToken = copy?.token;
    this.retainedRenameIntent = copy?.renameIntent ?? null;
    if (
      this.retainedRenameIntent?.acknowledgement !== undefined &&
      projectFileOperationKey(this.retainedRenameIntent.destination) === this.options.journal.key &&
      projectFileOperationKey(this.retainedRenameIntent.from) !== this.options.journal.key
    ) {
      const sourceCopy = await this.options.journal.store.read(
        projectFileOperationKey(this.retainedRenameIntent.from),
      );
      if (sourceCopy !== undefined) this.completedRenameReceipt = this.retainedRenameIntent;
      this.retainedRenameIntent = null;
      // Completed namespace provenance is not an unsaved draft. A clean
      // destination must still start from its authoritative current read.
      if (copy !== undefined) copy = { ...copy, renameIntent: null };
    }
    if (this.confirmedFileRevision === "" && (copy === undefined || checkpointHoldsNothing(copy)))
      throw new Error(
        "An authoritative source read is required before this file can be published.",
      );
    if (copy !== undefined && !checkpointHoldsNothing(copy)) {
      const localContents = this.latestContents;
      const localEdits = this.latestRevision;
      this.baselineSource = copy.baselineSource;
      this.confirmedFileRevision = copy.baselineRevision;
      const state = copy.genericSaveState;
      this.latestContents = localEdits > 0 ? localContents : copy.draftSource;
      const recoveredEditRevision =
        state?.editRevision ??
        (copy.publicationIntent?.editVersion ?? 1) +
          (copy.publicationIntent != null && copy.draftSource !== copy.publicationIntent.source
            ? 1
            : 0);
      this.latestRevision = recoveredEditRevision + localEdits;
      this.confirmedEditRevision = state?.confirmedEditRevision ?? 0;
      this.intent =
        copy.publicationIntent == null
          ? null
          : {
              contents: copy.publicationIntent.source,
              editRevision: copy.publicationIntent.editVersion,
              expectedRevision: copy.publicationIntent.createOnly
                ? undefined
                : copy.publicationIntent.expectedRevision,
              ...(copy.publicationIntent.createOnly ? { createOnly: true } : {}),
              mutationId: copy.publicationIntent.mutationId,
            };
      this.attention = copy.publicationAttention ?? this.attention;
      this.missingCurrent = copy.currentMissing === true;
      this.outcome = copy.publicationOutcome ?? null;
      this.failureKind =
        state?.failureKind ?? (copy.conflict ? "conflict" : (copy.attention ?? null));
      this.failureMutationId = copy.attentionMutationId ?? null;
      this.recoveryAcceptedHold = state?.acceptedMissingHold ?? this.missingCurrent;
      this.unchangedRefusal = state?.unchangedRefusal ?? copy.publicationOutcome === "unchanged";
      this.recoveryReceiptPending = state?.recoveryReceiptPending ?? false;
      this.resolvedRecoveryId = state?.resolvedRecoveryId ?? null;
      if (this.attention?.recoveryId === this.resolvedRecoveryId && this.recoveryReceiptPending)
        this.attention = null;
      this.authorizedRecovery = state?.authorizedRecovery ?? null;
      this.pendingReview = state?.pendingReview ?? null;
      // A journaled review is authorization to resume only that exact review,
      // never to publish the working source automatically.
      if (state?.pendingReview != null) this.recoveryAcceptedHold = true;
    }
    // Rotate the CAS token even for a clean journal: an old renderer is fenced.
    await this.replaceJournal();
    if (copy !== undefined && !checkpointHoldsNothing(copy))
      this.options.onRestoredSource?.(this.latestContents);
    if (this.hasPendingChanges) this.options.onPendingChange(true);
    if (this.attention !== null || this.recoveryReceiptPending)
      this.options.onAttentionChange?.(this.attention);
    this.options.onRenameIntentChange?.(this.retainedRenameIntent ?? null);
    this.options.onReviewRequiredChange?.(this.reviewRequired);
    this.options.onCurrentMissingChange?.(this.missingCurrent);
    if (
      this.hasPendingChanges &&
      !this.requiresRecovery &&
      !this.recoveryAcceptedHold &&
      !this.disposed
    )
      this.schedule(this.debounceMs);
  }

  get publicationAttention(): ProjectFilePublicationAttention | null {
    return this.attention;
  }
  get requiresRecovery(): boolean {
    return (
      this.attention !== null ||
      (this.failureKind !== null &&
        this.failureKind !== "transient" &&
        this.failureKind !== "conflict")
    );
  }
  get hasPendingChanges(): boolean {
    return this.missingCurrent || this.latestRevision > this.confirmedEditRevision;
  }
  get currentMissing(): boolean {
    return this.missingCurrent;
  }
  get hasRecoveryReceipt(): boolean {
    return this.recoveryReceiptPending;
  }
  get reviewRequired(): boolean {
    return this.unchangedRefusal && this.attention === null;
  }

  change(contents: string, debounceMs = this.debounceMs): void {
    if (this.disposed) return;
    this.debounceMs = debounceMs;
    this.latestContents = contents;
    if (!this.missingCurrent && !this.requiresRecovery && this.activeRecovery === null)
      this.recoveryAcceptedHold = false;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.copyDraft();
    if (this.failureKind === null && !this.requiresRecovery) this.schedule(this.debounceMs);
  }

  /** Only an explicit user action may recreate an accepted missing current file. */
  recreateMissingCurrent(contents?: string): boolean {
    if (
      this.journalBlocked ||
      this.disposed ||
      this.suspended ||
      !this.missingCurrent ||
      !this.recoveryAcceptedHold ||
      (this.latestRevision === 0 && contents === undefined) ||
      this.intent !== null ||
      this.failureKind !== null ||
      this.requiresRecovery ||
      this.activeRecovery !== null ||
      this.saving ||
      this.options.canPersist?.() === false
    )
      return false;
    if (this.latestRevision === 0 && contents !== undefined) {
      this.latestContents = contents;
      this.latestRevision += 1;
      this.options.onPendingChange(true);
    }
    this.recoveryAcceptedHold = false;
    this.intent = null;
    this.schedule(0);
    this.copyDraft();
    return true;
  }

  /** A read can add retained attention, but only guarded backend recovery can remove it. */
  observePublicationAttention(attention: ProjectFilePublicationAttention | null | undefined): void {
    if (attention == null) {
      this.recoveryReceiptPending = false;
      this.copyDraft();
      return;
    }
    if (attention.recoveryId === this.resolvedRecoveryId) return;
    this.attention = attention;
    this.clearTimer();
    this.options.onAttentionChange?.(attention);
    this.copyDraft();
  }

  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) this.clearTimer();
    else if (this.hasPendingChanges && !this.saving && this.failureKind === null) {
      this.schedule(Math.max(0, this.debounceMs - (Date.now() - this.lastChangeAt)));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    void this.flush();
  }

  async flush(): Promise<boolean> {
    this.clearTimer();
    if (this.activePersist !== null) await this.activePersist;
    if (!(await this.ready())) return false;
    if (this.retainedRenameIntent != null) return false;
    if (this.requiresRecovery || this.activeRecovery !== null) return false;
    if (!this.hasPendingChanges) return true;
    if (this.recoveryAcceptedHold) return false;
    if (this.failureKind !== null && this.failureKind !== "transient") return false;
    await this.startPersist(true);
    return (
      !this.journalBlocked && !this.retired && !this.hasPendingChanges && !this.requiresRecovery
    );
  }

  syncConfirmedFileRevision(revision: string, source: string): void {
    if (this.retired) return;
    this.observedCurrent = { source, revision };
    if (
      this.retainedRenameIntent == null &&
      !this.saving &&
      !this.hasPendingChanges &&
      !this.requiresRecovery
    ) {
      this.confirmedFileRevision = revision;
      this.baselineSource = this.latestContents = source;
      this.copyDraft();
    }
  }

  discardPending(revision: string): void {
    this.resolvePending({ _tag: "discard", revision });
  }
  retryPending(revision: string): void {
    this.resolvePending({ _tag: "retry", revision });
  }

  /** A file-scoped mutation such as rename shares the editor's retained recovery lane. */
  noteMutationFailure(error: unknown, mutationId: string): void {
    if (this.retired) return;
    this.clearTimer();
    this.failureMutationId = mutationId;
    this.failureKind = this.options.classifyFailure?.(error) ?? "terminal";
    this.outcome = this.options.publicationOutcome?.(error) ?? null;
    this.unchangedRefusal = this.outcome === "unchanged";
    this.options.onRecoveryFailure?.(error);
    const attention = this.options.describeAttention?.(error, mutationId);
    if (attention) this.observePublicationAttention(attention);
    this.options.onReviewRequiredChange?.(this.reviewRequired);
    this.copyDraft();
  }

  /** Keep the current draft; acceptance authorizes no write until a subsequent user action. */
  resolveRetainedAttention(recoveryId: string, currentRevision: string | null): Promise<boolean> {
    if (this.activeRecovery !== null) {
      return this.activeRecoveryReview?.recoveryId === recoveryId &&
        this.activeRecoveryReview.currentRevision === currentRevision
        ? this.activeRecovery
        : Promise.resolve(false);
    }
    if (
      this.disposed ||
      this.attention?.recoveryId !== recoveryId ||
      this.saving ||
      !this.options.readForRecovery ||
      !this.options.resolveRecovery ||
      this.options.canPersist?.() === false
    )
      return Promise.resolve(false);
    this.clearTimer();
    this.activeRecoveryReview = { recoveryId, currentRevision };
    this.pendingReview = this.activeRecoveryReview;
    this.copyDraft();
    const operation = this.acceptCurrent(recoveryId, currentRevision);
    this.activeRecovery = operation;
    void operation.finally(() => {
      if (this.activeRecovery === operation) {
        this.activeRecovery = null;
        this.activeRecoveryReview = null;
      }
    });
    return operation;
  }
  /** Review a proven pre-publication refusal without claiming a durable mutation acknowledgement. */
  reviewUnchangedRefusal(currentRevision: string | null): Promise<boolean> {
    if (this.activeRecovery !== null) {
      return this.activeRecoveryReview?.recoveryId === null &&
        this.activeRecoveryReview.currentRevision === currentRevision
        ? this.activeRecovery
        : Promise.resolve(false);
    }
    if (
      !this.reviewRequired ||
      this.saving ||
      this.disposed ||
      !this.options.readForRecovery ||
      this.options.canPersist?.() === false
    )
      return Promise.resolve(false);
    this.clearTimer();
    this.activeRecoveryReview = { recoveryId: null, currentRevision };
    this.pendingReview = this.activeRecoveryReview;
    this.copyDraft();
    const operation = (async () => {
      try {
        if (!(await this.ready())) return false;
        await this.checkpoint();
        const read = await this.options.readForRecovery!();
        if (read.publicationAttention != null) {
          this.observePublicationAttention(read.publicationAttention);
          this.options.onReviewRequiredChange?.(false);
          return false;
        }
        if (!this.matchesReview(read, currentRevision)) return false;
        if (currentRevision === null) {
          const after = await this.options.readForRecovery!();
          if (!this.matchesReview(after, null) || after.publicationAttention != null) {
            this.observePublicationAttention(after.publicationAttention);
            return false;
          }
          this.setCurrentMissing(true);
        } else {
          this.confirmedFileRevision = currentRevision;
          if (read.missing !== true) this.baselineSource = read.source;
          this.setCurrentMissing(false);
        }
        this.intent = null;
        this.failureKind = null;
        this.outcome = null;
        this.unchangedRefusal = false;
        this.recoveryAcceptedHold = true;
        this.activeRecoveryReview = null;
        this.pendingReview = null;
        this.retainedRenameIntent = null;
        this.options.onRenameIntentChange?.(null);
        await this.checkpoint();
        this.options.onReviewRequiredChange?.(false);
        this.options.onAttentionChange?.(null);
        return true;
      } catch (error) {
        this.options.onRecoveryFailure?.(error);
        return false;
      }
    })();
    this.activeRecovery = operation;
    void operation.finally(() => {
      if (this.activeRecovery === operation) {
        this.activeRecovery = null;
        this.activeRecoveryReview = null;
      }
    });
    return operation;
  }

  private async acceptCurrent(
    recoveryId: string,
    currentRevision: string | null,
  ): Promise<boolean> {
    try {
      if (!(await this.ready())) return false;
      await this.checkpoint();
      const authorized =
        this.authorizedRecovery?.recoveryId === recoveryId &&
        this.authorizedRecovery.currentRevision === currentRevision;
      if (!authorized || currentRevision === null) {
        const before = await this.options.readForRecovery!();
        if (
          !this.matchesReview(before, currentRevision) ||
          (before.publicationAttention != null &&
            before.publicationAttention.recoveryId !== recoveryId)
        ) {
          this.observePublicationAttention(before.publicationAttention);
          return false;
        }
      }
      if (!authorized || currentRevision === null) {
        // Persist the exact reviewed authorization before calling the backend.
        await this.checkpoint();
        const resolved = await this.options.resolveRecovery!({ recoveryId, currentRevision });
        if (resolved.revision !== currentRevision) return false;
        this.authorizedRecovery = { recoveryId, currentRevision };
        await this.checkpoint();
      }
      const after = await this.options.readForRecovery!();
      if (after.publicationAttention != null) {
        this.observePublicationAttention(after.publicationAttention);
        return false;
      }
      if (!this.matchesReview(after, currentRevision)) return false;
      if (currentRevision === null) {
        this.setCurrentMissing(true);
      } else {
        this.confirmedFileRevision = currentRevision;
        if (after.missing !== true) this.baselineSource = after.source;
        this.setCurrentMissing(false);
      }
      this.intent = null;
      this.failureKind = null;
      this.outcome = null;
      this.unchangedRefusal = false;
      this.options.onReviewRequiredChange?.(false);
      this.attention = null;
      this.resolvedRecoveryId = recoveryId;
      this.recoveryReceiptPending = true;
      this.recoveryAcceptedHold = true;
      this.authorizedRecovery = null;
      this.activeRecoveryReview = null;
      this.pendingReview = null;
      this.retainedRenameIntent = null;
      this.options.onRenameIntentChange?.(null);
      await this.checkpoint();
      this.options.onAttentionChange?.(null);
      return true;
    } catch (error) {
      this.options.onRecoveryFailure?.(error);
      return false;
    }
  }

  private matchesReview(read: FileSaveRecoveryRead, revision: string | null): boolean {
    return revision === null
      ? read.missing === true && read.revision === null
      : read.missing !== true && read.revision === revision;
  }

  private setCurrentMissing(missing: boolean): void {
    if (this.missingCurrent === missing) return;
    this.missingCurrent = missing;
    this.options.onCurrentMissingChange?.(missing);
    if (missing) this.options.onPendingChange(true);
  }

  private resolvePending(resolution: PendingResolution): void {
    if (this.requiresRecovery || this.activeRecovery !== null || this.missingCurrent) return;
    this.clearTimer();
    if (this.saving) this.pendingResolution = resolution;
    else this.applyResolution(resolution);
  }

  private applyResolution(resolution: PendingResolution): void {
    if (this.requiresRecovery) return;
    // A transient result does not authorize abandoning or rebasing its exact owned intent.
    if (this.intent !== null && this.failureKind === "transient") {
      if (resolution._tag === "retry") this.schedule(0);
      return;
    }
    if (this.observedCurrent.revision === resolution.revision)
      this.baselineSource = this.observedCurrent.source;
    else if (this.confirmedFileRevision !== resolution.revision) return;
    this.confirmedFileRevision = resolution.revision;
    this.intent = null;
    this.failureKind = null;
    this.outcome = null;
    this.recoveryAcceptedHold = false;
    if (resolution._tag === "discard") {
      this.latestContents = this.baselineSource;
      this.confirmedEditRevision = this.latestRevision;
      this.options.onPendingChange(false);
    } else this.schedule(0);
    this.options.onResolutionApplied?.(resolution._tag);
    this.copyDraft();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    if (
      this.retired ||
      this.journalBlocked ||
      this.requiresRecovery ||
      this.recoveryAcceptedHold ||
      this.activeRecovery !== null ||
      (this.suspended && !this.disposed)
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.startPersist(false);
    }, delay);
  }
  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
  private startPersist(force: boolean): Promise<void> {
    if (this.activePersist !== null) return this.activePersist;
    if (
      this.requiresRecovery ||
      this.recoveryAcceptedHold ||
      this.activeRecovery !== null ||
      !this.hasPendingChanges ||
      (this.suspended && !this.disposed && !force)
    )
      return Promise.resolve();
    const operation = this.persistLatest(force);
    this.activePersist = operation;
    void operation.finally(() => {
      if (this.activePersist === operation) this.activePersist = null;
    });
    return operation;
  }

  private async persistLatest(force: boolean): Promise<void> {
    if (!(await this.ready())) return;
    if (
      this.retainedRenameIntent != null ||
      this.saving ||
      this.requiresRecovery ||
      !this.hasPendingChanges ||
      (this.suspended && !this.disposed && !force) ||
      this.options.canPersist?.() === false
    )
      return;
    this.saving = true;
    const intent = this.intent ?? {
      contents: this.latestContents,
      editRevision: this.latestRevision,
      expectedRevision: this.missingCurrent ? undefined : this.confirmedFileRevision,
      ...(this.missingCurrent ? { createOnly: true } : {}),
      mutationId: randomUUID(),
    };
    this.intent = intent;
    let confirmed = false;
    try {
      await this.checkpoint();
      if (this.retired || this.journalBlocked || this.options.canPersist?.() === false) return;
      const result = await (intent.createOnly
        ? this.options.persist(intent.contents, undefined, intent.mutationId, true)
        : this.options.persist(intent.contents, intent.expectedRevision, intent.mutationId));
      if (result._tag === "Success") {
        if (this.retired) return;
        this.confirmedFileRevision = this.options.revisionFromResult(result.value);
        this.baselineSource = intent.contents;
        this.confirmedEditRevision = intent.editRevision;
        this.setCurrentMissing(false);
        this.intent = null;
        this.failureKind = null;
        this.outcome = null;
        await this.checkpoint();
        confirmed = this.options.onConfirmed(intent.contents, result.value) !== false;
      } else {
        this.failureKind = this.options.classifyFailure?.(result.cause) ?? "terminal";
        this.outcome = this.options.publicationOutcome?.(result.cause) ?? null;
        this.unchangedRefusal = this.outcome === "unchanged";
        const attention = this.options.describeAttention?.(result.cause, intent.mutationId);
        if (attention) this.observePublicationAttention(attention);
        this.options.onReviewRequiredChange?.(this.reviewRequired);
        await this.checkpoint();
        this.options.onFailure?.(intent.contents, result);
      }
    } catch (error) {
      if (this.retired || this.journalBlocked) return;
      this.failureKind = this.options.classifyFailure?.(error) ?? "terminal";
      this.outcome = this.options.publicationOutcome?.(error) ?? null;
      this.unchangedRefusal = this.outcome === "unchanged";
      const attention = this.options.describeAttention?.(error, intent.mutationId);
      if (attention) this.observePublicationAttention(attention);
      this.options.onReviewRequiredChange?.(this.reviewRequired);
      try {
        await this.checkpoint();
      } catch {
        return;
      }
      this.options.onRecoveryFailure?.(error);
    } finally {
      this.saving = false;
    }
    if (this.requiresRecovery && this.attention === null && !this.unchangedRefusal) {
      void this.options.readForRecovery?.().then(
        (read) => this.observePublicationAttention(read.publicationAttention),
        () => undefined,
      );
    }
    if (this.pendingResolution !== null) {
      const resolution = this.pendingResolution;
      this.pendingResolution = null;
      this.applyResolution(resolution);
      return;
    }
    if (this.failureKind !== null || this.requiresRecovery) {
      this.clearTimer();
      return;
    }
    if (!this.hasPendingChanges) {
      if (confirmed) this.options.onPendingChange(false);
      return;
    }
    if (this.disposed || force) await this.persistLatest(true);
    else this.schedule(Math.max(0, this.debounceMs - (Date.now() - this.lastChangeAt)));
  }
}
