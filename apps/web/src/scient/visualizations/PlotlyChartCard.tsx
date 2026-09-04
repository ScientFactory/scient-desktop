import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  Maximize2Icon,
  FileBracesIcon,
  FileImageIcon,
  ImageIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  RichFenceSourceMenuItem,
  type ScientRichFenceAuthoringActions,
  useRichFenceContextMenu,
} from "../presentation/RichFenceSourceActions";
import {
  VisualCardDetails,
  VisualCardToolbar,
  VisualCardMenuPopup,
  VisualCardToolbarMenuItems,
} from "../presentation/VisualCardToolbar";

import { PlotlyChartDialog } from "./PlotlyChartDialog";
import { PlotlyInteractionToolbar } from "./PlotlyInteractionToolbar";
import {
  copyPlotlyPng,
  downloadPlotlyPng,
  downloadPlotlySource,
  downloadPlotlySvg,
  plotlyMarkdownCopySource,
} from "./plotlyExport";
import type { MountedPlotlyView, PlotlyTheme, PlotlyViewState } from "./plotlyRuntime";
import {
  parsePlotlySource,
  plotlyFigureDescription,
  plotlyFigureTitle,
  type ParsedPlotlySource,
} from "./plotlySpec";
import { PlotlyView, type PlotlyViewController } from "./PlotlyView";
import { usePlotlyViewportActivity } from "./usePlotlyViewportActivity";

import "./scient-visualizations.css";

interface PlotlyChartCardProps {
  readonly authoringActions?: ScientRichFenceAuthoringActions | undefined;
  readonly fenceMeta?: string | undefined;
  readonly language: string;
  readonly source: string;
  readonly theme: PlotlyTheme;
  readonly title: string | null;
}

type ChartStatus =
  | { readonly kind: "idle" | "loading"; readonly source: string }
  | {
      readonly kind: "ready" | "waiting-for-slot";
      readonly source: string;
      readonly warnings: ReadonlyArray<string>;
    }
  | { readonly kind: "error"; readonly message: string; readonly source: string };

type ChartAction = "copy-png" | "copy-source" | "download-png" | "download-svg" | null;

export function plotlySlotStatus(
  status: ChartStatus,
  input: { readonly active: boolean; readonly expanded: boolean; readonly hasWebGl: boolean },
): ChartStatus {
  return status.kind === "ready" && input.hasWebGl && !input.active && !input.expanded
    ? { ...status, kind: "waiting-for-slot" }
    : status;
}

function parseSource(
  source: string,
):
  | { readonly parsed: ParsedPlotlySource; readonly error: null }
  | { readonly parsed: null; readonly error: Error } {
  try {
    return { parsed: parsePlotlySource(source), error: null };
  } catch (cause) {
    return {
      parsed: null,
      error: cause instanceof Error ? cause : new Error("Unable to parse the Plotly source."),
    };
  }
}

