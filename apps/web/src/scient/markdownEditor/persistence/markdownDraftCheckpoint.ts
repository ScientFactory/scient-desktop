import { randomUUID } from "~/lib/utils";
import type {
  DocumentAuthorizedCurrentReview,
  DocumentFilePublicationAttention,
  DocumentPersistenceAttention,
  DocumentPersistenceFailureKind,
  DocumentPublicationOutcome,
  DocumentSaveIntent,
} from "@scientfactory/scient-document";
import type { MarkdownPersistenceSnapshot } from "@scientfactory/scient-markdown";
import { EnvironmentId, ProjectFilePublicationAttention } from "@t3tools/contracts";
import type { MarkdownPersistenceTarget } from "./markdownPersistenceTransport";
import * as Schema from "effect/Schema";

export interface DocumentRenameIntent {
  readonly mutationId: string;
  readonly from: MarkdownPersistenceTarget;
  readonly destination: MarkdownPersistenceTarget;
  readonly expectedRevision: string;
  readonly removeEmptyFolders?: true;
  readonly baselineSource: string;
  readonly source: string;
  readonly draftSource: string;
  readonly acknowledgement?: {
    readonly destinationRelativePath: string;
    readonly revision: string;
  };
}

/** Binary/oversized files can rename without inventing a textual baseline. */
export interface MetadataFileRenameIntent {
  readonly mutationId: string;
  readonly from: MarkdownPersistenceTarget;
  readonly destination: MarkdownPersistenceTarget;
  readonly expectedRevision?: string;
  readonly removeEmptyFolders?: true;
  readonly acknowledgement?: {
    readonly destinationRelativePath: string;
    readonly revision: string;
  };
}

export interface MetadataFileRenameCheckpoint {
  readonly kind: "file-rename";
  readonly token: string;
  readonly intent: MetadataFileRenameIntent;
}

export interface GenericFileSaveCheckpointState {
  readonly editRevision: number;
  readonly confirmedEditRevision: number;
  readonly failureKind: DocumentPersistenceFailureKind | null;
  readonly acceptedMissingHold: boolean;
  readonly unchangedRefusal: boolean;
  readonly recoveryReceiptPending: boolean;
  readonly resolvedRecoveryId: string | null;
  readonly authorizedRecovery: {
    readonly recoveryId: string;
    readonly currentRevision: string | null;
  } | null;
  readonly pendingReview: {
    readonly recoveryId: string | null;
    readonly currentRevision: string | null;
  } | null;
}

const RenameTarget = Schema.Struct({
  environmentId: EnvironmentId,
  cwd: Schema.String,
  relativePath: Schema.String,
});
const RenameIntent = Schema.Struct({
  mutationId: Schema.String,
  from: RenameTarget,
  destination: RenameTarget,
  expectedRevision: Schema.String,
  removeEmptyFolders: Schema.optionalKey(Schema.Literal(true)),
  baselineSource: Schema.String,
  source: Schema.String,
  draftSource: Schema.String,
  acknowledgement: Schema.optionalKey(
    Schema.Struct({
      destinationRelativePath: Schema.String,
      revision: Schema.String,
    }),
  ),
});

const MetadataRenameCheckpoint = Schema.Struct({
  kind: Schema.Literal("file-rename"),
  token: Schema.String,
  intent: Schema.Struct({
    mutationId: Schema.String,
    from: RenameTarget,
    destination: RenameTarget,
    expectedRevision: Schema.optionalKey(Schema.String),
    removeEmptyFolders: Schema.optionalKey(Schema.Literal(true)),
    acknowledgement: Schema.optionalKey(
      Schema.Struct({
        destinationRelativePath: Schema.String,
        revision: Schema.String,
      }),
    ),
  }),
});

