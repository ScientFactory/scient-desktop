import {
  type EnvironmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import type { PersistedComposerImageAttachment } from "../../composerDraftStore";
import { composerFileDedupKey, composerImageDedupKey } from "../../composerDraftStore";
import { isHeicImageFile } from "../../lib/imageCompression";
import { isVideoAttachment, videoMimeType } from "../../types";
import { isSvgAttachment } from "@t3tools/shared/image";

type ComposerAttachmentFileKind = "image" | "file";

/** Live and serialized images describe the same draft attachment, not two copies. */
export function composerDraftAttachmentFacts(draft: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly persistedAttachments: ReadonlyArray<PersistedComposerImageAttachment>;
}) {
  const images = new Map(
    draft.persistedAttachments.map(
      ({ id, name, mimeType, sizeBytes }) => [id, { id, name, mimeType, sizeBytes }] as const,
    ),
  );
  for (const image of draft.images) images.set(image.id, image);
  return [
    ...Array.from(images.values(), (image) => ({
      id: image.id,
      type: "image" as const,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dedupKey: composerImageDedupKey(image),
    })),
    ...draft.files.map((file) => ({
      id: file.id,
      type: file.type,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      dedupKey: composerFileDedupKey(file),
    })),
  ];
}

interface FileAttachmentCapabilityState {
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
}

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over a
 * `File` with an empty or generic MIME type.
 */
function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function inferImageMimeTypeForUnknownFile(file: Pick<File, "name" | "type">): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

export function normalizeComposerImageFileMimeType(file: File): File {
  const inferredMimeType = inferImageMimeTypeForUnknownFile(file);
  if (!inferredMimeType) {
    return file;
  }
  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified,
  });
}

function isDngFile(file: Pick<File, "name" | "type">): boolean {
  const mimeType = file.type.split(";", 1)[0]?.trim().toLowerCase();
  return (
    file.name.toLowerCase().endsWith(".dng") ||
    mimeType === "image/dng" ||
    mimeType === "image/x-dng" ||
    mimeType === "image/x-adobe-dng"
  );
}

export function composerFileAttachmentMimeType(file: Pick<File, "name" | "type">): string {
  // Downstream image detection uses MIME, even for attachments staged as files.
  if (isDngFile(file)) return "image/x-adobe-dng";
  if (isSvgAttachment({ name: file.name, mimeType: file.type })) return "image/svg+xml";
  return (
    videoMimeType({ name: file.name, mimeType: file.type }) ??
    (file.type || "application/octet-stream")
  );
}

export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (isSvgAttachment({ name: file.name, mimeType: file.type })) return "file";
  if (isDngFile(file)) return "file";
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (inferImageMimeTypeForUnknownFile(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  // SCIENT-FORK:START — non-vision formats remain file attachments.
  return isProviderSendTurnSupportedImageMimeType(file.type) ? "image" : "file";
  // SCIENT-FORK:END
}

export function isPreviewableComposerVideo(
  file: ComposerFileAttachment,
  environmentId: EnvironmentId,
): boolean {
  return (
    isVideoAttachment(file) &&
    (file.file !== null ||
      (file.uploadedAttachmentId !== undefined && file.uploadEnvironmentId === environmentId))
  );
}

export function composerOtherFilesForPresentation(
  files: ReadonlyArray<ComposerFileAttachment>,
  environmentId: EnvironmentId,
  inlineFileIds: ReadonlySet<string>,
): ComposerFileAttachment[] {
  return files.filter(
    (file) => !isPreviewableComposerVideo(file, environmentId) && !inlineFileIds.has(file.id),
  );
}

export function fileAttachmentStagingLimit(input: FileAttachmentCapabilityState): number | null {
  if (!input.attachmentUploadsCapabilityKnown) {
    return PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  }
  if (!input.supportsAttachmentUploads || input.maxFileAttachmentBytes === null) {
    return null;
  }
  return clampFileAttachmentUploadBytes(input.maxFileAttachmentBytes);
}

export function fileAttachmentCapabilityBlockReason(
  input: FileAttachmentCapabilityState & {
    readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  },
): string | null {
  if (input.files.length === 0) {
    return null;
  }
  if (!input.attachmentUploadsCapabilityKnown) {
    return "Waiting for the server before file attachments can send";
  }
  const maxFileAttachmentBytes = fileAttachmentStagingLimit(input);
  if (maxFileAttachmentBytes === null) {
    return "This server does not accept file attachments right now. Remove the files to send.";
  }
  const oversizedFile = input.files.find((file) => file.sizeBytes > maxFileAttachmentBytes);
  if (oversizedFile) {
    return fileAttachmentTooLargeMessage(oversizedFile.name, maxFileAttachmentBytes);
  }
  return null;
}

/** Release only unpersisted uploads; hydrated files still need their server copies. */
export function attachmentsToReleaseOnUploadCapabilityLoss(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): Array<ComposerImageAttachment | ComposerFileAttachment> {
  return attachments.filter(
    (attachment) => !(attachment.type === "file" && attachment.uploadedAttachmentId !== undefined),
  );
}

export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (
    input.files.some((file) => {
      if (isDngFile(file)) return true;
      const classification = classifyComposerAttachmentFile(file);
      return (
        classification === "image" ||
        file.type.toLowerCase().startsWith("image/") ||
        isSvgAttachment({ name: file.name, mimeType: file.type })
      );
    })
  ) {
    return true;
  }

  if (input.plainText.length > 0) {
    return false;
  }

  return input.files.some((file) => classifyComposerAttachmentFile(file) === "file");
}
