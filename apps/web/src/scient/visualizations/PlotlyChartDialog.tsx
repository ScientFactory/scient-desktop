import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileBracesIcon,
  FileImageIcon,
  ImageIcon,
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
  copyPlotlyPng,
  downloadPlotlyPng,
  downloadPlotlySource,
  downloadPlotlySvg,
} from "./plotlyExport";
import { PlotlyInteractionToolbar } from "./PlotlyInteractionToolbar";
import type { PlotlyTheme, PlotlyViewState } from "./plotlyRuntime";
import type { ParsedPlotlySource } from "./plotlySpec";
import { PlotlyView, type PlotlyViewController } from "./PlotlyView";
import { usePlotlyViewportActivity } from "./usePlotlyViewportActivity";

type DialogAction = "copy-png" | "copy-source" | "download-png" | "download-svg" | null;

interface PlotlyChartDialogProps {
  readonly initialState: PlotlyViewState | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReturnState: (state: PlotlyViewState) => void;
  readonly open: boolean;
  readonly parsed: ParsedPlotlySource;
  readonly source: string;
  readonly theme: PlotlyTheme;
  readonly title: string;
}

export function PlotlyChartDialog({
  initialState,
  onOpenChange,
  onReturnState,
  open,
  parsed,
  source,
  theme,
  title,
}: PlotlyChartDialogProps) {
  const controllerRef = useRef<PlotlyViewController | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<"error" | "loading" | "ready">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<DialogAction>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const dialogActivity = usePlotlyViewportActivity(parsed.hasWebGl, undefined, open);

  useEffect(
    () => () => {
      if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (open) setStatus("loading");
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
      operation: (controller: PlotlyViewController) => Promise<void>,
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
          console.error("[scient-visualizations] Expanded Plotly action failed", action, cause);
          setActiveAction(null);
          showPersistentMessage(failureMessage);
        },
      );
    },
    [activeAction, showPersistentMessage, showTransientMessage],
  );

  const handleCopySource = useCallback(() => {
    if (activeAction != null) return;
    if (navigator.clipboard?.writeText == null) {
      showPersistentMessage("Clipboard access is unavailable.");
      return;
    }
    setActiveAction("copy-source");
    void navigator.clipboard.writeText(source).then(
      () => {
        setActiveAction(null);
        showTransientMessage("Source copied");
      },
      () => {
        setActiveAction(null);
        showPersistentMessage("Unable to copy the Plotly source.");
      },
    );
  }, [activeAction, showPersistentMessage, showTransientMessage, source]);

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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup
        bottomStickOnMobile={false}
        className="scient-visual-dialog flex max-w-none flex-col overflow-hidden"
      >
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 pe-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base" dir="auto">
              {title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Expanded interactive Plotly figure. The current view returns to the inline figure when
              this dialog closes.
            </DialogDescription>
          </div>
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        aria-label="More Plotly actions"
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
              <TooltipPopup side="bottom">More Plotly actions</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-56">
              <MenuItem disabled={activeAction != null} onClick={handleCopySource}>
                {actionMessage === "Source copied" ? <CheckIcon /> : <CopyIcon />}
                {activeAction === "copy-source" ? "Copying source…" : "Copy source"}
              </MenuItem>
              <MenuItem onClick={() => downloadPlotlySource(source, title)}>
                <FileBracesIcon />
                Download Plotly JSON
              </MenuItem>
              <MenuItem
                disabled={status !== "ready" || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-svg",
                    (controller) => downloadPlotlySvg(controller, title),
                    parsed.hasWebGl ? "SVG downloaded; WebGL layers are rasterized" : null,
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
                    copyPlotlyPng,
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
                    (controller) => downloadPlotlyPng(controller, title),
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
        <PlotlyInteractionToolbar
          controller={status === "ready" ? controllerRef.current : null}
          disabled={status !== "ready" || activeAction != null}
          hasCartesian={parsed.hasCartesian}
          onError={showPersistentMessage}
          scrollZoom={true}
        />
        <div
          ref={dialogActivity.ref}
          className="relative min-h-0 flex-1 bg-secondary/30 p-4 sm:p-8"
        >
          {status === "loading" ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              Rendering interactive Plotly figure…
            </div>
          ) : null}
          {open && dialogActivity.active ? (
            <PlotlyView
              key={retryVersion}
              ref={controllerRef}
              className={status === "ready" ? "h-full w-full" : "invisible h-full w-full"}
              initialState={initialState}
              onError={(error) => {
                setErrorMessage(error.message);
                setStatus("error");
              }}
              onReady={() => {
                setErrorMessage(null);
                setStatus("ready");
              }}
              onWebGlContextLost={() => {
                setErrorMessage("The graphics context was lost. Retry to recreate this figure.");
                setStatus("error");
              }}
              parsed={parsed}
              surface="expanded"
              theme={theme}
            />
          ) : null}
          {status === "error" ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Button
                onClick={() => {
                  setErrorMessage(null);
                  setStatus("loading");
                  setRetryVersion((version) => version + 1);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Retry figure
              </Button>
            </div>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
