import {
  dataTablePageRows,
  type DataTableColumn,
  type DataTableMinimum,
  type DataTablePage,
  type DataTableQuery,
  type DataTableRow,
  type DataTableSort,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { ArrowDown, ArrowUp, Ellipsis, Search } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { FileSurfaceFailure, FileSurfaceLoading } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { m, type MessageResolver } from "~/i18n/messages";
import { Spinner } from "~/components/ui/spinner";
import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { DataColumnTypeLabel } from "./DataColumnTypeLabel";
import { GridActionMenuContext } from "./gridActionMenu";
import { DataGridMinimumFilter } from "./DataGridMinimumFilter";

import {
  clampColumnWidth,
  columnWindow,
  dataColumnTypeName,
  HEADER_HEIGHT,
  initialColumnWidth,
  isNumericType,
  MAX_COPY_ROWS,
  ROW_HEIGHT,
  rowWindow,
  tableText,
} from "./dataGridModel";

const MAX_CACHED_PAGES = 64;
const MAX_LOADING_PAGES = 2;
const FIRST_PAGE_LIMIT = 200;
type TableShape = Omit<DataTablePage, "offset" | "rows">;

interface Cell {
  readonly row: number;
  readonly column: number;
}

/**
 * One view of the table (source, sort and search). Its rows are replaced whole when the view
 * changes; the shape stays so the header holds still while the new rows arrive.
 */
interface ViewState {
  readonly view: string;
  readonly pages: Map<number, ReadonlyArray<DataTableRow>>;
  readonly loading: Set<number>;
  readonly shape: TableShape | null;
  readonly error: string | null;
}

const viewState = (view: string, shape: TableShape | null): ViewState => ({
  view,
  pages: new Map(),
  loading: new Set(),
  shape,
  error: null,
});

export interface DataGridView {
  readonly columns: ReadonlyArray<DataTableColumn>;
  readonly search: string;
  readonly minimum: DataTableMinimum | null;
  readonly sort: DataTableSort | null;
  readonly selectedColumns: { readonly first: number; readonly last: number } | null;
}

export interface DataGridProps {
  readonly label: string;
  readonly validateCopy?: () => Promise<void>;
  readonly loadPage: (query: DataTableQuery) => Promise<DataTablePage>;
  /** A new revision drops every loaded row, as when the source changes. */
  readonly revision: string;
  readonly toolbarStart?: ReactNode;
  readonly isCellChanged?: (rowLabel: string, column: number) => boolean;
  readonly toolbarEnd?: ReactNode;
  readonly enableMinimumFilter?: boolean;
  readonly renderMenuActions?: (view: DataGridView) => ReactNode;
}

/** A paged, virtualized table: only the rows on screen are ever fetched or drawn. */
export function DataGrid(props: DataGridProps) {
  const gt = useGT();
  const messages = useMessages();
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const launching = useRef(false);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<{ revision: string; minimum: DataTableMinimum } | null>(
    null,
  );
  const minimum = filter?.revision === props.revision ? filter.minimum : null;
  const [attempt, setAttempt] = useState(0);
  const view = JSON.stringify([props.revision, sort, search, minimum, attempt]);

  const [widths, setWidths] = useState<{ revision: string; values: number[] } | null>(null);
  const [table, setTable] = useState(() => viewState(view, null));
  if (table.view !== view) setTable(viewState(view, table.shape));
  const { shape, error } = table;

  const scroller = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [focus, setFocus] = useState<Cell | null>(null);
  const { copyToClipboard } = useCopyToClipboard({ target: namedClipboardTarget("cells") });

  // A new ref callback each render would re-observe, and a resize report renders again.
  const measureScroller = useStableCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    if (!node) return;
    const measure = () =>
      setViewport((old) =>
        old.width === node.clientWidth && old.height === node.clientHeight
          ? old
          : { width: node.clientWidth, height: node.clientHeight },
      );
    measure();
    return observeResize(node, measure);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- typing settles before the source scans every row.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchText.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const columns = shape?.columns ?? [];
  const rowCount = shape?.matchCount ?? 0;
  const pageRows = dataTablePageRows(columns.length);
  const visibleRows = rowWindow({
    scrollTop: scroll.top,
    viewportHeight: viewport.height,
    rowCount,
  });
  const firstPage = Math.floor(visibleRows.first / pageRows);
  const lastPage = Math.floor((visibleRows.first + Math.max(0, visibleRows.count - 1)) / pageRows);

  const requestPage = useStableCallback((page: number) => {
    const requested = table;
    requested.loading.add(page);
    const revision = props.revision;
    const first = shape === null;
    props
      .loadPage({
        offset: first ? 0 : page * pageRows,
        limit: first ? FIRST_PAGE_LIMIT : pageRows,
        sort,
        search,
        ...(minimum === null ? {} : { minimum }),
      })
      .then(
        ({ rows, offset: _offset, ...nextShape }) => {
          requested.loading.delete(page);
          requested.pages.set(page, rows);
          for (const old of requested.pages.keys()) {
            if (requested.pages.size <= MAX_CACHED_PAGES) break;
            if (Math.abs(old - page) > MAX_CACHED_PAGES / 2) requested.pages.delete(old);
          }
          setTable((current) =>
            current.view === requested.view ? { ...current, shape: nextShape } : current,
          );
          setWidths((current) =>
            current?.revision === revision && current.values.length === nextShape.columns.length
              ? current
              : {
                  revision,
                  values: nextShape.columns.map((column, index) =>
                    initialColumnWidth(
                      column,
                      dataColumnTypeName(column.type, messages),
                      rows.slice(0, 50).map((row) => row.cells[index] ?? null),
                    ),
                  ),
                },
          );
        },
        (cause: unknown) => {
          requested.loading.delete(page);
          setTable((current) =>
            current.view === requested.view ? { ...current, error: errorMessage(cause) } : current,
          );
        },
      );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rows come from the server page by page as they scroll into view.
  useEffect(() => {
    const { pages, loading } = table;
    if (error !== null || loading.size >= MAX_LOADING_PAGES) return;
    if (pages.size === 0) {
      if (!loading.has(0)) requestPage(0);
      return;
    }
    for (let page = firstPage; page <= lastPage; page++) {
      if (loading.size >= MAX_LOADING_PAGES) break;
      if (!pages.has(page) && !loading.has(page)) requestPage(page);
    }
  });

  const rowAt = (row: number) => table.pages.get(Math.floor(row / pageRows))?.[row % pageRows];

  const columnWidths = widths?.values ?? [];
  const offsets = [0];
  for (const width of columnWidths) offsets.push(offsets.at(-1)! + width);
  const labelChars = Math.max(
    String(shape?.rowCount ?? 0).length,
    ...Array.from({ length: visibleRows.count }, (_, index) =>
      Math.min(24, rowAt(visibleRows.first + index)?.label.length ?? 0),
    ),
  );
  const rowHeaderWidth = Math.max(44, labelChars * 8 + 20);
  const totalWidth = rowHeaderWidth + offsets.at(-1)!;
  const visibleColumns = columnWindow(
    offsets,
    scroll.left,
    Math.max(0, viewport.width - rowHeaderWidth),
  );
  const columnIndexes = Array.from(
    { length: visibleColumns.end - visibleColumns.first },
    (_, index) => visibleColumns.first + index,
  );

  const changeSort = (column: number) => {
    setSort((current) =>
      current?.column !== column
        ? { column, descending: false }
        : current.descending
          ? null
          : { column, descending: true },
    );
    resetPosition();
  };

  const resetPosition = () => {
    setAnchor(null);
    setFocus(null);
    if (scroller.current) scroller.current.scrollTop = 0;
    setScroll((current) => ({ ...current, top: 0 }));
  };

  const selection =
    anchor && focus
      ? {
          top: Math.min(anchor.row, focus.row),
          bottom: Math.max(anchor.row, focus.row),
          left: Math.min(anchor.column, focus.column),
          right: Math.max(anchor.column, focus.column),
        }
      : null;

  const reveal = (cell: Cell) => {
    const node = scroller.current;
    if (!node) return;
    if (cell.row < visibleRows.first) node.scrollTop = visibleRows.scrollTopFor(cell.row);
    else if (cell.row >= visibleRows.first + visibleRows.rowsPerPage)
      node.scrollTop = visibleRows.scrollTopFor(cell.row - visibleRows.rowsPerPage + 1);
    const left = offsets[cell.column]!;
    const right = offsets[cell.column + 1]!;
    const dataWidth = node.clientWidth - rowHeaderWidth;
    if (left < node.scrollLeft) node.scrollLeft = left;
    else if (right > node.scrollLeft + dataWidth) node.scrollLeft = right - dataWidth;
  };

  const copySelection = async () => {
    if (!selection) return;
    const bottom = Math.min(selection.bottom, selection.top + MAX_COPY_ROWS - 1);
    const lines: Array<ReadonlyArray<string | null>> = [];
    const wholeTable = selection.top === 0 && selection.bottom === rowCount - 1;
    if (wholeTable)
      lines.push(columns.slice(selection.left, selection.right + 1).map((c) => c.name));
    for (let page = Math.floor(selection.top / pageRows); page * pageRows <= bottom; page++) {
      const rows =
        table.pages.get(page) ??
        (
          await props.loadPage({
            offset: page * pageRows,
            limit: pageRows,
            sort,
            search,
            ...(minimum === null ? {} : { minimum }),
          })
        ).rows;
      for (let index = 0; index < rows.length; index++) {
        const row = page * pageRows + index;
        if (row < selection.top || row > bottom) continue;
        lines.push(rows[index]!.cells.slice(selection.left, selection.right + 1));
      }
    }
    await props.validateCopy?.();
    copyToClipboard(tableText(lines), undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || rowCount === 0 || columns.length === 0) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copySelection().catch((cause: unknown) =>
        setTable((current) => ({ ...current, error: errorMessage(cause) })),
      );
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setAnchor({ row: 0, column: 0 });
      setFocus({ row: rowCount - 1, column: columns.length - 1 });
      return;
    }
    const current = focus ?? { row: visibleRows.first, column: visibleColumns.first };
    const lastRow = rowCount - 1;
    const lastColumn = columns.length - 1;
    const moves: Record<string, Cell> = {
      ArrowUp: { row: mod ? 0 : current.row - 1, column: current.column },
      ArrowDown: { row: mod ? lastRow : current.row + 1, column: current.column },
      ArrowLeft: { row: current.row, column: mod ? 0 : current.column - 1 },
      ArrowRight: { row: current.row, column: mod ? lastColumn : current.column + 1 },
      PageUp: { row: current.row - visibleRows.rowsPerPage, column: current.column },
      PageDown: { row: current.row + visibleRows.rowsPerPage, column: current.column },
      Home: { row: mod ? 0 : current.row, column: 0 },
      End: { row: mod ? lastRow : current.row, column: lastColumn },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const next = {
      row: Math.max(0, Math.min(lastRow, move.row)),
      column: Math.max(0, Math.min(lastColumn, move.column)),
    };
    if (!event.shiftKey || !anchor) setAnchor(next);
    setFocus(next);
    reveal(next);
  };

  const selectCell = (cell: Cell, extend: boolean) => {
    if (!extend || !anchor) setAnchor(cell);
    setFocus(cell);
  };

  const resizeColumn = (column: number, event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = columnWidths[column] ?? 0;
    const move = (moveEvent: globalThis.PointerEvent) =>
      setWidths((current) =>
        current === null
          ? current
          : {
              ...current,
              values: current.values.map((width, index) =>
                index === column
                  ? clampColumnWidth(startWidth + moveEvent.clientX - startX)
                  : width,
              ),
            },
      );
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  if (error !== null)
    return (
      <FileSurfaceFailure
        title={gt("Couldn't read this table")}
        description={error}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  if (shape === null) return <FileSurfaceLoading />;

  const busy = Array.from(
    { length: lastPage - firstPage + 1 },
    (_, index) => firstPage + index,
  ).some((page) => table.loading.has(page));
  const rows = Array.from(
    { length: Math.max(0, visibleRows.count) },
    (_, index) => visibleRows.first + index,
  );

  const menu = {
    finalFocus: () => actionTrigger.current,
    launch: (open: () => void) => {
      launching.current = true;
      open();
    },
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {shape.truncated || shape.columns.length < shape.columnCount ? (
        <div
          role="status"
          className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 scient-reading-micro text-warning-foreground"
        >
          {shape.truncated ? (
            <p>
              {gt("Only the first {count} rows are available. Search and sort use these rows.", {
                count: shape.rowCount.toLocaleString(),
              })}
            </p>
          ) : null}
          {shape.columns.length < shape.columnCount ? (
            <p>
              {gt("Showing the first {count} of {total} columns.", {
                count: shape.columns.length.toLocaleString(),
                total: shape.columnCount.toLocaleString(),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="shrink-0 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {props.toolbarStart}
          <div className="min-w-0 flex-1">
            <InputGroup>
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                nativeInput
                size="compact"
                type="search"
                placeholder={gt("Search", { $context: "search field placeholder" })}
                aria-label={gt("Search {table}", { table: props.label })}
                value={searchText}
                onChange={(event) => {
                  setSearchText(event.currentTarget.value);
                  resetPosition();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchText !== "") {
                    event.stopPropagation();
                    setSearchText("");
                    resetPosition();
                  }
                }}
              />
            </InputGroup>
          </div>
          {props.toolbarEnd}
          {(props.enableMinimumFilter && columns.some(({ type }) => isNumericType(type))) ||
          props.renderMenuActions ? (
            <GridActionMenuContext value={menu}>
              <Menu
                modal={false}
                onOpenChange={(open) => {
                  if (open) launching.current = false;
                }}
              >
                <MenuTrigger
                  ref={actionTrigger}
                  aria-label={gt("Grid actions")}
                  render={(trigger, { open }) => (
                    <Button
                      {...trigger}
                      focus="edge"
                      type="button"
                      size="xs"
                      variant={open ? "selected" : "ghost"}
                    />
                  )}
                >
                  <Ellipsis aria-hidden="true" />
                  {gt("Actions")}
                </MenuTrigger>
                <MenuPopup keepMounted align="end" finalFocus={() => !launching.current}>
                  {props.enableMinimumFilter && columns.some(({ type }) => isNumericType(type)) ? (
                    <DataGridMinimumFilter
                      columns={columns}
                      minimum={minimum}
                      onChange={(value) => {
                        setFilter(
                          value === null ? null : { revision: props.revision, minimum: value },
                        );
                        resetPosition();
                      }}
                    />
                  ) : null}
                  {props.renderMenuActions?.({
                    columns,
                    search,
                    minimum,
                    sort,
                    selectedColumns:
                      anchor && focus
                        ? {
                            first: Math.min(anchor.column, focus.column),
                            last: Math.max(anchor.column, focus.column),
                          }
                        : null,
                  })}
                </MenuPopup>
              </Menu>
            </GridActionMenuContext>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-2">
            {busy ? <Spinner size="xs" /> : null}
            {tableCounts(shape, messages)}
          </span>
          {minimum === null ? null : (
            <span className="min-w-0 wrap-anywhere">
              {gt("Filter applied · {column} ≥ {value}", {
                column: columns[minimum.column]?.name ?? "",
                value: minimum.value.toLocaleString(),
              })}
            </span>
          )}
        </div>
      </div>
      <div
        ref={measureScroller}
        role="grid"
        tabIndex={0}
        aria-label={props.label}
        aria-rowcount={rowCount + 1}
        aria-colcount={columns.length + 1}
        aria-multiselectable="true"
        className="relative min-h-0 flex-1 overflow-auto text-xs outline-none select-none focus-visible:outline-1 focus-visible:outline-solid focus-visible:-outline-offset-1 focus-visible:outline-ring"
        onScroll={(event) =>
          setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })
        }
        onKeyDown={onKeyDown}
      >
        <div
          style={{ height: Math.max(visibleRows.trackHeight, viewport.height), width: totalWidth }}
        >
          <div
            className="sticky top-0 overflow-hidden"
            style={{ height: viewport.height, width: totalWidth }}
          >
            <div
              role="row"
              aria-rowindex={1}
              className="relative z-20 flex border-b border-border bg-muted"
              style={{ height: HEADER_HEIGHT }}
            >
              <div
                className="sticky left-0 z-10 shrink-0 border-r border-border bg-muted"
                style={{ width: rowHeaderWidth }}
              />
              {columnIndexes.map((column) => (
                <ColumnHeader
                  key={column}
                  column={columns[column]!}
                  index={column}
                  left={rowHeaderWidth + offsets[column]!}
                  width={columnWidths[column]!}
                  sort={sort?.column === column ? sort : null}
                  onSort={() => changeSort(column)}
                  onResize={(event) => resizeColumn(column, event)}
                />
              ))}
            </div>
            <div style={{ transform: `translateY(${-visibleRows.offset}px)` }}>
              {rows.map((position) => {
                const row = rowAt(position);
                const rowSelected =
                  selection !== null && position >= selection.top && position <= selection.bottom;
                return (
                  <div
                    key={position}
                    role="row"
                    aria-rowindex={position + 2}
                    className={cn(
                      "relative flex border-b border-border/50",
                      position % 2 === 1 && "bg-muted/25",
                    )}
                    style={{ height: ROW_HEIGHT, width: totalWidth }}
                  >
                    <div
                      role="rowheader"
                      className={cn(
                        "sticky left-0 z-10 shrink-0 truncate border-r border-border bg-background px-2 text-right leading-7 text-muted-foreground tabular-nums",
                        rowSelected && "text-foreground",
                      )}
                      style={{ width: rowHeaderWidth }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        scroller.current?.focus();
                        setAnchor({
                          row: event.shiftKey && anchor ? anchor.row : position,
                          column: 0,
                        });
                        setFocus({ row: position, column: columns.length - 1 });
                      }}
                    >
                      {row?.label ?? ""}
                    </div>
                    {columnIndexes.map((column) => {
                      const value = row?.cells[column] ?? null;
                      const selected =
                        rowSelected && column >= selection!.left && column <= selection!.right;
                      const active = focus?.row === position && focus.column === column;
                      const changed =
                        row !== undefined && props.isCellChanged?.(row.label, column) === true;
                      return (
                        <div
                          key={column}
                          role="gridcell"
                          aria-colindex={column + 2}
                          aria-selected={selected}
                          aria-label={
                            changed
                              ? gt("{value} · changed", { value: value ?? gt("Missing") })
                              : undefined
                          }
                          className={cn(
                            "absolute top-0 h-full truncate border-r border-border/40 px-2 leading-7",
                            isNumericType(columns[column]!.type) && "text-right tabular-nums",
                            value === null && "text-muted-foreground/50",
                            changed && "bg-amber-500/15 font-medium",
                            selected && "bg-primary/10",
                            active && "outline outline-1 -outline-offset-1 outline-primary",
                          )}
                          style={{
                            left: rowHeaderWidth + offsets[column]!,
                            width: columnWidths[column],
                          }}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            scroller.current?.focus();
                            selectCell({ row: position, column }, event.shiftKey);
                          }}
                          onPointerEnter={(event) => {
                            if (event.buttons === 1 && anchor) setFocus({ row: position, column });
                          }}
                        >
                          {row ? (value ?? "null") : ""}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ColumnHeader(props: {
  readonly column: DataTableColumn;
  readonly index: number;
  readonly left: number;
  readonly width: number;
  readonly sort: DataTableSort | null;
  readonly onSort: () => void;
  readonly onResize: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const numeric = isNumericType(props.column.type);
  return (
    <div
      role="columnheader"
      aria-colindex={props.index + 2}
      aria-sort={props.sort === null ? "none" : props.sort.descending ? "descending" : "ascending"}
      className="absolute top-0 h-full border-r border-border/60"
      style={{ left: props.left, width: props.width }}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cn(
          "flex size-full flex-col justify-center px-2 hover:bg-accent/60",
          numeric ? "items-end" : "items-start",
        )}
        onClick={props.onSort}
      >
        <span className="flex max-w-full items-center gap-1 font-medium text-foreground">
          <span className="truncate">{props.column.name}</span>
          {props.sort === null ? null : props.sort.descending ? (
            <ArrowDown className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <ArrowUp className="size-3 shrink-0" aria-hidden="true" />
          )}
        </span>
        <DataColumnTypeLabel
          column={props.column}
          className="max-w-full truncate text-[10px] text-muted-foreground"
        />
      </button>
      <div
        aria-hidden="true"
        className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-primary/30"
        onPointerDown={props.onResize}
      />
    </div>
  );
}

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : m(msg("The table could not be read."));

function tableCounts(shape: TableShape, resolve: MessageResolver): string {
  const total = shape.rowCount.toLocaleString();
  const rows =
    shape.matchCount === shape.rowCount
      ? resolve(
          msg("{count, plural, one {{total} row} other {{total} rows}}", {
            count: shape.rowCount,
            total,
          }),
        )
      : resolve(
          msg("{matches} of {count, plural, one {{total} row} other {{total} rows}}", {
            count: shape.rowCount,
            matches: shape.matchCount.toLocaleString(),
            total,
          }),
        );
  const columns = resolve(
    msg("{count, plural, one {{columns} column} other {{columns} columns}}", {
      count: shape.columnCount,
      columns: shape.columnCount.toLocaleString(),
    }),
  );
  return `${rows} · ${columns}`;
}
