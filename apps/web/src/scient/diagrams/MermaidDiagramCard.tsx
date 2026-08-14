import {
  CheckIcon,
  Code2Icon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  ExpandIcon,
  FileImageIcon,
  ImageIcon,
  RefreshCwIcon,
  WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

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

import "./scient-diagrams.css";

interface MermaidDiagramCardProps {
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

function useNearViewport(): {
  readonly ref: (node: HTMLDivElement | null) => void;
  readonly isNearViewport: boolean;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [isNearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    if (element == null || isNearViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, isNearViewport]);

  return { ref: setElement, isNearViewport };
}

function diagramErrorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "This Mermaid source could not be rendered.";
}

function DiagramActionButton({
  children,
  label,
  onClick,
}: {
  readonly children: ReactNode;
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
  }, [showPersistentMessage, showTransientMessage, source]);

  const readyResult = diagramState.status === "ready" ? diagramState.result : null;

  const handleCopyPng = useCallback(() => {
    if (readyResult == null) return;
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
  }, [readyResult, showPersistentMessage, showTransientMessage, theme]);

  const handleDownloadPng = useCallback(() => {
    if (readyResult == null) return;
    setActiveAction("download-png");
    void downloadMermaidPng(readyResult.svg, title, theme).then(
      () => setActiveAction(null),
      (cause) => {
        console.error("[scient-diagrams] Failed to download Mermaid PNG", cause);
        setActiveAction(null);
        showPersistentMessage("Unable to create the PNG image.");
      },
    );
  }, [readyResult, showPersistentMessage, theme, title]);

  const handleDownloadSvg = useCallback(() => {
    if (readyResult == null) return;
    try {
      downloadMermaidSvg(readyResult.svg, title, theme);
    } catch (cause) {
      console.error("[scient-diagrams] Failed to download Mermaid SVG", cause);
      showPersistentMessage("Unable to download the SVG image.");
    }
  }, [readyResult, showPersistentMessage, theme, title]);

  return (
    <div
      ref={ref}
      aria-label={displayTitle}
      className="scient-mermaid-card my-3 overflow-hidden rounded-lg border border-border/70 bg-secondary/30 leading-normal"
      data-markdown-copy={markdownCopy}
      dir="ltr"
      role="figure"
    >
      <div className="flex min-h-9 select-none items-center gap-2 border-b border-border/60 bg-secondary/60 px-2">
        <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" dir="auto">
          {displayTitle}
        </span>
        {readyResult != null ? (
          <span className="hidden rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            {readyResult.diagramType}
          </span>
        ) : null}
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Diagram actions">
          {readyResult != null ? (
            <DiagramActionButton label="Expand diagram" onClick={() => setExpanded(true)}>
              <ExpandIcon className="size-3" />
            </DiagramActionButton>
          ) : null}
          <DiagramActionButton label="Copy diagram source" onClick={handleCopySource}>
            {actionMessage === "Source copied" ? (
              <CheckIcon className="size-3" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </DiagramActionButton>
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
            <MenuPopup align="end" className="min-w-44">
              <MenuItem onClick={() => setSourceVisible((visible) => !visible)}>
                <Code2Icon />
                {sourceVisible ? "Hide source" : "Show source"}
              </MenuItem>
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
          <pre className="scient-mermaid-source max-h-72 overflow-auto rounded-md bg-background/70 p-3 text-xs leading-relaxed">
            <code>{source}</code>
          </pre>
        </div>
      ) : diagramState.status === "ready" ? (
        <div className="scient-mermaid-inline overflow-auto bg-background/45 p-4 sm:p-6">
          <div
            // Mermaid's strict renderer sanitizes generated SVG. We deliberately
            // do not call bindFunctions, so diagram-authored click handlers do not run.
            dangerouslySetInnerHTML={{ __html: diagramState.result.svg }}
          />
        </div>
      ) : null}

      {sourceVisible && diagramState.status !== "error" ? (
        <div className="border-t border-border/60 bg-background/45 p-3">
          <pre className="scient-mermaid-source max-h-72 overflow-auto text-xs leading-relaxed">
            <code>{source}</code>
          </pre>
        </div>
      ) : null}

      {readyResult != null ? (
        <MermaidDiagramDialog
          onOpenChange={setExpanded}
          open={expanded}
          svg={readyResult.svg}
          title={displayTitle}
        />
      ) : null}
    </div>
  );
}
