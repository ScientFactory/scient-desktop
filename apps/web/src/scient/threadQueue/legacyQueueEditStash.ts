/**
 * Scient builds before in-place queued edits stashed some drafts as references into an IndexedDB
 * journal: the stash entry held only the text, and the journal held the whole draft with its
 * attachment bytes. This reads such a stash back once and then removes it. Nothing writes the
 * journal any more.
 */
import { msg } from "gt-react";

import {
  composerDraftHasUserContent,
  composerTargetKey,
  flushComposerDraftPersistence,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { m } from "../../i18n/messages";
import { usePromptStashStore, type PromptStashEntry } from "../../promptStashStore";
import { serializeComposerImages } from "../../components/chat/composerImagePersistence";
import { createIndexedDbConnection } from "../storage/indexedDbConnection";

const journal = createIndexedDbConnection({
  name: "scient-queue-edit-journal",
  version: 2,
  upgrade: (database) => {
    if (!database.objectStoreNames.contains("edits"))
      database.createObjectStore("edits", { keyPath: "journalKey" });
    if (!database.objectStoreNames.contains("files")) database.createObjectStore("files");
  },
  // Read when the connection is blocked, so it is in the language of that moment.
  get blockedMessage() {
    return m(msg("Close older Scient windows and reload to restore this stash."));
  },
});

type StoredAttachment = {
  readonly name: string;
  readonly mimeType: string;
  readonly fileRef?: string;
  readonly file?: null;
};
type StoredDraft = Omit<ComposerThreadDraftState, "images" | "files"> & {
  readonly images: ReadonlyArray<StoredAttachment>;
  readonly files: ReadonlyArray<StoredAttachment>;
  // Fields of the retired extraction that a restored draft must not carry.
  readonly extractedIntent?: unknown;
  readonly pendingImageSelection?: unknown;
  readonly contextThreadId?: unknown;
};
type StoredSession = {
  readonly contextVersion?: 2;
  readonly ordinary: StoredDraft;
  readonly edited: StoredDraft;
};

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function readStashedDraft(
  journalKey: string,
  side: "ordinary" | "edited",
): Promise<ComposerThreadDraftState | undefined> {
  return journal.transaction(["edits", "files"], "readonly", async (transaction) => {
    const session: StoredSession | undefined = await result(
      transaction.objectStore("edits").get(journalKey),
    );
    if (session === undefined) return undefined;
    const files = transaction.objectStore("files");
    const withBytes = async (attachment: StoredAttachment) => {
      const { fileRef, ...metadata } = attachment;
      if (!fileRef) return { ...metadata, file: null };
      const blob: unknown = await result(files.get(fileRef));
      if (!(blob instanceof Blob))
        throw new Error(`The stashed attachment ${attachment.name} is unavailable.`);
      return {
        ...metadata,
        file: new File([blob], attachment.name, { type: attachment.mimeType }),
      };
    };
    const {
      extractedIntent: _intent,
      pendingImageSelection: _selection,
      contextThreadId: _owner,
      ...stored
    } = session[side];
    const [images, genericFiles] = await Promise.all([
      Promise.all(stored.images.map(withBytes)),
      Promise.all(stored.files.map(withBytes)),
    ]);
    const draft = {
      ...stored,
      images: images.map((image) => {
        if (!image.file) throw new Error(`The stashed image ${image.name} is unavailable.`);
        return { ...image, file: image.file, previewUrl: URL.createObjectURL(image.file) };
      }),
      files: genericFiles,
    } as ComposerThreadDraftState;
    // Version 1 saved element picks and terminal placeholders in an older shape; keep only text
    // and attachments from those.
    return session.contextVersion === 2
      ? draft
      : {
          ...draft,
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
        };
  });
}

async function forgetJournal(journalKey: string) {
  await journal.transaction(["edits", "files"], "readwrite", (transaction) => {
    transaction.objectStore("edits").delete(journalKey);
    transaction.objectStore("files").delete(IDBKeyRange.bound(`${journalKey}:`, `${journalKey}:￿`));
  });
}

/**
 * Restores an older journal-backed stash into an empty composer. The stash and its journal are
 * removed only once the restored draft survives a reload on its own: its images are stored with
 * the draft, and it holds no file whose bytes exist only in the journal.
 */
export async function restoreLegacyQueueEditStash(
  entry: PromptStashEntry & { readonly queueEditKey: string },
  target: ComposerThreadTarget,
) {
  const key = composerTargetKey(target);
  const occupied = () =>
    composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(target));
  const refusal = "Send, stash or clear the current draft first, then restore this stash.";
  if (occupied()) throw new Error(refusal);
  const draft = await readStashedDraft(entry.queueEditKey, entry.queueEditSide ?? "edited");
  if (draft === undefined)
    throw new Error("This stash was saved by an older Scient and can no longer be read.");
  const persistedAttachments = await serializeComposerImages(
    draft.images,
    draft.persistedAttachments ?? [],
  );
  const persistedIds = new Set(persistedAttachments.map((attachment) => attachment.id));
  // Typing or attaching while the journal was read wins over the stash.
  if (occupied()) throw new Error(refusal);
  useComposerDraftStore.setState((state) => ({
    draftsByThreadKey: {
      ...state.draftsByThreadKey,
      [key]: {
        ...draft,
        persistedAttachments,
        nonPersistedImageIds: draft.images
          .filter((image) => !persistedIds.has(image.id))
          .map((image) => image.id),
      },
    },
  }));
  flushComposerDraftPersistence();
  const durable =
    persistedIds.size === draft.images.length &&
    draft.files.every((file) => !file.file || file.uploadedAttachmentId !== undefined);
  if (!durable) return;
  const stash = usePromptStashStore.getState();
  stash.takeEntry(entry.id);
  if (
    !stash.entries.some(
      (other) => other.id !== entry.id && other.queueEditKey === entry.queueEditKey,
    )
  )
    await forgetJournal(entry.queueEditKey);
}

let offered = false;

/**
 * A queued-message edit that was still open when Scient updated left its draft in the journal,
 * with bytes the composer may not hold. Offer each such draft once in Stash.
 */
export async function offerLegacyQueueEditJournals() {
  if (offered) return;
  offered = true;
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;
  const databases = await indexedDB.databases();
  if (!databases.some((database) => database.name === "scient-queue-edit-journal")) return;
  const records: ReadonlyArray<unknown> = await journal.transaction(
    "edits",
    "readonly",
    (transaction) => result(transaction.objectStore("edits").getAll()),
  );
  const stash = usePromptStashStore.getState();
  for (const record of records) {
    if (typeof record !== "object" || record === null || "kind" in record) continue;
    const session = record as StoredSession & {
      readonly journalKey: string;
      readonly stashed?: boolean;
    };
    if (session.stashed === true) continue;
    if (stash.entries.some((entry) => entry.queueEditKey === session.journalKey)) continue;
    const edited = session.edited;
    if (edited.prompt.trim() === "" && edited.images.length === 0 && edited.files.length === 0)
      continue;
    stash.stashEntry({
      id: `queue-stash-${session.journalKey}-edited`,
      queueEditKey: session.journalKey,
      queueEditSide: "edited",
      createdAt: new Date().toISOString(),
      prompt: edited.prompt,
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });
  }
}
