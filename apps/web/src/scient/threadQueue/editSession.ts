import { flushSync } from "react-dom";
import {
  writeQueueEditJournal as write,
  readQueueEditJournals,
  readQueueEditJournal,
  initializeExtractedIntent,
  readExtractedIntent,
  updateExtractedIntent,
  type QueueEditSession as EditSession,
  type QueueEditItem,
} from "./editJournal";
import * as Schema from "effect/Schema";
import { usePromptStashStore, type PromptStashEntry } from "../../promptStashStore";
import { randomUUID } from "../../lib/utils";
import {
  ScientThreadQueueOperationError,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";
import {
  composerTargetKey,
  composerDraftHasUserContent,
  createEmptyThreadDraft,
  flushComposerDraftPersistence,
  useComposerDraftStore,
  type DraftId,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import { controlThreadQueue, extractNativeQueuedRun } from "./client";
import { restoreQueuedAttachments } from "./queueImageRestore";
import {
  decodeQueueItemComposerContext,
  assertQueueEditSelectionProvenance,
} from "./composerSnapshot";
import { composerSubmissionMatchesDraft } from "./submission";
import {
  asKnownContextRecord,
  terminalContextReference,
  previewAnnotationContextReference,
  reviewCommentContextReference,
} from "../../lib/composerContextRecords";
import {
  producerIdFromComposerContextId,
  toKindScopedComposerContextId,
  formatInlineContextReference,
} from "../../lib/composerContextReferences";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

const isQueueOperationError = Schema.is(ScientThreadQueueOperationError);
export const useQueueEditSessions = create<{
  sessions: Record<string, EditSession>;
  ready: boolean;
  error: { message: string; targetKey: string | null } | null;
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
// Browser leases prevent two windows from installing different recoverable drafts.
// The durable server extraction receipt arbitrates delivery and other devices.
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
function register(session: EditSession) {
  useQueueEditSessions.setState((state) => ({
    sessions: { ...state.sessions, [session.key]: session },
  }));
}
function unregister(session: EditSession) {
  if (useQueueEditSessions.getState().sessions[session.key]?.journalKey !== session.journalKey)
    return;
  useQueueEditSessions.setState((state) => {
    const sessions = { ...state.sessions };
    delete sessions[session.key];
    return { sessions };
  });
  releaseEditLease(session.key);
  if (
    session.intentId &&
    !Object.values(useQueueEditSessions.getState().sessions).some(
      (candidate) => candidate.intentId === session.intentId,
    )
  )
    releaseEditLease(`intent:${session.intentId}`);
}
const ending = new Set<string>();
const starting = new Set<string>();
const transferring = new Map<string, Promise<EditSession>>();
async function draftFromItem(
  target: ScopedThreadRef,
  item: QueueEditItem,
  ordinary: ComposerThreadDraftState,
) {
  const composer = decodeQueueItemComposerContext(item, target.threadId);
  if (!composer) assertQueueEditSelectionProvenance(false, item.text);
  const attachments = await restoreQueuedAttachments(target.environmentId, item.attachments);
  const localIds = new Map<string, string>();
  for (const candidate of item.context?.records ?? []) {
    const record = asKnownContextRecord(candidate);
    if (record?.kind === "image" || record?.kind === "file")
      localIds.set(
        record.attachmentId,
        producerIdFromComposerContextId(record.kind, record.contextId),
      );
  }
  return {
    draft: {
      ...createEmptyThreadDraft(),
      prompt: item.text,
      ...composer,
      contextThreadId: target.threadId,
      images: attachments.images.map((image) => ({
        ...image,
        id: localIds.get(image.id) ?? image.id,
      })),
      files: attachments.files.map((file) => ({ ...file, id: localIds.get(file.id) ?? file.id })),
      modelSelectionByProvider: item.modelSelection
        ? { [item.modelSelection.instanceId]: item.modelSelection }
        : ordinary.modelSelectionByProvider,
      activeProvider: item.modelSelection?.instanceId ?? ordinary.activeProvider,
      runtimeMode: item.runtimeMode ?? ordinary.runtimeMode,
      interactionMode: item.interactionMode ?? ordinary.interactionMode,
    },
    separated: composer !== undefined,
  };
}
function stashRecovery(session: EditSession, side: "ordinary" | "edited") {
  const draft = session[side];
  if (!composerDraftHasUserContent(draft)) return;
  const id = `queue-stash-${session.editToken}-${side}`;
  const receipt = usePromptStashStore.getState().stashEntry({
    id,
    queueEditKey: session.journalKey,
    queueEditSide: side,
    createdAt: new Date().toISOString(),
    prompt: draft.prompt,
    attachments: [],
    droppedImageNames: [],
    unreadableImageNames: [],
  });
  if (!receipt.written || !receipt.durable) {
    if (receipt.written) usePromptStashStore.getState().takeEntry(id);
    throw new Error(
      "The previous draft could not be safely stashed. Both drafts remain in the recovery journal.",
    );
  }
}
async function transfer(session: EditSession): Promise<EditSession> {
  const owned = useQueueEditSessions.getState().sessions[session.key];
  if (owned?.journalKey === session.journalKey && owned.transferred) return owned;
  if (session.transferred) return session;
  const pending = transferring.get(session.key);
  if (pending) return pending;
  const operation = (async () => {
    if (typeof session.originalTarget === "string")
      throw new Error("This recovered draft has no queue item to extract.");
    if (session.nativeRun)
      await extractNativeQueuedRun(session.originalTarget.environmentId, {
        threadId: session.originalTarget.threadId,
        runId: session.nativeRun.runId,
        expectedUpdatedAt: session.nativeRun.expectedUpdatedAt,
        editToken: session.editToken,
      });
    else
      await controlThreadQueue(session.originalTarget.environmentId, {
        threadId: session.originalTarget.threadId,
        queueItemId: session.queueItemId,
        editToken: session.editToken,
        action: "extract",
        expectedUpdatedAt: session.extractedItem?.updatedAt,
      });
    const intentId = session.intentId ?? session.editToken;
    await initializeExtractedIntent(intentId, session.extractedItem?.sourceProposedPlan);
    if (!(await acquireEditLease(`intent:${intentId}`)))
      throw new Error("This extracted intent is open in another window.");
    const result = { item: session.extractedItem };
    const restored = { draft: session.edited, separated: session.composerSeparated };
    const ordinary =
      useComposerDraftStore.getState().getComposerDraft(session.originalTarget) ?? session.ordinary;
    let complete: EditSession = {
      ...session,
      intentId,
      extractedItem: result.item,
      ordinary,
      edited: {
        ...revive(restored.draft),
        extractedIntent: { intentId, journalKey: session.journalKey },
      },
      editTarget: session.originalTarget,
      transferred: false,
      composerSeparated: restored.separated,
    };
    register(complete);
    for (;;) {
      await save({ ...complete, transferred: false });
      const beforeStash =
        useComposerDraftStore.getState().getComposerDraft(session.originalTarget) ??
        session.ordinary;
      if (beforeStash !== complete.ordinary) {
        complete = { ...complete, ordinary: beforeStash };
        continue;
      }
      stashRecovery(complete, "ordinary");
      complete = { ...complete, transferred: true };
      await save(complete);
      const current =
        useComposerDraftStore.getState().getComposerDraft(session.originalTarget) ??
        session.ordinary;
      if (current === complete.ordinary) break;
      complete = { ...complete, ordinary: current, transferred: false };
    }
    ending.add(session.journalKey);
    flushSync(() => {
      installDraft(session.originalTarget, complete.edited);
      register(complete);
      flushComposerDraftPersistence();
    });
    ending.delete(session.journalKey);
    return complete;
  })();
  transferring.set(session.key, operation);
  try {
    return await operation;
  } finally {
    transferring.delete(session.key);
  }
}
// The async journal can lag behind the composer snapshot flushed on unload.
// Keep same-intent edits and use the journal only for missing captured bytes.
function transferredDraftAfterReload(saved: EditSession): ComposerThreadDraftState {
  const current = useComposerDraftStore.getState().getComposerDraft(saved.originalTarget);
  const marker = current?.extractedIntent;
  if (
    !current ||
    !marker ||
    !("intentId" in marker) ||
    marker.intentId !== saved.intentId ||
    marker.journalKey !== saved.journalKey
  )
    return revive(saved.edited);
  return {
    ...current,
    files: current.files.map((file) => {
      if (file.file) return file;
      const captured = saved.edited.files.find(
        (candidate) =>
          candidate.id === file.id &&
          candidate.name === file.name &&
          candidate.mimeType === file.mimeType &&
          candidate.sizeBytes === file.sizeBytes,
      );
      return captured?.file ? { ...file, file: captured.file } : file;
    }),
  };
}
let loading: Promise<void> | undefined;
export function loadQueueEdits() {
  return (loading ??= (async () => {
    try {
      for (const saved of await readQueueEditJournals()) {
        const alreadyOwnedIntent = saved.intentId ? leases.has(`intent:${saved.intentId}`) : false;
        if (saved.intentId) {
          const intent = await readExtractedIntent(saved.intentId);
          if (!intent || intent.phase === "consumed") continue;
          if (!(await acquireEditLease(`intent:${saved.intentId}`))) continue;
        }
        if (!(await acquireEditLease(saved.key))) {
          if (saved.intentId && !alreadyOwnedIntent) releaseEditLease(`intent:${saved.intentId}`);
          continue;
        }
        const session = {
          ...saved,
          ordinary: revive(saved.ordinary),
          edited: saved.transferred ? transferredDraftAfterReload(saved) : revive(saved.edited),
        };
        register(session);
        try {
          if (session.transferred) {
            stashRecovery(session, "ordinary");
            ending.add(session.journalKey);
            installDraft(session.originalTarget, session.edited);
            ending.delete(session.journalKey);
          } else await transfer(session);
        } catch (cause) {
          if (
            isQueueOperationError(cause) &&
            !useQueueEditSessions.getState().sessions[session.key]?.transferred
          ) {
            if (!session.extractedItem) {
              stashRecovery(session, "ordinary");
              stashRecovery(session, "edited");
              await save({ ...session, stashed: true });
            } else await save(session.journalKey);
            unregister(session);
          }
          useQueueEditSessions.setState({
            error: { message: String(cause), targetKey: session.key },
          });
        }
      }
      useQueueEditSessions.setState({ ready: true });
    } catch (cause) {
      useQueueEditSessions.setState({
        ready: true,
        error: {
          message: `Queue editing storage is unavailable: ${String(cause)}`,
          targetKey: null,
        },
      });
    }
  })());
}
export async function beginQueueEdit(
  target: ScopedThreadRef,
  item: QueueEditItem,
  nativeRun?: EditSession["nativeRun"],
) {
  await loadQueueEdits();
  const key = composerTargetKey(target);
  const existing = useQueueEditSessions.getState().sessions[key];
  if (existing && !existing.transferred && existing.queueItemId === item.queueItemId) {
    await transfer(existing);
    return;
  }
  if (starting.has(key) || (existing && !existing.transferred))
    throw new Error("Reconcile the interrupted queue extraction first.");
  starting.add(key);
  try {
    if (existing) {
      ending.add(existing.journalKey);
      try {
        const previous = {
          ...existing,
          edited: useComposerDraftStore.getState().getComposerDraft(target) ?? existing.edited,
          stashed: true,
        };
        stashRecovery(previous, "ordinary");
        stashRecovery(previous, "edited");
        await save(previous);
        unregister(existing);
      } finally {
        ending.delete(existing.journalKey);
      }
    }
    if (!(await acquireEditLease(key)))
      throw new Error("This thread has a queue edit open in another window.");
    const ordinary =
      useComposerDraftStore.getState().getComposerDraft(target) ?? createEmptyThreadDraft();
    const restored = await draftFromItem(target, item, ordinary);
    const editToken = randomUUID();
    const session: EditSession = {
      key,
      journalKey: editToken,
      originalTarget: target,
      editTarget: target,
      queueItemId: item.queueItemId,
      editToken,
      ordinary,
      edited: restored.draft,
      extractedItem: item,
      ...(nativeRun === undefined ? {} : { nativeRun }),
      composerSeparated: restored.separated,
    };
    await save(session);
    register(session);
    try {
      await transfer(session);
    } catch (cause) {
      if (
        isQueueOperationError(cause) &&
        !useQueueEditSessions.getState().sessions[session.key]?.transferred
      ) {
        await save(session.journalKey);
        unregister(session);
      }
      throw cause;
    }
  } finally {
    starting.delete(key);
    if (!useQueueEditSessions.getState().sessions[key]) releaseEditLease(key);
  }
}
export async function flushQueueEdit(session: EditSession) {
  const complete = await transfer(session);
  const current = {
    ...complete,
    edited:
      useComposerDraftStore.getState().getComposerDraft(complete.originalTarget) ?? complete.edited,
  };
  await save(current);
  return current;
}
export async function finishQueueEdit(
  session: EditSession,
  submitted?: ComposerThreadDraftState | null,
) {
  const owned = useQueueEditSessions.getState().sessions[session.key];
  if (submitted && owned?.journalKey !== session.journalKey) return true;
  const current = useComposerDraftStore.getState().getComposerDraft(session.originalTarget);
  if (submitted && !composerSubmissionMatchesDraft(submitted, current)) {
    await flushQueueEdit(session);
    return true;
  }
  ending.add(session.journalKey);
  try {
    const complete = { ...(owned ?? session), stashed: true };
    stashRecovery(complete, "ordinary");
    await save(complete);
    let latest = useComposerDraftStore.getState().getComposerDraft(session.originalTarget);
    if (submitted && !composerSubmissionMatchesDraft(submitted, latest)) {
      for (;;) {
        const continuing = {
          ...complete,
          stashed: false,
          edited: latest ?? createEmptyThreadDraft(),
        };
        await save(continuing);
        const current = useComposerDraftStore.getState().getComposerDraft(session.originalTarget);
        if (current === latest) {
          register(continuing);
          return true;
        }
        latest = current;
      }
    }
    unregister(session);
  } finally {
    ending.delete(session.journalKey);
  }
  return false;
}
export async function stashRecoveredDraft(session: EditSession) {
  const complete = await transfer(session);
  const snapshot =
    useComposerDraftStore.getState().getComposerDraft(complete.originalTarget) ?? complete.edited;
  await resolveExtractedDraftIntent(snapshot);
  const copyKey = randomUUID();
  const copy = {
    ...complete,
    journalKey: copyKey,
    editToken: copyKey,
    ordinary: createEmptyThreadDraft(),
    edited:
      snapshot.extractedIntent && "intentId" in snapshot.extractedIntent
        ? { ...snapshot, extractedIntent: { ...snapshot.extractedIntent, journalKey: copyKey } }
        : snapshot,
    stashed: false,
  };
  await save(copy);
  try {
    stashRecovery(copy, "edited");
    await save({ ...copy, stashed: true });
  } catch (cause) {
    await save(copyKey);
    throw cause;
  }
  const lateChanges = await finishQueueEdit(complete, snapshot);
  if (!lateChanges) useComposerDraftStore.getState().clearComposerContent(complete.originalTarget);
}
useComposerDraftStore.subscribe((state, previous) => {
  for (const session of Object.values(useQueueEditSessions.getState().sessions)) {
    if (!session.transferred || ending.has(session.journalKey)) continue;
    // Transfer and recovery install this exact key. Store methods close over
    // live state, so compare the immutable snapshots rather than their getters.
    const key = composerTargetKey(session.originalTarget);
    const edited = state.draftsByThreadKey[key];
    if (!edited || edited === previous.draftsByThreadKey[key]) continue;
    void save({ ...session, edited }).catch((cause) =>
      useQueueEditSessions.setState({
        error: {
          message: `Recovered draft could not be saved: ${String(cause)}`,
          targetKey: session.key,
        },
      }),
    );
  }
});
export async function restoreQueueEditStash(
  entry: PromptStashEntry,
  target: ScopedThreadRef | DraftId,
  environmentId: EnvironmentId,
) {
  if (!entry.queueEditKey) return false;
  const session = await readQueueEditJournal(entry.queueEditKey);
  if (!session)
    throw new Error("The stashed draft could not be read. The stash entry has been kept.");
  let current =
    useComposerDraftStore.getState().getComposerDraft(target) ?? createEmptyThreadDraft();
  const side = entry.queueEditSide ?? "edited";
  const restored = revive(session[side]);
  if (side === "ordinary") delete restored.extractedIntent;
  if (restored.extractedIntent) {
    await resolveExtractedDraftIntent(restored);
    if (
      current.extractedIntent &&
      (!("intentId" in current.extractedIntent) ||
        !("intentId" in restored.extractedIntent) ||
        current.extractedIntent.intentId !== restored.extractedIntent.intentId)
    )
      throw new Error("Keep extracted intents in separate recoverable drafts.");
  }
  if (side === "edited")
    assertQueueEditSelectionProvenance(session.composerSeparated, restored.prompt);
  if (restored.files.some((file) => !file.file && file.uploadEnvironmentId !== environmentId))
    throw new Error(
      "This stash has a file available only in its original environment. Restore it there or attach the file again.",
    );
  const rewritten = new Map<string, string>();
  const annotationIds = new Map<string, string>();
  const terminalContexts = restored.terminalContexts.map((context) => {
    const imported = { ...context, id: randomUUID() };
    rewritten.set(
      terminalContextReference(context).contextId,
      terminalContextReference(imported).contextId,
    );
    return imported;
  });
  const previewAnnotations = restored.previewAnnotations.map((annotation) => {
    const imported = { ...annotation, id: randomUUID() };
    annotationIds.set(annotation.id, imported.id);
    rewritten.set(
      previewAnnotationContextReference(annotation).contextId,
      previewAnnotationContextReference(imported).contextId,
    );
    return imported;
  });
  const reviewComments = restored.reviewComments.map((comment) => {
    const imported = { ...comment, id: randomUUID() };
    rewritten.set(
      reviewCommentContextReference(comment).contextId,
      reviewCommentContextReference(imported).contextId,
    );
    return imported;
  });
  const images = restored.images.map((image) => {
    const imported = { ...image, id: annotationIds.get(image.id) ?? randomUUID() };
    rewritten.set(
      toKindScopedComposerContextId("image", image.id),
      toKindScopedComposerContextId("image", imported.id),
    );
    return imported;
  });
  const files = restored.files.map((attachment) => {
    const id = randomUUID();
    rewritten.set(
      toKindScopedComposerContextId("file", attachment.id),
      toKindScopedComposerContextId("file", id),
    );
    if (!attachment.file) return { ...attachment, id };
    const {
      uploadedAttachmentId: _upload,
      uploadEnvironmentId: _environment,
      ...file
    } = attachment;
    return { ...file, id };
  });
  const prompt = replaceComposerContextReferences(restored.prompt, (reference) => {
    const contextId = rewritten.get(reference.contextId);
    return contextId ? formatInlineContextReference({ ...reference, contextId }) : reference.source;
  });
  const combine = () => ({
    ...restored,
    ...(current.extractedIntent ? { extractedIntent: current.extractedIntent } : {}),
    prompt: [current.prompt, prompt].filter(Boolean).join("\n"),
    images: [...current.images, ...images],
    files: [...current.files, ...files],
    terminalContexts: [...current.terminalContexts, ...terminalContexts],
    previewAnnotations: [...current.previewAnnotations, ...previewAnnotations],
    reviewComments: [...current.reviewComments, ...reviewComments],
  });
  let combined = combine();
  const targetKey = composerTargetKey(target);
  const activeSession = useQueueEditSessions.getState().sessions[targetKey];
  if (activeSession && !activeSession.transferred)
    throw new Error("Reconcile this thread's interrupted edit before restoring a stash.");
  if (!(await acquireEditLease(targetKey)))
    throw new Error("This draft is open in another window.");
  const recoveryKey = activeSession?.journalKey ?? randomUUID();
  let recovery: EditSession = {
    ...(activeSession ?? session),
    // An ordinary stash restores authored content, not the extracted run's
    // plan or retry identity. An existing target edit keeps its own provenance.
    ...(!activeSession && side === "ordinary"
      ? { extractedItem: undefined, nativeRun: undefined, intentId: undefined }
      : {}),
    key: targetKey,
    journalKey: recoveryKey,
    originalTarget: target,
    editTarget: target,
    editToken: recoveryKey,
    ordinary: activeSession?.ordinary ?? createEmptyThreadDraft(),
    edited:
      combined.extractedIntent && "intentId" in combined.extractedIntent
        ? { ...combined, extractedIntent: { ...combined.extractedIntent, journalKey: recoveryKey } }
        : combined,
    transferred: true,
    stashed: false,
    composerSeparated: true,
  };
  try {
    for (;;) {
      await save(recovery);
      const latest = useComposerDraftStore.getState().getComposerDraft(target) ?? current;
      if (latest === current) break;
      current = latest;
      combined = combine();
      recovery = {
        ...recovery,
        edited:
          combined.extractedIntent && "intentId" in combined.extractedIntent
            ? {
                ...combined,
                extractedIntent: { ...combined.extractedIntent, journalKey: recoveryKey },
              }
            : combined,
      };
    }
  } catch (cause) {
    if (!activeSession) releaseEditLease(targetKey);
    throw cause;
  }
  flushSync(() => {
    ending.add(recovery.journalKey);
    installDraft(target, recovery.edited);
    register(recovery);
    ending.delete(recovery.journalKey);
  });
  const removal = usePromptStashStore.getState().takeEntry(entry.id);
  const otherStash = usePromptStashStore
    .getState()
    .entries.some((candidate) => candidate.queueEditKey === session.journalKey);
  const active = Object.values(useQueueEditSessions.getState().sessions).some(
    (candidate) => candidate.journalKey === session.journalKey,
  );
  if (removal.durable && !otherStash && !active) await save(session.journalKey);
  return true;
}

/** A hydrated composer can have provenance without a local edit session. */
export async function resolveExtractedDraftIntent(
  draft: ComposerThreadDraftState | null | undefined,
) {
  const marker = draft?.extractedIntent;
  if (!marker) return undefined;
  if (!("intentId" in marker))
    throw new Error("The extracted intent marker is invalid. Recovery has been kept.");
  const record = await readExtractedIntent(marker.intentId);
  if (!record)
    throw new Error("The extracted intent journal is unavailable. Recovery has been kept.");
  if (record.phase === "consumed")
    throw new Error(
      "This extracted intent was already submitted. Clear it before authoring a new ordinary draft.",
    );
  if (!(await acquireEditLease(`intent:${marker.intentId}`)))
    throw new Error("This extracted intent is open in another window.");
  return record;
}
export async function prepareExtractedDraftIntent(intentId: string) {
  if (!leases.has(`intent:${intentId}`))
    throw new Error("This extracted intent is owned by another window.");
  return updateExtractedIntent(intentId, (current) => {
    if (!current || current.phase === "consumed")
      throw new Error("This extracted intent was already submitted.");
    return current.packetJson ? current : { ...current, phase: "preparing" };
  });
}
export async function retireConsumedDraftIntent(
  target: ScopedThreadRef | DraftId,
  intentId: string,
  expectedJournalKey: string | undefined,
) {
  const key = composerTargetKey(target);
  const current = useComposerDraftStore.getState().getComposerDraft(target);
  const marker = current?.extractedIntent;
  if (
    marker &&
    "intentId" in marker &&
    marker.intentId === intentId &&
    marker.journalKey !== expectedJournalKey
  ) {
    // Remapping a recovery copy is not evidence of later ordinary authoring.
    // Its consumed marker remains visible/recoverable and refuses another offer.
    releaseEditLease(`intent:${intentId}`);
    flushComposerDraftPersistence();
    return;
  }
  const registered = useQueueEditSessions.getState().sessions[key];
  const session =
    registered?.intentId === intentId
      ? registered
      : marker && "intentId" in marker && marker.intentId === intentId
        ? await readQueueEditJournal(marker.journalKey)
        : undefined;
  if (session) {
    ending.add(session.journalKey);
    try {
      for (;;) {
        const latest = useComposerDraftStore.getState().getComposerDraft(target);
        const latestMarker = latest?.extractedIntent;
        if (latestMarker && "intentId" in latestMarker && latestMarker.intentId !== intentId) break;
        if (
          latestMarker &&
          "journalKey" in latestMarker &&
          latestMarker.journalKey !== expectedJournalKey
        )
          break;
        const { extractedIntent: _intent, ...ordinary } = latest ?? createEmptyThreadDraft();
        const continuing = {
          ...session,
          key,
          originalTarget: target,
          editTarget: target,
          intentId: undefined,
          nativeRun: undefined,
          extractedItem: undefined,
          edited: ordinary,
        };
        // Persist exact late file bytes/settings before removing provenance.
        // A failed storage write leaves the consumed marker and recovery intact.
        await save(continuing);
        if (useComposerDraftStore.getState().getComposerDraft(target) === latest) {
          if (latestMarker) installDraft(target, ordinary);
          if (registered?.intentId === intentId) register(continuing);
          break;
        }
      }
    } finally {
      ending.delete(session.journalKey);
    }
  }
  releaseEditLease(`intent:${intentId}`);
  flushComposerDraftPersistence();
}
export async function stashProvenanceDraft(target: ScopedThreadRef | DraftId) {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  await resolveExtractedDraftIntent(draft);
  const marker = draft?.extractedIntent;
  if (!draft || !marker || !("intentId" in marker))
    throw new Error("This extracted intent has no recovery journal.");
  const saved = await readQueueEditJournal(marker.journalKey);
  if (!saved) throw new Error("The extracted intent recovery journal is unavailable.");
  await stashRecoveredDraft({
    ...saved,
    key: composerTargetKey(target),
    originalTarget: target,
    editTarget: target,
    transferred: true,
    edited: draft,
  });
}
