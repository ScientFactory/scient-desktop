import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftId } from "../../composerDraftStore";

export type QueueEditSession = {
  key: string;
  journalKey: string;
  stashed?: boolean;
  originalTarget: ScopedThreadRef;
  editTarget: DraftId;
  queueItemId: string;
  editToken: string;
  ordinary: ComposerThreadDraftState;
  edited: ComposerThreadDraftState;
};
type StoredAttachment<A> = Omit<A, "file"> & { file?: File | null; fileRef?: string };
type StoredDraft = Omit<ComposerThreadDraftState, "images" | "files"> & {
  images: StoredAttachment<ComposerThreadDraftState["images"][number]>[];
  files: StoredAttachment<ComposerThreadDraftState["files"][number]>[];
};
type StoredSession = Omit<QueueEditSession, "ordinary" | "edited"> & {
  ordinary: StoredDraft;
  edited: StoredDraft;
};
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("scient-queue-edit-journal", 2);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("edits"))
        request.result.createObjectStore("edits", { keyPath: "journalKey" });
      if (!request.result.objectStoreNames.contains("files"))
        request.result.createObjectStore("files");
    });
    request.addEventListener("success", () => {
      request.result.addEventListener("versionchange", () => request.result.close());
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
    request.addEventListener("blocked", () => {
      database = undefined;
      reject(new Error("Close older Scient windows and reload to recover queue editing storage."));
    });
  }));
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}
// Attachment bytes are written once per object, not cloned on every keystroke.
// Keys are journal-owned so completion can remove precisely its own blobs.
const savedFiles = new Map<string, File>();
export async function writeQueueEditJournal(session: QueueEditSession | string) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(["edits", "files"], "readwrite");
    const entries = transaction.objectStore("edits");
    const files = transaction.objectStore("files");
    const written = new Map<string, File>();
    const key = typeof session === "string" ? session : session.journalKey;
    if (typeof session === "string") {
      entries.delete(key);
      files.delete(IDBKeyRange.bound(`${key}:`, `${key}:\uffff`));
    } else {
      const encode = (draft: ComposerThreadDraftState, side: string): StoredDraft => {
        const attachment = <A extends { id: string; file?: File | null }>(
          value: A,
        ): StoredAttachment<A> => {
          const { file, ...metadata } = value;
          if (!file) return { ...metadata, ...(file === null ? { file: null } : {}) };
          const fileRef = `${key}:${side}:${value.id}`;
          if (savedFiles.get(fileRef) !== file) {
            files.put(file, fileRef);
            written.set(fileRef, file);
          }
          return { ...metadata, fileRef };
        };
        return {
          ...draft,
          images: draft.images.map(attachment),
          files: draft.files.map(attachment),
        };
      };
      entries.put({
        ...session,
        ordinary: encode(session.ordinary, "ordinary"),
        edited: encode(session.edited, "edited"),
      } satisfies StoredSession);
    }
    transaction.addEventListener("complete", () => {
      for (const [ref, file] of written) savedFiles.set(ref, file);
      if (typeof session === "string" || session.stashed)
        for (const ref of savedFiles.keys()) if (ref.startsWith(`${key}:`)) savedFiles.delete(ref);
      resolve();
    });
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Draft storage was interrupted.")),
    );
  });
}
async function decode(session: StoredSession): Promise<QueueEditSession> {
  const database = await db();
  const transaction = database.transaction("files", "readonly");
  const files = transaction.objectStore("files");
  const draft = async (value: StoredDraft): Promise<ComposerThreadDraftState> => {
    const attachment = async <
      A extends { name: string; mimeType: string; file?: File | null; fileRef?: string },
    >(
      value: A,
    ) => {
      const { fileRef, ...metadata } = value;
      if (!fileRef) return metadata;
      const blob: unknown = await result(files.get(fileRef));
      if (!(blob instanceof Blob))
        throw new Error(
          `The saved attachment ${value.name} is unavailable. The edit journal has been kept.`,
        );
      const file = new File([blob], value.name, { type: value.mimeType });
      savedFiles.set(fileRef, file);
      return { ...metadata, file };
    };
    const [images, genericFiles] = await Promise.all([
      Promise.all(value.images.map(attachment)),
      Promise.all(value.files.map(attachment)),
    ]);
    return {
      ...value,
      images: images.map((image) => {
        if (!image.file) throw new Error(`The saved image ${image.name} is unavailable.`);
        return { ...image, file: image.file };
      }),
      files: genericFiles.map((file) => ({ ...file, file: file.file ?? null })),
    };
  };
  const [ordinary, edited] = await Promise.all([draft(session.ordinary), draft(session.edited)]);
  return { ...session, ordinary, edited };
}
export async function readQueueEditJournals(): Promise<QueueEditSession[]> {
  const database = await db();
  const entries: StoredSession[] = await result(
    database.transaction("edits", "readonly").objectStore("edits").getAll(),
  );
  return Promise.all(entries.filter((entry) => !entry.stashed).map(decode));
}
export async function readQueueEditJournal(key: string): Promise<QueueEditSession | undefined> {
  const database = await db();
  const entry: StoredSession | undefined = await result(
    database.transaction("edits", "readonly").objectStore("edits").get(key),
  );
  return entry ? decode(entry) : undefined;
}