function ChartActionButton({
  children,
  disabled,
  label,
  onClick,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="chat-markdown-chrome-action"
            disabled={disabled}
            onClick={onClick}
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function PlotlyChartCard({
  authoringActions,
  fenceMeta,
  language,
  source,
  theme,
  title,
}: PlotlyChartCardProps) {
  const descriptionId = useId();
  const controllerRef = useRef<PlotlyViewController | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parsedSource = useMemo(() => parseSource(source), [source]);
  const parsed = parsedSource.parsed;
  const [status, setStatus] = useState<ChartStatus>({ kind: "idle", source });
  const [retryVersion, setRetryVersion] = useState(0);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [transferredView, setTransferredView] = useState<{
    readonly source: string;
    readonly state: PlotlyViewState;
  } | null>(null);
  const [activeAction, setActiveAction] = useState<ChartAction>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const captureState = useCallback(() => {
    const state = controllerRef.current?.getState();
    if (state != null) setTransferredView({ source, state });
  }, [source]);
  const viewport = usePlotlyViewportActivity(
    parsed?.hasWebGl ?? false,
    captureState,
    false,
    expanded,
  );
  const fileTitle = title || (parsed == null ? null : plotlyFigureTitle(parsed.figure));
  const displayTitle = fileTitle || "Plotly figure";
  const description = parsed == null ? null : plotlyFigureDescription(parsed.figure);
  const markdownCopy = useMemo(
    () => plotlyMarkdownCopySource(source, language, fenceMeta),
    [fenceMeta, language, source],
  );

  useEffect(() => {
    if (viewport.active && parsed != null && !expanded) setStatus({ kind: "loading", source });
  }, [expanded, parsed, retryVersion, source, viewport.active]);

  useEffect(
    () => () => {
      if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    },
    [],
  );

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
      action: Exclude<ChartAction, "copy-source" | null>,
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
          console.error("[scient-visualizations] Plotly action failed", action, cause);
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

  const handleContextMenu = useRichFenceContextMenu(authoringActions, handleCopySource);
  const handleToggleSource = useCallback(() => {
    setSourceVisible((visible) => !visible);
  }, []);

  const handleExpand = useCallback(() => {
    captureState();
    setExpanded(true);
  }, [captureState]);

  const handleReady = useCallback(
    (mounted: MountedPlotlyView) => {
      setStatus({ kind: "ready", source, warnings: mounted.warnings });
    },
    [source],
  );

  const parseError = parsedSource.error;
  const currentStatus: ChartStatus =
    status.source === source ? status : { kind: viewport.active ? "loading" : "idle", source };
  const visibleStatus: ChartStatus =
    parseError == null
      ? plotlySlotStatus(currentStatus, {
          active: viewport.active,
          expanded,
          hasWebGl: parsed?.hasWebGl ?? false,
        })
      : { kind: "error", message: parseError.message, source };
  const ready = visibleStatus.kind === "ready";
  const waitingForSlot = visibleStatus.kind === "waiting-for-slot";
  const visibleWarnings =
    visibleStatus.kind === "ready" || visibleStatus.kind === "waiting-for-slot"
      ? visibleStatus.warnings
      : [];

  return (
    <div
      ref={viewport.ref}
      aria-describedby={description == null ? undefined : descriptionId}
      aria-label={displayTitle}
      className="scient-plotly-card my-3 overflow-hidden rounded-lg bg-background leading-normal"
      data-markdown-copy={markdownCopy}
      data-scient-visual-card
      dir="ltr"
      onContextMenu={handleContextMenu}
      role="figure"
    >
      {description == null ? null : (
        <span className="sr-only" id={descriptionId}>
          {description}
        </span>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 px-2 pt-2">
        {title ? (
          <span className="min-w-0 flex-1 basis-40 wrap-anywhere text-xs font-medium" dir="auto">
            {title}
          </span>
        ) : null}
        {(parsed?.externalResources.length ?? 0) > 0 ||
        parsed?.hasGeoTopology ||
        parsed?.hasMapTiles ? (
          <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Network content
          </span>
        ) : null}
        {parsed != null && visibleStatus.kind !== "error" ? (
          <PlotlyInteractionToolbar
            compact
            controller={ready ? controllerRef.current : null}
            disabled={!ready || activeAction != null}
            hasCartesian={parsed.hasCartesian}
            onError={showPersistentMessage}
            scrollZoom={false}
          />
        ) : null}
        <VisualCardToolbar label="Plotly actions">
          {ready ? (
            <ChartActionButton
              disabled={activeAction != null}
              label="Expand interactive figure"
              onClick={handleExpand}
            >
              <Maximize2Icon className="size-3.5" strokeWidth={1.5} />
            </ChartActionButton>
          ) : null}

          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        aria-label="More Plotly actions"
                        className="chat-markdown-chrome-action"
                        disabled={activeAction != null}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      />
                    }
                  />
                }
              >
                <EllipsisIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">More Plotly actions</TooltipPopup>
            </Tooltip>
            <VisualCardMenuPopup align="end" className="min-w-52 max-w-[calc(100vw-2rem)]">
              <VisualCardDetails
                title={displayTitle}
                detail={parsed?.hasWebGl ? "WebGL" : undefined}
              />
              <MenuItem disabled={activeAction != null} onClick={handleCopySource}>
                {actionMessage === "Source copied" ? <CheckIcon /> : <CopyIcon />}
                Copy source
              </MenuItem>
              <RichFenceSourceMenuItem
                authoringActions={authoringActions}
                onToggleSource={handleToggleSource}
                sourceVisible={sourceVisible}
              />
              <MenuItem onClick={() => downloadPlotlySource(source, fileTitle)}>
                <FileBracesIcon />
                Download Plotly JSON
              </MenuItem>
              <MenuItem
                disabled={!ready || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-svg",
                    (controller) => downloadPlotlySvg(controller, fileTitle),
                    parsed?.hasWebGl ? "SVG downloaded; WebGL layers are rasterized" : null,
                    "Unable to create the SVG image.",
                  )
                }
              >
                <DownloadIcon />
                Download current SVG
              </MenuItem>
              <MenuItem
                disabled={!ready || activeAction != null}
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
                disabled={!ready || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-png",
                    (controller) => downloadPlotlyPng(controller, fileTitle),
                    null,
                    "Unable to create the PNG image.",
                  )
                }
              >
                <FileImageIcon />
                {activeAction === "download-png" ? "Creating PNG…" : "Download current PNG"}
              </MenuItem>
              <VisualCardToolbarMenuItems />
            </VisualCardMenuPopup>
          </Menu>
        </VisualCardToolbar>
      </div>

      {actionMessage != null ? (
        <div
          aria-live="polite"
          className="border-b border-border/40 bg-background/45 px-3 py-1.5 text-muted-foreground text-xs"
        >
          {actionMessage}
        </div>
      ) : null}

      {visibleStatus.kind === "error" ? (
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-sm">Unable to render this Plotly figure</p>
              <p className="mt-1 text-muted-foreground text-xs">{visibleStatus.message}</p>
            </div>
            {parseError == null ? (
              <Button
                onClick={() => setRetryVersion((version) => version + 1)}
                size="xs"
                type="button"
                variant="outline"
              >
                <RefreshCwIcon />
                Retry
              </Button>
            ) : null}
          </div>
          <pre className="scient-plotly-source max-h-72 overflow-auto rounded-md bg-background/70 p-3 text-xs leading-relaxed">
            <code>{source}</code>
          </pre>
        </div>
      ) : (
        <div className="scient-plotly-stage relative p-2">
          {waitingForSlot ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              Waiting for graphics resources…
            </div>
          ) : visibleStatus.kind !== "ready" ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              {visibleStatus.kind === "idle"
                ? "Figure will render when visible"
                : "Rendering interactive Plotly figure…"}
            </div>
          ) : null}
          {viewport.active && parsed != null && !expanded ? (
            <PlotlyView
              key={retryVersion}
              ref={controllerRef}
              className={visibleStatus.kind === "ready" ? "w-full" : "invisible w-full"}
              initialState={transferredView?.source === source ? transferredView.state : null}
              onError={(error) => setStatus({ kind: "error", message: error.message, source })}
              onReady={handleReady}
              onWebGlContextLost={() =>
                setStatus({
                  kind: "error",
                  message: "The graphics context was lost. Retry to recreate this figure.",
                  source,
                })
              }
              parsed={parsed}
              surface="inline"
              theme={theme}
            />
          ) : null}
        </div>
      )}

      {visibleWarnings.length > 0 ? (
        <details className="border-t border-border/60 bg-amber-500/5 px-3 py-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-amber-700 dark:text-amber-300">
            <TriangleAlertIcon className="size-3.5" />
            {visibleWarnings.length === 1
              ? "1 figure warning"
              : `${visibleWarnings.length} figure warnings`}
          </summary>
          <ul className="mt-2 list-disc space-y-1 ps-6 text-muted-foreground">
            {visibleWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {sourceVisible && visibleStatus.kind !== "error" ? (
        <div className="border-t border-border/60 bg-background/45 p-3">
          <pre className="scient-plotly-source max-h-72 overflow-auto text-xs leading-relaxed">
            <code>{source}</code>
          </pre>
        </div>
      ) : null}

      {ready && parsed != null ? (
        <PlotlyChartDialog
          initialState={transferredView?.source === source ? transferredView.state : null}
          onOpenChange={(open) => {
            setExpanded(open);
            if (!open) setStatus({ kind: "loading", source });
          }}
          onReturnState={(state) => setTransferredView({ source, state })}
          open={expanded}
          parsed={parsed}
          source={source}
          theme={theme}
          title={displayTitle}
        />
      ) : null}
    </div>
  );
}
