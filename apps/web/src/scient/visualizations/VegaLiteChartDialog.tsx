import { RotateCcwIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

import type { VegaLiteTheme, VegaLiteViewState } from "./vegaLiteRuntime";
import type { ParsedVegaLiteSource } from "./vegaLiteSpec";
import { VegaLiteView, type VegaLiteViewController } from "./VegaLiteView";

interface VegaLiteChartDialogProps {
  readonly initialState: VegaLiteViewState | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReturnState: (state: VegaLiteViewState) => void;
  readonly open: boolean;
  readonly parsed: ParsedVegaLiteSource;
  readonly theme: VegaLiteTheme;
  readonly title: string;
}

export function VegaLiteChartDialog({
  initialState,
  onOpenChange,
  onReturnState,
  open,
  parsed,
  theme,
  title,
}: VegaLiteChartDialogProps) {
  const controllerRef = useRef<VegaLiteViewController | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
    const controller = controllerRef.current;
    if (controller == null) return;
    void controller.reset().catch((cause: unknown) => {
      setErrorMessage(cause instanceof Error ? cause.message : "Unable to reset the chart.");
    });
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup
        bottomStickOnMobile={false}
        className="flex h-[min(92vh,64rem)] w-[min(94vw,96rem)] max-w-none flex-col overflow-hidden"
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
            disabled={status !== "ready"}
            onClick={handleReset}
            size="sm"
            variant="ghost"
          >
            <RotateCcwIcon />
            Reset view
          </Button>
        </DialogHeader>
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
              onReady={() => setStatus("ready")}
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