function decodeMetadataRename(value: unknown): MetadataFileRenameCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (!Schema.is(MetadataRenameCheckpoint)(value))
    throw new Error(
      "The file rename checkpoint could not be read; its owner and copy are preserved.",
    );
  return value;
}
const GenericSaveState = Schema.Struct({
  editRevision: Schema.Number,
  confirmedEditRevision: Schema.Number,
  failureKind: Schema.NullOr(
    Schema.Literals([
      "conflict",
      "transient",
      "operation",
      "disconnected",
      "terminal",
      "recovery_required",
      "target_changed",
      "mutation_unavailable",
      "mutation_intent_conflict",
      "outcome_unknown",
    ]),
  ),
  acceptedMissingHold: Schema.Boolean,
  unchangedRefusal: Schema.Boolean,
  recoveryReceiptPending: Schema.Boolean,
  resolvedRecoveryId: Schema.NullOr(Schema.String),
  authorizedRecovery: Schema.NullOr(
    Schema.Struct({
      recoveryId: Schema.String,
      currentRevision: Schema.NullOr(Schema.String),
    }),
  ),
  pendingReview: Schema.NullOr(
    Schema.Struct({
      recoveryId: Schema.NullOr(Schema.String),
      currentRevision: Schema.NullOr(Schema.String),
    }),
  ),
});

function genericStateHoldsRecovery(state: GenericFileSaveCheckpointState | undefined): boolean {
  return (
    state !== undefined &&
    (state.failureKind !== null ||
      state.acceptedMissingHold ||
      state.unchangedRefusal ||
      state.recoveryReceiptPending ||
      state.authorizedRecovery !== null ||
      state.pendingReview !== null)
  );
}

export interface MarkdownDraftCheckpoint {
  readonly token: string;
  readonly baselineSource: string;
  readonly baselineRevision: string;
  readonly draftSource: string;
  readonly publicationSource?: string | null;
  readonly attention?: DocumentPersistenceAttention | null;
  readonly publicationIntent?: DocumentSaveIntent | null;
  readonly renameIntent?: DocumentRenameIntent | null;
  readonly genericSaveState?: GenericFileSaveCheckpointState;
  readonly publicationAttention?: DocumentFilePublicationAttention | null;
  readonly publicationOutcome?: DocumentPublicationOutcome | null;
  readonly attentionMutationId?: string | null;
  readonly currentMissing?: boolean;
  readonly authorizedCurrentReview?: DocumentAuthorizedCurrentReview | null;
  /**
   * Whether a conflict was open when this copy was taken. Absent in copies
   * written before it was recorded; only an explicit `false` counts as evidence.
   */
  readonly conflict?: boolean;
}

/**
 * A copy that provably holds nothing to recover: taken with no conflict open,
 * no unsaved source and no publication other than its baseline. Copies that
 * predate the conflict field never qualify.
 */
export function checkpointHoldsNothing(checkpoint: MarkdownDraftCheckpoint): boolean {
  return (
    checkpoint.conflict === false &&
    checkpoint.attention == null &&
    checkpoint.publicationAttention == null &&
    checkpoint.publicationIntent == null &&
    checkpoint.renameIntent == null &&
    checkpoint.authorizedCurrentReview == null &&
    !genericStateHoldsRecovery(checkpoint.genericSaveState) &&
    checkpoint.currentMissing !== true &&
    checkpoint.draftSource === checkpoint.baselineSource &&
    (checkpoint.publicationSource == null ||
      checkpoint.publicationSource === checkpoint.baselineSource)
  );
}

export interface MarkdownDraftCheckpointStore {
  read(key: string): Promise<MarkdownDraftCheckpoint | undefined>;
  /** Compare and replace in one storage transaction; never erase another owner's draft. */
  replace(
    key: string,
    expectedToken: string | undefined,
    next: MarkdownDraftCheckpoint | undefined,
  ): Promise<boolean>;
  /** Same physical journal; textual and metadata-only owners cannot overwrite one another. */
  readMetadataRename?(key: string): Promise<MetadataFileRenameCheckpoint | undefined>;
  replaceMetadataRename?(
    key: string,
    expectedToken: string | undefined,
    next: MetadataFileRenameCheckpoint | undefined,
  ): Promise<boolean>;
}

