import type { AssetCopyResult } from "@scientfactory/document-artifacts";
import { msg } from "gt-react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { ensureLocalApi } from "~/localApi";
import { getLocalFileManagerName } from "~/lib/utils";

import { presentPdfSaveCopyResult } from "./pdfSaveCopyModel";

function fileManagerName(): string {
  return getLocalFileManagerName(globalThis.navigator?.platform ?? "");
}

export function announcePdfSaveCopyResult(
  result: AssetCopyResult,
  options?: { readonly warnings?: readonly string[] },
) {
  const presentation = presentPdfSaveCopyResult(result);
  if (presentation._tag !== "notice") return presentation;
  const warnings = options?.warnings?.filter((warning) => warning.length > 0) ?? [];
  const hasWarnings = presentation.type === "success" && warnings.length > 0;
  const description = hasWarnings ? warnings.join(" · ") : presentation.description;
  const revealSavedAsset = ensureLocalApi().documents.revealSavedAsset;

  const revealAction =
    result._tag === "saved" && revealSavedAsset
      ? {
          children: m(msg("Show in {manager}", { manager: fileManagerName() })),
          onClick: () => {
            const manager = fileManagerName();
            void revealSavedAsset(result.path).catch((error) => {
              toastManager.add({
                type: "error",
                title: m(msg("Unable to show PDF in {manager}", { manager })),
                description: error instanceof Error ? error.message : m(msg("An error occurred.")),
              });
            });
          },
        }
      : undefined;

  toastManager.add({
    type: hasWarnings ? "warning" : presentation.type,
    title: !hasWarnings
      ? presentation.title
      : result._tag === "saved"
        ? m(msg("PDF saved with warnings"))
        : m(msg("PDF download started with warnings")),
    ...(description === undefined ? {} : { description }),
    ...(revealAction === undefined ? {} : { actionProps: revealAction }),
    ...(description === undefined ? { data: { compact: true } } : {}),
  });
  return presentation;
}
