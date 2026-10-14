import * as Schema from "effect/Schema";
import { ThreadId, PlanId } from "@t3tools/contracts";
import type { ScopedThreadRef, ScientThreadQueueItem, RunId, MessageId } from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftId } from "../../composerDraftStore";
import { createIndexedDbConnection } from "../storage/indexedDbConnection";
import { migrateQueueComposerContext } from "./composerSnapshot";

/** Local recovery payload; native run IDs never pass through the legacy queue codec. */
export type QueueEditItem = Omit<ScientThreadQueueItem, "queueItemId"> & {
  readonly queueItemId: string;
};
export type QueueEditSession = {
  key: string;
  journalKey: string;
  stashed?: boolean;
  transferred?: boolean;
  intentId?: string | undefined;
  extractedItem?: QueueEditItem | undefined;
  /** Native extraction retries target the exact captured revision and command receipt. */
  nativeRun?:
    | { readonly runId: RunId; readonly messageId: MessageId; readonly expectedUpdatedAt: string }
    | undefined;
  composerSeparated?: boolean | undefined;
  originalTarget: ScopedThreadRef | DraftId;
  editTarget: ScopedThreadRef | DraftId;
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
  contextVersion?: 2;
  ordinary: StoredDraft;
  edited: StoredDraft;
};
const journal = createIndexedDbConnection({
  name: "scient-queue-edit-journal",
  version: 2,
  upgrade: (database) => {
    if (!database.objectStoreNames.contains("edits"))
      database.createObjectStore("edits", { keyPath: "journalKey" });
    if (!database.objectStoreNames.contains("files")) database.createObjectStore("files");
  },
  blockedMessage: "Close older Scient windows and reload to recover queue editing storage.",
});
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}
// Attachment bytes are written once per object, not cloned on every keystroke.
// Keys are journal-owned so completion can remove precisely its own blobs.
// The record belongs to one connection: storage reopened after a close may have
// been deleted or cleared, so its blobs are written again.
const savedFilesByConnection = new WeakMap<IDBDatabase, Map<string, File>>();
function savedFilesFor(transaction: IDBTransaction) {
  let savedFiles = savedFilesByConnection.get(transaction.db);
  if (!savedFiles) savedFilesByConnection.set(transaction.db, (savedFiles = new Map()));
  return savedFiles;
}
export async function writeQueueEditJournal(session: QueueEditSession | string) {
  await journal.transaction(["edits", "files"], "readwrite", (transaction) =>
    writeJournal(transaction, session),
  );
}
function writeJournal(transaction: IDBTransaction, session: QueueEditSession | string) {
  return new Promise<void>((resolve, reject) => {
    const savedFiles = savedFilesFor(transaction);
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
        contextVersion: 2,
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
function decode(session: StoredSession): Promise<QueueEditSession> {
  return journal.transaction("files", "readonly", (transaction) =>
    decodeDrafts(transaction.objectStore("files"), session),
  );
}
async function decodeDrafts(
  files: IDBObjectStore,
  session: StoredSession,
): Promise<QueueEditSession> {
  const savedFiles = savedFilesFor(files.transaction);
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
      ...(session.contextVersion === 2 ? {} : migrateQueueComposerContext(value)),
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
  const entries: (StoredSession | ExtractedIntentRecord)[] = await journal.transaction(
    "edits",
    "readonly",
    (transaction) => result(transaction.objectStore("edits").getAll()),
  );
  return Promise.all(
    entries
      .filter((entry): entry is StoredSession => !("kind" in entry) && !entry.stashed)
      .map(decode),
  );
}
export async function readQueueEditJournal(key: string): Promise<QueueEditSession | undefined> {
  const entry: StoredSession | undefined = await journal.transaction(
    "edits",
    "readonly",
    (transaction) => result(transaction.objectStore("edits").get(key)),
  );
  return entry ? decode(entry) : undefined;
}

const ExtractedIntentRecordSchema = Schema.Struct({
  kind: Schema.Literal("extracted-intent"),
  journalKey: Schema.String,
  intentId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  phase: Schema.Literals(["active", "preparing", "submitted-unknown", "consumed"]),
  sourceProposedPlan: Schema.optionalKey(Schema.Struct({ threadId: ThreadId, planId: PlanId })),
  packetJson: Schema.optionalKey(Schema.String),
  draftFingerprint: Schema.optionalKey(Schema.String),
  boundJournalKey: Schema.optionalKey(Schema.String),
  consumedCommandId: Schema.optionalKey(Schema.String),
});
export type ExtractedIntentRecord = typeof ExtractedIntentRecordSchema.Type;
const decodeIntent = Schema.decodeUnknownSync(ExtractedIntentRecordSchema);

/** Same existing IDB store, not another queue ledger. Atomic updates serialize
 * phase/packet changes across tabs. Browser locks own the live writer. */
export async function updateExtractedIntent(
  intentId: string,
  update: (current: ExtractedIntentRecord | undefined) => ExtractedIntentRecord,
): Promise<ExtractedIntentRecord> {
  return journal.transaction("edits", "readwrite", (transaction) =>
    updateIntent(transaction, intentId, update),
  );
}
function updateIntent(
  transaction: IDBTransaction,
  intentId: string,
  update: (current: ExtractedIntentRecord | undefined) => ExtractedIntentRecord,
): Promise<ExtractedIntentRecord> {
  return new Promise((resolve, reject) => {
    const entries = transaction.objectStore("edits");
    const request = entries.get(`intent:${intentId}`);
    let saved: ExtractedIntentRecord;
    let failure: unknown;
    request.addEventListener("success", () => {
      try {
        saved = decodeIntent(
          update(request.result === undefined ? undefined : decodeIntent(request.result)),
        );
        if (saved.intentId !== intentId || saved.journalKey !== `intent:${intentId}`)
          throw new Error("The extracted intent identity changed. Recovery has been kept.");
        entries.put(saved);
      } catch (cause) {
        failure = cause;
        transaction.abort();
      }
    });
    transaction.addEventListener("complete", () => resolve(saved));
    transaction.addEventListener("error", () => reject(failure ?? transaction.error));
    transaction.addEventListener("abort", () =>
      reject(failure ?? transaction.error ?? new Error("Intent storage was interrupted.")),
    );
  });
}
export async function readExtractedIntent(
  intentId: string,
): Promise<ExtractedIntentRecord | undefined> {
  const value: unknown = await journal.transaction("edits", "readonly", (transaction) =>
    result(transaction.objectStore("edits").get(`intent:${intentId}`)),
  );
  if (value === undefined) return undefined;
  const record = decodeIntent(value);
  if (record.intentId !== intentId || record.journalKey !== `intent:${intentId}`)
    throw new Error("The extracted intent storage identity is invalid. Recovery has been kept.");
  return record;
}
export async function initializeExtractedIntent(intentId: string, sourceProposedPlan?: unknown) {
  return updateExtractedIntent(
    intentId,
    (current) =>
      current ??
      decodeIntent({
        kind: "extracted-intent",
        journalKey: `intent:${intentId}`,
        intentId,
        phase: "active",
        ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
      }),
  );
}
