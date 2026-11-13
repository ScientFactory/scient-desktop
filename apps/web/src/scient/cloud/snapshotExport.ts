import type { ConversationSnapshotV1 } from "@t3tools/contracts";
import {
  buildConversationDocument,
  exportFileName,
  writeConversationMarkdown,
} from "@scientfactory/conversation";

function randomExportValue(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The conversation as Scient's Markdown export: readable anywhere, and Scient imports it back as a
 * new conversation (text only; attachments are listed by name).
 */
export function snapshotMarkdownFile(snapshot: ConversationSnapshotV1): File {
  const exportValue = randomExportValue();
  const document = buildConversationDocument({
    snapshot,
    exportValue,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    resolveAttachment: (attachment) => ({
      _tag: "external",
      byteLength: attachment.sizeBytes,
      sha256: null,
    }),
  });
  const markdown = writeConversationMarkdown({
    bundle: document.bundle,
    exportValue,
    exported: new Date().toISOString(),
    packaging: "text",
  });
  return new File([markdown], exportFileName(snapshot.thread.title, ".md"), {
    type: "text/markdown;charset=utf-8",
  });
}

export function saveFile(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
