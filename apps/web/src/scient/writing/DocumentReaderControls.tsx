import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  ListTree,
  Maximize2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Scan,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { formatPdfZoom, parsePdfPageInput, stepPdfZoom } from "../pdf/pdfReaderModel";
import "./documentReaderControls.css";

export function ReaderButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string },
) {
  const { label, className, children, title: _title, ...buttonProps } = props;
  return (
    <ScientTooltip content={label}>
      <button
        {...buttonProps}
        type="button"
        className={cn("scient-pdf-toolbar-button", className)}
        aria-label={label}
      >
        {children}
      </button>
    </ScientTooltip>
  );
}

/** PDF and Visual supply navigation adapters; all control interactions live here. */
export function DocumentReaderControls(props: {
  label: string;
  ready: boolean;
  page: number;
  pageCount: number;
  scale: number;
  sidebarOpen: boolean;
  searchOpen: boolean;
  onPage: (page: number) => void;
  onZoom: (scale: number) => void;
  onActualSize: () => void;
  onFitWidth: () => void;
  onToggleSidebar: () => void;
  onToggleSearch: () => void;
  onShowSearch: () => void;
  shortcutLabel: (command: string) => string;
  moreActions?: ReactNode;
  contextControls?: ReactNode;
}) {
  const [pageInput, setPageInput] = useState(String(props.page));
  const pendingSearch = useRef<(() => void) | null>(null);
  const searchOwnsFocus = useRef(false);
  useEffect(() => setPageInput(String(props.page)), [props.page]);
  const commitPage = () => {
    const page = parsePdfPageInput(pageInput, props.pageCount);
    if (page === null) setPageInput(String(props.page));
    else props.onPage(page);
  };
  return (
    <div className="scient-document-controls">
      <div className="scient-pdf-toolbar" role="toolbar" aria-label={props.label + " controls"}>
        <ReaderButton
          className="scient-pdf-action-sidebar"
          label={
            props.sidebarOpen
              ? "Hide " + props.label + " sidebar"
              : "Show " + props.label + " sidebar"
          }
          onClick={props.onToggleSidebar}
        >
          {props.sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
        </ReaderButton>
        <div className="scient-pdf-toolbar-separator" />
        <ReaderButton
          className="scient-pdf-action-page-step"
          label="Previous page"
          disabled={!props.ready || props.page <= 1}
          onClick={() => props.onPage(props.page - 1)}
        >
          <ChevronLeft />
        </ReaderButton>
        <div className="scient-pdf-page-control">
          <input
            value={pageInput}
            inputMode="numeric"
            aria-label="Page number"
            disabled={!props.ready}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commitPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPage();
            }}
          />
          <span aria-label={`${props.pageCount} pages`}>/ {props.pageCount || "–"}</span>
        </div>
        <ReaderButton
          className="scient-pdf-action-page-step"
          label="Next page"
          disabled={!props.ready || props.page >= props.pageCount}
          onClick={() => props.onPage(props.page + 1)}
        >
          <ChevronRight />
        </ReaderButton>
        <div className="scient-pdf-toolbar-separator" />
        <div className="scient-pdf-zoom-stepper">
          <ReaderButton
            className="scient-pdf-action-zoom-step"
            label={
              "Zoom in" +
              (props.shortcutLabel("pdf.zoomIn")
                ? " (" + props.shortcutLabel("pdf.zoomIn") + ")"
                : "")
            }
            disabled={!props.ready}
            onClick={() => props.onZoom(stepPdfZoom(props.scale, "in"))}
          >
            <Plus />
          </ReaderButton>
          <ReaderButton
            className="scient-pdf-action-zoom-step"
            label={
              "Zoom out" +
              (props.shortcutLabel("pdf.zoomOut")
                ? " (" + props.shortcutLabel("pdf.zoomOut") + ")"
                : "")
            }
            disabled={!props.ready}
            onClick={() => props.onZoom(stepPdfZoom(props.scale, "out"))}
          >
            <Minus />
          </ReaderButton>
        </div>
        <ScientTooltip content="Fit width">
          <button
            type="button"
            className="scient-pdf-zoom-label"
            aria-label={"Fit width, zoom " + formatPdfZoom(props.scale)}
            disabled={!props.ready}
            onClick={() => props.onFitWidth()}
          >
            {formatPdfZoom(props.scale)}
          </button>
        </ScientTooltip>
        {props.contextControls ?? <div className="min-w-1 flex-1" />}
        <ReaderButton
          className="scient-pdf-action-search"
          label={
            "Search " +
            props.label +
            (props.shortcutLabel("pdf.find") ? " (" + props.shortcutLabel("pdf.find") + ")" : "")
          }
          aria-pressed={props.searchOpen}
          onClick={props.onToggleSearch}
        >
          <Search />
        </ReaderButton>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) searchOwnsFocus.current = false;
          }}
          onOpenChangeComplete={(open) => {
            if (open) return;
            const action = pendingSearch.current;
            pendingSearch.current = null;
            action?.();
          }}
        >
          <DropdownMenuTrigger render={<ReaderButton label={"More " + props.label + " actions"} />}>
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" finalFocus={() => !searchOwnsFocus.current}>
            <DropdownMenuItem
              disabled={!props.ready}
              onClick={() => props.onZoom(stepPdfZoom(props.scale, "out"))}
            >
              <ZoomOut /> Zoom out
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!props.ready} onClick={() => props.onActualSize()}>
              <Scan /> Actual size
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!props.ready}
              onClick={() => props.onZoom(stepPdfZoom(props.scale, "in"))}
            >
              <ZoomIn /> Zoom in
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!props.ready} onClick={() => props.onFitWidth()}>
              <Maximize2 /> Fit width
            </DropdownMenuItem>
            <DropdownMenuItem onClick={props.onToggleSidebar}>
              <ListTree /> {props.sidebarOpen ? "Hide sidebar" : "Show pages and outline"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                searchOwnsFocus.current = true;
                pendingSearch.current = props.onShowSearch;
              }}
            >
              <Search /> Search {props.label}
            </DropdownMenuItem>
            {props.contextControls ? (
              <>
                <DropdownMenuItem
                  disabled={!props.ready || props.page <= 1}
                  onClick={() => props.onPage(props.page - 1)}
                >
                  <ChevronLeft /> Previous page
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!props.ready || props.page >= props.pageCount}
                  onClick={() => props.onPage(props.page + 1)}
                >
                  <ChevronRight /> Next page
                </DropdownMenuItem>
              </>
            ) : null}
            {props.moreActions}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function DocumentSearchBar(props: {
  label: string;
  query: string;
  current: number;
  total: number;
  notFound: boolean;
  focusRequest?: number;
  onQuery: (query: string) => void;
  onNavigate: (backwards: boolean) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, [props.focusRequest]);
  return (
    <div className="scient-document-controls">
      <form
        className="scient-pdf-searchbar"
        onSubmit={(event) => {
          event.preventDefault();
          props.onNavigate(false);
        }}
      >
        <Search className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <input
          ref={input}
          value={props.query}
          placeholder={props.label}
          aria-label={props.label}
          onChange={(event) => {
            const value = event.target.value;
            props.onQuery(value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              props.onNavigate(event.shiftKey);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              props.onNavigate(false);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              props.onNavigate(true);
            }
          }}
        />
        <span className="scient-pdf-find-count">
          {props.total > 0 ? `${props.current} of ${props.total}` : props.notFound ? "0 of 0" : ""}
        </span>
        <ReaderButton
          className="scient-pdf-search-secondary"
          label="Previous result"
          disabled={!props.query}
          onClick={() => props.onNavigate(true)}
        >
          <ChevronDown className="rotate-180" />
        </ReaderButton>
        <ReaderButton
          className="scient-pdf-search-secondary"
          label="Next result"
          disabled={!props.query}
          onClick={() => props.onNavigate(false)}
        >
          <ChevronDown />
        </ReaderButton>
        <ReaderButton label="Close search" onClick={props.onClose}>
          <X />
        </ReaderButton>
      </form>
    </div>
  );
}
