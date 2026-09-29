import type {
  DesktopAssetCopyResult,
  EnvironmentId,
  ScientConversationExportFile,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { toastManager } from "../../components/ui/toast";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { exportConversation, exportFileUrl } from "./client";
import { copyMarkdownRequest } from "./exportDialog.logic";

export function exportErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The conversation could not be exported.";
}

export function localTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Saves a produced export with the same path every document uses: the native
 * Save Copy dialog on desktop, a download in the browser.
 */
export async function saveConversationExport(
  environmentId: EnvironmentId,
  file: ScientConversationExportFile,
): Promise<DesktopAssetCopyResult> {
  const url = exportFileUrl(environmentId, file.relativeUrl);
  if (url === null) return { _tag: "failed", reason: "source-unavailable" };
  return ensureLocalApi().documents.saveAssetCopy({ url, suggestedFileName: file.fileName });
}

/**
 * Copy ▸ Conversation as Markdown: copies the whole conversation as text-only
 * Markdown and reports the outcome in a toast.
 */
export async function copyConversationMarkdown(threadRef: ScopedThreadRef): Promise<void> {
  try {
    const result = await exportConversation(
      threadRef.environmentId,
      copyMarkdownRequest(threadRef.threadId, localTimeZone()),
    );
    const copied = await writeTextToClipboard(result.text ?? "", "conversation Markdown");
    if (!copied) throw new Error("The conversation has nothing to copy yet.");
    toastManager.add(
      result.warnings.length > 0
        ? {
            type: "warning",
            title: "Markdown copied with notes",
            description: result.warnings.map((warning) => warning.message).join("\n"),
          }
        : { type: "success", title: "Markdown copied" },
    );
  } catch (cause) {
    toastManager.add({
      type: "error",
      title: "Could not copy the conversation",
      description: exportErrorMessage(cause),
    });
  }
}

const SAVE_FAILURE_MESSAGES: Record<
  Extract<DesktopAssetCopyResult, { _tag: "failed" }>["reason"],
  string
> = {
  "dialog-failed": "The save dialog could not be opened.",
  "network-failed": "The export could not be downloaded from the server.",
  "source-changed": "The export changed while it was being saved. Export again.",
  "source-unavailable": "The export is no longer available. Export again.",
  "write-failed": "The file could not be written.",
};

export function saveFailureMessage(
  result: Extract<DesktopAssetCopyResult, { _tag: "failed" }>,
): string {
  return SAVE_FAILURE_MESSAGES[result.reason];
}
