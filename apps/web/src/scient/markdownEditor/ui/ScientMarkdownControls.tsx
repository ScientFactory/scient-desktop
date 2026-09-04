import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpToLine,
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  Brackets,
  Code,
  Columns3,
  Copy,
  CornerDownLeft,
  Eraser,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  ListTree,
  ListX,
  Merge,
  Minus,
  NotebookText,
  PanelTop,
  PilcrowLeft,
  PilcrowRight,
  Plus,
  Redo2,
  RemoveFormatting,
  Search,
  Sigma,
  Split,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  TextInitial,
  TextQuote,
  Trash2,
  Undo2,
  Rows3,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  MenuRadioGroup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import {
  Popover,
  PopoverCreateHandle,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import {
  DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS,
  filterScientMarkdownSlashCommands,
  MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION,
  type ScientMarkdownCommand,
  type ScientMarkdownTableDimensions,
} from "../prosemirror/commands";
import type { ScientMarkdownBlockAction } from "../prosemirror/blocks";
import type { ScientMarkdownEditorSnapshot, ScientMarkdownEditorView } from "../prosemirror/view";
import {
  scientMarkdownShortcut,
  type ScientMarkdownShortcutId,
  type ScientMarkdownShortcutPresentation,
} from "../shortcuts";
import {
  EMPTY_WIKI_LINK_CANDIDATES,
  EMPTY_WIKI_LINK_RECENT_PATHS,
  type ScientMarkdownWikiLinkCandidate,
} from "../wikiLinkPicker";
import {
  DockButton,
  DockDivider,
  DockMenu,
  DockTooltipContent,
  DockCommandItem as MenuItem,
  DockCommandRadioItem as MenuRadioItem,
  DockOverflowRow,
  MenuRow,
  dockButtonClass,
  type DockGroup,
} from "./dockChrome";
import { ScientFindBar } from "./ScientFindBar";
import { ScientWikiLinkPicker } from "./ScientWikiLinkPicker";

const ignoreWikiLinkSelection = () => undefined;

const createLinkEditorHandle = () => PopoverCreateHandle();
type LinkEditorHandle = ReturnType<typeof createLinkEditorHandle>;

/** One icon per command, shared by the dock menus and the slash menu. */
function commandIcon(command: ScientMarkdownCommand): ReactNode {
  const className = "size-4 text-muted-foreground";
  switch (command) {
    case "paragraph":
      return <TextInitial className={className} />;
    case "heading-1":
      return <Heading1 className={className} />;
    case "heading-2":
      return <Heading2 className={className} />;
    case "heading-3":
      return <Heading3 className={className} />;
    case "heading-4":
      return <Heading4 className={className} />;
    case "heading-5":
      return <Heading5 className={className} />;
    case "heading-6":
      return <Heading6 className={className} />;
    case "bullet-list":
      return <List className={className} />;
    case "ordered-list":
      return <ListOrdered className={className} />;
    case "task-list":
      return <ListTodo className={className} />;
    case "list-none":
      return <ListX className={className} />;
    case "blockquote":
      return <TextQuote className={className} />;
    case "code-block":
      return <SquareCode className={className} />;
    case "display-math":
      return <Sigma className={className} />;
    case "footnote":
      return <NotebookText className={className} />;
    case "table":
      return <TableIcon className={className} />;
    case "image":
      return <ImageIcon className={className} />;
    case "wiki-link":
      return <Brackets className={className} />;
    case "horizontal-rule":
      return <Minus className={className} />;
    case "hard-break":
      return <CornerDownLeft className={className} />;
    case "direction-auto":
      return <ArrowRightLeft className={className} />;
    case "direction-ltr":
      return <PilcrowRight className={className} />;
    case "direction-rtl":
      return <PilcrowLeft className={className} />;
    default:
      return <FileText className={className} />;
  }
}

function CommandButton(props: {
  readonly active?: boolean;
  readonly command: ScientMarkdownCommand;
  readonly controller: ScientMarkdownEditorView;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly preserveIconWeight?: boolean;
  readonly shortcut?: ScientMarkdownShortcutId;
}) {
  return (
    <DockButton
      label={props.label}
      icon={props.icon}
      active={props.active}
      disabled={props.disabled}
      preserveIconWeight={props.preserveIconWeight}
      shortcut={props.shortcut ? scientMarkdownShortcut(props.shortcut) : undefined}
      onClick={() => props.controller.execute(props.command)}
    />
  );
}

const STYLE_ITEMS: ReadonlyArray<{
  readonly command: ScientMarkdownCommand;
  readonly label: string;
  readonly shortcut?: ScientMarkdownShortcutId;
}> = [
  { command: "paragraph", label: "Paragraph", shortcut: "paragraph" },
  { command: "heading-1", label: "Heading 1", shortcut: "heading1" },
  { command: "heading-2", label: "Heading 2", shortcut: "heading2" },
  { command: "heading-3", label: "Heading 3", shortcut: "heading3" },
  { command: "heading-4", label: "Heading 4", shortcut: "heading4" },
  { command: "heading-5", label: "Heading 5", shortcut: "heading5" },
  { command: "heading-6", label: "Heading 6", shortcut: "heading6" },
  { command: "blockquote", label: "Quote" },
];

function styleMenuLabel(snapshot: ScientMarkdownEditorSnapshot): string {
  switch (snapshot.blockType) {
    case "heading":
      return snapshot.headingLevel !== null ? `Heading ${snapshot.headingLevel}` : "Heading";
    case "blockquote":
      return "Quote";
    case "code_block":
      return "Code block";
    default:
      return "Paragraph";
  }
}

function styleMenuValue(snapshot: ScientMarkdownEditorSnapshot): string {
  switch (snapshot.blockType) {
    case "heading":
      return snapshot.headingLevel !== null ? `heading-${snapshot.headingLevel}` : "";
    case "blockquote":
      return "blockquote";
    case "paragraph":
    case "list_item":
      return "paragraph";
    default:
      return "";
  }
}

function styleTriggerIcon(snapshot: ScientMarkdownEditorSnapshot): ReactNode {
  switch (snapshot.blockType) {
    case "heading":
      switch (snapshot.headingLevel) {
        case 2:
          return <Heading2 className="size-4" />;
        case 3:
          return <Heading3 className="size-4" />;
        case 4:
          return <Heading4 className="size-4" />;
        case 5:
          return <Heading5 className="size-4" />;
        case 6:
          return <Heading6 className="size-4" />;
        default:
          return <Heading1 className="size-4" />;
      }
    case "blockquote":
      return <TextQuote className="size-4" />;
    case "code_block":
      return <SquareCode className="size-4" />;
    default:
      return <TextInitial className="size-4" />;
  }
}

function StyleMenuItems({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  return (
    <MenuRadioGroup value={styleMenuValue(snapshot)}>
      {STYLE_ITEMS.map((item) => {
        const shortcut = item.shortcut ? scientMarkdownShortcut(item.shortcut) : undefined;
        return (
          <MenuRadioItem
            key={item.command}
            value={item.command}
            aria-keyshortcuts={shortcut?.ariaKeyShortcuts}
            onClick={() => controller.execute(item.command)}
          >
            <MenuRow icon={commandIcon(item.command)} label={item.label} shortcut={shortcut} />
          </MenuRadioItem>
        );
      })}
    </MenuRadioGroup>
  );
}

function StyleMenu({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  return (
    <DockMenu
      label={`Style: ${styleMenuLabel(snapshot)}`}
      icon={styleTriggerIcon(snapshot)}
      groupLabel="Style"
      popupClassName="w-52"
    >
      <StyleMenuItems controller={controller} snapshot={snapshot} />
    </DockMenu>
  );
}

function listMenuLabel(kind: ScientMarkdownEditorSnapshot["listKind"]): string {
  switch (kind) {
    case "ordered":
      return "Numbered";
    case "task":
      return "Task";
    case "bullet":
      return "Bullet";
    default:
      return "None";
  }
}

function listMenuValue(kind: ScientMarkdownEditorSnapshot["listKind"]): ScientMarkdownCommand {
  switch (kind) {
    case "ordered":
      return "ordered-list";
    case "task":
      return "task-list";
    case "bullet":
      return "bullet-list";
    default:
      return "list-none";
  }
}

function listTriggerIcon(kind: ScientMarkdownEditorSnapshot["listKind"]): ReactNode {
  switch (kind) {
    case "ordered":
      return <ListOrdered className="size-4" />;
    case "task":
      return <ListTodo className="size-4" />;
    default:
      return <List className="size-4" />;
  }
}

const LIST_ITEMS: ReadonlyArray<{
  readonly command: ScientMarkdownCommand;
  readonly label: string;
  readonly shortcut: ScientMarkdownShortcutId;
}> = [
  { command: "bullet-list", label: "Bullet list", shortcut: "bulletList" },
  { command: "ordered-list", label: "Numbered list", shortcut: "orderedList" },
  { command: "task-list", label: "Task list", shortcut: "taskList" },
];

function ListsMenuItems({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  return (
    <MenuRadioGroup value={listMenuValue(snapshot.listKind)}>
      {LIST_ITEMS.map((item) => {
        const shortcut = scientMarkdownShortcut(item.shortcut);
        return (
          <MenuRadioItem
            key={item.command}
            value={item.command}
            aria-keyshortcuts={shortcut.ariaKeyShortcuts}
            onClick={() => controller.execute(item.command)}
          >
            <MenuRow icon={commandIcon(item.command)} label={item.label} shortcut={shortcut} />
          </MenuRadioItem>
        );
      })}
      <MenuSeparator />
      <MenuRadioItem value="list-none" onClick={() => controller.execute("list-none")}>
        <MenuRow icon={commandIcon("list-none")} label="No list" />
      </MenuRadioItem>
    </MenuRadioGroup>
  );
}

function ListsMenu({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  return (
    <DockMenu
      label={`List: ${listMenuLabel(snapshot.listKind)}`}
      icon={listTriggerIcon(snapshot.listKind)}
      groupLabel="Lists"
      popupClassName="w-52"
    >
      <ListsMenuItems controller={controller} snapshot={snapshot} />
    </DockMenu>
  );
}

const INSERT_ITEMS: ReadonlyArray<{
  readonly command: ScientMarkdownCommand;
  readonly label: string;
}> = [
  { command: "code-block", label: "Code block" },
  { command: "display-math", label: "Math equation ($$)" },
  { command: "footnote", label: "Footnote" },
  { command: "image", label: "Image" },
  { command: "wiki-link", label: "Wiki link ([[note]])" },
  { command: "horizontal-rule", label: "Divider line" },
];

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

function TableSizeMenu({ controller }: { readonly controller: ScientMarkdownEditorView }) {
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
      <MenuSubTrigger>
        {commandIcon("table")}
        <span>Table</span>
      </MenuSubTrigger>
      <MenuSubPopup
        className="w-auto max-w-(--available-width) [&>div]:max-h-none [&>div]:overflow-y-visible"
        collisionAvoidance={
          placement.locked ? LOCKED_TABLE_SIZE_PICKER_COLLISION_AVOIDANCE : undefined
        }
        data-keybinding-capture=""
        side={placement.locked && placement.side ? placement.side : "inline-end"}
      >
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
              aria-label="Choose table size, columns by rows"
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
                const label = `Insert table with ${tableSizeLabel(dimensions)}`;
                return (
                  <MenuItem
                    key={`${dimensions.columns}×${dimensions.rows}`}
                    ref={(element) => {
                      cellRefs.current[tableSizePickerCellIndex(dimensions)] = element;
                    }}
                    aria-label={label}
                    data-scient-table-size-cell
                    data-scient-table-size-cell-column={dimensions.columns}
                    data-scient-table-size-cell-row={dimensions.rows}
                    label={label}
                    className={cn(
                      "size-4 min-h-0 rounded-[3px] border p-0 sm:min-h-0",
                      "data-highlighted:outline-2 data-highlighted:outline-ring data-highlighted:outline-offset-1",
                      selected
                        ? "border-muted-foreground/55 bg-accent"
                        : "border-border/80 bg-background",
                    )}
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
                    onClick={() => controller.insertTable(dimensions)}
                  >
                    <span className="sr-only">{label}</span>
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
      </MenuSubPopup>
    </MenuSub>
  );
}

function InsertBlockMenuItems({ controller }: { readonly controller: ScientMarkdownEditorView }) {
  const hardBreakShortcut = scientMarkdownShortcut("hardBreak");
  return (
    <>
      <TableSizeMenu controller={controller} />
      {INSERT_ITEMS.map((item) => (
        <MenuItem key={item.command} onClick={() => controller.execute(item.command)}>
          {commandIcon(item.command)}
          <span>{item.label}</span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        aria-keyshortcuts={hardBreakShortcut.ariaKeyShortcuts}
        onClick={() => controller.execute("hard-break")}
      >
        {commandIcon("hard-break")}
        <span>Line break</span>
        <MenuShortcut aria-hidden="true" dir="ltr">
          {hardBreakShortcut.display}
        </MenuShortcut>
      </MenuItem>
    </>
  );
}

function InsertBlockMenu({ controller }: { readonly controller: ScientMarkdownEditorView }) {
  return (
    <DockMenu
      label="Insert block or element"
      icon={<Plus className="size-4" />}
      groupLabel="Insert"
      popupClassName="w-52"
    >
      <InsertBlockMenuItems controller={controller} />
    </DockMenu>
  );
}

const DIRECTION_ITEMS: ReadonlyArray<{
  readonly command: ScientMarkdownCommand;
  readonly label: string;
}> = [
  { command: "direction-auto", label: "Auto" },
  { command: "direction-ltr", label: "Left-to-right" },
  { command: "direction-rtl", label: "Right-to-left" },
];

function directionMenuLabel(direction: ScientMarkdownEditorSnapshot["textDirection"]): string {
  switch (direction) {
    case "ltr":
      return "Left-to-right";
    case "rtl":
      return "Right-to-left";
    default:
      return "Auto";
  }
}

function directionTriggerIcon(direction: ScientMarkdownEditorSnapshot["textDirection"]): ReactNode {
  switch (direction) {
    case "ltr":
      return <PilcrowRight className="size-4" />;
    case "rtl":
      return <PilcrowLeft className="size-4" />;
    default:
      return <ArrowRightLeft className="size-4" />;
  }
}

function DirectionMenuItems({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  const value =
    snapshot.textDirection === null ? "direction-auto" : `direction-${snapshot.textDirection}`;
  return (
    <MenuRadioGroup value={value}>
      {DIRECTION_ITEMS.map((item) => (
        <MenuRadioItem
          key={item.command}
          value={item.command}
          onClick={() => controller.execute(item.command)}
        >
          <MenuRow
            icon={commandIcon(item.command)}
            label={
              snapshot.inTable && item.command === "direction-auto"
                ? "Auto — detect from table"
                : item.label
            }
          />
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

function DirectionMenu({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  return (
    <DockMenu
      label={`${snapshot.inTable ? "Table" : "Text"} direction: ${directionMenuLabel(snapshot.textDirection)}`}
      icon={directionTriggerIcon(snapshot.textDirection)}
      groupLabel={snapshot.inTable ? "Table direction" : "Text direction"}
    >
      <DirectionMenuItems controller={controller} snapshot={snapshot} />
    </DockMenu>
  );
}

/** The surface's permanent overflow-menu items: outline, find, block actions. */
function BlockActionsMenuItems({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  const findShortcut = scientMarkdownShortcut("find");
  const clearFormattingShortcut = scientMarkdownShortcut("clearFormatting");
  const moveUpShortcut = scientMarkdownShortcut("moveBlockUp");
  const moveDownShortcut = scientMarkdownShortcut("moveBlockDown");
  const duplicateShortcut = scientMarkdownShortcut("duplicateBlock");
  const blockAction = (action: ScientMarkdownBlockAction) => () => {
    controller.executeBlock(action);
  };

  return (
    <>
      {snapshot.outlineItems.length === 0 ? (
        <MenuItem disabled>
          <ListTree />
          <span>Document outline</span>
        </MenuItem>
      ) : (
        <MenuSub>
          <MenuSubTrigger>
            <ListTree />
            <span>Document outline</span>
          </MenuSubTrigger>
          <MenuSubPopup className="w-60 p-1" data-keybinding-capture="">
            {snapshot.outlineItems.map((item, index) => (
              <MenuItem
                key={`${item.position}-${item.level}-${item.text}`}
                inset={item.level === 1}
                className={cn(
                  item.level === 2 && "ps-5",
                  item.level >= 3 && "ps-7 text-[13px]",
                  index === snapshot.outlineActiveIndex && "bg-accent/70 font-medium",
                )}
                onClick={() => controller.navigateToOutline(item.position)}
              >
                <span className="truncate">{item.text || "Untitled heading"}</span>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      )}
      <MenuItem
        aria-keyshortcuts={findShortcut.ariaKeyShortcuts}
        onClick={() => controller.setFindOpen(!snapshot.findOpen)}
      >
        <Search />
        <span>Find & Replace</span>
        <MenuShortcut aria-hidden="true" dir="ltr">
          {findShortcut.display}
        </MenuShortcut>
      </MenuItem>
      {snapshot.editable ? (
        <>
          <MenuItem
            aria-keyshortcuts={clearFormattingShortcut.ariaKeyShortcuts}
            onClick={() => controller.execute("clear-formatting")}
          >
            <RemoveFormatting />
            <span>Clear formatting</span>
            <MenuShortcut aria-hidden="true" dir="ltr">
              {clearFormattingShortcut.display}
            </MenuShortcut>
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            aria-keyshortcuts={
              snapshot.canMoveBlockUp ? moveUpShortcut.ariaKeyShortcuts : undefined
            }
            disabled={!snapshot.canMoveBlockUp}
            onClick={blockAction("move-up")}
          >
            <ArrowUp />
            <span>Move block up</span>
            <MenuShortcut aria-hidden="true" dir="ltr">
              {moveUpShortcut.display}
            </MenuShortcut>
          </MenuItem>
          <MenuItem
            aria-keyshortcuts={
              snapshot.canMoveBlockDown ? moveDownShortcut.ariaKeyShortcuts : undefined
            }
            disabled={!snapshot.canMoveBlockDown}
            onClick={blockAction("move-down")}
          >
            <ArrowDown />
            <span>Move block down</span>
            <MenuShortcut aria-hidden="true" dir="ltr">
              {moveDownShortcut.display}
            </MenuShortcut>
          </MenuItem>
          <MenuItem
            aria-keyshortcuts={
              snapshot.canDuplicateBlock ? duplicateShortcut.ariaKeyShortcuts : undefined
            }
            disabled={!snapshot.canDuplicateBlock}
            onClick={blockAction("duplicate")}
          >
            <Copy />
            <span>Duplicate block</span>
            <MenuShortcut aria-hidden="true" dir="ltr">
              {duplicateShortcut.display}
            </MenuShortcut>
          </MenuItem>
          <MenuItem
            disabled={!snapshot.canDeleteBlock}
            variant="destructive"
            onClick={blockAction("delete")}
          >
            <Trash2 />
            <span>Delete block</span>
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

function LinkEditorTrigger({
  controller,
  active,
  handle,
  openRequest = 0,
  shortcut,
  triggerId,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly active?: boolean;
  readonly handle: LinkEditorHandle;
  readonly openRequest?: number;
  readonly shortcut: ScientMarkdownShortcutPresentation;
  readonly triggerId: string;
}) {
  useEffect(() => {
    if (openRequest === 0) return;
    handle.open(triggerId);
    controller.acknowledgeLinkEditRequest(openRequest);
  }, [controller, handle, openRequest, triggerId]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <PopoverTrigger
            handle={handle}
            id={triggerId}
            render={
              <button
                type="button"
                className={dockButtonClass(active)}
                aria-label="Add or edit link"
                aria-keyshortcuts={shortcut.ariaKeyShortcuts}
                data-preserve-icon-weight="true"
              >
                <Link2 className="size-4" />
              </button>
            }
          />
        }
      />
      <TooltipPopup side="top">
        <DockTooltipContent label="Link" shortcut={shortcut} />
      </TooltipPopup>
    </Tooltip>
  );
}

function LinkEditorPopup({
  active,
  controller,
  handle,
}: {
  readonly active: boolean;
  readonly controller: ScientMarkdownEditorView;
  readonly handle: LinkEditorHandle;
}) {
  const [href, setHref] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const openedFromEditorRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | true | false>(false);

  const closeToEditor = () => {
    controller.focus();
    returnFocusRef.current = false;
    handle.close();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (controller.setLink(href)) {
      setHref("");
      closeToEditor();
    }
  };

  const remove = () => {
    controller.removeLink();
    setHref("");
    closeToEditor();
  };

  return (
    <Popover
      handle={handle}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) {
          openedFromEditorRef.current = details.reason === "imperative-action";
          returnFocusRef.current = false;
          setHref(controller.currentLink()?.href ?? "");
          return;
        }
        if (details.reason === "outside-press" || details.reason === "focus-out") {
          returnFocusRef.current = false;
        } else if (details.reason === "escape-key") {
          returnFocusRef.current = openedFromEditorRef.current
            ? (controller.view?.dom ?? false)
            : true;
        } else if (details.reason === "trigger-press") {
          returnFocusRef.current = true;
        }
      }}
    >
      <PopoverPopup
        align="center"
        className="w-72 max-w-[calc(100vw-1rem)]"
        side="bottom"
        viewportClassName="p-2"
        data-keybinding-capture=""
        initialFocus={inputRef}
        finalFocus={() => {
          const target = returnFocusRef.current;
          returnFocusRef.current = false;
          return target;
        }}
      >
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <div className="flex items-center justify-between px-1">
            <PopoverTitle className="text-xs font-medium">Link</PopoverTitle>
            {active ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-destructive hover:underline"
                onClick={remove}
              >
                <Trash2 className="size-3" />
                Remove
              </button>
            ) : null}
          </div>
          <Input
            ref={inputRef}
            aria-label="Link destination"
            inputMode="url"
            placeholder="https://... or relative path"
            size="compact"
            value={href}
            onChange={(event) => setHref(event.target.value)}
          />
          <div className="flex items-center justify-end gap-1">
            <Button size="xs" type="button" variant="ghost" onClick={closeToEditor}>
              Cancel
            </Button>
            <Button disabled={!href.trim()} size="xs" type="submit">
              Apply
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function TableMenuItems({ controller }: { readonly controller: ScientMarkdownEditorView }) {
  const execute = (command: ScientMarkdownCommand) => {
    controller.execute(command);
  };

  return (
    <>
      <MenuItem onClick={() => execute("select-table")}>
        <TableIcon />
        <span>Select whole table</span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => execute("add-row-before")}>
        <ArrowUpToLine />
        <span>Add row above</span>
      </MenuItem>
      <MenuItem onClick={() => execute("add-row-after")}>
        <ArrowDownToLine />
        <span>Add row below</span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => execute("add-column-before")}>
        <ArrowLeftToLine />
        <span>Add column before</span>
      </MenuItem>
      <MenuItem onClick={() => execute("add-column-after")}>
        <ArrowRightToLine />
        <span>Add column after</span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem disabled title="Markdown tables use one header row.">
        <PanelTop />
        <span>Toggle header cell</span>
      </MenuItem>
      <MenuItem disabled title="Merged cells cannot be saved in a Markdown table.">
        <Merge />
        <span>Merge selected cells</span>
      </MenuItem>
      <MenuItem disabled title="Merged cells cannot be saved in a Markdown table.">
        <Split />
        <span>Split cell</span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => execute("align-column-left")}>
        <AlignLeft />
        <span>Align column left</span>
      </MenuItem>
      <MenuItem onClick={() => execute("align-column-center")}>
        <AlignCenter />
        <span>Align column center</span>
      </MenuItem>
      <MenuItem onClick={() => execute("align-column-right")}>
        <AlignRight />
        <span>Align column right</span>
      </MenuItem>
      <MenuItem onClick={() => execute("align-column-default")}>
        <Eraser />
        <span>Clear column alignment</span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={() => execute("delete-row")}>
        <Rows3 />
        <span>Delete row</span>
      </MenuItem>
      <MenuItem variant="destructive" onClick={() => execute("delete-column")}>
        <Columns3 />
        <span>Delete column</span>
      </MenuItem>
      <MenuItem variant="destructive" onClick={() => execute("delete-table")}>
        <Trash2 />
        <span>Delete table</span>
      </MenuItem>
    </>
  );
}

function TableActions({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Table actions">
      <CommandButton
        controller={controller}
        command="add-row-after"
        label="Add row below"
        icon={<BetweenHorizontalEnd className="size-4" />}
      />
      <CommandButton
        controller={controller}
        command="add-column-after"
        label="Add column after"
        icon={<BetweenVerticalEnd className="size-4" />}
      />
      <DockDivider />
      <CommandButton
        controller={controller}
        command="align-column-left"
        label="Align column left"
        icon={<AlignLeft className="size-4" />}
        active={snapshot.tableAlignment === "left"}
      />
      <CommandButton
        controller={controller}
        command="align-column-center"
        label="Align column center"
        icon={<AlignCenter className="size-4" />}
        active={snapshot.tableAlignment === "center"}
      />
      <CommandButton
        controller={controller}
        command="align-column-right"
        label="Align column right"
        icon={<AlignRight className="size-4" />}
        active={snapshot.tableAlignment === "right"}
      />
    </span>
  );
}

/**
 * Floating formatting toolbar anchored just above the text selection. It is
 * portaled to the body and never participates in document flow, so selecting
 * text cannot shift the document. While the pointer is held down (drag or
 * double-click in progress) it stays hidden and appears on release.
 */
function SelectionToolbar({
  controller,
  linkEditorHandle,
  linkEditorTriggerId,
  snapshot,
  linkOpenRequest,
  wikiLinkCandidates,
  recentWikiLinkPaths,
  onWikiLinkSelected,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly linkEditorHandle: LinkEditorHandle;
  readonly linkEditorTriggerId: string;
  readonly snapshot: ScientMarkdownEditorSnapshot;
  readonly linkOpenRequest: number;
  readonly wikiLinkCandidates: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
  readonly recentWikiLinkPaths: ReadonlyArray<string>;
  readonly onWikiLinkSelected: (path: string) => void;
}) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; bottom: number } | null>(null);
  const [place, setPlace] = useState<"above" | "below">("above");
  const [selectingWithPointer, setSelectingWithPointer] = useState(false);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (toolbarRef.current?.contains(event.target as globalThis.Node)) return;
      if (!controller.containsEditorDomNode(event.target as globalThis.Node)) return;
      setSelectingWithPointer(true);
    };
    const finishPointerSelection = () => setSelectingWithPointer(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", finishPointerSelection, true);
    window.addEventListener("pointercancel", finishPointerSelection, true);
    window.addEventListener("blur", finishPointerSelection);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", finishPointerSelection, true);
      window.removeEventListener("pointercancel", finishPointerSelection, true);
      window.removeEventListener("blur", finishPointerSelection);
    };
  }, [controller]);

  useLayoutEffect(() => {
    if (selectingWithPointer) return;
    if (!snapshot.editable || snapshot.selectionEmpty) {
      setAnchor(null);
      return;
    }
    setAnchor(controller.selectionToolbarAnchor());
  }, [
    controller,
    selectingWithPointer,
    snapshot.version,
    snapshot.editable,
    snapshot.selectionEmpty,
  ]);

  // Keep the toolbar glued to the selection while the document scrolls.
  useEffect(() => {
    if (anchor === null) return;
    const update = () => setAnchor(controller.selectionToolbarAnchor());
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [controller, anchor !== null]);

  // Clamp horizontally and flip below the selection when there is no room above.
  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element || anchor === null) return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    const half = rect.width / 2;
    const left = Math.min(Math.max(anchor.left, margin + half), window.innerWidth - margin - half);
    const fitsAbove = anchor.top - rect.height - margin >= margin;
    const nextPlace = fitsAbove ? "above" : "below";
    if (left !== anchor.left || nextPlace !== place) {
      setAnchor({ ...anchor, left });
      setPlace(nextPlace);
    }
  });

  if (!snapshot.editable || anchor === null) {
    return null;
  }

  const active = new Set(snapshot.activeMarks);
  const visible = !snapshot.selectionEmpty && !selectingWithPointer;
  return createPortal(
    <div
      ref={toolbarRef}
      className="scient-markdown-selection-toolbar"
      data-keybinding-capture=""
      role="toolbar"
      aria-label="Text formatting"
      aria-hidden={!visible}
      style={{
        left: anchor.left,
        top: place === "above" ? anchor.top : anchor.bottom,
        transform:
          place === "above" ? "translate(-50%, calc(-100% - 8px))" : "translate(-50%, 8px)",
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <CommandButton
        controller={controller}
        command="bold"
        label="Bold"
        icon={<Bold className="size-4" strokeWidth={2.5} />}
        preserveIconWeight
        shortcut="bold"
        active={active.has("strong")}
      />
      <CommandButton
        controller={controller}
        command="italic"
        label="Italic"
        icon={<Italic className="size-4" />}
        active={active.has("em")}
        shortcut="italic"
      />
      <CommandButton
        controller={controller}
        command="inline-code"
        label="Inline code"
        icon={<Code className="size-4" />}
        preserveIconWeight
        active={active.has("code")}
        shortcut="inlineCode"
      />
      <LinkEditorTrigger
        controller={controller}
        active={active.has("link")}
        handle={linkEditorHandle}
        openRequest={linkOpenRequest}
        shortcut={scientMarkdownShortcut("link")}
        triggerId={linkEditorTriggerId}
      />
      <ScientWikiLinkPicker
        controller={controller}
        candidates={wikiLinkCandidates}
        disabled={!snapshot.canSetWikiLink}
        openRequest={snapshot.wikiLinkEditRequest}
        recentPaths={recentWikiLinkPaths}
        selectedTarget={snapshot.selectedWikiLinkTarget}
        onLinked={onWikiLinkSelected}
      />
    </div>,
    document.body,
  );
}

export function ScientMarkdownControls({
  controller,
  expanded,
  onExpandedChange,
  wikiLinkCandidates = EMPTY_WIKI_LINK_CANDIDATES,
  recentWikiLinkPaths = EMPTY_WIKI_LINK_RECENT_PATHS,
  onWikiLinkSelected = ignoreWikiLinkSelection,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly wikiLinkCandidates?: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
  readonly recentWikiLinkPaths?: ReadonlyArray<string>;
  readonly onWikiLinkSelected?: (path: string) => void;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const active = new Set(snapshot.activeMarks);
  const undoShortcut = scientMarkdownShortcut("undo");
  const redoShortcut = scientMarkdownShortcut("redo");
  const [linkEditorHandle] = useState(createLinkEditorHandle);
  const dockLinkEditorTriggerId = `scient-markdown-link-dock-${useId()}`;
  const selectionLinkEditorTriggerId = `scient-markdown-link-selection-${useId()}`;
  const slashItems =
    snapshot.slashQuery === null ? [] : filterScientMarkdownSlashCommands(snapshot.slashQuery);

  useEffect(() => {
    // Entering a table reveals its contextual commands in the existing dock.
    // A later manual collapse stays respected until the cursor leaves and
    // re-enters a table; movement within cells never resizes the document.
    if (snapshot.editable && snapshot.inTable) onExpandedChange(true);
  }, [onExpandedChange, snapshot.editable, snapshot.inTable]);

  useEffect(() => {
    if (snapshot.linkEditRequest !== 0 && snapshot.selectionEmpty) {
      onExpandedChange(true);
    }
  }, [onExpandedChange, snapshot.linkEditRequest, snapshot.selectionEmpty]);

  // Overflow order: direction goes first, then insert, history (undo covers
  // it), lists, and style. Contextual table tools outlast those groups; core
  // inline formatting is pinned. Displaced groups keep every action in the
  // existing More-actions menu without adding another toolbar row.
  const dockGroups: readonly DockGroup[] = !snapshot.editable
    ? []
    : [
        {
          id: "history",
          priority: 30,
          estimatedWidth: 70,
          bar: (
            <>
              <CommandButton
                controller={controller}
                command="undo"
                label="Undo"
                icon={<Undo2 className="size-4" />}
                disabled={!snapshot.canUndo}
                shortcut="undo"
              />
              <CommandButton
                controller={controller}
                command="redo"
                label="Redo"
                icon={<Redo2 className="size-4" />}
                disabled={!snapshot.canRedo}
                shortcut="redo"
              />
              <DockDivider />
            </>
          ),
          overflowLabel: "History",
          overflow: (
            <>
              <MenuItem
                aria-keyshortcuts={snapshot.canUndo ? undoShortcut.ariaKeyShortcuts : undefined}
                disabled={!snapshot.canUndo}
                onClick={() => controller.execute("undo")}
              >
                <Undo2 />
                <span>Undo</span>
                <MenuShortcut aria-hidden="true" dir="ltr">
                  {undoShortcut.display}
                </MenuShortcut>
              </MenuItem>
              <MenuItem
                aria-keyshortcuts={snapshot.canRedo ? redoShortcut.ariaKeyShortcuts : undefined}
                disabled={!snapshot.canRedo}
                onClick={() => controller.execute("redo")}
              >
                <Redo2 />
                <span>Redo</span>
                <MenuShortcut aria-hidden="true" dir="ltr">
                  {redoShortcut.display}
                </MenuShortcut>
              </MenuItem>
            </>
          ),
        },
        {
          id: "format",
          priority: 100,
          pinned: true,
          estimatedWidth: 160,
          bar: (
            <>
              <CommandButton
                controller={controller}
                command="bold"
                label="Bold"
                icon={<Bold className="size-4" strokeWidth={2.5} />}
                preserveIconWeight
                active={active.has("strong")}
                shortcut="bold"
              />
              <CommandButton
                controller={controller}
                command="italic"
                label="Italic"
                icon={<Italic className="size-4" />}
                active={active.has("em")}
                shortcut="italic"
              />
              <CommandButton
                controller={controller}
                command="strike"
                label="Strikethrough"
                icon={<Strikethrough className="size-4" />}
                active={active.has("strike")}
                shortcut="strike"
              />
              <CommandButton
                controller={controller}
                command="inline-code"
                label="Inline code"
                icon={<Code className="size-4" />}
                preserveIconWeight
                active={active.has("code")}
                shortcut="inlineCode"
              />
              <LinkEditorTrigger
                controller={controller}
                active={active.has("link")}
                handle={linkEditorHandle}
                openRequest={snapshot.selectionEmpty ? snapshot.linkEditRequest : 0}
                shortcut={scientMarkdownShortcut("link")}
                triggerId={dockLinkEditorTriggerId}
              />
              <DockDivider />
            </>
          ),
        },
        {
          id: "style",
          priority: 50,
          estimatedWidth: 44,
          bar: <StyleMenu controller={controller} snapshot={snapshot} />,
          overflowLabel: "Style",
          overflow: <StyleMenuItems controller={controller} snapshot={snapshot} />,
        },
        {
          id: "lists",
          priority: 40,
          estimatedWidth: 48,
          bar: (
            <>
              <ListsMenu controller={controller} snapshot={snapshot} />
              <DockDivider />
            </>
          ),
          overflowLabel: "Lists",
          overflow: <ListsMenuItems controller={controller} snapshot={snapshot} />,
        },
        {
          id: "insert",
          priority: 20,
          estimatedWidth: 48,
          bar: (
            <>
              <InsertBlockMenu controller={controller} />
              <DockDivider />
            </>
          ),
          overflowLabel: "Insert",
          overflow: <InsertBlockMenuItems controller={controller} />,
        },
        {
          id: "direction",
          priority: 10,
          estimatedWidth: 44,
          bar: <DirectionMenu controller={controller} snapshot={snapshot} />,
          overflowLabel: "Text direction",
          overflow: <DirectionMenuItems controller={controller} snapshot={snapshot} />,
        },
        ...(snapshot.inTable
          ? [
              {
                id: "table",
                priority: 60,
                estimatedWidth: 168,
                alwaysInOverflow: true,
                bar: (
                  <>
                    <DockDivider />
                    <TableActions controller={controller} snapshot={snapshot} />
                  </>
                ),
                overflowLabel: "Table",
                overflow: <TableMenuItems controller={controller} />,
              },
            ]
          : []),
      ];

  return (
    <>
      <DockOverflowRow
        label="Document actions"
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        groups={dockGroups}
        overflowItems={<BlockActionsMenuItems controller={controller} snapshot={snapshot} />}
      />

      {snapshot.findOpen ? <ScientFindBar controller={controller} snapshot={snapshot} /> : null}

      <SelectionToolbar
        controller={controller}
        linkEditorHandle={linkEditorHandle}
        linkEditorTriggerId={selectionLinkEditorTriggerId}
        snapshot={snapshot}
        linkOpenRequest={snapshot.selectionEmpty ? 0 : snapshot.linkEditRequest}
        wikiLinkCandidates={wikiLinkCandidates}
        recentWikiLinkPaths={recentWikiLinkPaths}
        onWikiLinkSelected={onWikiLinkSelected}
      />

      <LinkEditorPopup
        active={active.has("link")}
        controller={controller}
        handle={linkEditorHandle}
      />

      {snapshot.editable && snapshot.slashQuery !== null && slashItems.length > 0 ? (
        <div
          className="scient-markdown-slash-menu flex max-h-72 w-56 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
          role="listbox"
          aria-label="Insert block"
        >
          <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
            Blocks
          </div>
          {slashItems.map((item, index) => (
            <button
              key={item.command}
              type="button"
              role="option"
              aria-selected={index === snapshot.slashActiveIndex}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                index === snapshot.slashActiveIndex &&
                  "bg-accent font-medium text-accent-foreground",
              )}
              onClick={() => controller.executeSlashCommand(item.command)}
            >
              {commandIcon(item.command)}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
