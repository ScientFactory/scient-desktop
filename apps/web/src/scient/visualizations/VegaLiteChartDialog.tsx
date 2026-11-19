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
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useRef, useState } from "react";

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
  const gt = useGT();
  const messages = useMessages();
  const controllerRef = useRef<VegaLiteViewController | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousOpenRef = useRef(open);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<DialogAction>(null);
  const [actionNotice, setActionNotice] = useState<{
    readonly message: string;
    readonly copiedKind?: "source";
  } | null>(null);
  const actionMessage = actionNotice === null ? null : messages(actionNotice.message);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the action-message timer on unmount
  useEffect(
    () => () => {
      if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    },
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets dialog state each time the dialog opens
  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setStatus("loading");
      setErrorMessage(null);
      setActiveAction(null);
      setActionNotice(null);
    }
    previousOpenRef.current = open;
  }, [open]);

  const showTransientMessage = (message: string, copiedKind?: "source") => {
    if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    setActionNotice({ message, ...(copiedKind ? { copiedKind } : {}) });
    messageTimerRef.current = setTimeout(() => {
      messageTimerRef.current = null;
      setActionNotice(null);
    }, 1_500);
  };

  const showPersistentMessage = (message: string) => {
    if (messageTimerRef.current != null) {
      clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
    setActionNotice({ message });
  };

  const runControllerAction = (
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
  };

  const handleCopySource = () => {
    if (navigator.clipboard?.writeText == null) {
      showPersistentMessage(msg("Clipboard access is unavailable."));
      return;
    }
    if (activeAction != null) return;
    setActiveAction("copy-source");
    void navigator.clipboard.writeText(source).then(
      () => {
        setActiveAction(null);
        showTransientMessage(msg("Source copied"), "source");
      },
      (cause: unknown) => {
        console.error("[scient-visualizations] Unable to copy expanded chart source", cause);
        setActiveAction(null);
        showPersistentMessage(msg("Unable to copy the chart source."));
      },
    );
  };

  const handleDownloadSource = () => {
    try {
      downloadVegaLiteSource(source, exportTitle);
    } catch (cause) {
      console.error("[scient-visualizations] Unable to download expanded chart source", cause);
      showPersistentMessage(msg("Unable to download the Vega-Lite source."));
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      const state = controllerRef.current?.getState();
      if (state != null) onReturnState(state);
    }
    onOpenChange(nextOpen);
  };

  const handleReset = () => {
    runControllerAction(
      "reset",
      (controller) => controller.reset(),
      msg("View reset"),
      msg("Unable to reset the chart view."),
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup bottomStickOnMobile={false} layout="visual">
        <DialogHeader layout="visual">
          <div className="min-w-0 flex-1">
            <DialogTitle size="compact">
              <span className="block truncate">{title}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <T>
                Expanded interactive Vega-Lite chart. Selections and controls return to the inline
                chart when this view closes.
              </T>
            </DialogDescription>
          </div>
          <Button
            aria-label={gt("Reset chart interaction")}
            disabled={status !== "ready" || activeAction != null}
            onClick={handleReset}
            size="sm"
            variant="ghost"
          >
            <RotateCcwIcon />
            <T>Reset view</T>
          </Button>
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        aria-label={gt("More chart actions")}
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
              <TooltipPopup side="bottom">
                <T>More chart actions</T>
              </TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-52">
              <MenuItem disabled={activeAction != null} onClick={handleCopySource}>
                {actionNotice?.copiedKind === "source" ? <CheckIcon /> : <CopyIcon />}
                {activeAction === "copy-source" ? gt("Copying source…") : gt("Copy source")}
              </MenuItem>
              <MenuItem disabled={activeAction != null} onClick={handleDownloadSource}>
                <FileBracesIcon />
                <T>Download Vega-Lite JSON</T>
              </MenuItem>
              <MenuItem
                disabled={status !== "ready" || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-svg",
                    (controller) => downloadVegaLiteSvg(controller, exportTitle),
                    null,
                    msg("Unable to create the SVG image."),
                  )
                }
              >
                <DownloadIcon />
                <T>Download current SVG</T>
              </MenuItem>
              <MenuItem
                disabled={status !== "ready" || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "copy-png",
                    copyVegaLitePng,
                    msg("Image copied"),
                    msg("Copy image is unavailable. You can download the PNG instead."),
                  )
                }
              >
                <ImageIcon />
                {activeAction === "copy-png" ? gt("Copying image…") : gt("Copy current image")}
              </MenuItem>
              <MenuItem
                disabled={status !== "ready" || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-png",
                    (controller) => downloadVegaLitePng(controller, exportTitle),
                    null,
                    msg("Unable to create the PNG image."),
                  )
                }
              >
                <FileImageIcon />
                {activeAction === "download-png" ? gt("Creating PNG…") : gt("Download current PNG")}
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
        <div className="scrollbar-gutter-both relative min-h-0 flex-1 overflow-auto bg-secondary/30 p-4 sm:p-8">
          {status === "loading" ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              <T>Rendering interactive chart…</T>
            </div>
          ) : null}
          {status === "error" ? (
            <div className="flex min-h-64 items-center justify-center text-muted-foreground text-sm">
              {errorMessage || gt("Unable to render this chart.")}
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
