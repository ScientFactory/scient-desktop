import type {
  DesktopAssetCopyResult,
  EnvironmentId,
  ScientConversationExportFile,
} from "@t3tools/contracts";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { exportFileUrl } from "./client";

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

export async function copyConversationExport(text: string): Promise<void> {
  await writeTextToClipboard(text, "conversation Markdown");
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
