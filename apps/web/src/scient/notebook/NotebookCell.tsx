import type { NotebookCellType, NotebookCellView } from "@t3tools/contracts";
import type { NotebookStaleness } from "@t3tools/shared/notebookStaleness";
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
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useStore } from "zustand";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import {
  createScientNestedCodeEditor,
  highlightedCodeSpans,
  type HighlightedCodeSpan,
  type ScientNestedCodeEditor,
} from "~/scient/markdownEditor/nodes/codeMirrorCodeEditor";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import type { NotebookCaret, NotebookCellActivity, NotebookController } from "./notebookController";
import {
  NOTEBOOK_MARKDOWN_PLUGINS,
  NotebookCellOutputs,
  type NotebookPlace,
} from "./NotebookOutputs";

type Cell = NotebookCellView;

// The document editor is large; a notebook needs it only once a Text cell is edited.
const NotebookTextEditor = lazy(() => import("./NotebookTextEditor"));
export type NotebookCellEdge = "start" | "end";

/** One stable set of actions for every cell, so a cell re-renders only when it changes. */
export interface NotebookCellHandlers {
  readonly run: (cellId: string, advance: boolean) => void;
  readonly stop: () => void;
  readonly escape: (cellId: string) => void;
  readonly leave: (cellId: string, edge: NotebookCellEdge) => void;
  readonly insert: (cellId: string, cellType: NotebookCellType) => void;
  readonly ask: (cellId: string) => void;
  readonly delete: (cellId: string) => void;
  /** Opens the cell's editor with its caret there. */
  readonly edit: (cellId: string, caret: NotebookCaret) => void;
  /** Calls back once when the cell comes near the visible area. */
  readonly observeNear: (node: Element, onNear: () => void) => () => void;
}

function CellEditor(props: {
  readonly cell: Cell;
  readonly language: string;
  readonly onChange: (source: string) => void;
  readonly onRun: (advance: boolean) => void;
  readonly onEscape: () => void;
  readonly onLeave: (edge: NotebookCellEdge) => void;
  readonly caret: NotebookCaret;
  readonly caretRequest: number;
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
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [onChange, onEscape]);
  const { caret, caretRequest } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the editor places its own caret, after the mount above, for each request to edit this cell.
  useLayoutEffect(() => {
    if (caretRequest > 0 && typeof caret !== "object") editor.current?.focusAt(caret);
  }, [caret, caretRequest]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps CodeMirror's text in step with outside edits to the cell (another view, an agent).
  useEffect(() => {
    if (props.cell.source === shown.current) return;
    shown.current = props.cell.source;
    editor.current?.replaceExternalCode(props.cell.source, props.language);
  }, [props.cell.source, props.language]);
  return (
    <div
      ref={parent}
      className="min-w-0 px-1 py-1 text-[13px] [&_.cm-scroller]:font-mono! [&_.cm-scroller]:leading-[1.4]!"
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
  const failed = cell.outputs.some((output) => output.outputType === "error");
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

/** Where a click landed in the code, so the editor opens with the caret there. */
function textOffsetAt(root: HTMLElement, x: number, y: number): number | "end" {
  const point = root.ownerDocument.caretRangeFromPoint(x, y);
  if (point === null || !root.contains(point.startContainer)) return "end";
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    if (walker.currentNode === point.startContainer) return offset + point.startOffset;
    offset += walker.currentNode.textContent?.length ?? 0;
  }
  return "end";
}

/** A cell's code without an editor. It lays out exactly like one, so opening never moves it. */
function StaticCode(props: {
  readonly source: string;
  readonly language: string;
  readonly near: boolean;
  readonly onEdit: (offset: number | "end") => void;
}) {
  const { source, language, near } = props;
  const [spans, setSpans] = useState<ReadonlyArray<HighlightedCodeSpan> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- colors arrive once the language parser has loaded.
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    void highlightedCodeSpans(source, language).then((next) => {
      if (!cancelled) setSpans(next);
    });
    return () => {
      cancelled = true;
    };
  }, [language, near, source]);
  return (
    <pre
      className="min-w-0 cursor-text py-[calc(--spacing(1)+4px)] pr-[calc(--spacing(1)+2px)] pl-[calc(--spacing(1)+6px)] font-mono text-[13px] leading-[1.4] wrap-anywhere whitespace-break-spaces"
      onClick={(event) =>
        props.onEdit(textOffsetAt(event.currentTarget, event.clientX, event.clientY))
      }
    >
      {spans === null
        ? source
        : spans.map((span, index) =>
            span.className === "" ? (
              span.text
            ) : (
              // oxlint-disable-next-line react/no-array-index-key -- spans are the text in order and have no identity.
              <span key={index} className={span.className}>
                {span.text}
              </span>
            ),
          )}
      {source === "" || source.endsWith("\n") ? "\n" : null}
    </pre>
  );
}

