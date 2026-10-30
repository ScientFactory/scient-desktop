import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import {
  createScientNestedCodeEditor,
  type ScientNestedCodeEditor,
} from "~/scient/markdownEditor/nodes/codeMirrorCodeEditor";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import type { NotebookCell as Cell, NotebookCellType } from "./notebookDocument";
import { NOTEBOOK_MARKDOWN_PLUGINS } from "./NotebookOutputs";
import type { NotebookStaleness } from "./notebookStaleness";

export type NotebookCellActivity = "queued" | "running" | null;
export type NotebookCellEdge = "start" | "end";

function CellEditor(props: {
  readonly cell: Cell;
  readonly language: string;
  readonly onChange: (source: string) => void;
  readonly onRun: (advance: boolean) => void;
  readonly onEscape: () => void;
  readonly onLeave: (edge: NotebookCellEdge) => void;
  readonly register: (editor: ScientNestedCodeEditor | null) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<ScientNestedCodeEditor | null>(null);
  // The source this editor last showed or produced; typing never loops back as a replacement.
  const shown = useRef(props.cell.source);
  const onChange = useStableCallback((code: string) => {
    shown.current = code;
    props.onChange(code);
  });
  const onEscape = useStableCallback(() => props.onEscape());
  const register = useStableCallback((next: ScientNestedCodeEditor | null) => props.register(next));
  const initial = useRef({ code: props.cell.source, language: props.language });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the CodeMirror editor into its DOM node for this cell's lifetime.
  useLayoutEffect(() => {
    if (parent.current === null) return;
    const view = createScientNestedCodeEditor({
      parent: parent.current,
      code: initial.current.code,
      editable: true,
      language: initial.current.language,
      ariaLabel: "Notebook cell",
      onUserCodeChange: onChange,
      onEscape,
    });
    editor.current = view;
    register(view);
    return () => {
      register(null);
      view.destroy();
      editor.current = null;
    };
  }, [onChange, onEscape, register]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps CodeMirror's text in step with outside edits to the cell (another view, an agent).
  useEffect(() => {
    if (props.cell.source === shown.current) return;
    shown.current = props.cell.source;
    editor.current?.replaceExternalCode(props.cell.source, props.language);
  }, [props.cell.source, props.language]);
  return (
    <div
      ref={parent}
      className="min-w-0 px-1 py-1 text-[13px] [&_.cm-focused]:outline-none"
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          props.onRun(event.shiftKey);
          return;
        }
        const edge = event.key === "ArrowUp" ? "start" : event.key === "ArrowDown" ? "end" : null;
        if (edge === null || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
          return;
        }
        if (editor.current?.caretAtEdge(edge)) {
          event.preventDefault();
          event.stopPropagation();
          props.onLeave(edge);
        }
      }}
    />
  );
}

function CellAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactElement;
}) {
  return (
    <ScientTooltip content={props.label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={props.label}
        onClick={(event) => {
          event.stopPropagation();
          props.onClick();
        }}
      >
        {props.children}
      </Button>
    </ScientTooltip>
  );
}

function formatRunTime(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function runLabel(cell: Cell, stale: NotebookStaleness | null): string {
  if (stale === "edited") return "Run · edited since it ran";
  if (stale === "upstream") return "Run · a cell above changed since it ran";
  if (cell.run === null) return "Run";
  const time = new Date(cell.run.at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return cell.run.ms === null
    ? `Run · ran at ${time}`
    : `Run · ran at ${time} in ${formatRunTime(cell.run.ms)}`;
}

/** A cell's state, one mark in one place; the pointer or focus turns it into Run or Stop. */
function CellGutter(props: {
  readonly cell: Cell;
  readonly activity: NotebookCellActivity;
  readonly stale: NotebookStaleness | null;
  readonly onRun: () => void;
  readonly onStop: () => void;
}) {
  const { cell, activity, stale } = props;
  const failed = cell.outputs.some((output) => output.output_type === "error");
  return (
    <div className="sticky top-0 flex h-8 items-center justify-center self-start">
      <span className="flex items-center justify-center group-focus-within/cell:hidden group-hover/cell:hidden">
        {activity === "running" ? (
          <LoaderCircle
            aria-label="Running"
            className="size-3.5 animate-spin text-muted-foreground"
          />
        ) : activity === "queued" ? (
          <span
            aria-label="Queued"
            className="size-2 rounded-full border border-muted-foreground/70"
          />
        ) : stale !== null ? (
          <span aria-label="Out of date" className="size-2 rounded-full bg-warning" />
        ) : (
          <span
            className={cn(
              "font-mono text-[11px] tabular-nums",
              failed ? "text-destructive" : "text-muted-foreground/70",
            )}
          >
            {cell.executionCount ?? ""}
          </span>
        )}
      </span>
      <span className="hidden group-focus-within/cell:inline-flex group-hover/cell:inline-flex">
        {activity === null ? (
          <CellAction label={runLabel(cell, stale)} onClick={props.onRun}>
            <Play />
          </CellAction>
        ) : (
          <CellAction label="Stop" onClick={props.onStop}>
            <Square />
          </CellAction>
        )}
      </span>
    </div>
  );
}

/** Insert and arrange live in a row of their own, so no control ever sits on a cell's code. */
function CellRow(props: {
  readonly canAsk: boolean;
  readonly onInsert: (type: NotebookCellType) => void;
  readonly onAsk: () => void;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="col-start-2 flex h-6.5 min-w-0 items-center justify-between gap-1">
      <div className="group/insert flex h-full min-w-0 flex-1 items-center">
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover/insert:opacity-100 focus-within:opacity-100">
          <Button variant="ghost-muted" size="xs" onClick={() => props.onInsert("code")}>
            <Plus /> Code
          </Button>
          <Button variant="ghost-muted" size="xs" onClick={() => props.onInsert("markdown")}>
            <Plus /> Text
          </Button>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/cell:opacity-100 group-hover/cell:opacity-100">
        {props.canAsk ? (
          <CellAction label="Ask in chat" onClick={props.onAsk}>
            <MessageSquarePlus />
          </CellAction>
        ) : null}
        <CellAction label="Move up" onClick={() => props.onMove(-1)}>
          <ArrowUp />
        </CellAction>
        <CellAction label="Move down" onClick={() => props.onMove(1)}>
          <ArrowDown />
        </CellAction>
        <CellAction label="Delete" onClick={props.onDelete}>
          <Trash2 />
        </CellAction>
      </div>
    </div>
  );
}

export function NotebookCell(props: {
  readonly cell: Cell;
  readonly index: number;
  readonly language: string;
  readonly selected: boolean;
  readonly editingText: boolean;
  readonly activity: NotebookCellActivity;
  readonly stale: NotebookStaleness | null;
  readonly output: ReactNode;
  readonly onSelect: () => void;
  readonly onEditText: () => void;
  readonly onChange: (source: string) => void;
  readonly onRun: (advance: boolean) => void;
  readonly onStop: () => void;
  readonly onEscape: () => void;
  readonly onLeave: (edge: NotebookCellEdge) => void;
  readonly onInsert: (type: NotebookCellType) => void;
  readonly onAsk: () => void;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onDelete: () => void;
  readonly registerEditor: (editor: ScientNestedCodeEditor | null) => void;
}) {
  const { cell } = props;
  const isCode = cell.cellType === "code";
  const rendered = cell.cellType === "markdown" && !props.editingText && cell.source.trim() !== "";
  return (
    // `application` keeps command-mode keys here instead of the chat's type-to-focus.
    <section
      data-notebook-cell={cell.id}
      role="application"
      aria-label={`Cell ${props.index + 1}`}
      tabIndex={-1}
      className="group/cell grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-1 pr-3 pl-1 outline-none"
      onFocusCapture={props.onSelect}
      onClick={props.onSelect}
    >
      <CellRow
        canAsk={isCode && cell.outputs.length > 0}
        onInsert={props.onInsert}
        onAsk={props.onAsk}
        onMove={props.onMove}
        onDelete={props.onDelete}
      />
      {isCode ? (
        <CellGutter
          cell={cell}
          activity={props.activity}
          stale={props.stale}
          onRun={() => props.onRun(false)}
          onStop={props.onStop}
        />
      ) : (
        <span />
      )}
      <div className="min-w-0">
        <div
          className={cn(
            "rounded-md border bg-background",
            props.selected ? "border-ring" : rendered ? "border-transparent" : "border-border/60",
          )}
        >
          {rendered ? (
            <div className="min-h-8 cursor-text px-3 py-1" onDoubleClick={props.onEditText}>
              <ChatMarkdown
                text={cell.source}
                cwd={undefined}
                parseRawHtml={false}
                extraRemarkPlugins={NOTEBOOK_MARKDOWN_PLUGINS}
              />
            </div>
          ) : (
            <CellEditor
              cell={cell}
              language={props.language}
              onChange={props.onChange}
              onRun={props.onRun}
              onEscape={props.onEscape}
              onLeave={props.onLeave}
              register={props.registerEditor}
            />
          )}
        </div>
        {isCode && props.output !== null ? (
          <div className={cn("min-w-0 transition-opacity", props.stale !== null && "opacity-55")}>
            {props.output}
          </div>
        ) : null}
      </div>
    </section>
  );
}