const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_CHECKPOINTS = 32;
let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    let failed = false;
    const request = indexedDB.open("scient-markdown-drafts", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("drafts"));
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
    request.addEventListener("blocked", () => {
      failed = true;
      database = undefined;
      reject(new Error("Markdown recovery storage is blocked."));
    });
    request.addEventListener("success", () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.addEventListener("versionchange", () => {
        db.close();
        database = undefined;
      });
      resolve(db);
    });
  }));
}

function decode(value: unknown): MarkdownDraftCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("baselineSource" in value) ||
    typeof value.baselineSource !== "string" ||
    !("baselineRevision" in value) ||
    typeof value.baselineRevision !== "string" ||
    !("draftSource" in value) ||
    typeof value.draftSource !== "string"
  ) {
    throw new Error("Markdown recovery data could not be read; it has been preserved.");
  }
  const intent = "publicationIntent" in value ? value.publicationIntent : null;
  if (
    intent != null &&
    (typeof intent !== "object" ||
      !("mutationId" in intent) ||
      typeof intent.mutationId !== "string" ||
      !("source" in intent) ||
      typeof intent.source !== "string" ||
      !("expectedRevision" in intent) ||
      typeof intent.expectedRevision !== "string" ||
      !("editVersion" in intent) ||
      typeof intent.editVersion !== "number" ||
      !Number.isSafeInteger(intent.editVersion) ||
      intent.editVersion < 0 ||
      ("createOnly" in intent && intent.createOnly !== undefined && intent.createOnly !== true))
  )
    throw new Error("The pending file mutation identity could not be read; its copy is preserved.");
  const publicationAttention =
    "publicationAttention" in value ? (value.publicationAttention ?? null) : null;
  if (
    publicationAttention != null &&
    !Schema.is(ProjectFilePublicationAttention)(publicationAttention)
  )
    throw new Error(
      "The retained file recovery reference could not be read; its copy is preserved.",
    );
  if ("currentMissing" in value && typeof value.currentMissing !== "boolean")
    throw new Error("The missing-current recovery state could not be read; its copy is preserved.");
  const authorizedCurrentReview =
    "authorizedCurrentReview" in value ? (value.authorizedCurrentReview ?? null) : null;
  if (
    authorizedCurrentReview != null &&
    (!Schema.is(
      Schema.Struct({
        recoveryId: Schema.String,
        currentRevision: Schema.NullOr(Schema.String),
      }),
    )(authorizedCurrentReview) ||
      publicationAttention == null ||
      authorizedCurrentReview.recoveryId !== publicationAttention.recoveryId)
  )
    throw new Error("The reviewed current authorization could not be read; its copy is preserved.");
  const renameIntent = "renameIntent" in value ? value.renameIntent : null;
  if (renameIntent != null && !Schema.is(RenameIntent)(renameIntent))
    throw new Error("The pending rename identity could not be read; its copy is preserved.");
  const genericSaveState = "genericSaveState" in value ? value.genericSaveState : undefined;
  if (
    genericSaveState !== undefined &&
    (!Schema.is(GenericSaveState)(genericSaveState) ||
      !Number.isSafeInteger(genericSaveState.editRevision) ||
      !Number.isSafeInteger(genericSaveState.confirmedEditRevision) ||
      genericSaveState.editRevision < 0 ||
      genericSaveState.confirmedEditRevision < 0 ||
      genericSaveState.confirmedEditRevision > genericSaveState.editRevision)
  )
    throw new Error("The file recovery authorization could not be read; its copy is preserved.");
  return {
    token: value.token,
    baselineSource: value.baselineSource,
    baselineRevision: value.baselineRevision,
    draftSource: value.draftSource,
    publicationSource:
      "publicationSource" in value && typeof value.publicationSource === "string"
        ? value.publicationSource
        : null,
    publicationIntent: intent as DocumentSaveIntent | null,
    renameIntent: renameIntent as DocumentRenameIntent | null,
    ...(genericSaveState === undefined
      ? {}
      : {
          genericSaveState: genericSaveState as GenericFileSaveCheckpointState,
        }),
    publicationAttention,
    authorizedCurrentReview,
    ...("currentMissing" in value ? { currentMissing: value.currentMissing as boolean } : {}),
    ...("publicationOutcome" in value &&
    (value.publicationOutcome === "unchanged" || value.publicationOutcome === "retained-attention")
      ? { publicationOutcome: value.publicationOutcome }
      : {}),
    ...("attentionMutationId" in value && typeof value.attentionMutationId === "string"
      ? { attentionMutationId: value.attentionMutationId }
      : {}),
    ...("attention" in value &&
    (value.attention === "recovery_required" ||
      value.attention === "target_changed" ||
      value.attention === "mutation_unavailable" ||
      value.attention === "mutation_intent_conflict" ||
      value.attention === "outcome_unknown")
      ? { attention: value.attention }
      : {}),
    // Absent or malformed is unknown, never evidence of a clean copy.
    ...("conflict" in value && typeof value.conflict === "boolean"
      ? { conflict: value.conflict }
      : {}),
  };
}

