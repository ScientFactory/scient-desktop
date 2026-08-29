import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Bold,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  ListTree,
  Minus,
  MoreHorizontal,
  Plus,
  Quote,
  Redo2,
  Search,
  Sigma,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Undo2,
  X,
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
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
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

function BlockCommandButton(props: {
  readonly action: ScientMarkdownBlockAction;
  readonly controller: ScientMarkdownEditorView;
  readonly disabled: boolean;
  readonly label: string;
  readonly icon: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"
            aria-label={props.label}
            disabled={props.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.controller.executeBlock(props.action)}
          >
            {props.icon}
          </button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
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
      <MenuPopup align="start" className="w-56 p-1">
        <MenuGroup>
          <MenuGroupLabel>Text & Headings</MenuGroupLabel>
          <MenuItem onClick={() => execute("paragraph")}>
            <FileText className="size-4 text-muted-foreground" />
            <span>Paragraph</span>
          </MenuItem>
          <MenuItem onClick={() => execute("heading-1")}>
            <Heading1 className="size-4 text-muted-foreground" />
            <span>Heading 1</span>
          </MenuItem>
          <MenuItem onClick={() => execute("heading-2")}>
            <Heading2 className="size-4 text-muted-foreground" />
            <span>Heading 2</span>
          </MenuItem>
          <MenuItem onClick={() => execute("heading-3")}>
            <Heading3 className="size-4 text-muted-foreground" />
            <span>Heading 3</span>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Lists & Structure</MenuGroupLabel>
          <MenuItem onClick={() => execute("bullet-list")}>
            <List className="size-4 text-muted-foreground" />
            <span>Bullet list</span>
          </MenuItem>
          <MenuItem onClick={() => execute("ordered-list")}>
            <ListOrdered className="size-4 text-muted-foreground" />
            <span>Numbered list</span>
          </MenuItem>
          <MenuItem onClick={() => execute("task-list")}>
            <ListTodo className="size-4 text-muted-foreground" />
            <span>Task list</span>
          </MenuItem>
          <MenuItem onClick={() => execute("blockquote")}>
            <Quote className="size-4 text-muted-foreground" />
            <span>Quote block</span>
          </MenuItem>
          <MenuItem onClick={() => execute("horizontal-rule")}>
            <Minus className="size-4 text-muted-foreground" />
            <span>Divider line</span>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Scientific & Media</MenuGroupLabel>
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
        </MenuGroup>
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

function OutlineControl({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  const [open, setOpen] = useState(false);

  if (snapshot.outlineItems.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              aria-label="Document outline (no headings)"
              disabled
            >
              <ListTree className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="top">Add headings to see outline</TooltipPopup>
      </Tooltip>
    );
  }

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
                    open && "bg-accent text-accent-foreground font-semibold shadow-xs",
                  )}
                  aria-label="Document outline"
                >
                  <ListTree className="size-3.5" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">Document Outline</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-64 max-h-80 overflow-y-auto p-1.5" side="bottom">
        <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
          Document Outline
        </div>
        <div className="flex flex-col gap-0.5 pt-1">
          {snapshot.outlineItems.map((item, index) => (
            <button
              key={`${item.position}-${item.level}-${item.text}`}
              type="button"
              className={cn(
                "flex w-full items-center rounded-sm px-2 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
                item.level === 1 && "font-semibold text-foreground",
                item.level === 2 && "ps-4 text-foreground/90",
                item.level >= 3 && "ps-6 text-foreground/75 text-[11px]",
                index === snapshot.outlineActiveIndex && "bg-accent/70 font-medium text-foreground",
              )}
              onClick={() => {
                controller.navigateToOutline(item.position);
                setOpen(false);
              }}
            >
              <span className="truncate">{item.text || "Untitled heading"}</span>
            </button>
          ))}
        </div>
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
        <MenuItem onClick={() => execute("add-row-before")}>Add row above</MenuItem>
        <MenuItem onClick={() => execute("add-column-before")}>Add column before</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => execute("toggle-header-cell")}>Toggle header cell</MenuItem>
        <MenuItem onClick={() => execute("merge-cells")}>Merge selected cells</MenuItem>
        <MenuItem onClick={() => execute("split-cell")}>Split cell</MenuItem>
        <MenuItem onClick={() => execute("align-column-default")}>Clear column alignment</MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => execute("delete-table")}>
          <Trash2 className="size-4" />
          <span>Delete table</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function FindButton({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              snapshot.findOpen && "bg-accent text-accent-foreground font-semibold shadow-xs",
            )}
            aria-label={snapshot.findOpen ? "Close find" : "Find in document"}
            aria-pressed={snapshot.findOpen}
            onClick={() => controller.setFindOpen(!snapshot.findOpen)}
          >
            <Search className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top">Find & Replace (Cmd+F)</TooltipPopup>
    </Tooltip>
  );
}

