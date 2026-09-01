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
  Ellipsis,
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
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
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
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import {
  filterScientMarkdownSlashCommands,
  type ScientMarkdownCommand,
} from "../prosemirror/commands";
import type { ScientMarkdownBlockAction } from "../prosemirror/blocks";
import type { ScientMarkdownEditorSnapshot, ScientMarkdownEditorView } from "../prosemirror/view";
import {
  EMPTY_WIKI_LINK_CANDIDATES,
  EMPTY_WIKI_LINK_RECENT_PATHS,
  type ScientMarkdownWikiLinkCandidate,
} from "../wikiLinkPicker";
import {
  DockButton,
  DockDivider,
  DockMenu,
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
}) {
  return (
    <DockButton
      label={props.label}
      icon={props.icon}
      active={props.active}
      disabled={props.disabled}
      preserveIconWeight={props.preserveIconWeight}
      onClick={() => props.controller.execute(props.command)}
    />
  );
}

const STYLE_ITEMS: ReadonlyArray<{
  readonly command: ScientMarkdownCommand;
  readonly label: string;
}> = [
  { command: "paragraph", label: "Paragraph" },
  { command: "heading-1", label: "Heading 1" },
  { command: "heading-2", label: "Heading 2" },
  { command: "heading-3", label: "Heading 3" },
  { command: "heading-4", label: "Heading 4" },
  { command: "heading-5", label: "Heading 5" },
  { command: "heading-6", label: "Heading 6" },
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
      {STYLE_ITEMS.map((item) => (
        <MenuRadioItem
          key={item.command}
          value={item.command}
          onClick={() => controller.execute(item.command)}
        >
          <MenuRow icon={commandIcon(item.command)} label={item.label} />
        </MenuRadioItem>
      ))}
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
}> = [
  { command: "bullet-list", label: "Bullet list" },
  { command: "ordered-list", label: "Numbered list" },
  { command: "task-list", label: "Task list" },
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
      {LIST_ITEMS.map((item) => (
        <MenuRadioItem
          key={item.command}
          value={item.command}
          onClick={() => controller.execute(item.command)}
        >
          <MenuRow icon={commandIcon(item.command)} label={item.label} />
        </MenuRadioItem>
      ))}
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
    >
      <ListsMenuItems controller={controller} snapshot={snapshot} />
    </DockMenu>
  );
}

const INSERT_ITEMS: ReadonlyArray<{
  readonly command: ScientMarkdownCommand;
  readonly label: string;
}> = [
  { command: "table", label: "Table (3×3)" },
  { command: "code-block", label: "Code block" },
  { command: "display-math", label: "Math equation ($$)" },
  { command: "image", label: "Image" },
  { command: "wiki-link", label: "Wiki link ([[note]])" },
  { command: "horizontal-rule", label: "Divider line" },
];

