import type { UploadChatAttachment } from "@t3tools/contracts";

import type { ComposerImageAttachment } from "../../composerDraftStore";

/**
 * Rebuilds composer image attachments from a queued item's upload-shaped
 * attachments so "edit" can restore exactly what was queued. Queued items
 * store data URLs (the thread.turn.start upload wire shape); the composer
 * works with File objects.
 */
export async function restoreQueuedImages(
  attachments: ReadonlyArray<UploadChatAttachment>,
): Promise<ComposerImageAttachment[]> {
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
      id: `queued_${crypto.randomUUID()}`,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      previewUrl: URL.createObjectURL(file),
      file,
    });
  }
  return restored;
}
