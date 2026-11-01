import type { Dispatch, SetStateAction, RefObject } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Download, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";

import { readHtmlPdfRelation } from "../documentExport/htmlPdfSourceStore";
import { useBrowserPdfExport } from "../documentExport/useBrowserPdfExport";
import { announcePdfSaveCopyResult } from "./pdfSaveCopyNotification";
import { usePdfSaveCopy } from "./usePdfSaveCopy";

type PdfExportAction = "open" | "save";

export function ScientPreviewExportActions(props: {
  readonly disabled: boolean;
  readonly pageUrl: string;
  readonly tabId: string;
  readonly runtimeTabId: string | null;
  readonly threadRef: ScopedThreadRef;
}) {
  const exportBrowserPdf = useBrowserPdfExport();
  const savePdfCopy = usePdfSaveCopy(props.threadRef.environmentId);
  const [exporting, setExporting] = useState(false);
  const exportPendingRef = useRef(false);
  const mountedRef = useRef(true);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mounted state in mountedRef for async export callbacks
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const exportPdf = (action: PdfExportAction) =>
    createPreviewPdfExport({
      props,
      exportBrowserPdf,
      savePdfCopy,
      exportPendingRef,
      mountedRef,
      setExporting,
    })(action);

  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>{exporting ? "Exporting PDF…" : "Export to PDF"}</MenuGroupLabel>
        <MenuItem
          data-export-action="open"
          disabled={props.disabled || exporting}
          onClick={() => void exportPdf("open")}
        >
          <FileText />
          Open PDF
        </MenuItem>
        <MenuItem
          data-export-action="save"
          disabled={props.disabled || exporting}
          onClick={() => void exportPdf("save")}
        >
          <Download />
          Save PDF…
        </MenuItem>
      </MenuGroup>
    </>
  );
}

function createPreviewPdfExport({
  props,
  exportBrowserPdf,
  savePdfCopy,
  exportPendingRef,
  mountedRef,
  setExporting,
}: {
  props: Parameters<typeof ScientPreviewExportActions>[0];
  exportBrowserPdf: ReturnType<typeof useBrowserPdfExport>;
  savePdfCopy: ReturnType<typeof usePdfSaveCopy>;
  exportPendingRef: RefObject<boolean>;
  mountedRef: RefObject<boolean>;
  setExporting: Dispatch<SetStateAction<boolean>>;
}) {
  return async (action: PdfExportAction) => {
    if (props.disabled || !props.runtimeTabId || !props.pageUrl || exportPendingRef.current) return;
    exportPendingRef.current = true;
    setExporting(true);
    const hadArtifact = Boolean(readHtmlPdfRelation(props.threadRef, props.tabId)?.artifactId);
    try {
      const result = await exportBrowserPdf({
        threadRef: props.threadRef,
        tabId: props.tabId,
        runtimeTabId: props.runtimeTabId,
        pageUrl: props.pageUrl,
        activate: action === "open",
        trigger: "user",
      });
      if (action === "save") {
        const saveResult = await savePdfCopy(result.source);
        announcePdfSaveCopyResult(saveResult, { warnings: result.receipt.warnings });
      } else if (result.receipt.warnings.length > 0) {
        toastManager.add({
          type: "warning",
          title: "PDF exported with warnings",
          description: result.receipt.warnings.join(" · "),
        });
      } else {
        toastManager.add({
          type: "success",
          title: hadArtifact ? "PDF updated" : "PDF exported",
          data: { compact: true, dismissAfterVisibleMs: 2_500 },
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: action === "save" ? "Unable to save PDF" : "Unable to export PDF",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      exportPendingRef.current = false;
      if (mountedRef.current) setExporting(false);
    }
  };
}
