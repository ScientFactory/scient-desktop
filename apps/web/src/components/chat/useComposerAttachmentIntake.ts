import { stageComposerAttachmentBatch } from "./composerAttachmentStaging";
import { composerDraftAttachmentFacts } from "./composerAttachmentFiles";
import { useComposerDraftStore } from "../../composerDraftStore";
import { questionAttachmentDraftId } from "../../questionAttachments";
import type { ChatComposerProps } from "./ChatComposer";
import {
  type ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import {
  type ComposerContextReference,
  collectInlineContextIds,
  stripInlineContextReferences,
} from "~/lib/composerContextReferences";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
} from "../../composerDraftStore";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { type PendingUserInput } from "../../session-logic";
import {
  changeQuestionAttachmentPreparation,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "./composerAttachmentFiles";
import {
  fileAttachmentTooLargeMessage,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";
import { fileContextReference, imageContextReference } from "~/lib/composerContextRecords";
import { isMacPlatform, randomUUID } from "~/lib/utils";
import {
  nextPastedTextFileName,
  pastedTextDisposition,
  wouldTextPasteExceedLimit,
} from "@t3tools/client-runtime/text-paste";
import { requestConfirmDialog } from "~/confirmDialog";
import { toastManager } from "../ui/toast";
import { type RefObject, useRef } from "react";
import { videoMimeType } from "../../types";
import {
  addPreparingComposerImages,
  isPreparingComposerImage,
  removePreparingComposerImages,
} from "./preparingComposerImages";

/**
 * Takes files into the draft: validates and reserves slots, compresses images, inserts
 * their inline chips, folds large pastes into text attachments, and confirms removing a referenced image.
 */
export function useComposerAttachmentIntake(input: {
  readonly environmentId: ChatComposerProps["environmentId"];
  readonly attachmentDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly activeThreadId: ChatComposerProps["activeThreadId"];
  readonly activePendingProgress: ChatComposerProps["activePendingProgress"];
  readonly activePendingIsResponding: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly supportsQuestionAttachments: boolean;
  readonly isLiteralPendingAnswer: boolean;
  readonly isConnecting: boolean;
  readonly projectSelectionRequired: boolean;
  readonly questionAttachmentTarget: DraftId | null;
  readonly attachmentTargetKey: string;
  readonly fileStagingLimit: number | null;
  readonly promptRef: ChatComposerProps["promptRef"];
  readonly composerImagesRef: ChatComposerProps["composerImagesRef"];
  readonly composerFilesRef: ChatComposerProps["composerFilesRef"];
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly isRevertingCheckpointRef: RefObject<boolean>;
  readonly setThreadError: ChatComposerProps["setThreadError"];
  readonly countReservedAttachments: () => number;
  readonly addComposerImage: (image: ComposerImageAttachment) => string[];
  readonly addComposerImagesToDraft: (images: ComposerImageAttachment[]) => string[];
  readonly addComposerFilesToDraft: (files: ComposerFileAttachment[]) => string[];
  readonly removeComposerImageFromDraft: (imageId: string) => void;
  readonly insertAttachmentReferences: (
    references: ReadonlyArray<ComposerContextReference>,
    selection?: { start: number; end: number },
  ) => boolean;
}) {
  const {
    activeThreadId,
    activePendingProgress,
    activePendingIsResponding,
    pendingUserInputs,
    supportsQuestionAttachments,
    isLiteralPendingAnswer,
    isConnecting,
    projectSelectionRequired,
    questionAttachmentTarget,
    attachmentTargetKey,
    fileStagingLimit,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerEditorRef,
    isRevertingCheckpointRef,
    setThreadError,
    countReservedAttachments,
    addComposerImage,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    removeComposerImageFromDraft,
    insertAttachmentReferences,
  } = input;
  const { environmentId, attachmentDraftTarget } = input;
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const otherQuestionAttachmentKeys = () => {
    const questionRequest = pendingUserInputs[0];
    return questionAttachmentTarget && questionRequest && activeThreadId
      ? questionRequest.questions
          .map((question) =>
            questionAttachmentDraftId(
              environmentId,
              activeThreadId,
              questionRequest.requestId,
              question.id,
            ),
          )
          .filter((key) => key !== questionAttachmentTarget)
      : [];
  };
  const pastedTextFileNamesRef = useRef<{ targetKey: string; names: Set<string> }>({
    targetKey: "",
    names: new Set(),
  });

  const addComposerAttachments = async (
    files: File[],
    options?: {
      readonly source?: ChatFileAttachment["source"];
      readonly selection?: { start: number; end: number };
      readonly skipImageInlineChip?: boolean;
    },
  ): Promise<boolean> => {
    if (!activeThreadId || files.length === 0 || isRevertingCheckpointRef.current) return false;
    if (
      pendingUserInputs.length > 0 &&
      (!supportsQuestionAttachments ||
        activePendingProgress?.activeQuestion?.allowCustomAnswer === false ||
        activePendingIsResponding)
    ) {
      toastManager.add({
        type: "error",
        title: "This question cannot accept attachments.",
      });
      return false;
    }
    // Captured before the awaits below: the user may switch threads while a
    // large image is being compressed, and the attachments and errors belong
    // to the thread the paste happened in.
    const threadId = activeThreadId;
    const imageAttachmentsGetChips =
      !options?.skipImageInlineChip &&
      (options?.selection !== undefined ||
        isConnecting ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        stripInlineContextReferences(promptRef.current).trim().length > 0);

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (as preparing images)
    // before the first await, keeping the total under the limit.
    let reservedCount = countReservedAttachments();
    // A pick that matches a needs-reattach marker replaces it in the draft, so
    // it must not consume a slot; a draft full of markers would otherwise hit
    // the capacity error before the replacement path could run.
    const reattachMarkers = composerFilesRef.current.filter(composerFileNeedsReattach);
    const replacedReattachMarkerIds = new Set<string>();
    const acceptedImages: File[] = [];
    const acceptedFiles: ComposerFileAttachment[] = [];
    let error: string | null = null;
    for (const file of files) {
      const attachmentKind = classifyComposerAttachmentFile(file);
      const fileMimeType =
        attachmentKind === "file"
          ? (videoMimeType({ name: file.name, mimeType: file.type }) ??
            (file.type || "application/octet-stream"))
          : file.type;
      const matchingReattachMarker =
        attachmentKind === "file"
          ? reattachMarkers.find(
              (marker) =>
                !replacedReattachMarkerIds.has(marker.id) &&
                composerFileMatchesReattachMarker(marker, {
                  name: file.name || "file",
                  mimeType: fileMimeType,
                  sizeBytes: file.size,
                }),
            )
          : undefined;
      if (matchingReattachMarker) {
        replacedReattachMarkerIds.add(matchingReattachMarker.id);
      }
      if (!matchingReattachMarker && reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
        continue;
      }
      if (attachmentKind === "image") {
        acceptedImages.push(normalizeComposerImageFileMimeType(file));
      } else {
        if (fileStagingLimit === null) {
          error = "This server does not support file attachments.";
          continue;
        }
        if (file.size <= 0) {
          error = `'${file.name}' is empty or could not be read.`;
          continue;
        }
        if (file.size > fileStagingLimit) {
          error = fileAttachmentTooLargeMessage(file.name, fileStagingLimit);
          continue;
        }
        const attachmentFile =
          file.type === fileMimeType
            ? file
            : new File([file], file.name, { type: fileMimeType, lastModified: file.lastModified });
        acceptedFiles.push({
          type: "file",
          id: randomUUID(),
          name: attachmentFile.name || "file",
          mimeType: fileMimeType,
          sizeBytes: attachmentFile.size,
          file: attachmentFile,
          ...(options?.source ? { source: options.source } : {}),
        });
      }
      if (!matchingReattachMarker) {
        reservedCount += 1;
      }
    }
    setThreadError(threadId, error);
    const preparingImages = acceptedImages.map((file) => ({
      id: randomUUID(),
      name: file.name || "image",
      file,
    }));
    if (preparingImages.length > 0)
      addPreparingComposerImages(attachmentTargetKey, preparingImages);
    if (questionAttachmentTarget)
      changeQuestionAttachmentPreparation(questionAttachmentTarget, acceptedImages.length);
    const stageAttachments = async (): Promise<boolean> => {
      const staged = await stageComposerAttachmentBatch({
        images: preparingImages,
        files: acceptedFiles,
        isImageWanted: (id) => isPreparingComposerImage(attachmentTargetKey, id),
        readExisting: () => {
          const targetDraft = getComposerDraft(attachmentDraftTarget) ?? {
            images: [],
            files: [],
            persistedAttachments: [],
          };
          return [
            ...composerDraftAttachmentFacts(targetDraft),
            ...otherQuestionAttachmentKeys().flatMap((key) => {
              const draft = getComposerDraft(key);
              return draft
                ? composerDraftAttachmentFacts(draft).map((attachment) => ({
                    id: attachment.id,
                    type: attachment.type,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                  }))
                : [];
            }),
          ].filter((attachment) => !replacedReattachMarkerIds.has(attachment.id));
        },
        stillWanted: () =>
          acceptedImages.length === 0 ||
          !questionAttachmentTarget ||
          questionAttachmentTarget in useQuestionAttachmentPreparation.getState().counts,
        commit: ({ images, files }) => {
          let insertedAny = false;
          if (files.length > 0) {
            const storedIds = new Set(addComposerFilesToDraft([...files]));
            const storedFiles = files.filter((file) => storedIds.has(file.id));
            if (storedFiles.length > 0) {
              insertedAny = insertAttachmentReferences(
                storedFiles.map(fileContextReference),
                options?.selection,
              );
            }
            if (options?.source?._tag === "pasted-text" && storedFiles.length > 0) {
              const attached = storedFiles[0]!;
              toastManager.add({
                type: "info",
                title: `Large paste attached as ${attached.name}`,
                description: `${formatAttachmentSize(attached.sizeBytes)} · Use ${
                  isMacPlatform(navigator.platform) ? "⌘⇧V" : "Ctrl+Shift+V"
                } to keep a large paste inline.`,
                data: { hideCopyButton: true },
              });
            }
          }
          const nextImages: ComposerImageAttachment[] = images.map(({ id, file }) => ({
            type: "image",
            id,
            name: file.name || "image",
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl: URL.createObjectURL(file),
            file,
          }));
          const storedImageIds = new Set(
            nextImages.length === 1 && nextImages[0]
              ? addComposerImage(nextImages[0])
              : nextImages.length > 1
                ? addComposerImagesToDraft(nextImages)
                : [],
          );
          const storedImages = nextImages.filter((image) => storedImageIds.has(image.id));
          for (const image of nextImages) {
            if (!storedImageIds.has(image.id)) URL.revokeObjectURL(image.previewUrl);
          }
          if (storedImages.length > 0 && imageAttachmentsGetChips) {
            insertedAny =
              insertAttachmentReferences(storedImages.map(imageContextReference)) || insertedAny;
          }
          return insertedAny;
        },
      });
      if (staged.error !== null) setThreadError(threadId, staged.error);
      return staged.inserted;
    };
    return await stageAttachments().finally(() => {
      const removed = removePreparingComposerImages(
        attachmentTargetKey,
        new Set(preparingImages.map((image) => image.id)),
      );
      if (questionAttachmentTarget)
        changeQuestionAttachmentPreparation(questionAttachmentTarget, -removed.size);
    });
  };

  const removeComposerImage = (imageId: string) => {
    if (removePreparingComposerImages(attachmentTargetKey, new Set([imageId])).size > 0) {
      // Its compression finishes in the background and is dropped.
      if (questionAttachmentTarget)
        changeQuestionAttachmentPreparation(questionAttachmentTarget, -1);
      return;
    }
    const image = composerImagesRef.current.find((candidate) => candidate.id === imageId);
    const referenced = collectInlineContextIds(promptRef.current).includes(
      image ? imageContextReference(image).contextId : "",
    );
    if (!referenced) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    const confirmation = requestConfirmDialog(
      `Remove ${image?.name ?? "this image"} from the message?\nIt is referenced in your text; removing it also removes every reference.`,
      { variant: "destructive" },
    );
    if (!confirmation) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    void confirmation.then((confirmed) => {
      if (confirmed) removeComposerImageFromDraft(imageId);
    });
  };

  const foldPastedText = (
    plainText: string,
    bypassAutoAttachment: boolean,
    selectionOverride?: { start: number; end: number },
  ): boolean => {
    if (isLiteralPendingAnswer) return false;
    const questionCanAttach =
      pendingUserInputs.length === 0 ||
      (supportsQuestionAttachments &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer !== false &&
        !activePendingIsResponding);
    const hasAttachmentSlot = countReservedAttachments() < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    const selection = selectionOverride ?? composerEditorRef.current?.readSelectionRange();
    const wouldExceedInputLimit = wouldTextPasteExceedLimit({
      valueLength: promptRef.current.length,
      selection: selection ?? { start: 0, end: 0 },
      textLength: plainText.length,
      maxLength: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    });
    const shouldFold =
      pastedTextDisposition({
        text: plainText,
        bypassAutoAttachment,
        wouldExceedInputLimit,
        canAttach: true,
      }) === "attachment";
    if (!shouldFold) {
      return false;
    }

    const canStageAttachment =
      Boolean(activeThreadId) &&
      !isRevertingCheckpointRef.current &&
      questionCanAttach &&
      hasAttachmentSlot;
    if (!canStageAttachment || fileStagingLimit === null) {
      if (!wouldExceedInputLimit) {
        return false;
      }
      toastManager.add({
        type: "error",
        title: "Pasted text is too large for this message",
        description: "Remove some text or an attachment, then paste again.",
        data: { hideCopyButton: true },
      });
      return true;
    }

    if (pastedTextFileNamesRef.current.targetKey !== attachmentTargetKey) {
      pastedTextFileNamesRef.current = { targetKey: attachmentTargetKey, names: new Set() };
    }
    const reservedNames = pastedTextFileNamesRef.current.names;
    for (const file of composerFilesRef.current) reservedNames.add(file.name);
    const foldedFileName = nextPastedTextFileName([...reservedNames]);
    reservedNames.add(foldedFileName);
    const foldedFile = new File([plainText], foldedFileName, {
      type: "text/plain;charset=utf-8",
    });
    if (foldedFile.size > fileStagingLimit) {
      reservedNames.delete(foldedFileName);
      if (!wouldExceedInputLimit) return false;
      toastManager.add({
        type: "error",
        title: "Pasted text is too large to attach",
        description: "Reduce the clipboard contents or save a smaller excerpt as a file.",
        data: { hideCopyButton: true },
      });
      return true;
    }

    void addComposerAttachments([foldedFile], {
      source: { _tag: "pasted-text" },
      ...(selection ? { selection } : {}),
    });
    return true;
  };

  return {
    addComposerAttachments,
    removeComposerImage,
    foldPastedText,
  };
}