function FindBar({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ScientMarkdownEditorSnapshot;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [replacement, setReplacement] = useState("");

  useEffect(() => {
    if (snapshot.findOpen) inputRef.current?.focus();
  }, [snapshot.findFocusRequest, snapshot.findOpen]);

  const configure = (input: {
    readonly query?: string;
    readonly caseSensitive?: boolean;
    readonly wholeWord?: boolean;
  }) => {
    controller.configureFind({
      query: input.query ?? snapshot.findQuery,
      caseSensitive: input.caseSensitive ?? snapshot.findCaseSensitive,
      wholeWord: input.wholeWord ?? snapshot.findWholeWord,
    });
  };

  return (
    <div
      className="scient-markdown-find-bar flex flex-col gap-2 border-b border-border/80 bg-background/95 p-2 shadow-xs backdrop-blur-md"
      role="search"
      aria-label="Find and replace"
    >
      <div className="scient-markdown-find-row flex items-center gap-1.5">
        <div className="relative flex min-w-44 flex-1 items-center">
          <Input
            ref={inputRef}
            aria-label="Find text"
            className="h-7 pe-14 text-xs"
            placeholder="Find in document..."
            type="search"
            value={snapshot.findQuery}
            onChange={(event) => configure({ query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                controller.navigateFind(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                controller.setFindOpen(false);
                controller.view?.focus();
              }
            }}
          />
          <span
            aria-live="polite"
            className="scient-markdown-find-count pointer-events-none absolute right-2 text-[10px] text-muted-foreground font-mono"
          >
            {snapshot.findMatchCount === 0
              ? "0"
              : `${snapshot.findActiveIndex + 1}/${snapshot.findMatchCount}`}
          </span>
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-foreground/80 hover:bg-accent disabled:opacity-35"
                aria-label="Previous match"
                disabled={snapshot.findMatchCount === 0}
                onClick={() => controller.navigateFind(-1)}
              >
                <ChevronUp className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup>Previous (Shift+Enter)</TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-foreground/80 hover:bg-accent disabled:opacity-35"
                aria-label="Next match"
                disabled={snapshot.findMatchCount === 0}
                onClick={() => controller.navigateFind(1)}
              >
                <ChevronDown className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup>Next (Enter)</TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-1.5 text-xs font-mono transition-colors hover:bg-accent",
                  snapshot.findCaseSensitive && "bg-accent font-bold text-foreground",
                )}
                aria-label="Match case"
                aria-pressed={snapshot.findCaseSensitive}
                onClick={() => configure({ caseSensitive: !snapshot.findCaseSensitive })}
              >
                Aa
              </button>
            }
          />
          <TooltipPopup>Match Case</TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-1.5 text-xs font-mono transition-colors hover:bg-accent",
                  snapshot.findWholeWord && "bg-accent font-bold text-foreground",
                )}
                aria-label="Match whole word"
                aria-pressed={snapshot.findWholeWord}
                onClick={() => configure({ wholeWord: !snapshot.findWholeWord })}
              >
                "W"
              </button>
            }
          />
          <TooltipPopup>Match Whole Word</TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close find"
                onClick={() => controller.setFindOpen(false)}
              >
                <X className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup>Close (Esc)</TooltipPopup>
        </Tooltip>
      </div>

      {snapshot.editable ? (
        <div className="scient-markdown-find-row flex items-center gap-1.5">
          <Input
            aria-label="Replacement text"
            className="h-7 text-xs"
            placeholder="Replace with..."
            type="text"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                controller.replaceFind(replacement, false);
              }
            }}
          />
          <Button
            className="h-7 text-xs"
            disabled={snapshot.findMatchCount === 0}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => controller.replaceFind(replacement, false)}
          >
            Replace
          </Button>
          <Button
            className="h-7 text-xs"
            disabled={snapshot.findMatchCount === 0}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => controller.replaceFind(replacement, true)}
          >
            Replace all
          </Button>
        </div>
      ) : null}
    </div>
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
        {snapshot.editable ? <InsertBlockMenu controller={controller} /> : null}
        {snapshot.editable ? (
          <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
        ) : null}
        {snapshot.editable ? (
          <CommandButton
            controller={controller}
            command="undo"
            label="Undo (Cmd+Z)"
            icon={<Undo2 className="size-3.5" />}
          />
        ) : null}
        {snapshot.editable ? (
          <CommandButton
            controller={controller}
            command="redo"
            label="Redo (Cmd+Shift+Z)"
            icon={<Redo2 className="size-3.5" />}
          />
        ) : null}
        {snapshot.editable ? (
          <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
        ) : null}

        {snapshot.editable ? (
          <>
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
            <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
            <CommandButton
              controller={controller}
              command="bullet-list"
              label="Bullet List"
              icon={<List className="size-3.5" />}
              active={snapshot.blockType === "bullet_list"}
            />
            <CommandButton
              controller={controller}
              command="ordered-list"
              label="Numbered List"
              icon={<ListOrdered className="size-3.5" />}
              active={snapshot.blockType === "ordered_list"}
            />
            <CommandButton
              controller={controller}
              command="task-list"
              label="Task Checklist"
              icon={<ListTodo className="size-3.5" />}
              active={snapshot.blockType === "task_list"}
            />
            <CommandButton
              controller={controller}
              command="blockquote"
              label="Blockquote"
              icon={<Quote className="size-3.5" />}
              active={snapshot.blockType === "blockquote"}
            />
            <CommandButton
              controller={controller}
              command="code-block"
              label="Code Block"
              icon={<Code2 className="size-3.5" />}
              active={snapshot.blockType === "code_block"}
            />
            <CommandButton
              controller={controller}
              command="table"
              label="Insert Table"
              icon={<TableIcon className="size-3.5" />}
            />
            <CommandButton
              controller={controller}
              command="display-math"
              label="Math Equation ($$)"
              icon={<Sigma className="size-3.5" />}
            />
            <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
            <BlockCommandButton
              controller={controller}
              action="move-up"
              label="Move block up (Option+Up)"
              icon={<ArrowUp className="size-3.5" />}
              disabled={!snapshot.canMoveBlockUp}
            />
            <BlockCommandButton
              controller={controller}
              action="move-down"
              label="Move block down (Option+Down)"
              icon={<ArrowDown className="size-3.5" />}
              disabled={!snapshot.canMoveBlockDown}
            />
            <BlockCommandButton
              controller={controller}
              action="duplicate"
              label="Duplicate block (Shift+Option+Down)"
              icon={<Copy className="size-3.5" />}
              disabled={!snapshot.canDuplicateBlock}
            />
            <BlockCommandButton
              controller={controller}
              action="delete"
              label="Delete block"
              icon={<Trash2 className="size-3.5 text-destructive" />}
              disabled={!snapshot.canDeleteBlock}
            />
            <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
          </>
        ) : null}

        <div className="ms-auto flex items-center gap-0.5">
          <OutlineControl controller={controller} snapshot={snapshot} />
          <FindButton controller={controller} snapshot={snapshot} />
        </div>
      </div>

      {snapshot.findOpen ? <FindBar controller={controller} snapshot={snapshot} /> : null}

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
            icon={<span className="text-[11px] font-medium">+ Row</span>}
          />
          <CommandButton
            controller={controller}
            command="add-column-after"
            label="Add column after"
            icon={<span className="text-[11px] font-medium">+ Col</span>}
          />
          <CommandButton
            controller={controller}
            command="delete-row"
            label="Delete row"
            icon={<span className="text-[11px] font-medium text-destructive">− Row</span>}
          />
          <CommandButton
            controller={controller}
            command="delete-column"
            label="Delete column"
            icon={<span className="text-[11px] font-medium text-destructive">− Col</span>}
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
