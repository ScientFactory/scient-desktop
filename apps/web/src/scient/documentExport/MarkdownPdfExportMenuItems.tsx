import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { FileDown } from "lucide-react";
import { useCallback, useRef } from "react";

import { MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { scientDocumentPdfEnvironment } from "~/state/scientDocumentPdf";
import { useAtomCommand } from "~/state/use-atom-command";

import { beginScientUiOperation } from "../analytics/client";
import type { MarkdownPersistenceLease } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { DockCommandItem } from "../markdownEditor/ui/dockChrome";
import { documentPdfAvailability, renderDocumentPagePdf } from "./documentPagePdf";
import {
  deliverDocumentPdf,
  openDocumentPdf,
  releaseDocumentPdfCapture,
  saveDocumentPdfCopy,
} from "./documentPdfDelivery";
import { runMarkdownPdfExport, summarizeDocumentWarnings } from "./markdownPdfExport";

export interface MarkdownPdfExportTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly persistence: MarkdownPersistenceLease;
}

/**
 * Exports the saved file and saves the PDF through the same Save dialog as
 * every other export; the notice's Open shows it in Scient's reader.
 */
function useMarkdownPdfExport(target: MarkdownPdfExportTarget) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(target.environmentId);
  const prepare = useAtomCommand(scientDocumentPdfEnvironment.prepareMarkdown, {
    reportFailure: false,
  });
  const publish = useAtomCommand(scientDocumentPdfEnvironment.publish, { reportFailure: false });
  const runningRef = useRef(false);

  return useCallback(async () => {
    if (runningRef.current) return;
    const availability = documentPdfAvailability();
    if (!availability.available) {
      toastManager.add({
        type: "error",
        title: "PDF export unavailable",
        description: availability.reason,
      });
      return;
    }
    if (httpBaseUrl === null) {
      toastManager.add({
        type: "error",
        title: "PDF export unavailable",
        description: "This project's Scient environment is not connected.",
      });
      return;
    }
    runningRef.current = true;
    const finish = beginScientUiOperation(target.environmentId, "pdf-export", "user");
    const toastId = toastManager.add({ type: "loading", title: "Exporting PDF…", timeout: 0 });
    try {
      const published = await runMarkdownPdfExport(
        {
          flush: () => target.persistence.flushNow(),
          snapshot: () => {
            const snapshot = target.persistence.getSnapshot();
            return {
              pending: snapshot.pending || snapshot.draftSource !== snapshot.baselineSource,
              hasProblem: snapshot.conflict !== null || snapshot.error !== null,
              baselineRevision: snapshot.baselineRevision,
            };
          },
          prepare: async (input) => {
            const result = await prepare({ environmentId: target.environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
          render: (request) =>
            renderDocumentPagePdf({ httpBaseUrl, request, bridge: availability.bridge }),
          publish: async (input) => {
            const result = await publish({ environmentId: target.environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
          release: (captureId) => releaseDocumentPdfCapture(target.environmentId, captureId),
        },
        target,
      );
      toastManager.close(toastId);
      const delivery = await deliverDocumentPdf(
        { saveCopy: (pdf) => saveDocumentPdfCopy(target.environmentId, pdf) },
        published,
      );
      if (delivery._tag === "delivered") {
        const open = {
          actionProps: {
            children: "Open",
            onClick: () => openDocumentPdf(target.threadRef, published),
          },
        };
        toastManager.add(
          published.warnings.length > 0
            ? {
                type: "warning",
                title: `${delivery.title} with notes`,
                description: summarizeDocumentWarnings(published.warnings),
                ...open,
              }
            : {
                type: "success",
                title: delivery.title,
                description: delivery.description,
                ...open,
              },
        );
      }
      finish("completed");
    } catch (error) {
      toastManager.close(toastId);
      toastManager.add({
        type: "error",
        title: "Unable to export PDF",
        description: error instanceof Error ? error.message : "The PDF export failed.",
      });
      finish("failed");
    } finally {
      runningRef.current = false;
    }
  }, [httpBaseUrl, prepare, publish, target]);
}

/** Markdown editor → More actions → Export ▸ PDF / Word. */
export function MarkdownPdfExportMenuItems(
  props: MarkdownPdfExportTarget & { readonly onWordExport: () => void },
) {
  const exportPdf = useMarkdownPdfExport(props);
  const availability = documentPdfAvailability();
  return (
    <MenuSub>
      <MenuSubTrigger>
        <FileDown />
        <span>Export</span>
      </MenuSubTrigger>
      <MenuSubPopup className="w-64">
        <DockCommandItem
          disabled={!availability.available}
          onClick={() => void exportPdf()}
          {...(availability.available ? {} : { title: availability.reason })}
        >
          <span className="flex min-w-0 flex-col">
            <span>PDF</span>
            {availability.available ? null : (
              <span className="text-xs text-muted-foreground">{availability.reason}</span>
            )}
          </span>
        </DockCommandItem>
        <DockCommandItem onClick={props.onWordExport}>Word</DockCommandItem>
      </MenuSubPopup>
    </MenuSub>
  );
}