function RenderedText(props: { readonly source: string; readonly live: boolean }) {
  return props.live ? (
    <ChatMarkdown
      text={props.source}
      cwd={undefined}
      parseRawHtml={false}
      extraRemarkPlugins={NOTEBOOK_MARKDOWN_PLUGINS}
    />
  ) : (
    <p className="text-sm whitespace-pre-wrap">{props.source}</p>
  );
}

export function NotebookCell(props: {
  readonly controller: NotebookController;
  readonly place: NotebookPlace;
  readonly cellId: string;
  readonly language: string;
  readonly handlers: NotebookCellHandlers;
}) {
  const { controller, cellId, handlers } = props;
  const cell = useStore(controller.store, (state) => state.cells[cellId]);
  const selected = useStore(controller.store, (state) => state.selected === cellId);
  const editing = useStore(controller.store, (state) => state.editing === cellId);
  const caretRequest = useStore(controller.store, (state) =>
    state.editing === cellId ? state.caretRequest : 0,
  );
  const caret = useStore(controller.store, (state) => state.caret);
  const activity = useStore(controller.store, (state) => state.activity[cellId] ?? null);
  const stale = useStore(controller.store, (state) => state.stale.get(cellId) ?? null);
  const section = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a cell mounts its editor and outputs only when it scrolls near the view.
  useEffect(() => {
    if (section.current === null) return;
    return handlers.observeNear(section.current, () => setNear(true));
  }, [handlers]);
  if (cell === undefined) return null;
  const isCode = cell.cellType === "code";
  const isText = cell.cellType === "markdown";
  const rendered = isText && !editing && cell.source.trim() !== "";
  const live = near || selected;
  const language = isCode ? props.language : isText ? "markdown" : "text";
  return (
    // `application` keeps command-mode keys here instead of the chat's type-to-focus.
    <section
      ref={section}
      data-notebook-cell={cellId}
      role="application"
      aria-label={isCode ? "Code cell" : "Text cell"}
      tabIndex={-1}
      className="group/cell grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-1 pr-3 pl-1 outline-none [content-visibility:auto] [contain-intrinsic-size:auto_6rem]"
      onFocusCapture={() => controller.select(cellId)}
      onClick={() => controller.select(cellId)}
    >
      <CellRow
        canAsk={isCode && cell.outputs.length > 0}
        onInsert={(type) => handlers.insert(cellId, type)}
        onAsk={() => handlers.ask(cellId)}
        onMove={(offset) => controller.move(cellId, offset)}
        onDelete={() => handlers.delete(cellId)}
      />
      {isCode ? (
        <CellGutter
          cell={cell}
          activity={activity}
          stale={stale}
          onRun={() => handlers.run(cellId, false)}
          onStop={handlers.stop}
        />
      ) : (
        <span />
      )}
      <div className="min-w-0">
        <div
          data-notebook-cell-box=""
          className={cn(
            "rounded-md border bg-background",
            selected
              ? "border-foreground/25"
              : rendered
                ? "border-transparent"
                : "border-border/60",
          )}
        >
          {rendered ? (
            <div
              className="min-h-8 cursor-text px-3 py-1"
              onClick={(event) => handlers.edit(cellId, { x: event.clientX, y: event.clientY })}
            >
              <RenderedText source={cell.source} live={live} />
            </div>
          ) : isText && editing ? (
            <Suspense
              fallback={
                <div className="min-h-8 px-3 py-1">
                  <RenderedText source={cell.source} live />
                </div>
              }
            >
              <NotebookTextEditor
                source={cell.source}
                caret={caret}
                onChange={(source) => controller.setSource(cellId, source)}
                onDone={(advance) => handlers.run(cellId, advance)}
              />
            </Suspense>
          ) : editing ? (
            <CellEditor
              cell={cell}
              language={language}
              onChange={(source) => controller.setSource(cellId, source)}
              onRun={(advance) => handlers.run(cellId, advance)}
              onEscape={() => handlers.escape(cellId)}
              onLeave={(edge) => handlers.leave(cellId, edge)}
              caret={caret}
              caretRequest={caretRequest}
            />
          ) : (
            <StaticCode
              source={cell.source}
              language={language}
              near={live}
              onEdit={(offset) => handlers.edit(cellId, offset)}
            />
          )}
        </div>
        {isCode ? (
          <div className={cn("min-w-0 transition-opacity", stale !== null && "opacity-55")}>
            <NotebookCellOutputs
              controller={controller}
              place={props.place}
              cell={cell}
              near={live}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
