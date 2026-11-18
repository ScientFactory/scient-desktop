import { useStableCallback } from "~/hooks/useStableCallback";
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
import { T, msg, useGT, useLocale } from "gt-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { m } from "~/i18n/messages";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  RichFenceSourceMenuItem,
  type ScientRichFenceAuthoringActions,
  createRichFenceContextMenu,
} from "../presentation/RichFenceSourceActions";
import {
  VisualCardDetails,
  VisualCardToolbar,
  VisualCardMenuPopup,
  VisualCardToolbarMenuItems,
} from "../presentation/VisualCardToolbar";

import { PlotlyChartDialog } from "./PlotlyChartDialog";
import { PlotlyInteractionToolbar, readPlotlyInteractionMode } from "./PlotlyInteractionToolbar";
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
    return { parsed: parsePlotlySource(source, m), error: null };
  } catch (cause) {
    return {
      parsed: null,
      error:
        cause instanceof Error ? cause : new Error(m(msg("Unable to parse the Plotly source."))),
    };
  }
}

/**
 * Keeps its identity while `source` and `locale` do, so state that follows it settles; a language
 * switch parses again, with errors in the new language.
 */
function chartSource(source: string, locale: string) {
  void locale;
  const result = parseSource(source);
  const parsed = result.parsed;
  return {
    ...result,
    figureTitle: parsed == null ? null : plotlyFigureTitle(parsed.figure),
    description: parsed == null ? null : plotlyFigureDescription(parsed.figure),
  };
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
  const gt = useGT();
  const locale = useLocale();
  const parsedSource = chartSource(source, locale);
  const parsed = parsedSource.parsed;
  const fileTitle = title || parsedSource.figureTitle;
  const displayTitle = fileTitle || gt("Plotly figure");
  const description = parsedSource.description;
  const hasWebGl = parsed?.hasWebGl ?? false;
  const markdownCopy = plotlyMarkdownCopySource(source, language, fenceMeta);
  const descriptionId = useId();
  const controllerRef = useRef<PlotlyViewController | null>(null);
  const [controller, setController] = useState<PlotlyViewController | null>(null);
  const [initialInteractionMode, setInitialInteractionMode] = useState<
    import("./plotlyRuntime").PlotlyInteractionMode | null
  >(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // Which copy just succeeded: its message is translated, so the checkmark keys on this instead.
  const [copiedKind, setCopiedKind] = useState<string | null>(null);
  const captureState = useStableCallback(() => {
    const state = controllerRef.current?.getState();
    if (state != null) setTransferredView({ source, state });
  });
  const { active: viewportActive, ref: viewportRef } = usePlotlyViewportActivity(
    hasWebGl,
    captureState,
    false,
    expanded,
  );

  const [previousMount, setPreviousMount] = useState({
    expanded: expanded,
    parsed: parsed,
    retryVersion: retryVersion,
    source: source,
    active: viewportActive,
  });
  if (
    previousMount.expanded !== expanded ||
    previousMount.parsed !== parsed ||
    previousMount.retryVersion !== retryVersion ||
    previousMount.source !== source ||
    previousMount.active !== viewportActive
  ) {
    setPreviousMount({
      expanded: expanded,
      parsed: parsed,
      retryVersion: retryVersion,
      source: source,
      active: viewportActive,
    });
    if (viewportActive && parsed != null && !expanded) setStatus({ kind: "loading", source });
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the action-message timer on unmount
  useEffect(
    () => () => {
      if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    },
    [],
  );

  const showTransientMessage = (message: string, kind: string | null = null) => {
    if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    setActionMessage(message);
    setCopiedKind(kind);
    messageTimerRef.current = setTimeout(() => {
      messageTimerRef.current = null;
      setActionMessage(null);
      setCopiedKind(null);
    }, 1_500);
  };

  const showPersistentMessage = (message: string) => {
    if (messageTimerRef.current != null) {
      clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
    setActionMessage(message);
    setCopiedKind(null);
  };

  const runControllerAction = (
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
  };

  const handleCopySource = useStableCallback(() => {
    if (activeAction != null) return;
    if (navigator.clipboard?.writeText == null) {
      showPersistentMessage(gt("Clipboard access is unavailable."));
      return;
    }
    setActiveAction("copy-source");
    void navigator.clipboard.writeText(source).then(
      () => {
        setActiveAction(null);
        showTransientMessage(gt("Source copied"), "source");
      },
      () => {
        setActiveAction(null);
        showPersistentMessage(gt("Unable to copy the Plotly source."));
      },
    );
  });

  const handleContextMenu = createRichFenceContextMenu(authoringActions, handleCopySource);
  const handleToggleSource = () => {
    setSourceVisible((visible) => !visible);
  };

  const handleExpand = () => {
    captureState();
    setExpanded(true);
  };

  const handleReady = (mounted: MountedPlotlyView) => {
    setController(controllerRef.current);
    setInitialInteractionMode(readPlotlyInteractionMode(controllerRef.current));
    setStatus({ kind: "ready", source, warnings: mounted.warnings });
  };

  const parseError = parsedSource.error;
  const currentStatus: ChartStatus =
    status.source === source ? status : { kind: viewportActive ? "loading" : "idle", source };
  const visibleStatus: ChartStatus =
    parseError == null
      ? currentStatus.kind === "ready" && hasWebGl && !viewportActive && !expanded
        ? { ...currentStatus, kind: "waiting-for-slot" }
        : currentStatus
      : { kind: "error", message: parseError.message, source };
  const ready = visibleStatus.kind === "ready";
  const waitingForSlot = visibleStatus.kind === "waiting-for-slot";
  const visibleWarnings =
    visibleStatus.kind === "ready" || visibleStatus.kind === "waiting-for-slot"
      ? visibleStatus.warnings
      : [];

  return (
    <div
      ref={viewportRef}
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
        {parsed?.hasNetworkContent ? (
          <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <T>Network content</T>
          </span>
        ) : null}
        {parsed != null && visibleStatus.kind !== "error" ? (
          <PlotlyInteractionToolbar
            compact
            controller={ready ? controller : null}
            initialMode={ready ? initialInteractionMode : null}
            disabled={!ready || activeAction != null}
            hasCartesian={parsed.hasCartesian}
            onError={showPersistentMessage}
            scrollZoom={false}
          />
        ) : null}
        <VisualCardToolbar label={gt("Plotly actions")}>
          {ready ? (
            <ChartActionButton
              disabled={activeAction != null}
              label={gt("Expand interactive figure")}
              onClick={handleExpand}
            >
              <Maximize2Icon className="size-3" strokeWidth={1.5} />
            </ChartActionButton>
          ) : null}

          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        aria-label={gt("More Plotly actions")}
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
              <TooltipPopup side="top">
                <T>More Plotly actions</T>
              </TooltipPopup>
            </Tooltip>
            <VisualCardMenuPopup align="end" className="min-w-52 max-w-[calc(100vw-2rem)]">
              <VisualCardDetails
                title={displayTitle}
                detail={parsed?.hasWebGl ? "WebGL" : undefined}
              />
              <MenuItem disabled={activeAction != null} onClick={handleCopySource}>
                {copiedKind === "source" ? <CheckIcon /> : <CopyIcon />}
                <T>Copy Plotly JSON</T>
              </MenuItem>
              <RichFenceSourceMenuItem
                authoringActions={authoringActions}
                onToggleSource={handleToggleSource}
                sourceVisible={sourceVisible}
              />
              <MenuItem onClick={() => downloadPlotlySource(source, fileTitle)}>
                <FileBracesIcon />
                <T>Download Plotly JSON</T>
              </MenuItem>
              <MenuItem
                disabled={!ready || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-svg",
                    (controller) => downloadPlotlySvg(controller, fileTitle),
                    parsed?.hasWebGl ? gt("SVG downloaded; WebGL layers are rasterized") : null,
                    gt("Unable to create the SVG image."),
                  )
                }
              >
                <DownloadIcon />
                <T>Download current SVG</T>
              </MenuItem>
              <MenuItem
                disabled={!ready || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "copy-png",
                    copyPlotlyPng,
                    gt("Image copied"),
                    gt("Copy image is unavailable. You can download the PNG instead."),
                  )
                }
              >
                <ImageIcon />
                {activeAction === "copy-png" ? gt("Copying image…") : gt("Copy current image")}
              </MenuItem>
              <MenuItem
                disabled={!ready || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-png",
                    (controller) => downloadPlotlyPng(controller, fileTitle),
                    null,
                    gt("Unable to create the PNG image."),
                  )
                }
              >
                <FileImageIcon />
                {activeAction === "download-png" ? gt("Creating PNG…") : gt("Download current PNG")}
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
              <p className="font-medium text-sm">
                <T>Unable to render this Plotly figure</T>
              </p>
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
                <T>Retry</T>
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
              <T>Waiting for graphics resources…</T>
            </div>
          ) : visibleStatus.kind !== "ready" ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              {visibleStatus.kind === "idle"
                ? gt("Figure will render when visible")
                : gt("Rendering interactive Plotly figure…")}
            </div>
          ) : null}
          {viewportActive && parsed != null && !expanded ? (
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
                  message: gt("The graphics context was lost. Retry to recreate this figure."),
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
            {gt("{count, plural, one {{count} figure warning} other {{count} figure warnings}}", {
              count: visibleWarnings.length,
            })}
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
