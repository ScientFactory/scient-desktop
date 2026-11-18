import {
  HandIcon,
  LassoSelectIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  SquareDashedMousePointerIcon,
  type LucideIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { VisualCardToolbar } from "../presentation/VisualCardToolbar";

import type { PlotlyInteractionMode } from "./plotlyRuntime";
import type { PlotlyViewController } from "./PlotlyView";

interface PlotlyInteractionToolbarProps {
  readonly compact?: boolean;
  readonly controller: PlotlyViewController | null;
  readonly initialMode: PlotlyInteractionMode | null;
  readonly disabled: boolean;
  readonly hasCartesian: boolean;
  readonly onError: (message: string) => void;
  readonly scrollZoom: boolean;
}

const CARTESIAN_TOOLS: ReadonlyArray<{
  readonly icon: LucideIcon;
  readonly label: string;
  readonly mode: PlotlyInteractionMode;
}> = [
  { icon: ScanSearchIcon, label: msg("Zoom", { $context: "chart tool" }), mode: "zoom" },
  { icon: HandIcon, label: msg("Pan", { $context: "chart tool" }), mode: "pan" },
  { icon: SquareDashedMousePointerIcon, label: msg("Box select"), mode: "select" },
  { icon: LassoSelectIcon, label: msg("Lasso select"), mode: "lasso" },
];

function ToolButton({
  active = false,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  readonly active?: boolean | undefined;
  readonly disabled: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={active || undefined}
            data-pressed={active || undefined}
            disabled={disabled}
            onClick={onClick}
            size="icon-xs"
            shape="square"
            type="button"
            variant="ghost"
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function readPlotlyInteractionMode(
  controller: PlotlyViewController | null,
): PlotlyInteractionMode | null {
  try {
    return controller?.getInteractionMode() ?? null;
  } catch {
    return null;
  }
}

export function PlotlyInteractionToolbar({
  compact = false,
  controller,
  initialMode,
  disabled,
  hasCartesian,
  onError,
  scrollZoom,
}: PlotlyInteractionToolbarProps) {
  const gt = useGT();
  const messages = useMessages();
  const [activeMode, setActiveMode] = useState<PlotlyInteractionMode | null>(initialMode);
  const [pending, setPending] = useState<PlotlyInteractionMode | "reset" | null>(null);

  const [previousController, setPreviousController] = useState({ controller: controller });
  if (previousController.controller !== controller) {
    setPreviousController({ controller: controller });
    setActiveMode(initialMode);
  }

  const unavailable = disabled || controller == null || pending != null;

  const setMode = (mode: PlotlyInteractionMode) => {
    if (unavailable || controller == null) return;
    setPending(mode);
    void controller.setInteractionMode(mode).then(
      () => {
        setActiveMode(mode);
        setPending(null);
      },
      () => {
        setPending(null);
        onError(gt("Unable to change the Plotly interaction mode."));
      },
    );
  };

  const reset = () => {
    if (unavailable || controller == null) return;
    setPending("reset");
    void controller.reset().then(
      () => {
        setActiveMode(controller.getInteractionMode());
        setPending(null);
      },
      () => {
        setPending(null);
        onError(gt("Unable to reset the Plotly view."));
      },
    );
  };

  const controls = (
    <>
      {hasCartesian
        ? CARTESIAN_TOOLS.map((tool) => (
            <ToolButton
              active={activeMode === tool.mode}
              disabled={unavailable}
              icon={tool.icon}
              key={tool.mode}
              label={messages(tool.label)}
              onClick={() => setMode(tool.mode)}
            />
          ))
        : null}
      {hasCartesian ? <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" /> : null}
      <ToolButton
        disabled={unavailable}
        icon={RotateCcwIcon}
        label={gt("Reset view")}
        onClick={reset}
      />
    </>
  );

  if (compact) {
    return (
      <VisualCardToolbar label={gt("Plotly interaction tools")} variant="exploration">
        {controls}
      </VisualCardToolbar>
    );
  }

  return (
    <div
      aria-label={gt("Plotly interaction tools")}
      className="flex min-h-9 items-center gap-2 border-b border-border/60 bg-background/60 px-2"
      role="toolbar"
    >
      <span className="px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <T>Explore</T>
      </span>
      <span className="hidden text-[10px] text-muted-foreground sm:inline">
        {scrollZoom ? gt("Scroll or pinch to zoom") : gt("Use the tools to zoom or pan")}
      </span>
      <span className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-secondary/45 p-0.5">
        {controls}
      </span>
    </div>
  );
}
