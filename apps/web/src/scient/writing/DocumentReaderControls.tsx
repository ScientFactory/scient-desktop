import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { formatPdfZoom, parsePdfPageInput, stepPdfZoom } from "../pdf/pdfReaderModel";
import { ReaderBarHostContext } from "./readerBarHost";
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

/** The row a More menu belongs to, so it can leave out what the row shows. */
export const ReaderRowContext = createContext<HTMLElement | null>(null);

/**
 * A More menu item that stands in for a control in the row: it appears only
 * while that control is hidden, for example in a narrow pane.
 */
export function IfRowHidden(props: { readonly selector: string; readonly children: ReactNode }) {
  const row = useContext(ReaderRowContext);
  if (!row) return props.children;
  const shown = [...row.querySelectorAll<HTMLElement>(props.selector)].some(
    (element) => element.getClientRects().length > 0,
  );
  return shown ? null : props.children;
}

/** What the search field in the reader controls shows and does. */
export interface ReaderSearch {
  readonly query: string;
  /** The active result, counted from 1; 0 when there is none. */
  readonly current: number;
  readonly total: number;
  readonly notFound: boolean;
  /** Raised to move focus into the field, for example by Cmd+F. */
  readonly focusRequest: number;
  readonly onQuery: (query: string) => void;
  readonly onNavigate: (backwards: boolean) => void;
  /** Escape: forget the search. */
  readonly onClear: () => void;
  readonly onFocus?: (() => void) | undefined;
}

/**
 * A search field that rests as quietly as the sidebar's: an icon and "Search",
 * no frame. Click and type. Once there is a query, the count and two small
 * arrows appear at its end.
 */
