import {
  writeQueueEditJournal as write,
  readQueueEditJournals,
  readQueueEditJournal,
  type QueueEditSession as EditSession,
} from "./editJournal";
import * as Schema from "effect/Schema";
import { usePromptStashStore, type PromptStashEntry } from "../../promptStashStore";
import { randomUUID } from "../../lib/utils";
import {
  ScientThreadQueueOperationError,
  type EnvironmentId,
  type ScopedThreadRef,
  type ScientThreadQueueItem,
} from "@t3tools/contracts";
import { create } from "zustand";
import {
  DraftId,
  composerTargetKey,
  createEmptyThreadDraft,
  useComposerDraftStore,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import { controlThreadQueue } from "./client";
import { restoreQueuedImages } from "./queueImageRestore";

const isQueueOperationError = Schema.is(ScientThreadQueueOperationError);
export const useQueueEditSessions = create<{
  sessions: Record<string, EditSession>;
  ready: boolean;
  error: string | null;
}>(() => ({ sessions: {}, ready: false, error: null }));
const lanes = new Map<string, Promise<void>>();
function save(session: EditSession | string) {
  const key = typeof session === "string" ? session : session.journalKey;
  const pending = (lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => write(session));
  lanes.set(key, pending);
  void pending
    .finally(() => {
      if (lanes.get(key) === pending) lanes.delete(key);
    })
    .catch(() => {});
  return pending;
}
function installDraft(target: ScopedThreadRef | DraftId, draft: ComposerThreadDraftState) {
  useComposerDraftStore.setState((state) => ({
    draftsByThreadKey: { ...state.draftsByThreadKey, [composerTargetKey(target)]: draft },
  }));
}
function revive(draft: ComposerThreadDraftState): ComposerThreadDraftState {
  return {
    ...draft,
    images: draft.images.map((image) => ({
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    })),
  };
}
// One browser window owns a recoverable edit for a thread at a time. The browser
// releases the lease on close/crash; server edit tokens arbitrate other devices.
const leases = new Map<string, () => void>();
async function acquireEditLease(key: string) {
  if (leases.has(key)) return true;
  if (!globalThis.navigator?.locks)
    throw new Error(
      "This browser cannot safely own a queue edit. Use HTTPS or localhost to enable browser locks.",
    );
  return new Promise<boolean>((resolve, reject) => {
    void navigator.locks
      .request(`scient-queue-edit:${key}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        await new Promise<void>((release) => {
          leases.set(key, release);
          resolve(true);
        });
      })
      .catch(reject);
  });
}
function releaseEditLease(key: string) {
  leases.get(key)?.();
  leases.delete(key);
}
let loading: Promise<void> | undefined;
export function loadQueueEdits() {
  return (loading ??= (async () => {
    try {
      const sessions = await readQueueEditJournals();
      for (const session of sessions) {
        if (session.stashed || !(await acquireEditLease(session.key))) continue;
        const ordinary = revive(session.ordinary);
        const edited = revive(session.edited);
        installDraft(session.originalTarget, ordinary);
        installDraft(session.editTarget, edited);
        useQueueEditSessions.setState((state) => ({
          sessions: { ...state.sessions, [session.key]: { ...session, ordinary, edited } },
        }));
      }
      useQueueEditSessions.setState({ ready: true });
    } catch (cause) {
      useQueueEditSessions.setState({
        ready: true,
        error: `Queue editing storage is unavailable: ${String(cause)}`,
      });
    }
  })());
}
const starting = new Set<string>();
const preparedSessions = new Map<string, EditSession>();
const ending = new Set<string>();
export async function beginQueueEdit(target: ScopedThreadRef, item: ScientThreadQueueItem) {
  await loadQueueEdits();
  const key = composerTargetKey(target);
  if (starting.has(key) || useQueueEditSessions.getState().sessions[key])
    throw new Error("Finish the current queue edit first.");
  starting.add(key);
  try {
    if (!(await acquireEditLease(key)))
      throw new Error("This thread has a queue edit open in another window.");
    const ordinary =
      useComposerDraftStore.getState().getComposerDraft(target) ?? createEmptyThreadDraft();
    const images = restoreQueuedImages(item.attachments);
    if (images.length !== item.attachments.length)
      throw new Error("An image could not be restored. The queued message was left intact.");
    const editToken = randomUUID();
    const editTarget = DraftId.make(`queue-edit-${editToken}`);
    const edited = {
      ...createEmptyThreadDraft(),
      prompt: item.text,
      images,
      modelSelectionByProvider: item.modelSelection
        ? { [item.modelSelection.instanceId]: item.modelSelection }
        : ordinary.modelSelectionByProvider,
      activeProvider: item.modelSelection?.instanceId ?? ordinary.activeProvider,
      runtimeMode: item.runtimeMode ?? ordinary.runtimeMode,
      interactionMode: item.interactionMode ?? ordinary.interactionMode,
    };
    const session: EditSession = {
      key,
      journalKey: editToken,
      originalTarget: target,
      editTarget,
      queueItemId: item.queueItemId,
      editToken,
      ordinary,
      edited,
    };
    // Persist both complete drafts (including File/Blob bytes) before withdrawal.
    await save(session);
    preparedSessions.set(key, session);
    // An ambiguous response leaves the durable edit intent recoverable. Retry
    // uses the same token and can never withdraw another editor's item.
    try {
      await controlThreadQueue(target.environmentId, {
        threadId: target.threadId,
        action: "edit",
        queueItemId: item.queueItemId,
        editToken,
      });
    } catch (cause) {
      if (isQueueOperationError(cause)) {
        await save(session.journalKey);
        throw cause;
      }
      installDraft(editTarget, edited);
      useQueueEditSessions.setState((state) => ({
        sessions: { ...state.sessions, [key]: session },
      }));
      throw cause;
    }
    installDraft(editTarget, edited);
    useQueueEditSessions.setState((state) => ({ sessions: { ...state.sessions, [key]: session } }));
  } finally {
    preparedSessions.delete(key);
    starting.delete(key);
    if (!useQueueEditSessions.getState().sessions[key]) releaseEditLease(key);
  }
}
export async function flushQueueEdit(session: EditSession) {
  const store = useComposerDraftStore.getState();
  await save({
    ...session,
    ordinary: store.getComposerDraft(session.originalTarget) ?? session.ordinary,
    edited: store.getComposerDraft(session.editTarget) ?? session.edited,
  });
}
export async function finishQueueEdit(session: EditSession, submitted?: ComposerThreadDraftState) {
  if (
    submitted &&
    useComposerDraftStore.getState().getComposerDraft(session.editTarget) !== submitted
  ) {
    await stashQueueEdit(session);
    useQueueEditSessions.setState({
      error:
        "The message was queued. Changes received during sending were kept in your prompt stash.",
    });
    return;
  }
  ending.add(session.journalKey);
  try {
    await save(session.journalKey);
  } catch (cause) {
    ending.delete(session.journalKey);
    throw cause;
  }
  useQueueEditSessions.setState((state) => {
    const sessions = { ...state.sessions };
    delete sessions[session.key];
    return { sessions };
  });
  ending.delete(session.journalKey);
  releaseEditLease(session.key);
}
useComposerDraftStore.subscribe((state, previous) => {
  for (const session of [
    ...Object.values(useQueueEditSessions.getState().sessions),
    ...preparedSessions.values(),
  ]) {
    if (ending.has(session.journalKey)) continue;
    const ordinary = state.getComposerDraft(session.originalTarget) ?? session.ordinary;
    const edited = state.getComposerDraft(session.editTarget) ?? session.edited;
    if (
      ordinary === previous.getComposerDraft(session.originalTarget) &&
      edited === previous.getComposerDraft(session.editTarget)
    )
      continue;
    void save({ ...session, ordinary, edited }).catch((cause) =>
      useQueueEditSessions.setState({ error: `Queue edit could not be saved: ${String(cause)}` }),
    );
  }
});

export async function stashQueueEdit(session: EditSession) {
  const store = useComposerDraftStore.getState();
  const edited = store.getComposerDraft(session.editTarget) ?? session.edited;
  const complete = {
    ...session,
    edited,
    ordinary: store.getComposerDraft(session.originalTarget) ?? session.ordinary,
  };
  await save(complete);
  const id = `queue-stash-${session.editToken}`;
  if (!usePromptStashStore.getState().entries.some((entry) => entry.id === id)) {
    const receipt = usePromptStashStore.getState().stashEntry({
      id,
      queueEditKey: session.journalKey,
      createdAt: new Date().toISOString(),
      prompt: edited.prompt,
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });
    if (!receipt.written || !receipt.durable)
      throw new Error("The edit could not be safely stashed. Both drafts have been kept.");
  }
  await controlThreadQueue(session.originalTarget.environmentId, {
    threadId: session.originalTarget.threadId,
    action: "stash",
    queueItemId: session.queueItemId,
    editToken: session.editToken,
  });
  ending.add(session.journalKey);
  try {
    await save({ ...complete, stashed: true });
  } catch (cause) {
    ending.delete(session.journalKey);
    throw cause;
  }
  useQueueEditSessions.setState((state) => {
    const sessions = { ...state.sessions };
    delete sessions[session.key];
    return { sessions };
  });
  ending.delete(session.journalKey);
  releaseEditLease(session.key);
}
export async function restoreQueueEditStash(
  entry: PromptStashEntry,
  target: ScopedThreadRef | DraftId,
  environmentId: EnvironmentId,
) {
  if (!entry.queueEditKey) return false;
  const session = await readQueueEditJournal(entry.queueEditKey);
  if (!session)
    throw new Error("The stashed draft could not be read. The stash entry has been kept.");
  const current =
    useComposerDraftStore.getState().getComposerDraft(target) ?? createEmptyThreadDraft();
  const restored = revive(session.edited);
  if (restored.files.some((file) => !file.file && file.uploadEnvironmentId !== environmentId))
    throw new Error(
      "This stash has a file available only in its original environment. Restore it there or attach the file again.",
    );
  installDraft(target, {
    ...current,
    prompt: [current.prompt, restored.prompt].filter(Boolean).join("\n"),
    images: [
      ...current.images,
      ...restored.images.map((image) => ({ ...image, id: `queue-stash-${randomUUID()}` })),
    ],
    files: [
      ...current.files,
      ...restored.files.map((attachment) => {
        if (!attachment.file) return { ...attachment, id: `queue-stash-${randomUUID()}` };
        const {
          uploadedAttachmentId: _upload,
          uploadEnvironmentId: _environment,
          ...file
        } = attachment;
        return { ...file, id: `queue-stash-${randomUUID()}` };
      }),
    ],
    terminalContexts: [...current.terminalContexts, ...restored.terminalContexts],
    elementContexts: [...current.elementContexts, ...restored.elementContexts],
    previewAnnotations: [...current.previewAnnotations, ...restored.previewAnnotations],
    reviewComments: [...current.reviewComments, ...restored.reviewComments],
  });
  // The journal remains a recovery copy; normal stash deletion removes the menu entry.
  return true;
}
