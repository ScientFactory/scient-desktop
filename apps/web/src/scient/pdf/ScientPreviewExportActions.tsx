import type { ScopedThreadRef } from "@t3tools/contracts";
import { Download, FileDown, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";

import { readHtmlPdfRelation } from "../documentExport/htmlPdfSourceStore";
import { useBrowserPdfExport } from "../documentExport/useBrowserPdfExport";
import { ScientTooltip } from "../presentation/ScientTooltip";
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const exportPdf = useCallback(
    async (action: PdfExportAction) => {
      if (!previewBridge || !props.runtimeTabId || !props.pageUrl || exportPendingRef.current)
        return;
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
    },
    [
      exportBrowserPdf,
      props.pageUrl,
      props.runtimeTabId,
      props.tabId,
      props.threadRef,
      savePdfCopy,
    ],
  );

  if (!previewBridge) return null;

  return (
    <Menu>
      <ScientTooltip content={exporting ? "Exporting PDF…" : "Export PDF"}>
        <MenuTrigger
          render={
            <Button
              variant={exporting ? "secondary" : "ghost"}
              size="icon-xs"
              aria-label="Export PDF"
              type="button"
              disabled={props.disabled || exporting}
            />
          }
        >
          <FileDown className={exporting ? "animate-pulse" : undefined} />
        </MenuTrigger>
      </ScientTooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-40">
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
      </MenuPopup>
    </Menu>
  );
}
