import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  Maximize2Icon,
  FileImageIcon,
  ImageIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  RichFenceSourceMenuItem,
  RichFenceSourcePreview,
  type ScientRichFenceAuthoringActions,
  useRichFenceContextMenu,
} from "../presentation/RichFenceSourceActions";

import {
  copyMermaidPng,
  downloadMermaidPng,
  downloadMermaidSvg,
  mermaidMarkdownCopySource,
} from "./mermaidExport";
import { MermaidDiagramDialog } from "./MermaidDiagramDialog";
import {
  renderMermaidDiagram,
  type MermaidTheme,
  type RenderedMermaidDiagram,
} from "./mermaidRuntime";
import { useNearViewport } from "../presentation/useNearViewport";
import {
  VisualCardDetails,
  VisualCardToolbar,
  VisualCardMenuPopup,
  VisualCardToolbarMenuItems,
} from "../presentation/VisualCardToolbar";

import "./scient-diagrams.css";

interface MermaidDiagramCardProps {
  readonly authoringActions?: ScientRichFenceAuthoringActions | undefined;
  readonly source: string;
  readonly language: string;
  readonly fenceMeta?: string | undefined;
  readonly title: string | null;
  readonly theme: MermaidTheme;
}

type DiagramState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly result: RenderedMermaidDiagram }
  | { readonly status: "error"; readonly message: string };

type DiagramAction = "copy-source" | "copy-png" | "download-png" | null;

function diagramErrorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "This Mermaid source could not be rendered.";
}

