import {
  BarChart3Icon,
  CheckIcon,
  Code2Icon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  ExpandIcon,
  FileBracesIcon,
  FileImageIcon,
  ImageIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { useNearViewport } from "../presentation/useNearViewport";
import { VegaLiteChartDialog } from "./VegaLiteChartDialog";
import {
  copyVegaLitePng,
  downloadVegaLitePng,
  downloadVegaLiteSource,
  downloadVegaLiteSvg,
  vegaLiteMarkdownCopySource,
} from "./vegaLiteExport";
import type { MountedVegaLiteView, VegaLiteTheme, VegaLiteViewState } from "./vegaLiteRuntime";
import { parseVegaLiteSource, type ParsedVegaLiteSource } from "./vegaLiteSpec";
import { VegaLiteView, type VegaLiteViewController } from "./VegaLiteView";

import "./scient-visualizations.css";

interface VegaLiteChartCardProps {
  readonly fenceMeta?: string | undefined;
  readonly language: string;
  readonly source: string;
  readonly theme: VegaLiteTheme;
  readonly title: string | null;
}

type ChartStatus =
  | { readonly kind: "idle" | "loading" }
  | {
      readonly kind: "ready";
      readonly externalResources: ReadonlyArray<string>;
      readonly warnings: ReadonlyArray<string>;
    }
  | { readonly kind: "error"; readonly message: string };

type ChartAction = "copy-source" | "copy-png" | "download-png" | "download-svg" | "reset" | null;

function parseSource(
  source: string,
):
  | { readonly parsed: ParsedVegaLiteSource; readonly error: null }
  | { readonly parsed: null; readonly error: Error } {
  try {
    return { parsed: parseVegaLiteSource(source), error: null };
  } catch (cause) {
    return {
      parsed: null,
      error: cause instanceof Error ? cause : new Error("Unable to parse the Vega-Lite source."),
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

export function VegaLiteChartCard({
  fenceMeta,
  language,
  source,
  theme,
  title,
}: VegaLiteChartCardProps) {
  const { ref: viewportRef, isNearViewport } = useNearViewport();
  const controllerRef = useRef<VegaLiteViewController | null>(null);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parsedSource = useMemo(() => parseSource(source), [source]);
  const [status, setStatus] = useState<ChartStatus>({ kind: "idle" });
  const [retryVersion, setRetryVersion] = useState(0);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [expandedState, setExpandedState] = useState<VegaLiteViewState | null>(null);
  const [activeAction, setActiveAction] = useState<ChartAction>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const displayTitle = title || "Vega-Lite chart";
  const markdownCopy = useMemo(
    () => vegaLiteMarkdownCopySource(source, language, fenceMeta),
    [fenceMeta, language, source],
  );

  useEffect(() => {
    if (isNearViewport && parsedSource.parsed != null) setStatus({ kind: "loading" });
  }, [isNearViewport, parsedSource, retryVersion, theme]);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current != null) clearTimeout(copyResetTimerRef.current);
    },
    [],
  );

  const showTransientMessage = useCallback((message: string) => {
    if (copyResetTimerRef.current != null) clearTimeout(copyResetTimerRef.current);
    setActionMessage(message);
    copyResetTimerRef.current = setTimeout(() => {
      setActionMessage(null);
      copyResetTimerRef.current = null;
    }, 1_500);
  }, []);

  const showPersistentMessage = useCallback((message: string) => {
    if (copyResetTimerRef.current != null) {
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    setActionMessage(message);
  }, []);

  const runControllerAction = useCallback(
    (
      action: Exclude<ChartAction, "copy-source" | null>,
      operation: (controller: VegaLiteViewController) => Promise<void>,
      successMessage: string | null,
      failureMessage: string,
    ) => {
      const controller = controllerRef.current;
      if (controller == null) return;
      setActiveAction(action);
      void operation(controller).then(
        () => {
          setActiveAction(null);
          if (successMessage != null) showTransientMessage(successMessage);
        },
        (cause) => {
          console.error("[scient-visualizations] Vega-Lite chart action failed", action, cause);
          setActiveAction(null);
          showPersistentMessage(failureMessage);
        },
      );
    },
    [showPersistentMessage, showTransientMessage],
  );

  const handleCopySource = useCallback(() => {
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
        showPersistentMessage("Unable to copy the chart source.");
      },
    );
  }, [showPersistentMessage, showTransientMessage, source]);

  const handleExpand = useCallback(() => {
    setExpandedState(controllerRef.current?.getState() ?? null);
    setExpanded(true);
  }, []);

  const handleReturnState = useCallback((state: VegaLiteViewState) => {
    const controller = controllerRef.current;
    if (controller == null) return;
    void controller.setState(state).catch((cause: unknown) => {
      console.error("[scient-visualizations] Unable to return expanded chart state", cause);
    });
  }, []);

  const handleReady = useCallback((mounted: MountedVegaLiteView) => {
    setStatus({
      kind: "ready",
      externalResources: mounted.externalResources,
      warnings: mounted.warnings,
    });
  }, []);

  const parseError = parsedSource.error;
  const visibleStatus: ChartStatus =
    parseError == null ? status : { kind: "error", message: parseError.message };
  const ready = visibleStatus.kind === "ready";

  return (
    <div
      ref={viewportRef}
      aria-label={displayTitle}
      className="scient-vega-lite-card my-3 overflow-hidden rounded-lg border border-border/70 bg-secondary/30 leading-normal"
      data-markdown-copy={markdownCopy}
      dir="ltr"
      role="figure"
    >
      <div className="flex min-h-9 select-none items-center gap-2 border-b border-border/60 bg-secondary/60 px-2">
        <BarChart3Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" dir="auto">
          {displayTitle}
        </span>
        {ready && visibleStatus.externalResources.length > 0 ? (
          <span className="hidden rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            External data
          </span>
        ) : null}
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Chart actions">
          {ready ? (
            <ChartActionButton label="Expand interactive chart" onClick={handleExpand}>
              <ExpandIcon className="size-3" />
            </ChartActionButton>
          ) : null}
          <ChartActionButton label="Copy chart source" onClick={handleCopySource}>
            {actionMessage === "Source copied" ? (
              <CheckIcon className="size-3" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </ChartActionButton>
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        aria-label="More chart actions"
                        className="chat-markdown-chrome-action"
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
              <TooltipPopup side="top">More chart actions</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-48">
              <MenuItem onClick={() => setSourceVisible((visible) => !visible)}>
                <Code2Icon />
                {sourceVisible ? "Hide source" : "Show source"}
              </MenuItem>
              <MenuItem onClick={() => downloadVegaLiteSource(source, title)}>
                <FileBracesIcon />
                Download Vega-Lite JSON
              </MenuItem>
              <MenuItem
                disabled={!ready || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "reset",
                    (controller) => controller.reset(),
                    "View reset",
                    "Unable to reset the chart view.",
                  )
                }
              >
                <RotateCcwIcon />
                Reset interaction
              </MenuItem>
              <MenuItem
                disabled={!ready || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-svg",
                    (controller) => downloadVegaLiteSvg(controller, title),
                    null,
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
                disabled={!ready || activeAction != null}
                onClick={() =>
                  runControllerAction(
                    "download-png",
                    (controller) => downloadVegaLitePng(controller, title),
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
        </span>
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
              <p className="font-medium text-sm">Unable to render this chart</p>
              <p className="mt-1 text-muted-foreground text-xs">{visibleStatus.message}</p>
            </div>
            {parseError == null ? (
              <Button
                onClick={() => setRetryVersion((version) => version + 1)}
                size="xs"
                variant="outline"
              >
                <RefreshCwIcon />
                Retry
              </Button>
            ) : null}
          </div>
          <pre className="scient-vega-lite-source max-h-72 overflow-auto rounded-md bg-background/70 p-3 text-xs leading-relaxed">
            <code>{source}</code>
          </pre>
        </div>
      ) : (
        <div className="relative min-h-52 overflow-auto bg-background/45 p-4 sm:p-6">
          {visibleStatus.kind !== "ready" ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              {visibleStatus.kind === "idle"
                ? "Chart will render when visible"
                : "Rendering interactive chart…"}
            </div>
          ) : null}
          {isNearViewport && parsedSource.parsed != null ? (
            <VegaLiteView
              key={retryVersion}
              ref={controllerRef}
              aria-label={displayTitle}
              className={visibleStatus.kind === "ready" ? "w-full" : "invisible w-full"}
              onError={(error) => setStatus({ kind: "error", message: error.message })}
              onReady={handleReady}
              parsed={parsedSource.parsed}
              theme={theme}
              title={displayTitle}
            />
          ) : null}
        </div>
      )}

      {ready && visibleStatus.warnings.length > 0 ? (
        <details className="border-t border-border/60 bg-amber-500/5 px-3 py-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-amber-700 dark:text-amber-300">
            <TriangleAlertIcon className="size-3.5" />
            {visibleStatus.warnings.length === 1
              ? "1 chart warning"
              : `${visibleStatus.warnings.length} chart warnings`}
          </summary>
          <ul className="mt-2 list-disc space-y-1 ps-6 text-muted-foreground">
            {visibleStatus.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {sourceVisible && visibleStatus.kind !== "error" ? (
        <div className="border-t border-border/60 bg-background/45 p-3">
          <pre className="scient-vega-lite-source max-h-72 overflow-auto text-xs leading-relaxed">
            <code>{source}</code>
          </pre>
        </div>
      ) : null}

      {ready && parsedSource.parsed != null ? (
        <VegaLiteChartDialog
          initialState={expandedState}
          onOpenChange={setExpanded}
          onReturnState={handleReturnState}
          open={expanded}
          parsed={parsedSource.parsed}
          theme={theme}
          title={displayTitle}
        />
      ) : null}
    </div>
  );
}
