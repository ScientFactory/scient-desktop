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
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { scientDocumentPdfEnvironment } from "~/state/scientDocumentPdf";
import { readPreparedConnection } from "~/state/session";

import { saveFailureMessage } from "../conversationExport/exportActions";
import { pdfSourceAssetResource, saveResolvedPdfCopy } from "../pdf/pdfSource";
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
  readonly saveCopy: (published: ScientDocumentPdfPublished) => Promise<DesktopAssetCopyResult>;
}

/** Saves a published PDF; a failure throws its readable message. */
export async function deliverDocumentPdf(
  dependencies: DocumentPdfDeliveryDependencies,
  published: ScientDocumentPdfPublished,
): Promise<DocumentPdfDelivery> {
  const saved = await dependencies.saveCopy(published);
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
        description: published.source.fileName,
      };
  }
}

const commandOptions = { reportFailure: false, reportDefect: false } as const;

/** Offers a published PDF through this client's Save dialog or download. */
export async function saveDocumentPdfCopy(
  environmentId: EnvironmentId,
  published: ScientDocumentPdfPublished,
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
  return saveResolvedPdfCopy(published.source, {
    url,
    expiresAt: issued.value.expiresAt,
    refresh: () => undefined,
  });
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
