import { composerAttachmentLimitError } from "../lib/attachmentUpload";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import { queuedEditDraftKey, queuedRunEditsAtom } from "./queued-run-edit";
import {
  appendComposerDraftAttachments,
  getComposerDraftAfterSelection,
  getComposerDraftSnapshot,
  scheduleUnusedComposerAttachmentCleanup,
} from "./use-composer-drafts";

/** Admit normalized picker/paste output against the current draft, then commit synchronously. */
export function appendPreparedComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
  options?: Pick<
    NonNullable<Parameters<typeof appendComposerDraftAttachments>[2]>,
    "appendReference" | "insertion"
  >,
): { readonly rejectedCount: number; readonly limitError: string | null } {
  if (attachments.length === 0) return { rejectedCount: 0, limitError: null };
  const draft =
    options?.appendReference && options.insertion
      ? getComposerDraftAfterSelection(draftKey, options.insertion)
      : getComposerDraftSnapshot(draftKey);
  const edit = Object.entries(appAtomRegistry.get(queuedRunEditsAtom)).find(
    ([threadKey, edit]) => queuedEditDraftKey(threadKey, edit.runId) === draftKey,
  )?.[1];
  const limitError = composerAttachmentLimitError({
    attachments: [...draft.attachments, ...attachments],
    ...(edit ? { retainedAttachments: edit.existingAttachments } : {}),
  });
  if (limitError) {
    scheduleUnusedComposerAttachmentCleanup(attachments);
    return { rejectedCount: attachments.length, limitError };
  }
  // No await between the current draft read and the existing store reducer.
  return {
    rejectedCount: appendComposerDraftAttachments(draftKey, attachments, options),
    limitError: null,
  };
}
