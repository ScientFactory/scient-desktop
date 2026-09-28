import { exportFileName } from "@scientfactory/conversation";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopAssetCopyResult,
  EnvironmentId,
  ScientDocumentCaptureId,
  ScientDocumentPdfPublished,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { ensureLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { scientDocumentPdfEnvironment } from "~/state/scientDocumentPdf";
import { readPreparedConnection } from "~/state/session";

import { saveFailureMessage } from "../conversationExport/exportActions";
import { pdfSourceAssetResource } from "../pdf/pdfSource";
import { scientGeneratedPdfSurface } from "../rightPanel/surfaces";

/**
 * Delivering a published document PDF the way every export is delivered: the
 * native Save dialog on desktop, a download in a browser. The PDF stays in
 * Scient's generated-document store, so the notice can offer to open it in
 * the reader.
 */

export type DocumentPdfDelivery =
  | { readonly _tag: "cancelled" }
  | {
      readonly _tag: "delivered";
      /** "Export saved" or "Download started", as for every other format. */
      readonly title: string;
      /** The saved path, or the downloaded file's name. */
      readonly description: string;
    };

export interface DocumentPdfDeliveryDependencies {
  readonly saveCopy: (
    published: ScientDocumentPdfPublished,
    suggestedFileName: string,
  ) => Promise<DesktopAssetCopyResult>;
}

/** The name the Save dialog suggests for a conversation's PDF, as for its other formats. */
export function conversationPdfFileName(title: string): string {
  return exportFileName(title, ".pdf");
}

/** The name the Save dialog suggests for a project file's PDF: the file's own name. */
export function markdownPdfFileName(relativePath: string): string {
  const name = relativePath.split(/[\\/]/u).at(-1) ?? "";
  return exportFileName(name.replace(/\.(?:md|markdown)$/iu, ""), ".pdf");
}

/** Saves a published PDF under `suggestedFileName`; a failure throws its readable message. */
export async function deliverDocumentPdf(
  dependencies: DocumentPdfDeliveryDependencies,
  published: ScientDocumentPdfPublished,
  suggestedFileName: string,
): Promise<DocumentPdfDelivery> {
  const saved = await dependencies.saveCopy(published, suggestedFileName);
  switch (saved._tag) {
    case "cancelled":
      return { _tag: "cancelled" };
    case "failed":
      throw new Error(saveFailureMessage(saved));
    case "saved":
      return { _tag: "delivered", title: "Export saved", description: saved.path };
    case "download-started":
      return {
        _tag: "delivered",
        title: "Download started",
        description: suggestedFileName,
      };
  }
}

const commandOptions = { reportFailure: false, reportDefect: false } as const;

/** Offers a published PDF through this client's Save dialog or download. */
export async function saveDocumentPdfCopy(
  environmentId: EnvironmentId,
  published: ScientDocumentPdfPublished,
  suggestedFileName: string,
): Promise<DesktopAssetCopyResult> {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) return { _tag: "failed", reason: "source-unavailable" };
  const issued = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: pdfSourceAssetResource(published.source) },
    }),
    { ...commandOptions, refresh: true },
  );
  if (issued._tag === "Failure") return { _tag: "failed", reason: "source-unavailable" };
  const url = resolveAssetUrl(connection.httpBaseUrl, issued.value.relativeUrl);
  if (url === null) return { _tag: "failed", reason: "source-unavailable" };
  // The stored PDF's own name is internal; the title-based name is what every export suggests.
  return ensureLocalApi().documents.saveAssetCopy({ url, suggestedFileName });
}

/** Opens a published PDF in the reader of the conversation it was exported from. */
export function openDocumentPdf(
  threadRef: ScopedThreadRef,
  published: ScientDocumentPdfPublished,
): void {
  if (published.source._tag !== "generated-pdf") return;
  useRightPanelStore.getState().openScient(threadRef, scientGeneratedPdfSurface(published.source));
}

/** Frees a capture this desktop did not print. */
export async function releaseDocumentPdfCapture(
  environmentId: EnvironmentId,
  captureId: ScientDocumentCaptureId,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    scientDocumentPdfEnvironment.release,
    { environmentId, input: { captureId } },
    commandOptions,
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
}
