import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import { msg } from "gt-react";

import { previewBridge } from "~/components/preview/previewBridge";
import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { browserPdfExportEnvironment } from "~/state/browserPdfExport";
import { useAtomCommand } from "~/state/use-atom-command";
import { beginScientUiOperation } from "../analytics/client";
import type { FinishScientUiOperation, ScientUiFailureCategory } from "../analytics/clientGate";

import {
  browserExportLogicalDocumentKey,
  browserExportReceiptUrl,
} from "../pdf/browserPdfExportModel";
import { scientGeneratedPdfSurface } from "../rightPanel/surfaces";
import { runBrowserPdfExport } from "./browserPdfExportCoordinator";
import { readHtmlPdfRelation, useHtmlPdfSourceStore } from "./htmlPdfSourceStore";
import { readBrowserPdfExportLease } from "./browserPdfExportOwner";

export interface BrowserPdfExportTarget {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly pageUrl: string;
  readonly activate: boolean;
  readonly isCurrent?: () => boolean;
  readonly trigger?: "user" | "agent" | "other";
}

export function useBrowserPdfExport() {
  const publishBrowserPdfExport = usePublishBrowserPdfExport();

  const exportServerPage = useExportServerPage();

  return (target: BrowserPdfExportTarget) =>
    exportBrowserPdf({ publishBrowserPdfExport, exportServerPage }, target);
}

function exportBrowserPdf(
  {
    publishBrowserPdfExport,
    exportServerPage,
  }: {
    publishBrowserPdfExport: ReturnType<typeof usePublishBrowserPdfExport>;
    exportServerPage: ReturnType<typeof useExportServerPage>;
  },
  target: BrowserPdfExportTarget,
) {
  return (async (target: BrowserPdfExportTarget) => {
    const lease = readBrowserPdfExportLease(target.threadRef, target.tabId, target.runtimeTabId);
    if (!lease || lease.pageUrl !== target.pageUrl)
      throw new Error("The Browser page changed or its PDF renderer is unavailable.");
    const isCurrent = () => {
      const current = readBrowserPdfExportLease(
        target.threadRef,
        target.tabId,
        target.runtimeTabId,
      );
      return (
        current?.owner === lease.owner &&
        current.serverEpoch === lease.serverEpoch &&
        current.pageUrl === lease.pageUrl &&
        (target.isCurrent?.() ?? true)
      );
    };
    const relation = readHtmlPdfRelation(target.threadRef, target.tabId);
    const logicalDocumentKey = LogicalDocumentKey.make(
      browserExportLogicalDocumentKey(target.pageUrl, relation?.source),
    );

    let finish: FinishScientUiOperation = () => {};
    // The step running when a failure is thrown; analytics names it, never the error.
    let step: ScientUiFailureCategory = "render-failed";
    try {
      const result = await runBrowserPdfExport(
        `${target.threadRef.environmentId}:${logicalDocumentKey}`,
        async () => {
          finish = beginScientUiOperation(
            target.threadRef.environmentId,
            "pdf-export",
            target.trigger ?? "other",
          );
          const identity = {
            logicalDocumentKey,
            operationId: ProducingOperationId.make(`browser-export-${randomUUID()}`),
            producerId: ArtifactProducerId.make("browser.export"),
          };
          const published =
            lease.owner === "server"
              ? await exportServerPage({
                  environmentId: target.threadRef.environmentId,
                  input: {
                    ...identity,
                    threadId: target.threadRef.threadId,
                    tabId: target.tabId,
                    expectedServerEpoch: lease.serverEpoch,
                    expectedSourceUrl: lease.pageUrl,
                  },
                })
              : await (async () => {
                  const bridge = previewBridge;
                  if (!bridge) {
                    step = "renderer-unavailable";
                    throw new Error("The desktop Browser is unavailable.");
                  }
                  const artifact = await bridge.exportPdf(target.runtimeTabId);
                  if (!isCurrent()) {
                    step = "source-changed";
                    throw new Error("The HTML source changed during PDF export.");
                  }
                  step = "publication-failed";
                  return publishBrowserPdfExport({
                    environmentId: target.threadRef.environmentId,
                    input: {
                      ...identity,
                      title: artifact.title || m(msg("Browser export")),
                      sourceUrl: browserExportReceiptUrl(artifact.sourceUrl),
                      profile: artifact.profile,
                      media: artifact.media,
                      warnings: artifact.warnings,
                      sourceSignals: artifact.sourceSignals,
                      bytesBase64: Base64Url.encode(artifact.data),
                    },
                  });
                })();
          if (published._tag === "Failure") throw squashAtomCommandFailure(published);
          step = "publication-failed";
          if (published.value.source._tag !== "generated-pdf") {
            throw new Error("The PDF export server returned a non-generated source.");
          }
          if (!isCurrent()) {
            step = "source-changed";
            throw new Error("The HTML source changed while the PDF was being published.");
          }
          return published.value;
        },
      );
      if (result.source._tag !== "generated-pdf") {
        throw new Error("The PDF export server returned a non-generated source.");
      }
      if (!isCurrent()) {
        step = "source-changed";
        throw new Error("The HTML source changed before the PDF could be presented.");
      }

      step = "delivery-failed";
      const surface = scientGeneratedPdfSurface(result.source);
      if (target.activate) {
        useRightPanelStore.getState().openScient(target.threadRef, surface);
      } else {
        useRightPanelStore.getState().updateScientGeneratedPdf(target.threadRef, surface);
      }
      if (relation) useHtmlPdfSourceStore.getState().recordExport(relation.id, result.source);
      finish("completed");
      return result;
    } catch (error) {
      finish("failed", step);
      throw error;
    }
  })(target);
}

function usePublishBrowserPdfExport() {
  return useAtomCommand(browserPdfExportEnvironment.publish, "publish browser PDF export");
}
function useExportServerPage() {
  return useAtomCommand(browserPdfExportEnvironment.exportServerPage, "export server browser PDF");
}
