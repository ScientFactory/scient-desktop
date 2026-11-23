import {
  type EnvironmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";
import { msg } from "gt-react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import type { PersistedComposerImageAttachment } from "../../composerDraftStore";
import { composerFileDedupKey } from "../../composerDraftStore";
import { m, type MessageResolver } from "../../i18n/messages";
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
  const images = new Map<
    string,
    | ComposerImageAttachment
    | Pick<ComposerImageAttachment, "id" | "name" | "mimeType" | "sizeBytes">
  >(
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
      // A serialized image has no bytes to compare, so it matches nothing, like an unread file.
      ...("file" in image ? { dedupKey: composerImageDedupKey(image) } : {}),
      signature: composerImageSignature(image),
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

// SCIENT-FORK: staging matches images by signature before their bytes are read.
export function composerImageSignature(
  image: Pick<ComposerImageAttachment, "mimeType" | "sizeBytes" | "name">,
): string {
  // Hydrated images get fresh lastModified values, so exclude it from dedupe.
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

// Byte hashes by file; a file whose bytes were never read gets a key that matches only itself.
const composerImageFingerprints = new WeakMap<File, string>();
let unreadComposerImageCount = 0;

function composerImageFingerprint(file: File): string {
  let fingerprint = composerImageFingerprints.get(file);
  if (fingerprint === undefined) {
    fingerprint = `unread:${unreadComposerImageCount++}`;
    composerImageFingerprints.set(file, fingerprint);
  }
  return fingerprint;
}

/** Records the bytes behind an image file, so a draft drops it only as a byte-for-byte repeat. */
export function rememberComposerImageBytes(file: File, bytes: Uint8Array): void {
  // cyrb53, synchronous: crypto.subtle is missing on plain-http remote origins.
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    first = Math.imul(first ^ byte, 2654435761);
    second = Math.imul(second ^ byte, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507);
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507);
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);
  composerImageFingerprints.set(file, `${second >>> 0}:${first >>> 0}`);
}

export async function readComposerImageBytes(file: File): Promise<void> {
  // An unreadable file keeps matching only itself.
  const bytes = await file.arrayBuffer().catch(() => null);
  if (bytes) rememberComposerImageBytes(file, new Uint8Array(bytes));
}

/**
 * Matches name, type, size and bytes; unread files match only themselves.
 * Producers must await readComposerImageBytes before publishing images to the draft.
 */
export function composerImageDedupKey(
  image: Pick<ComposerImageAttachment, "mimeType" | "sizeBytes" | "name" | "file">,
): string {
  return `${composerImageSignature(image)}\u0000${composerImageFingerprint(image.file)}`;
}

// Compression changes an image's bytes, so a compressed image answers for the file it came from.
const composerImageSourceKeys = new WeakMap<File, string>();

/** A pasted image's name, type and size: a guess, before its bytes are read, that the draft has it. */
export function composerImageSourceKey(file: File): string {
  return (
    composerImageSourceKeys.get(file) ??
    composerImageSignature({
      mimeType: file.type,
      sizeBytes: file.size,
      name: file.name || "image",
    })
  );
}

export function rememberComposerImageSource(source: File, prepared: File): void {
  if (prepared !== source) composerImageSourceKeys.set(prepared, composerImageSourceKey(source));
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
  resolve: MessageResolver = m,
): string | null {
  if (input.files.length === 0) {
    return null;
  }
  if (!input.attachmentUploadsCapabilityKnown) {
    return resolve(msg("Waiting for the server before file attachments can send"));
  }
  const maxFileAttachmentBytes = fileAttachmentStagingLimit(input);
  if (maxFileAttachmentBytes === null) {
    return resolve(
      msg("This server does not accept file attachments right now. Remove the files to send."),
    );
  }
  const oversizedFile = input.files.find((file) => file.sizeBytes > maxFileAttachmentBytes);
  if (oversizedFile) {
    return fileAttachmentTooLargeMessage(oversizedFile.name, maxFileAttachmentBytes, resolve);
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

function isOnlyFileNames(text: string, files: ReadonlyArray<File>): boolean {
  const names = new Set(files.map((file) => file.name));
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .every((line) => names.has(line));
}

/**
 * A browser's Copy Image puts only an <img> in text/html; a chat message (QQ, WeChat) puts its text
 * beside the <img>; rich text sources (Word, Pages) put only the text there.
 */
export function clipboardHtmlImageContent(html: string): "only-image" | "image-and-text" | "none" {
  if (html.length === 0) return "none";
  const body = new DOMParser().parseFromString(html, "text/html").body;
  if (body.querySelector("img") === null) return "none";
  return (body.textContent ?? "").trim().length === 0 ? "only-image" : "image-and-text";
}

function isPastedImageFile(file: File): boolean {
  const classification = classifyComposerAttachmentFile(file);
  // SCIENT-FORK:START — non-vision image formats classify as files but still paste as pictures.
  return classification === "image" || file.type.toLowerCase().startsWith("image/");
  // SCIENT-FORK:END
}

/** The images of a message copied with its text: they attach while the text pastes as text. */
export function imagesToAttachBesidePastedText(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
  readonly bypassAutoAttachment?: boolean;
  readonly htmlHasImageAndText: boolean;
}): File[] {
  if (input.bypassAutoAttachment || input.plainText.length === 0 || !input.htmlHasImageAndText) {
    return [];
  }
  return input.files.filter(isPastedImageFile);
}

export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
  readonly bypassAutoAttachment?: boolean;
  readonly htmlIsOnlyImage?: boolean;
}): boolean {
  // Paste as Text keeps the text even when the source also put an image of it on the clipboard.
  if (input.bypassAutoAttachment && input.plainText.length > 0) return false;
  if (
    input.files.some(
      (file) => isDngFile(file) || isSvgAttachment({ name: file.name, mimeType: file.type }),
    )
  ) {
    return true;
  }
  const hasImage = input.files.some(isPastedImageFile);
  if (input.plainText.length === 0) {
    return hasImage || input.files.some((file) => classifyComposerAttachmentFile(file) === "file");
  }
  // Rich text sources (Word, Pages) add a picture of the text. Copy Image adds the image URL as
  // text beside an <img>, and a Finder copy adds the file names.
  return (
    hasImage && (input.htmlIsOnlyImage === true || isOnlyFileNames(input.plainText, input.files))
  );
}
