import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Table as TableIcon } from "lucide-react";
import { MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { DockCommandItem as MenuItem } from "./dockChrome";
import {
  DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS,
  MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION,
  type ScientMarkdownTableDimensions,
} from "../markdownEditor/prosemirror/commands";

const INITIAL_TABLE_SIZE_PICKER_DIMENSIONS = {
  columns: 8,
  rows: 8,
} as const satisfies ScientMarkdownTableDimensions;
const TABLE_SIZE_PICKER_CELL_GAP_PX = 3;
const TABLE_SIZE_PICKER_CELL_SIZE_PX = 16;
const TABLE_SIZE_PICKER_POINTER_GRACE_PITCHES = 2.5;
const LOCKED_TABLE_SIZE_PICKER_COLLISION_AVOIDANCE = {
  side: "none",
  align: "shift",
  fallbackAxisSide: "none",
} as const;

type PhysicalHorizontalSide = "left" | "right";

interface TableSizePickerPlacement {
  readonly side: PhysicalHorizontalSide | null;
  readonly locked: boolean;
}

interface TableSizePickerPointerBounds {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

function tableSizePickerGridInlineSize(columns: number): string {
  return `calc(${columns}rem + ${(columns - 1) * TABLE_SIZE_PICKER_CELL_GAP_PX}px)`;
}

function tableSizeChoices(
  visibleDimensions: ScientMarkdownTableDimensions,
): ReadonlyArray<ScientMarkdownTableDimensions> {
  return Array.from(
    { length: visibleDimensions.columns * visibleDimensions.rows },
    (_unused, index) => ({
      columns: (index % visibleDimensions.columns) + 1,
      rows: Math.floor(index / visibleDimensions.columns) + 1,
    }),
  );
}

function expandedTableSizePickerDimensions(
  visibleDimensions: ScientMarkdownTableDimensions,
  activeDimensions: ScientMarkdownTableDimensions,
): ScientMarkdownTableDimensions {
  const expand = (visible: number, active: number) =>
    active >= visible - 1
      ? Math.min(MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION, Math.max(visible + 1, active + 1))
      : visible;
  return {
    columns: expand(visibleDimensions.columns, activeDimensions.columns),
    rows: expand(visibleDimensions.rows, activeDimensions.rows),
  };
}

function tableSizePickerCellIndex(dimensions: ScientMarkdownTableDimensions): number {
  return (
    (dimensions.rows - 1) * MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION + dimensions.columns - 1
  );
}

function popupPhysicalHorizontalSide(
  side: string | undefined,
  direction: string,
): PhysicalHorizontalSide | null {
  if (side === "left") return "left";
  if (side === "right") return "right";
  if (side === "inline-start") return direction === "rtl" ? "right" : "left";
  if (side === "inline-end") return direction === "rtl" ? "left" : "right";
  return null;
}

function continuedTableSizeFromPointer({
  activeDimensions,
  bounds,
  cellPitch,
  opensToLeft,
  pointerX,
  pointerY,
  visibleDimensions,
}: {
  readonly activeDimensions: ScientMarkdownTableDimensions;
  readonly bounds: TableSizePickerPointerBounds;
  readonly cellPitch: number;
  readonly opensToLeft: boolean;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly visibleDimensions: ScientMarkdownTableDimensions;
}): ScientMarkdownTableDimensions | null {
  const graceDistance = cellPitch * TABLE_SIZE_PICKER_POINTER_GRACE_PITCHES;
  const horizontalDistance = opensToLeft ? bounds.left - pointerX : pointerX - bounds.right;
  const verticalDistance = pointerY - bounds.bottom;
  const canContinueColumns =
    horizontalDistance > 0 &&
    horizontalDistance <= graceDistance &&
    pointerY >= bounds.top &&
    pointerY <= bounds.bottom + graceDistance;
  const canContinueRows =
    verticalDistance > 0 &&
    verticalDistance <= graceDistance &&
    pointerX >= bounds.left - graceDistance &&
    pointerX <= bounds.right + graceDistance;

  if (!canContinueColumns && !canContinueRows) return null;

  const dimensions = {
    columns: canContinueColumns
      ? Math.min(
          MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION,
          visibleDimensions.columns + Math.ceil(horizontalDistance / cellPitch),
        )
      : activeDimensions.columns,
    rows: canContinueRows
      ? Math.min(
          MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION,
          visibleDimensions.rows + Math.ceil(verticalDistance / cellPitch),
        )
      : activeDimensions.rows,
  };
  return dimensions.columns === activeDimensions.columns &&
    dimensions.rows === activeDimensions.rows
    ? null
    : dimensions;
}

function tableSizeLabel(dimensions: ScientMarkdownTableDimensions): string {
  const columnLabel = dimensions.columns === 1 ? "column" : "columns";
  const rowLabel = dimensions.rows === 1 ? "row" : "rows";
  return `${dimensions.columns} ${columnLabel} × ${dimensions.rows} ${rowLabel}`;
}

export function DocumentTableSizeMenu({
  onInsert,
  onCustomSize,
}: {
  readonly onInsert: (dimensions: ScientMarkdownTableDimensions) => void;
  readonly onCustomSize?: (() => void) | undefined;
}) {
  return (
    <DocumentGridSizeMenu
      label="Table"
      icon={<TableIcon className="size-4" />}
      onInsert={onInsert}
      onCustomSize={onCustomSize}
    />
  );
}

/** Shared size picker for rectangular document objects. */
export function DocumentGridSizeMenu({
  label,
  icon,
  options,
  commandScope,
  disabled,
  onInsert,
  onCustomSize,
}: {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly options?: ReactNode;
  readonly commandScope?: string;
  readonly disabled?: boolean;
  readonly onInsert: (dimensions: ScientMarkdownTableDimensions) => void;
  readonly onCustomSize?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [activeSize, setActiveSize] = useState<ScientMarkdownTableDimensions>(
    DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS,
  );
  const [visibleSize, setVisibleSize] = useState<ScientMarkdownTableDimensions>(
    INITIAL_TABLE_SIZE_PICKER_DIMENSIONS,
  );
  const [placement, setPlacement] = useState<TableSizePickerPlacement>({
    side: null,
    locked: false,
  });
  const [pickerElement, setPickerElement] = useState<HTMLDivElement | null>(null);
  const cellRefs = useRef<Array<HTMLElement | null>>([]);
  const activeSizeRef = useRef<ScientMarkdownTableDimensions>(
    DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS,
  );
  const visibleSizeRef = useRef<ScientMarkdownTableDimensions>(
    INITIAL_TABLE_SIZE_PICKER_DIMENSIONS,
  );
  const initialFocusPendingRef = useRef(false);
  const pendingFocusRef = useRef<ScientMarkdownTableDimensions | null>(null);
  const pointerContinuationEnabledRef = useRef(false);
  const previousVisibleColumnsRef = useRef<number>(INITIAL_TABLE_SIZE_PICKER_DIMENSIONS.columns);
  const opensToLeft = placement.side === "left";

  useLayoutEffect(() => {
    activeSizeRef.current = activeSize;
  }, [activeSize]);

  useLayoutEffect(() => {
    visibleSizeRef.current = visibleSize;
  }, [visibleSize]);

  useLayoutEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (!pendingFocus) return;
    const cell = cellRefs.current[tableSizePickerCellIndex(pendingFocus)];
    if (!cell) return;
    pendingFocusRef.current = null;
    cell.focus();
  }, [visibleSize]);

  useLayoutEffect(() => {
    const previousColumns = previousVisibleColumnsRef.current;
    previousVisibleColumnsRef.current = visibleSize.columns;
    if (!open || visibleSize.columns <= previousColumns) return;

    const newEdgeCell =
      cellRefs.current[tableSizePickerCellIndex({ columns: visibleSize.columns, rows: 1 })];
    newEdgeCell?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
  }, [open, visibleSize.columns]);

  useLayoutEffect(() => {
    if (!open || !pickerElement || placement.locked) return;
    const popup = pickerElement.closest<HTMLElement>("[data-slot='menu-sub-content']");
    const positioner = popup?.closest<HTMLElement>("[data-slot='menu-positioner']");
    if (!popup) return;

    let settleFrame = 0;
    let lockFrame = 0;
    const readSide = () => {
      const side = positioner?.dataset.side ?? popup.dataset.side;
      const direction = getComputedStyle(popup).direction;
      return popupPhysicalHorizontalSide(side, direction);
    };
    const updateProvisionalSide = () => {
      const side = readSide();
      if (!side) return;
      setPlacement((current) => {
        if (current.locked || current.side === side) return current;
        return { side, locked: false };
      });
    };
    const scheduleLock = () => {
      cancelAnimationFrame(settleFrame);
      cancelAnimationFrame(lockFrame);
      updateProvisionalSide();
      settleFrame = requestAnimationFrame(() => {
        lockFrame = requestAnimationFrame(() => {
          const side = readSide();
          if (!side) return;
          setPlacement((current) => (current.locked ? current : { side, locked: true }));
        });
      });
    };
    scheduleLock();

    const observer = new MutationObserver(scheduleLock);
    observer.observe(popup, { attributes: true, attributeFilter: ["data-side", "dir", "style"] });
    if (positioner && positioner !== popup) {
      observer.observe(positioner, {
        attributes: true,
        attributeFilter: ["data-side", "dir", "style"],
      });
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(settleFrame);
      cancelAnimationFrame(lockFrame);
    };
  }, [open, pickerElement, placement.locked]);

  useEffect(() => {
    if (!open || !pickerElement) return;
    const viewport = pickerElement.querySelector<HTMLElement>("[data-scient-table-size-viewport]");
    const grid = pickerElement.querySelector<HTMLElement>("[data-scient-table-size-columns]");
    if (!viewport || !grid) return;

    const continueFromPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && pickerElement.contains(target)) {
        if (target instanceof Element && target.closest("[data-scient-table-size-cell]") !== null) {
          pointerContinuationEnabledRef.current = true;
          return;
        }
        if (viewport.contains(target)) return;
      }
      if (!pointerContinuationEnabledRef.current) return;

      const firstCell = grid.querySelector<HTMLElement>("[data-scient-table-size-cell]");
      const measuredCellWidth = firstCell?.getBoundingClientRect().width ?? 0;
      const measuredGap = Number.parseFloat(getComputedStyle(grid).columnGap);
      const cellPitch =
        (measuredCellWidth > 0 ? measuredCellWidth : TABLE_SIZE_PICKER_CELL_SIZE_PX) +
        (Number.isFinite(measuredGap) ? measuredGap : TABLE_SIZE_PICKER_CELL_GAP_PX);
      const nextDimensions = continuedTableSizeFromPointer({
        activeDimensions: activeSizeRef.current,
        bounds: viewport.getBoundingClientRect(),
        cellPitch,
        opensToLeft,
        pointerX: event.clientX,
        pointerY: event.clientY,
        visibleDimensions: visibleSizeRef.current,
      });
      if (!nextDimensions) {
        pointerContinuationEnabledRef.current = false;
        return;
      }

      activeSizeRef.current = nextDimensions;
      setActiveSize(nextDimensions);
      const nextVisibleDimensions = expandedTableSizePickerDimensions(
        visibleSizeRef.current,
        nextDimensions,
      );
      visibleSizeRef.current = nextVisibleDimensions;
      setVisibleSize(nextVisibleDimensions);
    };

    document.addEventListener("pointermove", continueFromPointer, { passive: true });
    return () => document.removeEventListener("pointermove", continueFromPointer);
  }, [open, opensToLeft, pickerElement]);

  const updateActiveSize = (dimensions: ScientMarkdownTableDimensions) => {
    activeSizeRef.current = dimensions;
    setActiveSize(dimensions);
    setVisibleSize((current) => {
      const next = expandedTableSizePickerDimensions(current, dimensions);
      visibleSizeRef.current = next;
      return next;
    });
  };

  const focusCell = (rowIndex: number, columnIndex: number) => {
    const dimensions = {
      columns: Math.min(MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION, Math.max(1, columnIndex + 1)),
      rows: Math.min(MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION, Math.max(1, rowIndex + 1)),
    };
    const cell = cellRefs.current[tableSizePickerCellIndex(dimensions)];
    if (cell) {
      cell.focus();
      return;
    }
    pendingFocusRef.current = dimensions;
    setVisibleSize((current) => {
      const next = expandedTableSizePickerDimensions(current, dimensions);
      visibleSizeRef.current = next;
      return next;
    });
  };

  const handleCellKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
    dimensions: ScientMarkdownTableDimensions,
  ) => {
    let rowIndex = dimensions.rows - 1;
    let columnIndex = dimensions.columns - 1;
    switch (event.key) {
      case "ArrowUp":
        rowIndex = Math.max(0, rowIndex - 1);
        break;
      case "ArrowDown":
        rowIndex = Math.min(MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION - 1, rowIndex + 1);
        break;
      case "ArrowLeft":
        columnIndex = opensToLeft
          ? Math.min(MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION - 1, columnIndex + 1)
          : Math.max(0, columnIndex - 1);
        break;
      case "ArrowRight":
        columnIndex = opensToLeft
          ? Math.max(0, columnIndex - 1)
          : Math.min(MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION - 1, columnIndex + 1);
        break;
      case "Home":
        rowIndex = 0;
        columnIndex = 0;
        break;
      case "End":
        rowIndex = MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION - 1;
        columnIndex = MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusCell(rowIndex, columnIndex);
  };

  return (
    <MenuSub
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        pointerContinuationEnabledRef.current = false;
        if (!nextOpen) return;
        initialFocusPendingRef.current = true;
        pendingFocusRef.current = null;
        activeSizeRef.current = DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS;
        visibleSizeRef.current = INITIAL_TABLE_SIZE_PICKER_DIMENSIONS;
        setPlacement({ side: null, locked: false });
        setActiveSize(DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS);
        setVisibleSize(INITIAL_TABLE_SIZE_PICKER_DIMENSIONS);
      }}
    >
      <MenuSubTrigger disabled={disabled}>
        {icon}
        <span>{label}</span>
      </MenuSubTrigger>
      <MenuSubPopup
        className="w-auto max-w-(--available-width) [&>div]:max-h-none [&>div]:overflow-y-visible"
        collisionAvoidance={
          placement.locked ? LOCKED_TABLE_SIZE_PICKER_COLLISION_AVOIDANCE : undefined
        }
        data-keybinding-capture=""
        data-dock-command-scope={commandScope}
        side={placement.locked && placement.side ? placement.side : "inline-end"}
      >
        {options}
        <div
          ref={setPickerElement}
          className="px-1.5 py-1"
          data-scient-table-size-picker
          data-scient-table-size-side={placement.side ?? "pending"}
          data-scient-table-size-side-locked={placement.locked ? "true" : "false"}
        >
          <div
            className="scient-markdown-table-size-viewport overflow-x-auto overflow-y-hidden overscroll-x-contain"
            data-scient-table-size-viewport
            dir={opensToLeft ? "rtl" : "ltr"}
            style={{
              inlineSize: `min(${tableSizePickerGridInlineSize(visibleSize.columns)}, calc(var(--available-width) - 1.25rem))`,
            }}
          >
            <div
              role="group"
              aria-label={`Choose ${label.toLowerCase()} size, columns by rows`}
              className="grid gap-[3px]"
              data-scient-table-size-columns={visibleSize.columns}
              data-scient-table-size-rows={visibleSize.rows}
              data-scient-table-size-origin={opensToLeft ? "right" : "left"}
              dir={opensToLeft ? "rtl" : "ltr"}
              style={{
                gridAutoRows: "1rem",
                gridTemplateColumns: `repeat(${visibleSize.columns}, 1rem)`,
              }}
            >
              {tableSizeChoices(visibleSize).map((dimensions) => {
                const selected =
                  dimensions.columns <= activeSize.columns && dimensions.rows <= activeSize.rows;
                const cellLabel = `Insert ${label.toLowerCase()} with ${tableSizeLabel(dimensions)}`;
                return (
                  <MenuItem
                    key={`${dimensions.columns}×${dimensions.rows}`}
                    ref={(element) => {
                      cellRefs.current[tableSizePickerCellIndex(dimensions)] = element;
                    }}
                    aria-label={cellLabel}
                    data-scient-table-size-cell
                    data-scient-table-size-cell-column={dimensions.columns}
                    data-scient-table-size-cell-row={dimensions.rows}
                    label={cellLabel}
                    active={selected}
                    variant="grid-cell"
                    onFocus={() => {
                      if (initialFocusPendingRef.current) {
                        initialFocusPendingRef.current = false;
                        if (
                          dimensions.columns !== DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS.columns ||
                          dimensions.rows !== DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS.rows
                        ) {
                          focusCell(
                            DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS.rows - 1,
                            DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS.columns - 1,
                          );
                          return;
                        }
                      }
                      updateActiveSize(dimensions);
                    }}
                    onMouseEnter={() => {
                      initialFocusPendingRef.current = false;
                      pointerContinuationEnabledRef.current = true;
                      updateActiveSize(dimensions);
                    }}
                    onKeyDown={(event) => handleCellKeyDown(event, dimensions)}
                    onClick={() => onInsert(dimensions)}
                  >
                    <span className="sr-only">{cellLabel}</span>
                  </MenuItem>
                );
              })}
            </div>
          </div>
          <div
            data-scient-table-size-label
            className="pt-2 text-center text-muted-foreground text-xs tabular-nums"
            aria-atomic="true"
            aria-live="polite"
          >
            {activeSize.columns} × {activeSize.rows}
          </div>
        </div>
        {onCustomSize && <MenuItem onClick={onCustomSize}>Choose size…</MenuItem>}
      </MenuSubPopup>
    </MenuSub>
  );
}
