import {
  canMoveInPlace,
  documentIdentity,
  type MarkdownPersistenceLease,
  type MarkdownPersistenceTarget,
  type MarkdownPersistenceMoveTransaction,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import type { RetainedFileAttention } from "~/scient/fileSurfaces/ScientFileFreshnessControls";
import {
  indexedDbMarkdownDrafts,
  type DocumentRenameIntent,
  type MetadataFileRenameIntent,
  type MarkdownDraftCheckpointStore,
} from "./markdownDraftCheckpoint";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import { randomUUID } from "~/lib/utils";

/** A rejected intent can be definitive; a lost reply is not proof of no rename. */
export function renameOutcomeAttention(cause: unknown): RetainedFileAttention | null {
  const failure =
    typeof cause === "object" && cause !== null && "failure" in cause
      ? cause.failure
      : typeof cause === "string"
        ? cause
        : null;
  switch (failure) {
    case "recovery_required":
    case "target_changed":
    case "mutation_unavailable":
    case "mutation_intent_conflict":
      return failure;
    case "invalid_workspace_root":
    case "invalid_relative_path":
    case "workspace_path_outside_root":
    case "resolved_path_outside_root":
    case "revision_conflict":
    case "path_exists":
    case "path_not_file":
    case "binary_file":
      return null;
    default:
      return "outcome_unknown";
  }
}

/**
 * An editor showing an open document. Before the document moves in place it
 * may refuse, for example while an input method is composing text. It never
 * publishes input to make itself ready.
 */
export interface RenameParticipant {
  readonly readyToMove: () => boolean;
}

const participants = new Map<string, Set<RenameParticipant>>();

/** Registers an editor of `documentId`; returns its removal. */
export function registerRenameParticipant(
  documentId: string,
  participant: RenameParticipant,
): () => void {
  let set = participants.get(documentId);
  if (set === undefined) participants.set(documentId, (set = new Set()));
  set.add(participant);
  return () => {
    set.delete(participant);
    if (set.size === 0 && participants.get(documentId) === set) participants.delete(documentId);
  };
}

function participantsReady(documentId: string): boolean {
  for (const participant of participants.get(documentId) ?? []) {
    try {
      if (!participant.readyToMove()) return false;
    } catch (error) {
      console.error("An editor could not prepare for an in-place rename:", error);
      return false;
    }
  }
  return true;
}

/** A rename cannot dispatch until its exact namespace identity is durable. */
export const RECOVERY_COPY_UNSETTLED =
  "This file's rename intent could not be saved. Your source and input have been preserved.";

export type ServerRenameResult =
  | { readonly ok: true; readonly destinationRelativePath: string; readonly revision: string }
  | { readonly ok: false; readonly cause: unknown };

export type RenameOpenDocumentResult =
  /** Moved in place: the editor, its history and its saving carried on. */
  | { readonly kind: "moved"; readonly destinationRelativePath: string; readonly revision: string }
  /**
   * The open document moved, but a view did not follow it: the caller remounts
   * its editors against the destination. The document is already there.
   */
  | { readonly kind: "repair"; readonly destinationRelativePath: string; readonly revision: string }
  /**
   * An in-place move is not possible right now; nothing was changed and the
   * server was not asked. The caller waits; it must not bypass durable admission.
   */
  | {
      readonly kind: "legacy-required";
      /**
       * `destination`: another view or recovery copy holds the new name; try
       * another. `busy`: an editor is not ready yet (composing, saving); try
       * again shortly.
       */
      readonly reason?: "destination" | "busy";
    }
  /** The server definitively refused, or a local preflight failed before dispatch. */
  | { readonly kind: "failed"; readonly cause: unknown }
  /** No path is adopted when the operation needs review or its outcome is unknown. */
  | {
      readonly kind: "attention";
      readonly attention: RetainedFileAttention;
      readonly cause: unknown;
    };

/**
 * Renames an open document by moving it in place: the editor, its undo history,
 * caret and saving stay; only the path changes.
 *
 * Phases: freeze (editors and the session hold), destination preflight, server
 * rename, commit (the session moves), the caller's view update, and the views'
 * acknowledgement. The hold is released last, whatever happens.
 */
export async function renameOpenDocument(input: {
  readonly lease: MarkdownPersistenceLease;
  readonly destination: MarkdownPersistenceTarget;
  /** A folder-document workflow may already hold the same leased move token. */
  readonly transaction?: MarkdownPersistenceMoveTransaction;
  readonly removeEmptyFolders?: true;
  /** The server rename, given the revision the document holds. */
  readonly rename: (
    expectedRevision: string,
    mutationId: string,
    intent: DocumentRenameIntent,
  ) => Promise<ServerRenameResult>;
  /**
   * Moves the caller's views to the destination (tab, path-keyed view state).
   * Called synchronously right after the session moved.
   */
  readonly follow: (destinationRelativePath: string) => void;
  /**
   * Whether no other view already shows the destination (or the document under
   * its old name elsewhere). Checked before starting and again before moving.
   */
  readonly destinationFree?: () => boolean;
  /** Resolves true once every view of the document has committed at the destination. */
  readonly followed: (destinationRelativePath: string) => Promise<boolean>;
}): Promise<RenameOpenDocumentResult> {
  const { lease, destination } = input;
  const snapshot = lease.getSnapshot();
  const recovered = lease.getRenameIntent?.() ?? null;
  if (snapshot.attention && !recovered)
    return { kind: "attention", attention: snapshot.attention, cause: snapshot.error };
  if (
    recovered &&
    (recovered.from.environmentId !== lease.target.environmentId ||
      recovered.from.cwd !== lease.target.cwd ||
      recovered.from.relativePath !== lease.target.relativePath ||
      recovered.destination.environmentId !== destination.environmentId ||
      recovered.destination.cwd !== destination.cwd ||
      recovered.destination.relativePath !== destination.relativePath)
  )
    return {
      kind: "attention",
      attention: "outcome_unknown",
      cause: new Error(
        "Replay the pending rename's original source and destination before starting another rename.",
      ),
    };
  if (!canMoveInPlace(lease)) return { kind: "legacy-required" };
  const documentId = documentIdentity(lease);
  if (!(input.destinationFree?.() ?? true))
    return { kind: "legacy-required", reason: "destination" };
  if (!participantsReady(documentId)) return { kind: "legacy-required", reason: "busy" };
  // Never retire the authoritative source checkpoint before dispatch.
  const move = input.transaction ?? lease.beginMove(destination);
  if (move === null) return { kind: "legacy-required" };
  try {
    if (move.documentId !== documentId || !move.isCurrent())
      return {
        kind: "failed",
        cause: new Error("This rename transaction does not own the document."),
      };
    // An editor may have started composing between the check and the hold.
    if (!participantsReady(documentId)) return { kind: "legacy-required", reason: "busy" };
    const destinationCopy = await move.preflight();
    if (destinationCopy === "occupied") return { kind: "legacy-required", reason: "destination" };
    if (destinationCopy !== "empty") return { kind: "legacy-required" };
    let intent: DocumentRenameIntent;
    try {
      intent = await move.admitRename({
        ...(input.removeEmptyFolders ? { removeEmptyFolders: true } : {}),
      });
      if (
        intent.destination.environmentId !== destination.environmentId ||
        intent.destination.cwd !== destination.cwd ||
        intent.destination.relativePath !== destination.relativePath
      )
        throw new Error("This move token belongs to another rename destination.");
    } catch (cause) {
      return { kind: "failed", cause };
    }
    if (!move.isCurrent())
      return {
        kind: "failed",
        cause: new Error("The rename lease retired before transport dispatch."),
      };
    let result: ServerRenameResult;
    try {
      result = intent.acknowledgement
        ? { ok: true, ...intent.acknowledgement }
        : await input.rename(intent.expectedRevision, intent.mutationId, intent);
    } catch (cause) {
      lease.noteMutationFailure(cause, intent.mutationId);
      return { kind: "attention", attention: "outcome_unknown", cause };
    }
    if (!result.ok) {
      const attention = renameOutcomeAttention(result.cause);
      if (attention === null) {
        try {
          await move.rejectRename();
        } catch (cause) {
          lease.noteMutationFailure(cause, intent.mutationId);
          return { kind: "attention", attention: "outcome_unknown", cause };
        }
        return { kind: "failed", cause: result.cause };
      }
      lease.noteMutationFailure(result.cause, intent.mutationId);
      return { kind: "attention", attention, cause: result.cause };
    }
    const renamed = {
      destinationRelativePath: result.destinationRelativePath,
      revision: result.revision,
    };
    try {
      if (!(await move.acknowledgeRename(renamed)))
        throw new Error("The rename receipt does not acknowledge its exact original intent.");
      if (!(input.destinationFree?.() ?? true) || !(await move.commit()))
        throw new Error(
          "The acknowledged rename could not move the owned document; its input remains recoverable.",
        );
    } catch (cause) {
      // A destination-journal clear may fail after the document moved. Its
      // receipt is still durable, so repair the view rather than reopen/erase.
      if (lease.target.relativePath === renamed.destinationRelativePath) {
        try {
          input.follow(renamed.destinationRelativePath);
        } catch {
          /* remount below */
        }
        return { kind: "repair", ...renamed };
      }
      lease.noteMutationFailure(cause, intent.mutationId);
      return { kind: "attention", attention: "outcome_unknown", cause };
    }
    try {
      input.follow(renamed.destinationRelativePath);
    } catch (error) {
      console.error("The renamed document's view could not follow it:", error);
      return { kind: "repair", ...renamed };
    }
    const followed = await input.followed(renamed.destinationRelativePath).catch(() => false);
    return followed ? { kind: "moved", ...renamed } : { kind: "repair", ...renamed };
  } finally {
    move.finish();
  }
}

export type MetadataFileRenameResult =
  | {
      readonly kind: "renamed";
      readonly destinationRelativePath: string;
      readonly revision: string;
    }
  | Extract<RenameOpenDocumentResult, { readonly kind: "failed" | "attention" }>;

/** Source-free namespace recovery uses the same row and CAS store as source owners. */
export async function readMetadataRenameIntent(
  from: MarkdownPersistenceTarget,
  store: MarkdownDraftCheckpointStore = indexedDbMarkdownDrafts,
): Promise<MetadataFileRenameIntent | null> {
  if (!store.readMetadataRename) throw new Error(RECOVERY_COPY_UNSETTLED);
  const current = await store.readMetadataRename(projectFileOperationKey(from));
  if (!current) return null;
  if (
    current.intent.acknowledgement &&
    projectFileOperationKey(current.intent.destination) === projectFileOperationKey(from)
  )
    return null;
  return current.intent;
}

/** Clears no namespace identity until exact server recovery and ordered review have succeeded. */
export async function settleMetadataRenameIntent(
  from: MarkdownPersistenceTarget,
  mutationId: string,
  store: MarkdownDraftCheckpointStore = indexedDbMarkdownDrafts,
): Promise<boolean> {
  if (!store.readMetadataRename || !store.replaceMetadataRename) return false;
  const key = projectFileOperationKey(from);
  const current = await store.readMetadataRename(key);
  return (
    current?.intent.mutationId === mutationId &&
    store.replaceMetadataRename(key, current.token, undefined)
  );
}

/** Binary/oversized namespace operations never manufacture or decode textual source. */
export async function renameMetadataFile(input: {
  readonly from: MarkdownPersistenceTarget;
  readonly destination: MarkdownPersistenceTarget;
  readonly expectedRevision?: string;
  readonly store?: MarkdownDraftCheckpointStore;
  readonly isActive: () => boolean;
  readonly rename: (intent: MetadataFileRenameIntent) => Promise<ServerRenameResult>;
}): Promise<MetadataFileRenameResult> {
  const store = input.store ?? indexedDbMarkdownDrafts;
  if (!store.readMetadataRename || !store.replaceMetadataRename)
    return { kind: "failed", cause: new Error(RECOVERY_COPY_UNSETTLED) };
  const fromKey = projectFileOperationKey(input.from);
  const toKey = projectFileOperationKey(input.destination);
  if (
    fromKey === toKey ||
    input.from.environmentId !== input.destination.environmentId ||
    input.from.cwd !== input.destination.cwd
  )
    return {
      kind: "failed",
      cause: new Error("A rename must keep its original workspace identity."),
    };
  let intent: MetadataFileRenameIntent;
  let token: string;
  try {
    let previous = await store.readMetadataRename(fromKey);
    if (
      previous?.intent.acknowledgement &&
      projectFileOperationKey(previous.intent.destination) === fromKey
    ) {
      if (!(await store.replaceMetadataRename(fromKey, previous.token, undefined)))
        throw new Error("The previous rename receipt is still owned by another renderer.");
      previous = undefined;
    }
    if (
      previous &&
      (projectFileOperationKey(previous.intent.from) !== fromKey ||
        projectFileOperationKey(previous.intent.destination) !== toKey)
    )
      return {
        kind: "attention",
        attention: "outcome_unknown",
        cause: new Error("Replay the pending rename's original source and destination."),
      };
    intent = previous?.intent ?? {
      mutationId: randomUUID(),
      from: { ...input.from },
      destination: { ...input.destination },
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    };
    const reservedDestination = await store.readMetadataRename(toKey);
    if (
      reservedDestination &&
      (reservedDestination.intent.mutationId !== intent.mutationId ||
        projectFileOperationKey(reservedDestination.intent.from) !== fromKey ||
        projectFileOperationKey(reservedDestination.intent.destination) !== toKey)
    )
      throw new Error(
        "Another file owns the destination journal; no namespace operation was dispatched.",
      );
    token = randomUUID();
    if (
      !input.isActive() ||
      !(await store.replaceMetadataRename(fromKey, previous?.token, {
        kind: "file-rename",
        token,
        intent,
      }))
    )
      throw new Error("The exact file rename identity could not be committed.");
    if (!input.isActive()) throw new Error("The rename holder retired before transport dispatch.");
  } catch (cause) {
    return { kind: "failed", cause };
  }
  let result: ServerRenameResult;
  try {
    result = intent.acknowledgement
      ? { ok: true, ...intent.acknowledgement }
      : await input.rename(intent);
  } catch (cause) {
    return { kind: "attention", attention: "outcome_unknown", cause };
  }
  if (!result.ok) {
    const attention = renameOutcomeAttention(result.cause);
    if (attention !== null) return { kind: "attention", attention, cause: result.cause };
    try {
      if (!(await store.replaceMetadataRename(fromKey, token, undefined)))
        throw new Error("The refused rename identity remains owned and preserved.");
      return { kind: "failed", cause: result.cause };
    } catch (cause) {
      return { kind: "attention", attention: "outcome_unknown", cause };
    }
  }
  try {
    if (
      result.destinationRelativePath !== intent.destination.relativePath ||
      (intent.expectedRevision !== undefined && result.revision !== intent.expectedRevision)
    )
      throw new Error("The namespace receipt does not match the frozen rename identity.");
    intent = {
      ...intent,
      acknowledgement: {
        destinationRelativePath: result.destinationRelativePath,
        revision: result.revision,
      },
    };
    const acknowledgedToken = randomUUID();
    if (
      !(await store.replaceMetadataRename(fromKey, token, {
        kind: "file-rename",
        token: acknowledgedToken,
        intent,
      }))
    )
      throw new Error(
        "The rename receipt could not be committed; its original intent remains preserved.",
      );
    token = acknowledgedToken;
    if (!input.isActive())
      throw new Error("The rename holder retired before adopting its acknowledged destination.");
    const destination = await store.readMetadataRename(toKey);
    if (
      destination &&
      (destination.intent.mutationId !== intent.mutationId ||
        projectFileOperationKey(destination.intent.from) !== fromKey ||
        projectFileOperationKey(destination.intent.destination) !== toKey)
    )
      throw new Error("Another file owns the destination journal.");
    const destinationToken = randomUUID();
    if (
      !(await store.replaceMetadataRename(toKey, destination?.token, {
        kind: "file-rename",
        token: destinationToken,
        intent,
      }))
    )
      throw new Error("The acknowledged destination journal could not be committed.");
    if (!input.isActive()) throw new Error("The rename holder retired before journal retirement.");
    if (!(await store.replaceMetadataRename(fromKey, token, undefined)))
      throw new Error("The original rename receipt remains preserved at its source.");
    // The destination now owns the durable receipt and the source is retired.
    // Cleanup failure must not strand the view at the now-missing source or
    // permit another ID there; the completed receipt is reusable at destination.
    try {
      if (!(await store.replaceMetadataRename(toKey, destinationToken, undefined)))
        console.error(
          "The acknowledged metadata rename receipt remains preserved at its destination.",
        );
    } catch (cause) {
      console.error(
        "The acknowledged metadata rename receipt remains preserved at its destination:",
        cause,
      );
    }
    return {
      kind: "renamed",
      destinationRelativePath: result.destinationRelativePath,
      revision: result.revision,
    };
  } catch (cause) {
    return { kind: "attention", attention: "outcome_unknown", cause };
  }
}
