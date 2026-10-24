import * as Dialog from "../components/ui/Dialog";
import { useLayoutEffect, useRef } from "react";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type ServerConfig } from "@t3tools/contracts";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { nextPastedTextFileName } from "@t3tools/client-runtime/text-paste";
import type { ComposerTextPaste } from "../components/ComposerEditor";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import {
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  getComposerDraftSnapshot,
  type ComposerDraftInsertion,
} from "./use-composer-drafts";
// SCIENT-FORK:START — queued edits share the native turn's retained attachment budget.
import { appendPreparedComposerDraftAttachments } from "./composer-attachment-admission";
// SCIENT-FORK:END

export function useComposerAttachmentActions(props: {
  readonly draftKey: string | null;
  // SCIENT-FORK:START — native callbacks can predate entering a queued edit.
  readonly resolveDraftKey?: (key: string) => string;
  // SCIENT-FORK:END
  readonly serverConfig: ServerConfig | null | undefined;
  readonly locked?: boolean;
}) {
  const currentKey = useRef(props.draftKey);
  const reservedNames = useRef(new Map<string, Set<string>>());
  // SCIENT-FORK:START - native and clipboard pastes reserve names before either awaits I/O.
  const reservePastedTextFileName = (key: string, existingNames: ReadonlyArray<string>) => {
    const names = reservedNames.current.get(key) ?? new Set<string>();
    reservedNames.current.set(key, names);
    for (const name of existingNames) names.add(name);
    const name = nextPastedTextFileName([...names]);
    names.add(name);
    return name;
  };
  // SCIENT-FORK:END
  useLayoutEffect(() => {
    currentKey.current = props.draftKey;
    return () => {
      currentKey.current = null;
    };
  }, [props.draftKey]);
  // SCIENT-FORK:START — resolve the queued-edit owner both before and after intake.
  const resolveKey = (key: string | null) =>
    key !== null && props.resolveDraftKey ? props.resolveDraftKey(key) : key;
  // SCIENT-FORK:END
  const capabilities = props.serverConfig?.environment.capabilities;
  const append = async (
    key: string,
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion: ComposerDraftInsertion,
  ) => {
    // SCIENT-FORK:START - a picker may finish after changing routes or closing its queued edit.
    if (resolveKey(currentKey.current) !== key) {
      await Promise.all(
        attachments.flatMap((item) =>
          item.fileUri ? [removePersistedComposerAttachmentFile(item.fileUri)] : [],
        ),
      );
      return { rejectedCount: 0, limitError: null };
    }
    // SCIENT-FORK:END
    // SCIENT-FORK:START — admission and store commit remain on the same stack.
    return appendPreparedComposerDraftAttachments(key, attachments, {
      appendReference: true,
      insertion,
    });
    // SCIENT-FORK:END
  };
  const report = (
    title: string,
    error: string | null | undefined,
    // SCIENT-FORK:START - retained queued files can exhaust the byte budget, not just the count.
    admission: { readonly rejectedCount: number; readonly limitError: string | null },
    // SCIENT-FORK:END
  ) => {
    const problems = [
      ...(error ? [error] : []),
      // SCIENT-FORK:START - show the actual shared admission error.
      ...(admission.limitError ? [admission.limitError] : []),
      ...(!admission.limitError && admission.rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
      // SCIENT-FORK:END
    ];
    if (problems.length) Dialog.alert(title, problems.join("\n\n"));
  };
  const onPickDraftMedia = async () => {
    // SCIENT-FORK:START - resolve edit ownership when the native callback runs.
    const key = resolveKey(props.draftKey);
    // SCIENT-FORK:END
    if (!key || props.locked) return;
    const insertion = captureComposerDraftInsertion(key);
    const result = await pickComposerMedia({
      existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
      maxVideoBytes: capabilities?.attachmentUploads
        ? capabilities.fileAttachments?.maxUploadBytes
        : undefined,
    });
    report(
      "Could not attach photo or video",
      result.error,
      await append(key, result.attachments, insertion),
    );
  };
  const onPickDraftFiles = async () => {
    // SCIENT-FORK:START - resolve edit ownership when the native callback runs.
    const key = resolveKey(props.draftKey);
    // SCIENT-FORK:END
    if (!key || props.locked) return;
    const maxBytes = capabilities?.fileAttachments?.maxUploadBytes;
    if (maxBytes === undefined) {
      Dialog.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }
    const insertion = captureComposerDraftInsertion(key);
    const result = await pickComposerFiles({
      existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
      maxBytes,
    });
    report("Could not attach file", result.error, await append(key, result.files, insertion));
  };
  const onNativePasteImages = async (uris: ReadonlyArray<string>) => {
    // SCIENT-FORK:START - resolve edit ownership when the native callback runs.
    const key = resolveKey(props.draftKey);
    // SCIENT-FORK:END
    if (!key || props.locked || !uris.length) return;
    const insertion = captureComposerDraftInsertion(key);
    try {
      const images = await convertPastedImagesToAttachments({
        uris,
        existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
      });
      report("Could not paste images", null, await append(key, images, insertion));
    } catch (error) {
      Dialog.alert("Could not paste images", error instanceof Error ? error.message : "Try again.");
    }
  };
  const onNativePasteText = async (paste: ComposerTextPaste) => {
    // SCIENT-FORK:START - resolve edit ownership when the native callback runs.
    const key = resolveKey(props.draftKey);
    // SCIENT-FORK:END
    if (!key || props.locked) return;
    const maxBytes = capabilities?.attachmentUploads
      ? capabilities.fileAttachments?.maxUploadBytes
      : undefined;
    if (maxBytes === undefined) return;
    // SCIENT-FORK:START - share the reservation owner with clipboard intake.
    const name = reservePastedTextFileName(
      key,
      getComposerDraftSnapshot(key).attachments.map((attachment) => attachment.name),
    );
    // SCIENT-FORK:END
    try {
      const attachment = await createPastedTextComposerAttachment({
        text: paste.text,
        name,
        maxBytes: clampFileAttachmentUploadBytes(maxBytes),
      });
      const admission = await append(key, [attachment], { text: paste.value, ...paste.selection });
      if (admission.rejectedCount > 0) {
        await removePersistedComposerAttachmentFile(attachment.fileUri);
      }
      report("Could not attach pasted text", null, admission);
    } catch (error) {
      Dialog.alert(
        "Could not attach pasted text",
        error instanceof Error ? error.message : "Try again.",
      );
    }
  };
  return {
    onPickDraftMedia,
    onPickDraftFiles,
    onNativePasteImages,
    onNativePasteText,
    // SCIENT-FORK:START - clipboard intake shares native paste reservations.
    reservePastedTextFileName,
    // SCIENT-FORK:END
  };
}
