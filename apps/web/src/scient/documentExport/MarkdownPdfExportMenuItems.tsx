import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { FileDown } from "lucide-react";
import { useCallback, useRef } from "react";

import { MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { scientDocumentPdfEnvironment } from "~/state/scientDocumentPdf";
import { useAtomCommand } from "~/state/use-atom-command";

import { beginScientUiOperation } from "../analytics/client";
import type { MarkdownPersistenceLease } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { DockCommandItem } from "../markdownEditor/ui/dockChrome";
import { scientGeneratedPdfSurface } from "../rightPanel/surfaces";
import { documentPdfAvailability, renderDocumentPagePdf } from "./documentPagePdf";
import { runMarkdownPdfExport, summarizeDocumentWarnings } from "./markdownPdfExport";

export interface MarkdownPdfExportTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly persistence: MarkdownPersistenceLease;
}

/** Exports the saved file and opens the PDF in Scient's reader, where Save Copy lives. */
export function useMarkdownPdfExport(target: MarkdownPdfExportTarget) {
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
        },
        target,
      );
      if (published.source._tag === "generated-pdf") {
        useRightPanelStore
          .getState()
          .openScient(target.threadRef, scientGeneratedPdfSurface(published.source));
      }
      toastManager.close(toastId);
      toastManager.add(
        published.warnings.length > 0
          ? {
              type: "warning",
              title: "PDF exported with notes",
              description: summarizeDocumentWarnings(published.warnings),
            }
          : { type: "success", title: "PDF exported", data: { compact: true } },
      );
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

/** Markdown editor → More actions → Export ▸ PDF. */
export function MarkdownPdfExportMenuItems(props: MarkdownPdfExportTarget) {
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
      </MenuSubPopup>
    </MenuSub>
  );
}