export function ReaderSearchField(props: ReaderSearch & { readonly label: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { focusRequest } = props;
  useEffect(() => {
    if (!focusRequest) return;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);
  const searching = props.query !== "";
  return (
    <div
      className="scient-reader-search"
      data-searching={searching ? "" : undefined}
      onMouseDown={(event) => {
        // The whole field takes the click, not only the text.
        if (event.target instanceof Element && event.target.closest("input, button")) return;
        event.preventDefault();
        input.current?.focus();
      }}
    >
      <div className="scient-reader-search-box">
        <Search className="scient-reader-search-icon" aria-hidden="true" />
        <input
          ref={input}
          value={props.query}
          placeholder="Search"
          aria-label={`Search ${props.label}`}
          spellCheck={false}
          onFocus={props.onFocus}
          onChange={(event) => props.onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              props.onNavigate(
                event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey),
              );
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (searching) props.onClear();
              else input.current?.blur();
            }
          }}
        />
        {searching ? (
          <>
            <span className="scient-reader-search-count" aria-live="polite">
              {props.total > 0 ? `${props.current}/${props.total}` : props.notFound ? "0/0" : ""}
            </span>
            <button
              type="button"
              aria-label="Previous result"
              disabled={props.total === 0}
              onClick={() => props.onNavigate(true)}
            >
              <ChevronDown className="rotate-180" />
            </button>
            <button
              type="button"
              aria-label="Next result"
              disabled={props.total === 0}
              onClick={() => props.onNavigate(false)}
            >
              <ChevronDown />
            </button>
          </>
        ) : null}
      </div>
    </div>
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
  /** When given, search is a field in the row instead of a button. */
  search?: ReaderSearch | undefined;
}) {
  const [pageInput, setPageInput] = useState(String(props.page));
  const pendingSearch = useRef<(() => void) | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [menuRow, setMenuRow] = useState<HTMLElement | null>(null);
  const searchOwnsFocus = useRef(false);
  useEffect(() => setPageInput(String(props.page)), [props.page]);
  const host = useContext(ReaderBarHostContext);
  const hostSlot = host?.slot ?? null;
  const onHosted = host?.onHosted;
  useLayoutEffect(() => {
    if (!onHosted || hostSlot === null) return;
    onHosted(true);
    return () => onHosted(false);
  }, [onHosted, hostSlot]);
  const commitPage = () => {
    const page = parsePdfPageInput(pageInput, props.pageCount);
    if (page === null) setPageInput(String(props.page));
    else props.onPage(page);
  };
  const toolbar = (
    <div
      ref={toolbarRef}
      className={cn("scient-pdf-toolbar", host ? "scient-pdf-toolbar-hosted" : null)}
      role="toolbar"
      aria-label={props.label + " controls"}
    >
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
          // As wide as the longest page number, with two digits as the minimum.
          style={{ width: `calc(${Math.max(2, String(props.pageCount).length)}ch + 12px)` }}
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
      <ReaderButton
        className="scient-pdf-action-zoom-step"
        label={
          "Zoom in" +
          (props.shortcutLabel("pdf.zoomIn") ? " (" + props.shortcutLabel("pdf.zoomIn") + ")" : "")
        }
        disabled={!props.ready}
        onClick={() => props.onZoom(stepPdfZoom(props.scale, "in"))}
      >
        <Plus />
      </ReaderButton>
      {host?.afterZoom}
      {props.search ? <ReaderSearchField label={props.label} {...props.search} /> : null}
      {host?.afterSearch}
      {(host ? null : props.contextControls) ?? <div className="min-w-1 flex-1" />}
      {host?.beforeTrailing}
      {props.search ? null : (
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
      )}
      {host?.trailing}
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          searchOwnsFocus.current = false;
          const toolbarElement = toolbarRef.current;
          setMenuRow(
            toolbarElement?.closest<HTMLElement>(".scient-latex-toolbar") ?? toolbarElement,
          );
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
          {/* Only what the row does not show right now, and what has no button. */}
          <ReaderRowContext value={menuRow}>
            <IfRowHidden selector=".scient-pdf-action-zoom-step">
              <DropdownMenuItem
                disabled={!props.ready}
                onClick={() => props.onZoom(stepPdfZoom(props.scale, "out"))}
              >
                <ZoomOut /> Zoom out
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!props.ready}
                onClick={() => props.onZoom(stepPdfZoom(props.scale, "in"))}
              >
                <ZoomIn /> Zoom in
              </DropdownMenuItem>
            </IfRowHidden>
            <DropdownMenuItem disabled={!props.ready} onClick={() => props.onActualSize()}>
              <Scan /> Actual size
            </DropdownMenuItem>
            <IfRowHidden selector=".scient-pdf-zoom-label">
              <DropdownMenuItem disabled={!props.ready} onClick={() => props.onFitWidth()}>
                <Maximize2 /> Fit width
              </DropdownMenuItem>
            </IfRowHidden>
            <IfRowHidden selector=".scient-pdf-action-sidebar">
              <DropdownMenuItem onClick={props.onToggleSidebar}>
                <ListTree /> {props.sidebarOpen ? "Hide sidebar" : "Show pages and outline"}
              </DropdownMenuItem>
            </IfRowHidden>
            <IfRowHidden selector=".scient-reader-search, .scient-pdf-action-search">
              <DropdownMenuItem
                onClick={() => {
                  searchOwnsFocus.current = true;
                  pendingSearch.current = props.onShowSearch;
                }}
              >
                <Search /> Search {props.label}
              </DropdownMenuItem>
            </IfRowHidden>
            {props.contextControls || host ? (
              <IfRowHidden selector=".scient-pdf-action-page-step">
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
              </IfRowHidden>
            ) : null}
            {props.moreActions}
            {host?.moreActions ? (
              <>
                <DropdownMenuSeparator />
                {host.moreActions}
              </>
            ) : null}
          </ReaderRowContext>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  // Hosted: the controls join the surface's own header row.
  if (host) return hostSlot ? createPortal(toolbar, hostSlot) : null;
  return <div className="scient-document-controls">{toolbar}</div>;
}