function InsertBlockMenuItems({ controller }: { readonly controller: ScientMarkdownEditorView }) {
  return (
    <>
      {INSERT_ITEMS.map((item) => (
        <MenuItem key={item.command} onClick={() => controller.execute(item.command)}>
          {commandIcon(item.command)}
          <span>{item.label}</span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onClick={() => controller.execute("hard-break")}>
        {commandIcon("hard-break")}
        <span>Line break</span>
        <MenuShortcut>⇧↩</MenuShortcut>
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
          <MenuRow icon={commandIcon(item.command)} label={item.label} />
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
          <MenuSubPopup className="w-60 p-1">
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
      <MenuItem onClick={() => controller.setFindOpen(!snapshot.findOpen)}>
        <Search />
        <span>Find & Replace</span>
        <MenuShortcut>⌘F</MenuShortcut>
      </MenuItem>
      {snapshot.editable ? (
        <>
          <MenuItem onClick={() => controller.execute("clear-formatting")}>
            <RemoveFormatting />
            <span>Clear formatting</span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!snapshot.canMoveBlockUp} onClick={blockAction("move-up")}>
            <ArrowUp />
            <span>Move block up</span>
            <MenuShortcut>⌥↑</MenuShortcut>
          </MenuItem>
          <MenuItem disabled={!snapshot.canMoveBlockDown} onClick={blockAction("move-down")}>
            <ArrowDown />
            <span>Move block down</span>
            <MenuShortcut>⌥↓</MenuShortcut>
          </MenuItem>
          <MenuItem disabled={!snapshot.canDuplicateBlock} onClick={blockAction("duplicate")}>
            <Copy />
            <span>Duplicate block</span>
            <MenuShortcut>⇧⌥↓</MenuShortcut>
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

function LinkEditor({
  controller,
  active,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (controller.setLink(href)) {
      setHref("");
      setOpen(false);
    }
  };

  const remove = () => {
    controller.removeLink();
    setHref("");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setHref(controller.currentLink()?.href ?? "");
        setOpen(nextOpen);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className={dockButtonClass(active)}
                  aria-label="Add or edit link"
                  data-preserve-icon-weight="true"
                >
                  <Link2 className="size-4" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">Link</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="center"
        className="w-72 max-w-[calc(100vw-1rem)]"
        side="bottom"
        viewportClassName="p-2"
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
            <Button size="xs" type="button" variant="ghost" onClick={() => setOpen(false)}>
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
      <DockMenu
        label="More table actions"
        icon={<Ellipsis className="size-4" />}
        chevron={false}
        align="end"
        popupClassName="w-48"
      >
        <TableMenuItems controller={controller} />
      </DockMenu>
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
  snapshot,
  wikiLinkCandidates,
  recentWikiLinkPaths,
  onWikiLinkSelected,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
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
        label="Bold (Cmd+B)"
        icon={<Bold className="size-4" strokeWidth={2.5} />}
        preserveIconWeight
        active={active.has("strong")}
      />
      <CommandButton
        controller={controller}
        command="italic"
        label="Italic (Cmd+I)"
        icon={<Italic className="size-4" />}
        active={active.has("em")}
      />
      <CommandButton
        controller={controller}
        command="inline-code"
        label="Inline Code"
        icon={<Code className="size-4" />}
        preserveIconWeight
        active={active.has("code")}
      />
      <LinkEditor controller={controller} active={active.has("link")} />
      {controller.canSetWikiLink() ? (
        <ScientWikiLinkPicker
          controller={controller}
          candidates={wikiLinkCandidates}
          recentPaths={recentWikiLinkPaths}
          onLinked={onWikiLinkSelected}
        />
      ) : null}
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
  const slashItems =
    snapshot.slashQuery === null ? [] : filterScientMarkdownSlashCommands(snapshot.slashQuery);

  useEffect(() => {
    // Entering a table reveals its contextual commands in the existing dock.
    // A later manual collapse stays respected until the cursor leaves and
    // re-enters a table; movement within cells never resizes the document.
    if (snapshot.editable && snapshot.inTable) onExpandedChange(true);
  }, [onExpandedChange, snapshot.editable, snapshot.inTable]);

  // Overflow order: direction goes first, then insert, history (Cmd+Z covers
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
                label="Undo (Cmd+Z)"
                icon={<Undo2 className="size-4" />}
                disabled={!snapshot.canUndo}
              />
              <CommandButton
                controller={controller}
                command="redo"
                label="Redo (Cmd+Shift+Z)"
                icon={<Redo2 className="size-4" />}
                disabled={!snapshot.canRedo}
              />
              <DockDivider />
            </>
          ),
          overflowLabel: "History",
          overflow: (
            <>
              <MenuItem disabled={!snapshot.canUndo} onClick={() => controller.execute("undo")}>
                <Undo2 />
                <span>Undo</span>
                <MenuShortcut>⌘Z</MenuShortcut>
              </MenuItem>
              <MenuItem disabled={!snapshot.canRedo} onClick={() => controller.execute("redo")}>
                <Redo2 />
                <span>Redo</span>
                <MenuShortcut>⇧⌘Z</MenuShortcut>
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
                label="Bold (Cmd+B)"
                icon={<Bold className="size-4" strokeWidth={2.5} />}
                preserveIconWeight
                active={active.has("strong")}
              />
              <CommandButton
                controller={controller}
                command="italic"
                label="Italic (Cmd+I)"
                icon={<Italic className="size-4" />}
                active={active.has("em")}
              />
              <CommandButton
                controller={controller}
                command="strike"
                label="Strikethrough (Cmd+Shift+X)"
                icon={<Strikethrough className="size-4" />}
                active={active.has("strike")}
              />
              <CommandButton
                controller={controller}
                command="inline-code"
                label="Inline Code (Cmd+E)"
                icon={<Code className="size-4" />}
                preserveIconWeight
                active={active.has("code")}
              />
              <LinkEditor controller={controller} active={active.has("link")} />
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
                estimatedWidth: 204,
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
        snapshot={snapshot}
        wikiLinkCandidates={wikiLinkCandidates}
        recentWikiLinkPaths={recentWikiLinkPaths}
        onWikiLinkSelected={onWikiLinkSelected}
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
