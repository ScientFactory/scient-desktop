import {
  UploadChatAttachment,
  ChatImageAttachment,
  ChatFileAttachment,
  type EnvironmentId,
  type ScientThreadQueueItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ComposerImageAttachment, ComposerFileAttachment } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { readQueuedAttachmentFile } from "./client";

/** Legacy queue images carried inline bytes instead of durable attachment IDs. */
export function restoreQueuedImages(
  attachments: ReadonlyArray<UploadChatAttachment>,
): ComposerImageAttachment[] {
  const restored: ComposerImageAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type !== "image") continue;
    const commaIndex = attachment.dataUrl.indexOf(",");
    if (!attachment.dataUrl.startsWith("data:") || commaIndex === -1) continue;
    const base64 = attachment.dataUrl.slice(commaIndex + 1);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const binary = atob(base64);
      bytes = new Uint8Array(new ArrayBuffer(binary.length));
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
    } catch {
      continue;
    }
    const file = new File([bytes], attachment.name, { type: attachment.mimeType });
    restored.push({
      type: "image",
      id: attachment.id ?? `queued_${randomUUID()}`,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      previewUrl: URL.createObjectURL(file),
      file,
      ...(attachment.source ? { source: attachment.source } : {}),
    });
  }
  return restored;
}

const isInlineAttachment = Schema.is(UploadChatAttachment);
const isQueuedImage = Schema.is(ChatImageAttachment);
const isQueuedFile = Schema.is(ChatFileAttachment);
export async function restoreQueuedAttachments(
  environmentId: EnvironmentId,
  attachments: ScientThreadQueueItem["attachments"],
) {
  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  for (const attachment of attachments) {
    if (isInlineAttachment(attachment)) {
      const restored = restoreQueuedImages([attachment])[0];
      if (!restored) throw new Error(`Could not restore attachment: ${attachment.name}`);
      images.push(restored);
      continue;
    }
    if (!isQueuedImage(attachment) && !isQueuedFile(attachment))
      throw new Error("This queued attachment cannot be restored.");
    const file = await readQueuedAttachmentFile(environmentId, attachment);
    if (isQueuedImage(attachment))
      images.push({ ...attachment, file, previewUrl: URL.createObjectURL(file) });
    else files.push({ ...attachment, file });
  }
  return { images, files };
}
