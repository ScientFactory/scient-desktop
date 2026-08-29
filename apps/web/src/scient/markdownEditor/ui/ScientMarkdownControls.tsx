import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpToLine,
  Bold,
  ChevronDown,
  Code2,
  Copy,
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
  Merge,
  Minus,
  MoreHorizontal,
  PanelTop,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  Search,
  Sigma,
  Split,
  Strikethrough,
  Table as TableIcon,
  TextQuote,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import {
  filterScientMarkdownSlashCommands,
  type ScientMarkdownCommand,
} from "../prosemirror/commands";
import type { ScientMarkdownBlockAction } from "../prosemirror/blocks";
import type { ScientMarkdownEditorSnapshot, ScientMarkdownEditorView } from "../prosemirror/view";
import { ScientFindBar } from "./ScientFindBar";

function CommandButton(props: {
  readonly active?: boolean;
  readonly command: ScientMarkdownCommand;
  readonly controller: ScientMarkdownEditorView;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35",
              props.active && "bg-accent text-accent-foreground font-semibold shadow-xs",
            )}
            aria-label={props.label}
            aria-pressed={props.active}
            disabled={props.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.controller.execute(props.command)}
          >
            {props.icon}
          </button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function DockDivider() {
  return <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />;
}

const HEADING_COMMANDS: ReadonlyArray<{
  readonly command: ScientMarkdownCommand;
  readonly label: string;
}> = [
  { command: "heading-1", label: "Heading 1" },
  { command: "heading-2", label: "Heading 2" },
  { command: "heading-3", label: "Heading 3" },
  { command: "heading-4", label: "Heading 4" },
  { command: "heading-5", label: "Heading 5" },
  { command: "heading-6", label: "Heading 6" },
];

function styleMenuLabel(snapshot: ScientMarkdownEditorSnapshot): string {
  switch (snapshot.blockType) {
    case "heading":
      return snapshot.headingLevel !== null ? `Heading ${snapshot.headingLevel}` : "Heading";
    case "blockquote":
      return "Quote";
    case "list_item":
      return "List item";
    case "code_block":
      return "Code block";
    default:
      return "Paragraph";
  }
}

function styleTriggerIcon(snapshot: ScientMarkdownEditorSnapshot): ReactNode {
  switch (snapshot.blockType) {
    case "heading":
      switch (snapshot.headingLevel) {
        case 2:
          return <Heading2 className="size-3.5" />;
        case 3:
          return <Heading3 className="size-3.5" />;
        case 4:
          return <Heading4 className="size-3.5" />;
        case 5:
          return <Heading5 className="size-3.5" />;
        case 6:
          return <Heading6 className="size-3.5" />;
        default:
          return <Heading1 className="size-3.5" />;
      }
    case "blockquote":
      return <TextQuote className="size-3.5" />;
    case "code_block":
      return <Code2 className="size-3.5" />;
    default:
      return <Pilcrow className="size-3.5" />;
  }
}

function StyleMenu({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  const headingChecked = (level: number) =>
    snapshot.blockType === "heading" && snapshot.headingLevel === level;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "scient-markdown-command-button inline-flex size-7 items-center justify-center gap-0.5 rounded-md text-foreground/80 transition-colors",
                    snapshot.blockType !== "paragraph" &&
                      "bg-accent text-accent-foreground font-semibold shadow-xs",
                  )}
                  aria-label={`Style: ${styleMenuLabel(snapshot)}`}
                >
                  {styleTriggerIcon(snapshot)}
                  <ChevronDown className="size-2.5 opacity-60" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">Style: {styleMenuLabel(snapshot)}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-44 p-1">
        <MenuGroup>
          <MenuGroupLabel>Style</MenuGroupLabel>
          <MenuCheckboxItem
            checked={snapshot.blockType === "paragraph"}
            onCheckedChange={() => controller.execute("paragraph")}
          >
            Paragraph
          </MenuCheckboxItem>
          {HEADING_COMMANDS.map((entry) => (
            <MenuCheckboxItem
              key={entry.command}
              checked={headingChecked(Number(entry.command.at(-1)))}
              onCheckedChange={() => controller.execute(entry.command)}
            >
              {entry.label}
            </MenuCheckboxItem>
          ))}
          <MenuCheckboxItem
            checked={snapshot.blockType === "blockquote"}
            onCheckedChange={() => controller.execute("blockquote")}
          >
            Quote
          </MenuCheckboxItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function listIcon(kind: ScientMarkdownEditorSnapshot["listKind"]) {
  switch (kind) {
    case "ordered":
      return <ListOrdered className="size-3.5" />;
    case "task":
      return <ListTodo className="size-3.5" />;
    default:
      return <List className="size-3.5" />;
  }
}

