import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileBracesIcon,
  FileImageIcon,
  ImageIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import {
  copyVegaLitePng,
  downloadVegaLitePng,
  downloadVegaLiteSource,
  downloadVegaLiteSvg,
} from "./vegaLiteExport";
import type { VegaLiteTheme, VegaLiteViewState } from "./vegaLiteRuntime";
import type { ParsedVegaLiteSource } from "./vegaLiteSpec";
import { VegaLiteView, type VegaLiteViewController } from "./VegaLiteView";

type DialogAction = "copy-source" | "copy-png" | "download-png" | "download-svg" | "reset" | null;

interface VegaLiteChartDialogProps {
  readonly exportTitle: string | null;
  readonly initialState: VegaLiteViewState | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReturnState: (state: VegaLiteViewState) => void;
  readonly open: boolean;
  readonly parsed: ParsedVegaLiteSource;
  readonly source: string;
  readonly theme: VegaLiteTheme;
  readonly title: string;
}

export function VegaLiteChartDialog({
  exportTitle,
  initialState,
  onOpenChange,
  onReturnState,
  open,
  parsed,
  source,
  theme,
  title,
}: VegaLiteChartDialogProps) {
  const controllerRef = useRef<VegaLiteViewController | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousOpenRef = useRef(open);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<DialogAction>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setStatus("loading");
      setErrorMessage(null);
      setActiveAction(null);
      setActionMessage(null);
    }
    previousOpenRef.current = open;
  }, [open]);

  const showTransientMessage = useCallback((message: string) => {
    if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    setActionMessage(message);
    messageTimerRef.current = setTimeout(() => {
      messageTimerRef.current = null;
      setActionMessage(null);
    }, 1_500);
  }, []);

  const showPersistentMessage = useCallback((message: string) => {
    if (messageTimerRef.current != null) {
      clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
    setActionMessage(message);
  }, []);

  const runControllerAction = useCallback(
    (
      action: Exclude<DialogAction, "copy-source" | null>,
      operation: (controller: VegaLiteViewController) => Promise<void>,
      successMessage: string | null,
      failureMessage: string,
    ) => {
      const controller = controllerRef.current;
      if (controller == null || activeAction != null) return;
      setActiveAction(action);
      void operation(controller).then(
        () => {
          setActiveAction(null);
          if (successMessage != null) showTransientMessage(successMessage);
        },
        (cause: unknown) => {
          console.error("[scient-visualizations] Expanded chart action failed", action, cause);
          setActiveAction(null);
          showPersistentMessage(failureMessage);
        },
      );
    },
    [activeAction, showPersistentMessage, showTransientMessage],
  );

  const handleCopySource = useCallback(() => {
    if (navigator.clipboard?.writeText == null) {
      showPersistentMessage("Clipboard access is unavailable.");
      return;
    }
    if (activeAction != null) return;
    setActiveAction("copy-source");
    void navigator.clipboard.writeText(source).then(
      () => {
        setActiveAction(null);
        showTransientMessage("Source copied");
      },
      (cause: unknown) => {
        console.error("[scient-visualizations] Unable to copy expanded chart source", cause);
        setActiveAction(null);
        showPersistentMessage("Unable to copy the chart source.");
      },
    );
  }, [activeAction, showPersistentMessage, showTransientMessage, source]);

  const handleDownloadSource = useCallback(() => {
    try {
      downloadVegaLiteSource(source, exportTitle);
    } catch (cause) {
      console.error("[scient-visualizations] Unable to download expanded chart source", cause);
      showPersistentMessage("Unable to download the Vega-Lite source.");
    }
  }, [exportTitle, showPersistentMessage, source]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        const state = controllerRef.current?.getState();
        if (state != null) onReturnState(state);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, onReturnState],
  );

  const handleReset = useCallback(() => {
    runControllerAction(
      "reset",
      (controller) => controller.reset(),
      "View reset",
      "Unable to reset the chart view.",
    );
  }, [runControllerAction]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup
        bottomStickOnMobile={false}
        className="scient-visual-dialog flex max-w-none flex-col overflow-hidden"
      >
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 pe-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">{title}</DialogTitle>
            <DialogDescription className="sr-only">
              Expanded interactive Vega-Lite chart. Selections and controls return to the inline
              chart when this view closes.
            </DialogDescription>
          </div>
          <Button
            aria-label="Reset chart interaction"
            disabled={status !== "ready" || activeAction != null}
            onClick={handleReset}
            size="sm"
            variant="ghost"
          >
            <RotateCcwIcon />
            Reset view
          </Button>
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        aria-label="More chart actions"
                        disabled={activeAction != null}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      />
                    }
                  />
                }
              >
                <EllipsisIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">More chart actions</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-52">
              <MenuItem disabled={activeAction != null} onClick={handleCopySource}>
                {actionMessage === "Source copied" ? <CheckIcon /> : <CopyIcon />}
                {activeAction === "copy-source" ? "Copying source…" : "Copy source"}
              </MenuItem>
              <MenuItem disabled={activeAction != null} onClick={handleDownloadSource}>
                <FileBracesIcon />
                Download Vega-Lite JSON
              </MenuItem>
              <MenuItem
                disabled={status !== "ready" || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-svg",
                    (controller) => downloadVegaLiteSvg(controller, exportTitle),
                    null,
                    "Unable to create the SVG image.",
                  )
                }
              >
                <DownloadIcon />
                Download current SVG
              </MenuItem>
              <MenuItem
                disabled={status !== "ready" || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "copy-png",
                    copyVegaLitePng,
                    "Image copied",
                    "Copy image is unavailable. You can download the PNG instead.",
                  )
                }
              >
                <ImageIcon />
                {activeAction === "copy-png" ? "Copying image…" : "Copy current image"}
              </MenuItem>
              <MenuItem
                disabled={status !== "ready" || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-png",
                    (controller) => downloadVegaLitePng(controller, exportTitle),
                    null,
                    "Unable to create the PNG image.",
                  )
                }
              >
                <FileImageIcon />
                {activeAction === "download-png" ? "Creating PNG…" : "Download current PNG"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </DialogHeader>
        {actionMessage != null ? (
          <div
            aria-live="polite"
            className="border-b border-border/60 bg-background/70 px-4 py-2 text-muted-foreground text-xs"
          >
            {actionMessage}
          </div>
        ) : null}
        {errorMessage != null ? (
          <div
            aria-live="polite"
            className="border-b border-border/60 bg-destructive/10 px-4 py-2 text-destructive text-xs"
          >
            {errorMessage}
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1 overflow-auto bg-secondary/30 p-4 sm:p-8">
          {status === "loading" ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              Rendering interactive chart…
            </div>
          ) : null}
          {status === "error" ? (
            <div className="flex min-h-64 items-center justify-center text-muted-foreground text-sm">
              {errorMessage || "Unable to render this chart."}
            </div>
          ) : (
            <VegaLiteView
              ref={controllerRef}
              aria-label={title}
              className={status === "ready" ? "mx-auto w-full" : "invisible mx-auto w-full"}
              initialState={initialState}
              onError={(error) => {
                setErrorMessage(error.message);
                setStatus("error");
              }}
              onReady={() => {
                setErrorMessage(null);
                setStatus("ready");
              }}
              parsed={parsed}
              theme={theme}
              title={title}
            />
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