function DiagramActionButton({
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

export function MermaidDiagramCard({
  authoringActions,
  fenceMeta,
  language,
  source,
  theme,
  title,
}: MermaidDiagramCardProps) {
  const { ref, isNearViewport } = useNearViewport();
  const [diagramState, setDiagramState] = useState<DiagramState>({ status: "idle" });
  const [retryVersion, setRetryVersion] = useState(0);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeAction, setActiveAction] = useState<DiagramAction>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const renderGenerationRef = useRef(0);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayTitle = title || "Mermaid diagram";
  const markdownCopy = useMemo(
    () => mermaidMarkdownCopySource(source, language, fenceMeta),
    [fenceMeta, language, source],
  );

  useEffect(() => {
    if (!isNearViewport) return;
    const generation = renderGenerationRef.current + 1;
    renderGenerationRef.current = generation;
    setDiagramState({ status: "loading" });

    void renderMermaidDiagram(source, theme).then(
      (result) => {
        if (renderGenerationRef.current === generation) {
          setDiagramState({ status: "ready", result });
        }
      },
      (cause) => {
        if (renderGenerationRef.current === generation) {
          setDiagramState({ status: "error", message: diagramErrorMessage(cause) });
        }
      },
    );

    return () => {
      if (renderGenerationRef.current === generation) {
        renderGenerationRef.current += 1;
      }
    };
  }, [isNearViewport, retryVersion, source, theme]);

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
      (cause) => {
        console.error("[scient-diagrams] Failed to copy Mermaid source", cause);
        setActiveAction(null);
        showPersistentMessage("Unable to copy the diagram source.");
      },
    );
  }, [activeAction, showPersistentMessage, showTransientMessage, source]);

  const handleContextMenu = useRichFenceContextMenu(authoringActions, handleCopySource);
  const handleToggleSource = useCallback(() => {
    setSourceVisible((visible) => !visible);
  }, []);

  const readyResult = diagramState.status === "ready" ? diagramState.result : null;

  const handleCopyPng = useCallback(() => {
    if (readyResult == null || activeAction != null) return;
    setActiveAction("copy-png");
    void copyMermaidPng(readyResult.svg, theme).then(
      () => {
        setActiveAction(null);
        showTransientMessage("Image copied");
      },
      (cause) => {
        console.error("[scient-diagrams] Failed to copy Mermaid PNG", cause);
        setActiveAction(null);
        showPersistentMessage("Copy image is unavailable. You can download the PNG instead.");
      },
    );
  }, [activeAction, readyResult, showPersistentMessage, showTransientMessage, theme]);

  const handleDownloadPng = useCallback(() => {
    if (readyResult == null || activeAction != null) return;
    setActiveAction("download-png");
    void downloadMermaidPng(readyResult.svg, title, theme).then(
      () => setActiveAction(null),
      (cause) => {
        console.error("[scient-diagrams] Failed to download Mermaid PNG", cause);
        setActiveAction(null);
        showPersistentMessage("Unable to create the PNG image.");
      },
    );
  }, [activeAction, readyResult, showPersistentMessage, theme, title]);

  const handleDownloadSvg = useCallback(() => {
    if (readyResult == null || activeAction != null) return;
    try {
      downloadMermaidSvg(readyResult.svg, title, theme);
    } catch (cause) {
      console.error("[scient-diagrams] Failed to download Mermaid SVG", cause);
      showPersistentMessage("Unable to download the SVG image.");
    }
  }, [activeAction, readyResult, showPersistentMessage, theme, title]);

  return (
    <div
      ref={ref}
      aria-label={displayTitle}
      className="scient-mermaid-card my-3 overflow-hidden rounded-lg bg-background leading-normal"
      data-markdown-copy={markdownCopy}
      data-scient-visual-card
      dir="ltr"
      onContextMenu={handleContextMenu}
      role="figure"
    >
      <div className="flex flex-wrap items-center justify-end gap-2 px-2 pt-2">
        {title ? (
          <span className="min-w-0 flex-1 basis-40 wrap-anywhere text-xs font-medium" dir="auto">
            {title}
          </span>
        ) : null}
        <VisualCardToolbar label="Diagram actions">
          {readyResult != null ? (
            <DiagramActionButton
              disabled={activeAction != null}
              label="Expand diagram"
              onClick={() => setExpanded(true)}
            >
              <Maximize2Icon className="size-3" strokeWidth={1.5} />
            </DiagramActionButton>
          ) : null}

          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        aria-label="More diagram actions"
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
              <TooltipPopup side="top">More diagram actions</TooltipPopup>
            </Tooltip>
            <VisualCardMenuPopup align="end" className="min-w-52 max-w-[calc(100vw-2rem)]">
              <VisualCardDetails title={displayTitle} detail={readyResult?.diagramType} />
              <MenuItem disabled={activeAction != null} onClick={handleCopySource}>
                {actionMessage === "Source copied" ? <CheckIcon /> : <CopyIcon />}
                Copy source
              </MenuItem>
              <RichFenceSourceMenuItem
                authoringActions={authoringActions}
                onToggleSource={handleToggleSource}
                sourceVisible={sourceVisible}
              />
              <MenuItem
                disabled={readyResult == null || activeAction != null}
                onClick={handleDownloadSvg}
              >
                <DownloadIcon />
                Download SVG
              </MenuItem>
              <MenuItem
                disabled={readyResult == null || activeAction != null}
                onClick={handleCopyPng}
              >
                <ImageIcon />
                {activeAction === "copy-png" ? "Copying image…" : "Copy image"}
              </MenuItem>
              <MenuItem
                disabled={readyResult == null || activeAction != null}
                onClick={handleDownloadPng}
              >
                <FileImageIcon />
                {activeAction === "download-png" ? "Creating PNG…" : "Download PNG"}
              </MenuItem>
              <VisualCardToolbarMenuItems />
            </VisualCardMenuPopup>
          </Menu>
        </VisualCardToolbar>
      </div>

      {actionMessage != null && !expanded ? (
        <div
          aria-live="polite"
          className="border-b border-border/40 bg-background/45 px-3 py-1.5 text-muted-foreground text-xs"
        >
          {actionMessage}
        </div>
      ) : null}

      {diagramState.status === "idle" || diagramState.status === "loading" ? (
        <div className="flex min-h-44 items-center justify-center px-4 py-8 text-muted-foreground text-sm">
          {diagramState.status === "idle"
            ? "Diagram will render when visible"
            : "Rendering diagram…"}
        </div>
      ) : diagramState.status === "error" ? (
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-sm">Unable to render this diagram</p>
              <p className="mt-1 text-muted-foreground text-xs">{diagramState.message}</p>
            </div>
            <Button
              onClick={() => setRetryVersion((version) => version + 1)}
              size="xs"
              variant="outline"
            >
              <RefreshCwIcon />
              Retry
            </Button>
          </div>
          <RichFenceSourcePreview
            authoringActions={authoringActions}
            source={source}
            label="Edit diagram source"
            className="scient-mermaid-source max-h-72 overflow-auto rounded-md bg-background/70 p-3 text-xs leading-relaxed"
          />
        </div>
      ) : diagramState.status === "ready" ? (
        <div className="scient-mermaid-inline overflow-auto p-2">
          <div
            // Mermaid's strict renderer sanitizes generated SVG. We deliberately
            // do not call bindFunctions, so diagram-authored click handlers do not run.
            dangerouslySetInnerHTML={{ __html: diagramState.result.svg }}
          />
        </div>
      ) : null}

      {sourceVisible && !authoringActions?.sourceEditorOpen && diagramState.status !== "error" ? (
        <div className="border-t border-border/60 bg-background/45 p-3">
          <RichFenceSourcePreview
            authoringActions={authoringActions}
            source={source}
            label="Edit diagram source"
            className="scient-mermaid-source max-h-72 overflow-auto text-xs leading-relaxed"
          />
        </div>
      ) : null}

      {readyResult != null ? (
        <MermaidDiagramDialog
          actionMessage={actionMessage}
          activeAction={activeAction}
          onCopyPng={handleCopyPng}
          onCopySource={handleCopySource}
          onDownloadPng={handleDownloadPng}
          onDownloadSvg={handleDownloadSvg}
          onOpenChange={setExpanded}
          open={expanded}
          svg={readyResult.svg}
          title={displayTitle}
        />
      ) : null}
    </div>
  );
}
