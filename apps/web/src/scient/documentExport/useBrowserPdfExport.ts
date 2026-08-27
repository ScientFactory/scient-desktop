import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import { useCallback } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { browserPdfExportEnvironment } from "~/state/browserPdfExport";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  browserExportLogicalDocumentKey,
  browserExportReceiptUrl,
} from "../pdf/browserPdfExportModel";
import { scientGeneratedPdfSurface } from "../rightPanel/surfaces";
import { runBrowserPdfExport } from "./browserPdfExportCoordinator";
import { readHtmlPdfRelation, useHtmlPdfSourceStore } from "./htmlPdfSourceStore";

export interface BrowserPdfExportTarget {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly pageUrl: string;
  readonly activate: boolean;
  readonly isCurrent?: () => boolean;
}

export function useBrowserPdfExport() {
  const publishBrowserPdfExport = useAtomCommand(
    browserPdfExportEnvironment.publish,
    "publish browser PDF export",
  );

  return useCallback(
    async (target: BrowserPdfExportTarget) => {
      const bridge = previewBridge;
      if (!bridge) throw new Error("The desktop Browser is unavailable.");
      const relation = readHtmlPdfRelation(target.threadRef, target.tabId);
      const logicalDocumentKey = LogicalDocumentKey.make(
        browserExportLogicalDocumentKey(target.pageUrl, relation?.source),
      );

      const result = await runBrowserPdfExport(
        `${target.threadRef.environmentId}:${logicalDocumentKey}`,
        async () => {
          const artifact = await bridge.exportPdf(target.runtimeTabId);
          if (target.isCurrent && !target.isCurrent()) {
            throw new Error("The HTML source changed during PDF export.");
          }
          const published = await publishBrowserPdfExport({
            environmentId: target.threadRef.environmentId,
            input: {
              logicalDocumentKey,
              operationId: ProducingOperationId.make(`browser-export-${randomUUID()}`),
              producerId: ArtifactProducerId.make("browser.export"),
              title: artifact.title || "Browser export",
              sourceUrl: browserExportReceiptUrl(artifact.sourceUrl),
              profile: artifact.profile,
              media: artifact.media,
              warnings: artifact.warnings,
              sourceSignals: artifact.sourceSignals,
              bytesBase64: Encoding.encodeBase64Url(artifact.data),
            },
          });
          if (published._tag === "Failure") throw squashAtomCommandFailure(published);
          if (published.value.source._tag !== "generated-pdf") {
            throw new Error("The PDF export server returned a non-generated source.");
          }
          if (target.isCurrent && !target.isCurrent()) {
            throw new Error("The HTML source changed while the PDF was being published.");
          }
          return published.value;
        },
      );
      if (result.source._tag !== "generated-pdf") {
        throw new Error("The PDF export server returned a non-generated source.");
      }
      if (target.isCurrent && !target.isCurrent()) {
        throw new Error("The HTML source changed before the PDF could be presented.");
      }

      const surface = scientGeneratedPdfSurface(result.source);
      if (target.activate) {
        useRightPanelStore.getState().openScient(target.threadRef, surface);
      } else {
        useRightPanelStore.getState().updateScientGeneratedPdf(target.threadRef, surface);
      }
      if (relation) useHtmlPdfSourceStore.getState().recordExport(relation.id, result.source);
      return result;
    },
    [publishBrowserPdfExport],
  );
}