function listMenuLabel(kind: ScientMarkdownEditorSnapshot["listKind"]): string {
  switch (kind) {
    case "ordered":
      return "Numbered";
    case "task":
      return "Task";
    default:
      return "List";
  }
}

function ListsMenu({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "scient-markdown-command-button inline-flex size-7 items-center justify-center gap-0.5 rounded-md text-foreground/80 transition-colors",
                    snapshot.listKind !== null &&
                      "bg-accent text-accent-foreground font-semibold shadow-xs",
                  )}
                  aria-label={`List: ${listMenuLabel(snapshot.listKind)}`}
                >
                  {listIcon(snapshot.listKind)}
                  <ChevronDown className="size-2.5 opacity-60" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">List: {listMenuLabel(snapshot.listKind)}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-44 p-1">
        <MenuGroup>
          <MenuGroupLabel>Lists</MenuGroupLabel>
          <MenuCheckboxItem
            checked={snapshot.listKind === "bullet"}
            onCheckedChange={() => controller.execute("bullet-list")}
          >
            <span className="flex items-center gap-2">
              <List className="size-4 text-muted-foreground" />
              Bullet list
            </span>
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={snapshot.listKind === "ordered"}
            onCheckedChange={() => controller.execute("ordered-list")}
          >
            <span className="flex items-center gap-2">
              <ListOrdered className="size-4 text-muted-foreground" />
              Numbered list
            </span>
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={snapshot.listKind === "task"}
            onCheckedChange={() => controller.execute("task-list")}
          >
            <span className="flex items-center gap-2">
              <ListTodo className="size-4 text-muted-foreground" />
              Task list
            </span>
          </MenuCheckboxItem>
          <MenuSeparator />
          <MenuCheckboxItem
            checked={false}
            disabled={snapshot.listKind === null}
            onCheckedChange={() => controller.execute("list-none")}
          >
            No list
          </MenuCheckboxItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function InsertBlockMenu({ controller }: { readonly controller: ScientMarkdownEditorView }) {
  const execute = (command: ScientMarkdownCommand) => {
    controller.execute(command);
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Insert Markdown block"
                >
                  <Plus className="size-3.5" />
                  <span>Insert</span>
                  <ChevronDown className="size-3 opacity-60" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">Insert block or element</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-52 p-1">
        <MenuGroup>
          <MenuGroupLabel>Insert</MenuGroupLabel>
          <MenuItem onClick={() => execute("table")}>
            <TableIcon className="size-4 text-muted-foreground" />
            <span>Table (3×3)</span>
          </MenuItem>
          <MenuItem onClick={() => execute("code-block")}>
            <Code2 className="size-4 text-muted-foreground" />
            <span>Code block</span>
          </MenuItem>
          <MenuItem onClick={() => execute("display-math")}>
            <Sigma className="size-4 text-muted-foreground" />
            <span>Math Equation ($$)</span>
          </MenuItem>
          <MenuItem onClick={() => execute("image")}>
            <ImageIcon className="size-4 text-muted-foreground" />
            <span>Image</span>
          </MenuItem>
          <MenuItem onClick={() => execute("wiki-link")}>
            <Link2 className="size-4 text-muted-foreground" />
            <span>Wiki link ([[note]])</span>
          </MenuItem>
          <MenuItem onClick={() => execute("horizontal-rule")}>
            <Minus className="size-4 text-muted-foreground" />
            <span>Divider line</span>
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
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
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    snapshot.textDirection !== null &&
                      "bg-accent text-accent-foreground font-semibold shadow-xs",
                  )}
                  aria-label="Text direction"
                >
                  <ArrowRightLeft className="size-3.5" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">Text direction</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-44 p-1">
        <MenuGroup>
          <MenuGroupLabel>Text direction</MenuGroupLabel>
          <MenuCheckboxItem
            checked={snapshot.textDirection === null}
            onCheckedChange={() => controller.execute("direction-auto")}
          >
            Auto
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={snapshot.textDirection === "ltr"}
            onCheckedChange={() => controller.execute("direction-ltr")}
          >
            Left-to-right
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={snapshot.textDirection === "rtl"}
            onCheckedChange={() => controller.execute("direction-rtl")}
          >
            Right-to-left
          </MenuCheckboxItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function BlockActionsMenu({
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
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="More document actions"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">More actions</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="w-56 p-1">
        {snapshot.outlineItems.length === 0 ? (
          <MenuItem disabled>
            <ListTree className="size-4 text-muted-foreground" />
            <span>Document outline</span>
          </MenuItem>
        ) : (
          <MenuSub>
            <MenuSubTrigger>
              <ListTree className="size-4 text-muted-foreground" />
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
        <MenuCheckboxItem
          checked={snapshot.findOpen}
          onCheckedChange={() => controller.setFindOpen(!snapshot.findOpen)}
        >
          <span className="flex w-full items-center gap-2">
            <Search className="size-4 text-muted-foreground" />
            Find & Replace
            <MenuShortcut>⌘F</MenuShortcut>
          </span>
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem disabled={!snapshot.canMoveBlockUp} onClick={blockAction("move-up")}>
          <ArrowUp className="size-4 text-muted-foreground" />
          <span>Move block up</span>
          <MenuShortcut>⌥↑</MenuShortcut>
        </MenuItem>
        <MenuItem disabled={!snapshot.canMoveBlockDown} onClick={blockAction("move-down")}>
          <ArrowDown className="size-4 text-muted-foreground" />
          <span>Move block down</span>
          <MenuShortcut>⌥↓</MenuShortcut>
        </MenuItem>
        <MenuItem disabled={!snapshot.canDuplicateBlock} onClick={blockAction("duplicate")}>
          <Copy className="size-4 text-muted-foreground" />
          <span>Duplicate block</span>
          <MenuShortcut>⇧⌥↓</MenuShortcut>
        </MenuItem>
        <MenuItem
          disabled={!snapshot.canDeleteBlock}
          variant="destructive"
          onClick={blockAction("delete")}
        >
          <Trash2 className="size-4" />
          <span>Delete block</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
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
      setTimeout(() => inputRef.current?.focus(), 50);
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
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-accent text-accent-foreground font-semibold shadow-xs",
                  )}
                  aria-label="Add or edit link"
                >
                  <Link2 className="size-3.5" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">Link (Cmd+K)</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="center" className="w-80 p-3" side="bottom">
        <form className="flex flex-col gap-2.5" onSubmit={submit}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">Insert or Edit Link</span>
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
            className="h-8 text-xs"
            inputMode="url"
            placeholder="https://... or relative path"
            value={href}
            onChange={(event) => setHref(event.target.value)}
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              className="h-7 text-xs"
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button className="h-7 text-xs" disabled={!href.trim()} size="sm" type="submit">
              Apply
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function TableMoreControl({ controller }: { readonly controller: ScientMarkdownEditorView }) {
  const execute = (command: ScientMarkdownCommand) => {
    controller.execute(command);
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="More table actions"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">More Table Actions</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="w-48 p-1">
        <MenuItem onClick={() => execute("add-row-before")}>
          <ArrowUpToLine className="size-4 text-muted-foreground" />
          <span>Add row above</span>
        </MenuItem>
        <MenuItem onClick={() => execute("add-column-before")}>
          <ArrowLeftToLine className="size-4 text-muted-foreground" />
          <span>Add column before</span>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => execute("toggle-header-cell")}>
          <PanelTop className="size-4 text-muted-foreground" />
          <span>Toggle header cell</span>
        </MenuItem>
        <MenuItem onClick={() => execute("merge-cells")}>
          <Merge className="size-4 text-muted-foreground" />
          <span>Merge selected cells</span>
        </MenuItem>
        <MenuItem onClick={() => execute("split-cell")}>
          <Split className="size-4 text-muted-foreground" />
          <span>Split cell</span>
        </MenuItem>
        <MenuItem onClick={() => execute("align-column-default")}>
          <Eraser className="size-4 text-muted-foreground" />
          <span>Clear column alignment</span>
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => execute("delete-table")}>
          <Trash2 className="size-4" />
          <span>Delete table</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function slashIcon(command: ScientMarkdownCommand) {
  switch (command) {
    case "heading-1":
      return <Heading1 className="size-4 text-muted-foreground" />;
    case "heading-2":
      return <Heading2 className="size-4 text-muted-foreground" />;
    case "heading-3":
      return <Heading3 className="size-4 text-muted-foreground" />;
    case "bullet-list":
      return <List className="size-4 text-muted-foreground" />;
    case "ordered-list":
      return <ListOrdered className="size-4 text-muted-foreground" />;
    case "task-list":
      return <ListTodo className="size-4 text-muted-foreground" />;
    case "blockquote":
      return <Quote className="size-4 text-muted-foreground" />;
    case "code-block":
      return <Code2 className="size-4 text-muted-foreground" />;
    case "display-math":
      return <Sigma className="size-4 text-muted-foreground" />;
    case "table":
      return <TableIcon className="size-4 text-muted-foreground" />;
    case "image":
      return <ImageIcon className="size-4 text-muted-foreground" />;
    case "wiki-link":
      return <Link2 className="size-4 text-muted-foreground" />;
    case "horizontal-rule":
      return <Minus className="size-4 text-muted-foreground" />;
    default:
      return <FileText className="size-4 text-muted-foreground" />;
  }
}

export function ScientMarkdownControls({
  controller,
}: {
  readonly controller: ScientMarkdownEditorView;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const active = new Set(snapshot.activeMarks);
  const slashItems =
    snapshot.slashQuery === null ? [] : filterScientMarkdownSlashCommands(snapshot.slashQuery);

  return (
    <>
      <div
        className="scient-markdown-editor-dock flex min-h-9 flex-wrap items-center gap-0.5 border-b border-border/80 bg-background/95 px-2 py-1 backdrop-blur-xs"
        role="toolbar"
        aria-label="Document actions"
      >
        {snapshot.editable ? (
          <>
            <CommandButton
              controller={controller}
              command="undo"
              label="Undo (Cmd+Z)"
              icon={<Undo2 className="size-3.5" />}
              disabled={!snapshot.canUndo}
            />
            <CommandButton
              controller={controller}
              command="redo"
              label="Redo (Cmd+Shift+Z)"
              icon={<Redo2 className="size-3.5" />}
              disabled={!snapshot.canRedo}
            />
            <DockDivider />
            <CommandButton
              controller={controller}
              command="bold"
              label="Bold (Cmd+B)"
              icon={<Bold className="size-3.5" />}
              active={active.has("strong")}
            />
            <CommandButton
              controller={controller}
              command="italic"
              label="Italic (Cmd+I)"
              icon={<Italic className="size-3.5" />}
              active={active.has("em")}
            />
            <CommandButton
              controller={controller}
              command="strike"
              label="Strikethrough (Cmd+Shift+X)"
              icon={<Strikethrough className="size-3.5" />}
              active={active.has("strike")}
            />
            <CommandButton
              controller={controller}
              command="inline-code"
              label="Inline Code (Cmd+E)"
              icon={<Code2 className="size-3.5" />}
              active={active.has("code")}
            />
            <LinkEditor controller={controller} active={active.has("link")} />
            <CommandButton
              controller={controller}
              command="clear-formatting"
              label="Clear formatting"
              icon={<Eraser className="size-3.5" />}
            />
            <DockDivider />
            <StyleMenu controller={controller} snapshot={snapshot} />
            <ListsMenu controller={controller} snapshot={snapshot} />
            <DockDivider />
            <InsertBlockMenu controller={controller} />
            <DockDivider />
            <DirectionMenu controller={controller} snapshot={snapshot} />
          </>
        ) : null}
        <div className="ms-auto flex items-center gap-0.5">
          <BlockActionsMenu controller={controller} snapshot={snapshot} />
        </div>
      </div>

      {snapshot.findOpen ? <ScientFindBar controller={controller} snapshot={snapshot} /> : null}

      {snapshot.editable && !snapshot.selectionEmpty ? (
        <div
          className="scient-markdown-selection-toolbar flex items-center gap-0.5 rounded-lg border border-border/80 bg-background/95 p-1 shadow-md backdrop-blur-md"
          role="toolbar"
          aria-label="Text formatting"
        >
          <CommandButton
            controller={controller}
            command="bold"
            label="Bold (Cmd+B)"
            icon={<Bold className="size-3.5" />}
            active={active.has("strong")}
          />
          <CommandButton
            controller={controller}
            command="italic"
            label="Italic (Cmd+I)"
            icon={<Italic className="size-3.5" />}
            active={active.has("em")}
          />
          <CommandButton
            controller={controller}
            command="strike"
            label="Strikethrough"
            icon={<Strikethrough className="size-3.5" />}
            active={active.has("strike")}
          />
          <CommandButton
            controller={controller}
            command="inline-code"
            label="Inline Code"
            icon={<Code2 className="size-3.5" />}
            active={active.has("code")}
          />
          <LinkEditor controller={controller} active={active.has("link")} />
        </div>
      ) : null}

      {snapshot.editable && snapshot.inTable ? (
        <div
          className="scient-markdown-table-toolbar flex items-center gap-1 border-b border-border/80 bg-muted/30 px-2 py-1 text-xs"
          role="toolbar"
          aria-label="Table actions"
        >
          <span className="text-[11px] font-semibold text-muted-foreground me-1">Table:</span>
          <CommandButton
            controller={controller}
            command="add-row-after"
            label="Add row below"
            icon={<span className="text-[11px] font-semibold">+ Row</span>}
          />
          <CommandButton
            controller={controller}
            command="add-column-after"
            label="Add column after"
            icon={<span className="text-[11px] font-semibold">+ Col</span>}
          />
          <CommandButton
            controller={controller}
            command="delete-row"
            label="Delete row"
            icon={<span className="text-[11px] font-semibold text-destructive">− Row</span>}
          />
          <CommandButton
            controller={controller}
            command="delete-column"
            label="Delete column"
            icon={<span className="text-[11px] font-semibold text-destructive">− Col</span>}
          />
          <span className="scient-markdown-command-divider mx-1 h-3.5 w-px bg-border/80" />
          <CommandButton
            controller={controller}
            command="align-column-left"
            label="Align column left"
            icon={<AlignLeft className="size-3.5" />}
            active={snapshot.tableAlignment === "left"}
          />
          <CommandButton
            controller={controller}
            command="align-column-center"
            label="Align column center"
            icon={<AlignCenter className="size-3.5" />}
            active={snapshot.tableAlignment === "center"}
          />
          <CommandButton
            controller={controller}
            command="align-column-right"
            label="Align column right"
            icon={<AlignRight className="size-3.5" />}
            active={snapshot.tableAlignment === "right"}
          />
          <TableMoreControl controller={controller} />
        </div>
      ) : null}

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
              {slashIcon(item.command)}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
