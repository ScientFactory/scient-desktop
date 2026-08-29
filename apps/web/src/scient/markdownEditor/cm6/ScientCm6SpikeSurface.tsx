import { redo, undo } from "@codemirror/commands";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { MarkdownSaveQueue } from "@scientfactory/scient-markdown";
import {
  ArrowRightLeft,
  Bold,
  ChevronDown,
  Columns3,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Plus,
  Redo2,
  Strikethrough,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import {
  insertBlockTemplate,
  insertImageTemplate,
  insertLink,
  toggleDirection,
  toggleLinePrefix,
  toggleNumberedList,
  toggleWrap,
} from "./commands";
import { ScientCm6EditorView } from "./view";
import { ScientFindBar } from "../ui/ScientFindBar";
import "../scient-markdown-editor.css";

const SAVE_DEBOUNCE_MS = 600;

const CODE_BLOCK_TEMPLATE = "```\n\n```";
const MATH_BLOCK_TEMPLATE = "$$\n\n$$";
const TABLE_TEMPLATE = "| Column | Column |\n| ------ | ------ |\n|        |        |";

type Cm6View = NonNullable<ScientCm6EditorView["view"]>;

function ToolbarIconButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={props.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              props.onClick();
            }}
          >
            {props.children}
          </button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function ToolbarMenu(props: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
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
                  className="scient-markdown-command-button inline-flex size-7 items-center justify-center gap-0.5 rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={props.label}
                >
                  {props.icon}
                  <ChevronDown className="size-2.5 opacity-60" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">{props.label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-44 p-1">
        <MenuGroup>
          <MenuGroupLabel>{props.label}</MenuGroupLabel>
          {props.children}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export interface ScientCm6SpikeSurfaceProps {
  readonly source: string;
  readonly revision: string;
  /** Shows or hides the editing controls; the document is always editable. */
  readonly editChrome: boolean;
  readonly ariaLabel: string;
  readonly persist: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaveConfirmed: (source: string, revision: string) => void;
  readonly onSaveFailure: (error: unknown) => void;
  readonly onExternalConflict: (input: {
    readonly source: string;
    readonly revision: string;
  }) => void;
  readonly resolveImageSource?: (authoredSource: string) => Promise<string | null>;
  readonly saveResolution?: {
    readonly action: "discard" | "retry";
    readonly revision: string;
  } | null;
  readonly onSaveResolutionApplied?: () => void;
}

/**
 * Dev-only spike surface for the CodeMirror live-preview core. Same file,
 * same save lane, same session contract as the ProseMirror surface, so the
 * feel of both can be compared on real documents.
 */
export function ScientCm6SpikeSurface(props: ScientCm6SpikeSurfaceProps) {
  const persistRef = useRef(props.persist);
  const onPendingChangeRef = useRef(props.onPendingChange);
  const onSaveConfirmedRef = useRef(props.onSaveConfirmed);
  const onSaveFailureRef = useRef(props.onSaveFailure);
  persistRef.current = props.persist;
  onPendingChangeRef.current = props.onPendingChange;
  onSaveConfirmedRef.current = props.onSaveConfirmed;
  onSaveFailureRef.current = props.onSaveFailure;

  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ScientCm6EditorView | null>(null);
  const [conflict, setConflict] = useState(false);

  const [saveQueue] = useState(
    () =>
      new MarkdownSaveQueue({
        debounceMs: SAVE_DEBOUNCE_MS,
        persist: (intent) => persistRef.current(intent),
        onPendingChange: (isPending) => {
          onPendingChangeRef.current(isPending);
        },
        onConfirmed: (intent, result) => {
          controllerRef.current?.confirmSave(intent, result.revision);
          onSaveConfirmedRef.current(intent.source, result.revision);
        },
        onFailure: (_intent, error) => onSaveFailureRef.current(error),
      }),
  );
  const [controller] = useState(
    () =>
      new ScientCm6EditorView({
        source: props.source,
        revision: props.revision,
        placeholder: "Start writing…",
        ...(props.resolveImageSource ? { resolveImageSource: props.resolveImageSource } : {}),
        onUserSourceChange: (_source, intent) => {
          saveQueue.enqueue(intent);
        },
      }),
  );
  controllerRef.current = controller;
  const findSnapshot = useSyncExternalStore(
    controller.subscribeFind,
    controller.getFindSnapshot,
    controller.getFindSnapshot,
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    controller.mount(element);
    return () => {
      void saveQueue.flush();
    };
  }, [controller, saveQueue]);

  useEffect(() => {
    const result = controller.receiveExternalSource({
      source: props.source,
      revision: props.revision,
    });
    if (result === "conflict") {
      saveQueue.pause();
      setConflict(true);
      props.onExternalConflict({ source: props.source, revision: props.revision });
    } else {
      setConflict(false);
      if (result === "adopted") {
        // Same draft, fresher revision: rebase the queued save intent.
        const rebased = controller.createSaveIntent();
        if (rebased) saveQueue.enqueue(rebased);
      }
    }
  }, [controller, props, saveQueue]);

  useEffect(() => {
    if (!props.saveResolution) return;
    if (props.saveResolution.action === "discard") {
      saveQueue.discard();
      controller.resolveExternalConflict("disk");
    } else {
      controller.resolveExternalConflict("local");
      saveQueue.retry(props.saveResolution.revision);
    }
    setConflict(false);
    props.onSaveResolutionApplied?.();
  }, [controller, props.saveResolution, saveQueue]);

  const startConflictResolution = (action: "discard" | "retry"): void => {
    if (action === "discard") {
      saveQueue.discard();
      controller.resolveExternalConflict("disk");
    } else {
      controller.resolveExternalConflict("local");
      saveQueue.retry();
    }
    setConflict(false);
  };

  const run = (action: (view: Cm6View) => boolean): void => {
    const view = controller.view;
    if (!view) return;
    action(view);
    view.focus();
  };

  return (
    <div
      className="scient-cm6-spike flex h-full flex-col"
      aria-label={props.ariaLabel}
      style={{ position: "relative" }}
    >
      {props.editChrome ? (
        <div
          aria-label="Markdown editing controls"
          className="flex flex-wrap items-center gap-0.5 border-b border-border/80 bg-background/95 px-2 py-1 backdrop-blur-xs"
        >
          <ToolbarIconButton label="Undo (Cmd+Z)" onClick={() => run(undo)}>
            <Undo2 className="size-3.5" />
          </ToolbarIconButton>
          <ToolbarIconButton label="Redo (Cmd+Shift+Z)" onClick={() => run(redo)}>
            <Redo2 className="size-3.5" />
          </ToolbarIconButton>
          <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
          <ToolbarIconButton
            label="Bold (Cmd+B)"
            onClick={() => run((view) => toggleWrap(view, "**"))}
          >
            <Bold className="size-3.5" />
          </ToolbarIconButton>
          <ToolbarIconButton
            label="Italic (Cmd+I)"
            onClick={() => run((view) => toggleWrap(view, "*"))}
          >
            <Italic className="size-3.5" />
          </ToolbarIconButton>
          <ToolbarIconButton
            label="Strikethrough (Cmd+Shift+X)"
            onClick={() => run((view) => toggleWrap(view, "~~"))}
          >
            <Strikethrough className="size-3.5" />
          </ToolbarIconButton>
          <ToolbarIconButton
            label="Inline Code (Cmd+E)"
            onClick={() => run((view) => toggleWrap(view, "`"))}
          >
            <span className="text-[11px] font-semibold">{`</>`}</span>
          </ToolbarIconButton>
          <ToolbarIconButton label="Link (Cmd+K)" onClick={() => run(insertLink)}>
            <Link2 className="size-3.5" />
          </ToolbarIconButton>
          <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
          <ToolbarMenu label="Paragraph style" icon={<Pilcrow className="size-3.5" />}>
            {[
              { label: "Paragraph", prefix: "" },
              { label: "Heading 1", prefix: "# " },
              { label: "Heading 2", prefix: "## " },
              { label: "Heading 3", prefix: "### " },
              { label: "Heading 4", prefix: "#### " },
              { label: "Heading 5", prefix: "##### " },
              { label: "Heading 6", prefix: "###### " },
              { label: "Quote", prefix: "> " },
            ].map((entry) => (
              <MenuCheckboxItem
                key={entry.label}
                checked={false}
                onCheckedChange={() =>
                  run((view) =>
                    entry.prefix === "" ? false : toggleLinePrefix(view, entry.prefix),
                  )
                }
              >
                {entry.label}
              </MenuCheckboxItem>
            ))}
          </ToolbarMenu>
          <ToolbarMenu label="List style" icon={<List className="size-3.5" />}>
            <MenuCheckboxItem
              checked={false}
              onCheckedChange={() => run((view) => toggleLinePrefix(view, "- "))}
            >
              <span className="flex items-center gap-2">
                <List className="size-4 text-muted-foreground" />
                Bullet list
              </span>
            </MenuCheckboxItem>
            <MenuCheckboxItem checked={false} onCheckedChange={() => run(toggleNumberedList)}>
              <span className="flex items-center gap-2">
                <ListOrdered className="size-4 text-muted-foreground" />
                Numbered list
              </span>
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={false}
              onCheckedChange={() => run((view) => toggleLinePrefix(view, "- [ ] "))}
            >
              <span className="flex items-center gap-2">
                <ListTodo className="size-4 text-muted-foreground" />
                Task list
              </span>
            </MenuCheckboxItem>
          </ToolbarMenu>
          <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <button
                        type="button"
                        className="scient-markdown-command-button inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Insert block or element"
                      >
                        <Plus className="size-3.5" />
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
                <MenuItem onClick={() => run((view) => insertBlockTemplate(view, TABLE_TEMPLATE))}>
                  <Columns3 className="size-4 text-muted-foreground" />
                  <span>Table (2×3)</span>
                </MenuItem>
                <MenuItem
                  onClick={() => run((view) => insertBlockTemplate(view, CODE_BLOCK_TEMPLATE))}
                >
                  <span className="size-4 text-center text-[11px] font-semibold text-muted-foreground">
                    {`</>`}
                  </span>
                  <span>Code block</span>
                </MenuItem>
                <MenuItem
                  onClick={() => run((view) => insertBlockTemplate(view, MATH_BLOCK_TEMPLATE))}
                >
                  <span className="size-4 text-center text-xs text-muted-foreground">∑</span>
                  <span>Math Equation ($$)</span>
                </MenuItem>
                <MenuItem onClick={() => run(insertImageTemplate)}>
                  <ImageIcon className="size-4 text-muted-foreground" />
                  <span>Image</span>
                </MenuItem>
                <MenuItem onClick={() => run((view) => insertBlockTemplate(view, "\n---\n"))}>
                  <Minus className="size-4 text-muted-foreground" />
                  <span>Divider line</span>
                </MenuItem>
              </MenuGroup>
            </MenuPopup>
          </Menu>
          <span className="scient-markdown-command-divider mx-1 h-4 w-px bg-border/80" />
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <button
                        type="button"
                        className="inline-flex size-7 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                  checked={false}
                  onCheckedChange={() => run((view) => toggleDirection(view, null))}
                >
                  Auto
                </MenuCheckboxItem>
                <MenuCheckboxItem
                  checked={false}
                  onCheckedChange={() => run((view) => toggleDirection(view, "ltr"))}
                >
                  Left-to-right
                </MenuCheckboxItem>
                <MenuCheckboxItem
                  checked={false}
                  onCheckedChange={() => run((view) => toggleDirection(view, "rtl"))}
                >
                  Right-to-left
                </MenuCheckboxItem>
              </MenuGroup>
            </MenuPopup>
          </Menu>
        </div>
      ) : null}
      {findSnapshot.findOpen ? (
        <ScientFindBar controller={controller} snapshot={findSnapshot} />
      ) : null}
      {conflict ? (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-border/80 bg-amber-500/15 px-4 py-2 text-sm"
        >
          <span>The file changed on disk while you were editing.</span>
          <button
            type="button"
            className="rounded-md px-2 py-0.5 text-xs font-medium hover:bg-accent"
            onClick={() => startConflictResolution("discard")}
          >
            Reload from disk
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md px-2 py-0.5 text-xs font-medium text-primary hover:bg-accent",
            )}
            onClick={() => startConflictResolution("retry")}
          >
            Keep mine
          </button>
        </div>
      ) : null}
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