async function readStoredCheckpoint(key: string): Promise<unknown> {
  const db = await openDatabase();
  return new Promise<unknown>((resolve, reject) => {
    const request = db.transaction("drafts", "readonly").objectStore("drafts").get(key);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function replaceStoredCheckpoint<T extends { readonly token: string }>(
  key: string,
  expectedToken: string | undefined,
  next: T | undefined,
  decodeBefore: (value: unknown) => T | undefined,
): Promise<boolean> {
  return openDatabase().then(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction("drafts", "readwrite");
        const store = transaction.objectStore("drafts");
        let accepted = false;
        transaction.addEventListener("complete", () => resolve(accepted));
        transaction.addEventListener("abort", () =>
          reject(transaction.error ?? new Error("Document recovery write was interrupted.")),
        );
        transaction.addEventListener("error", () => reject(transaction.error));
        const request = store.get(key);
        request.addEventListener("success", () => {
          let before: T | undefined;
          try {
            before = decodeBefore(request.result);
          } catch {
            transaction.abort();
            return;
          }
          if (before?.token !== expectedToken) return;
          const write = () => {
            if (next) store.put(next, key);
            else store.delete(key);
            accepted = true;
          };
          if (before || !next) {
            write();
            return;
          }
          const count = store.count();
          count.addEventListener("success", () => {
            if (count.result >= MAX_CHECKPOINTS) transaction.abort();
            else write();
          });
        });
      }),
  );
}

export const indexedDbMarkdownDrafts: MarkdownDraftCheckpointStore = {
  async read(key) {
    return decode(await readStoredCheckpoint(key));
  },
  async replace(key, expectedToken, next) {
    if (
      next &&
      2 *
        (next.baselineSource.length +
          next.draftSource.length +
          (next.publicationSource?.length ?? 0) +
          (next.publicationIntent?.source.length ?? 0) +
          (next.renameIntent?.baselineSource.length ?? 0) +
          (next.renameIntent?.source.length ?? 0) +
          (next.renameIntent?.draftSource.length ?? 0)) >
        MAX_CHECKPOINT_BYTES
    ) {
      throw new Error("Markdown recovery checkpoint exceeds its storage budget.");
    }
    return replaceStoredCheckpoint(key, expectedToken, next, decode);
  },
  async readMetadataRename(key) {
    return decodeMetadataRename(await readStoredCheckpoint(key));
  },
  async replaceMetadataRename(key, expectedToken, next) {
    if (next !== undefined && 2 * JSON.stringify(next).length > MAX_CHECKPOINT_BYTES)
      throw new Error("File rename checkpoint exceeds its storage budget.");
    return replaceStoredCheckpoint(key, expectedToken, next, decodeMetadataRename);
  },
};

/** A coalesced recovery copy, never a second publisher of the Markdown file. */
export class MarkdownDraftCheckpointWriter {
  private token: string | undefined;
  private latest: { snapshot: MarkdownPersistenceSnapshot; keep: boolean } | undefined;
  private lastSource: string | undefined;
  private lastBaseline: string | undefined;
  private lastPublication: string | null = null;
  private lastConflict = false;
  private lastIntent: DocumentSaveIntent | null = null;
  private lastAttention: DocumentPersistenceAttention | null = null;
  private lastPublicationAttention: DocumentFilePublicationAttention | null = null;
  private lastOutcome: DocumentPublicationOutcome | null = null;
  private lastAttentionMutationId: string | null = null;
  private lastCurrentMissing = false;
  private lastAuthorizedCurrentReview: DocumentAuthorizedCurrentReview | null;
  private strictReviewWriting = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | undefined;
  private disabled = false;
  private retired = false;
  private keepRecovery = false;
  private renameIntent: DocumentRenameIntent | null;
  private readonly genericSaveState: GenericFileSaveCheckpointState | undefined;

  constructor(
    private readonly key: string,
    private readonly store: MarkdownDraftCheckpointStore,
    initial?: MarkdownDraftCheckpoint,
  ) {
    this.token = initial?.token;
    this.keepRecovery = initial !== undefined && !checkpointHoldsNothing(initial);
    this.renameIntent = initial?.renameIntent ?? null;
    this.genericSaveState = initial?.genericSaveState;
    this.lastAuthorizedCurrentReview = initial?.authorizedCurrentReview ?? null;
  }

  /**
   * `pendingOnlyForRename`: the document is pending only because a rename holds
   * it. Such a snapshot has nothing to recover and is never written.
   */
  update(snapshot: MarkdownPersistenceSnapshot, pendingOnlyForRename = false): void {
    if (this.disabled || this.retired) return;
    const keep = (snapshot.pending && !pendingOnlyForRename) || this.extensionsHoldRecovery();
    this.keepRecovery = keep;
    const source = keep ? snapshot.draftSource : undefined;
    const conflict = snapshot.conflict !== null;
    if (
      source === this.lastSource &&
      snapshot.baselineRevision === this.lastBaseline &&
      snapshot.publicationSource === this.lastPublication &&
      conflict === this.lastConflict &&
      snapshot.attention === this.lastAttention &&
      snapshot.publicationIntent?.mutationId === this.lastIntent?.mutationId &&
      snapshot.publicationAttention === this.lastPublicationAttention &&
      snapshot.publicationOutcome === this.lastOutcome &&
      snapshot.attentionMutationId === this.lastAttentionMutationId &&
      snapshot.currentMissing === this.lastCurrentMissing &&
      snapshot.authorizedCurrentReview === this.lastAuthorizedCurrentReview
    )
      return;
    this.lastPublication = snapshot.publicationSource;
    this.lastSource = source;
    this.lastBaseline = snapshot.baselineRevision;
    this.lastConflict = conflict;
    this.lastAttention = snapshot.attention;
    this.lastIntent = snapshot.publicationIntent;
    this.lastPublicationAttention = snapshot.publicationAttention;
    this.lastOutcome = snapshot.publicationOutcome;
    this.lastAttentionMutationId = snapshot.attentionMutationId;
    this.lastCurrentMissing = snapshot.currentMissing;
    this.lastAuthorizedCurrentReview = snapshot.authorizedCurrentReview;
    this.latest = { snapshot, keep };
    if (!keep && this.token === undefined && this.writing === undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.latest = undefined;
      return;
    }
    // Leading deadline, not an endlessly postponed debounce during typing.
    if (this.timer === undefined && this.writing === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, 200);
  }

  /**
   * The publication admission boundary. Unlike ordinary draft copies, this
   * resolves only after storage has committed the exact intent and its source.
   * A failed CAS or storage transaction must never admit a backend mutation.
   */
  async flushPublication(snapshot: MarkdownPersistenceSnapshot): Promise<void> {
    if (snapshot.publicationIntent === null)
      throw new Error("A publication checkpoint requires an exact save intent.");
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.writing !== undefined) await this.writing;
    if (this.retired) throw new Error("This file's recovery checkpoint has retired.");
    if (this.disabled)
      throw new Error(
        "Another editor owns this file's recovery checkpoint; its draft has been preserved.",
      );
    // Typing may have advanced while an ordinary checkpoint was committing.
    const current = this.latest?.snapshot;
    const publication =
      current?.publicationIntent === snapshot.publicationIntent ? current : snapshot;
    this.keepRecovery = true;
    this.latest = undefined;
    await this.persist(publication, true);
    if (this.retired) throw new Error("This file's recovery checkpoint retired during admission.");
  }

  /** A resolved review cannot confirm or settle until its exact phase is durable. */
  async flushAuthorizedCurrentReview(snapshot: MarkdownPersistenceSnapshot): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.writing !== undefined) await this.writing;
    if (this.retired || this.disabled)
      throw new Error(
        "This file's recovery checkpoint no longer admits reviewed current confirmation.",
      );
    this.latest = undefined;
    this.strictReviewWriting = true;
    try {
      await this.persist(snapshot, snapshot.pending || snapshot.authorizedCurrentReview !== null);
      if (this.retired || this.disabled)
        throw new Error(
          "This file's recovery checkpoint retired during reviewed current admission.",
        );
      this.lastAuthorizedCurrentReview = snapshot.authorizedCurrentReview;
    } finally {
      this.strictReviewWriting = false;
      if (this.latest && !this.disabled && !this.retired && this.timer === undefined)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.drain();
        }, 200);
    }
  }

  /** A rename cannot enter transport until its exact identity is durable. */
  async flushRename(
    snapshot: MarkdownPersistenceSnapshot,
    intent: DocumentRenameIntent,
  ): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.writing !== undefined) await this.writing;
    if (this.retired || this.disabled)
      throw new Error("This file's recovery checkpoint no longer admits mutations.");
    const previous = this.renameIntent;
    if (
      previous !== null &&
      (previous.mutationId !== intent.mutationId ||
        previous.from.environmentId !== intent.from.environmentId ||
        previous.from.cwd !== intent.from.cwd ||
        previous.from.relativePath !== intent.from.relativePath ||
        previous.destination.environmentId !== intent.destination.environmentId ||
        previous.destination.cwd !== intent.destination.cwd ||
        previous.destination.relativePath !== intent.destination.relativePath ||
        previous.removeEmptyFolders !== intent.removeEmptyFolders ||
        previous.expectedRevision !== intent.expectedRevision ||
        previous.baselineSource !== intent.baselineSource ||
        previous.source !== intent.source ||
        previous.draftSource !== intent.draftSource ||
        (previous.acknowledgement !== undefined &&
          (previous.acknowledgement.destinationRelativePath !==
            intent.acknowledgement?.destinationRelativePath ||
            previous.acknowledgement.revision !== intent.acknowledgement?.revision)))
    )
      throw new Error("A pending rename identity cannot be reused with another intent.");
    if (
      intent.acknowledgement !== undefined &&
      (intent.acknowledgement.destinationRelativePath !== intent.destination.relativePath ||
        intent.acknowledgement.revision !== intent.expectedRevision)
    )
      throw new Error(
        "The rename acknowledgement does not match its frozen destination and revision.",
      );
    this.renameIntent = intent;
    this.keepRecovery = true;
    this.latest = undefined;
    await this.persist(snapshot, true);
    if (this.retired)
      throw new Error("This file's recovery checkpoint retired during rename admission.");
  }

  /** Clears only after an authoritative ACK, unchanged refusal, or explicitly reviewed settlement. */
  async clearRename(snapshot: MarkdownPersistenceSnapshot, mutationId: string): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.writing !== undefined) await this.writing;
    if (this.retired || this.disabled || this.renameIntent?.mutationId !== mutationId)
      throw new Error("The pending rename no longer belongs to this checkpoint writer.");
    const previous = this.renameIntent;
    this.renameIntent = null;
    this.latest = undefined;
    try {
      await this.persist(snapshot, snapshot.pending);
      this.keepRecovery = snapshot.pending || this.extensionsHoldRecovery();
    } catch (error) {
      this.renameIntent = previous;
      throw error;
    }
  }

  private extensionsHoldRecovery(): boolean {
    return (
      this.renameIntent !== null ||
      this.lastAuthorizedCurrentReview !== null ||
      genericStateHoldsRecovery(this.genericSaveState)
    );
  }

  /**
   * Before an in-place rename: waits for a copy being written, then removes
   * this writer's copy, which must not outlive the old name. True once no copy
   * of this writer remains; false if one with unsaved work is due, or removal
   * failed (the caller then renames the ordinary way).
   */
  async settle(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.writing !== undefined) await this.writing;
    if (this.keepRecovery || this.extensionsHoldRecovery()) return false;
    this.latest = undefined;
    if (this.token === undefined) return true;
    if (this.disabled) return false;
    try {
      if (await this.store.replace(this.key, this.token, undefined)) {
        this.token = undefined;
        return true;
      }
    } catch (error) {
      console.error("Markdown recovery checkpoint could not be removed before a rename:", error);
    }
    return false;
  }

  /**
   * The document left this path (a rename). Stops further copies, waits for one
   * already being written, then removes only the copy this writer owns.
   */
  async retire(): Promise<void> {
    if (this.retired) return;
    this.retired = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
    while (this.writing !== undefined) await this.writing;
    if (this.disabled || this.token === undefined || this.extensionsHoldRecovery()) return;
    try {
      if (await this.store.replace(this.key, this.token, undefined)) this.token = undefined;
    } catch (error) {
      // The copy stays. If it holds nothing, admission discards it later.
      console.error("Markdown recovery checkpoint could not be removed after a rename:", error);
    }
  }

  private drain(): Promise<void> {
    if (this.writing !== undefined || this.disabled || this.retired || !this.latest)
      return this.writing ?? Promise.resolve();
    const { snapshot, keep } = this.latest;
    this.latest = undefined;
    return this.persist(snapshot, keep).catch((error: unknown) => {
      console.error("Markdown recovery checkpoint failed:", error);
    });
  }

  private persist(snapshot: MarkdownPersistenceSnapshot, keep: boolean): Promise<void> {
    const next =
      keep || this.extensionsHoldRecovery()
        ? {
            token: randomUUID(),
            baselineSource: snapshot.baselineSource,
            baselineRevision: snapshot.baselineRevision,
            draftSource: snapshot.draftSource,
            publicationSource: snapshot.publicationSource,
            conflict: snapshot.conflict !== null,
            attention: snapshot.attention,
            publicationIntent: snapshot.publicationIntent,
            publicationAttention: snapshot.publicationAttention,
            publicationOutcome: snapshot.publicationOutcome,
            attentionMutationId: snapshot.attentionMutationId,
            currentMissing: snapshot.currentMissing,
            authorizedCurrentReview: snapshot.authorizedCurrentReview,
            renameIntent: this.renameIntent,
            ...(this.genericSaveState === undefined
              ? {}
              : { genericSaveState: this.genericSaveState }),
          }
        : undefined;
    const write = Promise.resolve().then(async () => {
      if (this.token !== undefined || next !== undefined) {
        if (!(await this.store.replace(this.key, this.token, next))) {
          this.disabled = true;
          throw new Error(
            "Another editor owns this file's recovery checkpoint; its draft has been preserved.",
          );
        }
        this.token = next?.token;
      }
    });
    // The lane itself never rejects: settle/retire still wait for failed writes.
    // The strict admission caller receives the original rejection.
    this.writing = write.then(
      () => {
        this.writing = undefined;
        if (this.latest && !this.disabled && !this.retired && !this.strictReviewWriting)
          void this.drain();
      },
      () => {
        this.writing = undefined;
        this.latest ??= { snapshot, keep };
      },
    );
    return write;
  }
}
