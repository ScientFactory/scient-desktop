import type {
  MarkdownPersistenceLease,
  MarkdownPersistenceTarget,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";

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

export type ServerRenameResult =
  | { readonly ok: true; readonly destinationRelativePath: string; readonly revision: string }
  | { readonly ok: false; readonly cause: unknown };

export type RenameOpenDocumentResult =
  /** Moved in place: the editor, its history and its saving carried on. */
  | { readonly kind: "moved"; readonly destinationRelativePath: string; readonly revision: string }
  /**
   * Renamed on disk, but the open document was not moved: `reopen` opened the
   * destination the ordinary way. Nothing local had been changed.
   */
  | {
      readonly kind: "renamed";
      readonly destinationRelativePath: string;
      readonly revision: string;
    }
  /**
   * The open document moved, but a view did not follow it: the caller remounts
   * its editors against the destination. The document is already there.
   */
  | { readonly kind: "repair"; readonly destinationRelativePath: string; readonly revision: string }
  /**
   * An in-place move is not possible right now; nothing was changed and the
   * server was not asked. The caller decides whether to rename the ordinary way.
   */
  | { readonly kind: "legacy-required" }
  /** The server refused or failed; nothing was changed. */
  | { readonly kind: "failed"; readonly cause: unknown };

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
  /** The server rename, given the revision the document holds. */
  readonly rename: (expectedRevision: string) => Promise<ServerRenameResult>;
  /**
   * The ordinary rename's follow-up (forget the session, open the destination),
   * for a file renamed on disk that could not move in place. Called while the
   * document is still held, as an ordinary rename does.
   */
  readonly reopen: (destinationRelativePath: string, revision: string) => void;
  /**
   * Moves the caller's views to the destination (tab, path-keyed view state).
   * Called synchronously right after the session moved.
   */
  readonly follow: (destinationRelativePath: string) => void;
  /** Resolves true once every view of the document has committed at the destination. */
  readonly followed: (destinationRelativePath: string) => Promise<boolean>;
}): Promise<RenameOpenDocumentResult> {
  const { lease, destination } = input;
  if (!participantsReady(lease.documentId)) return { kind: "legacy-required" };
  const move = lease.beginMove(destination);
  if (move === null) return { kind: "legacy-required" };
  try {
    // An editor may have started composing between the check and the hold.
    if (!participantsReady(lease.documentId)) return { kind: "legacy-required" };
    if ((await move.preflight()) !== "empty") return { kind: "legacy-required" };
    const result = await input.rename(lease.getSnapshot().baselineRevision);
    if (!result.ok) return { kind: "failed", cause: result.cause };
    const renamed = {
      destinationRelativePath: result.destinationRelativePath,
      revision: result.revision,
    };
    if (
      result.destinationRelativePath !== destination.relativePath ||
      result.revision !== lease.getSnapshot().baselineRevision ||
      !move.commit()
    ) {
      input.reopen(renamed.destinationRelativePath, renamed.revision);
      return { kind: "renamed", ...renamed };
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
