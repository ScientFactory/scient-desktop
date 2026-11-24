import type { NotebookCellType, NotebookCellView } from "@t3tools/contracts";
import type { NotebookStaleness } from "@t3tools/shared/notebookStaleness";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Ellipsis,
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
import { T, msg, useGT, useMessages } from "gt-react";
import { useStore } from "zustand";

import ChatMarkdown from "~/components/ChatMarkdown";
import { m, type MessageResolver } from "~/i18n/messages";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Button } from "~/components/ui/button";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import {
  createScientNestedCodeEditor,
  type ScientNestedCodeEditor,
} from "~/scient/markdownEditor/nodes/codeMirrorCodeEditor";
import { useCodeBlockWordWrap } from "~/scient/presentation/CodeBlockActions";
import { ComputeWrittenFiles } from "~/scient/compute/ComputeWrittenFiles";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { resultTime } from "~/scient/results/resultState";
import type { NotebookCaret, NotebookCellActivity, NotebookController } from "./notebookController";
import { NOTEBOOK_MARKDOWN, NotebookCellOutputs, type NotebookPlace } from "./NotebookOutputs";
import { NotebookCodeHeader, NotebookCodeSource, notebookCodeCardSurface } from "./NotebookCode";

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
  /** Absent where there is no chat to ask in. */
  readonly ask: ((cellId: string) => void) | null;
  readonly delete: (cellId: string) => void;
  /** Opens the cell's editor with its caret there. */
  readonly edit: (cellId: string, caret: NotebookCaret) => void;
  /** Calls back when the cell comes near the visible area and when it leaves it. */
  readonly observeNear: (node: Element, onChange: (near: boolean) => void) => () => void;
}

function CellEditor(props: {
  readonly cell: Cell;
  readonly language: string;
  readonly wrapped: boolean;
  readonly lineNumbers: boolean;
  readonly theme: "light" | "dark";
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
  const initial = useRef({
    code: props.cell.source,
    language: props.language,
    wrapped: props.wrapped,
    lineNumbers: props.lineNumbers,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the CodeMirror editor into its DOM node for this cell's lifetime.
  useLayoutEffect(() => {
    if (parent.current === null) return;
    const view = createScientNestedCodeEditor({
      parent: parent.current,
      code: initial.current.code,
      editable: true,
      language: initial.current.language,
      wordWrap: initial.current.wrapped,
      lineNumbers: initial.current.lineNumbers,
      ariaLabel: m(msg("Notebook cell")),
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- propagates the cell's wrap toggle into the mounted CodeMirror view.
  useEffect(() => {
    editor.current?.setWordWrap(props.wrapped);
  }, [props.wrapped]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates CodeMirror's light/dark theme compartment when app appearance changes.
  useEffect(() => {
    editor.current?.refreshAppearance(props.theme);
  }, [props.theme]);
  return (
    <div
      ref={parent}
      className={
        props.lineNumbers
          ? "min-w-0 px-3 pt-1.5 pb-3 text-[13px] [&_.cm-scroller]:font-mono! [&_.cm-scroller]:leading-5!"
          : "min-w-0 px-1 py-1 text-[13px] [&_.cm-scroller]:font-mono! [&_.cm-scroller]:leading-[1.4]!"
      }
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

/** A drag that selected text ends in a click, which must leave the selection alone. */
function selectingText(): boolean {
  return window.getSelection()?.isCollapsed === false;
}

function formatRunTime(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function runLabel(
  cell: Cell,
  stale: NotebookStaleness | null,
  resolve: MessageResolver = m,
): string {
  if (stale === "edited") return resolve(msg("Run · edited since it ran"));
  if (stale === "upstream") return resolve(msg("Run · output may be out of date"));
  if (cell.run === null) return resolve(msg("Run", { $context: "verb, runs a notebook cell" }));
  const time = new Date(cell.run.at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return cell.run.ms === null
    ? resolve(msg("Run · ran at {time}", { time }))
    : resolve(
        msg("Run · ran at {time} in {duration}", {
          time,
          duration: formatRunTime(cell.run.ms),
        }),
      );
}

/** A cell's state, one mark in one place; the pointer or focus turns it into Run or Stop. */
function CellGutter(props: {
  readonly cell: Cell;
  readonly activity: NotebookCellActivity;
  readonly stale: NotebookStaleness | null;
  readonly onRun: () => void;
  readonly onStop: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { cell, activity, stale } = props;
  const failed = cell.outputs.some((output) => output.outputType === "error");
  return (
    <div className="sticky top-0 flex flex-col items-center self-start pt-1.5">
      <span className="flex h-6 items-center justify-center group-focus-within/cell:hidden group-hover/cell:hidden">
        {activity === "running" ? (
          <LoaderCircle
            aria-label={gt("Running")}
            className="size-3.5 animate-spin text-muted-foreground"
          />
        ) : activity === "queued" ? (
          <span
            aria-label={gt("Queued")}
            className="size-2 rounded-full border border-muted-foreground/70"
          />
        ) : stale !== null ? (
          <span
            aria-label={stale === "upstream" ? gt("Output may be out of date") : gt("Out of date")}
            className="size-2 rounded-full bg-warning"
          />
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
      <span className="hidden flex-col items-center gap-0.5 group-focus-within/cell:inline-flex group-hover/cell:inline-flex">
        {activity === null ? (
          <CellAction label={runLabel(cell, stale, messages)} onClick={props.onRun}>
            <Play />
          </CellAction>
        ) : (
          <CellAction
            label={gt("Stop", { $context: "verb, stops a running cell" })}
            onClick={props.onStop}
          >
            <Square />
          </CellAction>
        )}
        {cell.executionCount !== null ? (
          <span
            className={cn(
              "font-mono text-[10px] leading-3.5 tabular-nums",
              failed ? "text-destructive/80" : "text-muted-foreground/60",
            )}
          >
            {cell.executionCount}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Slim hover-only insert target above a code cell, keeping prose and code tight. */
function CellInsertStrip(props: {
  readonly editsDisabled?: boolean | undefined;
  readonly onInsert: (type: NotebookCellType) => void;
}) {
  const gt = useGT();
  return (
    <div className="group/insert col-start-2 flex h-4 min-w-0 items-center">
      <span className="flex gap-0.5 opacity-0 transition-opacity group-hover/insert:opacity-100 focus-within:opacity-100">
        <Button
          variant="ghost-muted"
          size="micro"
          disabled={props.editsDisabled}
          onClick={() => props.onInsert("code")}
        >
          <Plus /> {gt("Code", { $context: "inserts a code cell" })}
        </Button>
        <Button
          variant="ghost-muted"
          size="micro"
          disabled={props.editsDisabled}
          onClick={() => props.onInsert("markdown")}
        >
          <Plus /> {gt("Text", { $context: "inserts a text cell" })}
        </Button>
      </span>
    </div>
  );
}

/** Seamless top row inside a code cell card, matching Markdown and Chat code blocks. */
function CodeCellTopRow(props: {
  readonly language: string;
  readonly theme: "light" | "dark";
  readonly wrapped: boolean;
  readonly folded: boolean;
  readonly onFoldChange: (folded: boolean) => void;
  readonly onWrapChange: (wrapped: boolean) => void;
  readonly readCode: () => string;
  readonly editsDisabled?: boolean | undefined;
  readonly onAsk: (() => void) | null;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onDelete: () => void;
  readonly menu: ReactElement | null;
}) {
  const gt = useGT();
  return (
    <NotebookCodeHeader
      language={props.language}
      theme={props.theme}
      wrapped={props.wrapped}
      onWrapChange={props.onWrapChange}
      readCode={props.readCode}
      folded={props.folded}
      onFoldChange={props.onFoldChange}
    >
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/cell:opacity-100 group-hover/cell:opacity-100">
        {props.onAsk !== null ? (
          <CellAction label={gt("Ask in chat")} onClick={props.onAsk}>
            <MessageSquarePlus />
          </CellAction>
        ) : null}
        {props.editsDisabled ? null : (
          <>
            <CellAction label={gt("Move up")} onClick={() => props.onMove(-1)}>
              <ArrowUp />
            </CellAction>
            <CellAction label={gt("Move down")} onClick={() => props.onMove(1)}>
              <ArrowDown />
            </CellAction>
          </>
        )}
        {props.menu}
        {props.editsDisabled ? null : (
          <CellAction
            label={gt("Delete", { $context: "verb, deletes a cell" })}
            onClick={props.onDelete}
          >
            <Trash2 />
          </CellAction>
        )}
        <span aria-hidden className="mx-0.5 h-3 w-px bg-border/80" />
      </div>
    </NotebookCodeHeader>
  );
}

/** Insert and arrange live in a row of their own, so no control ever sits on a cell's code. */
function CellRow(props: {
  readonly editsDisabled?: boolean | undefined;
  readonly onInsert: (type: NotebookCellType) => void;
  readonly onAsk: (() => void) | null;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onDelete: () => void;
  readonly menu: ReactElement | null;
}) {
  const gt = useGT();
  return (
    <div className="col-start-2 flex h-6.5 min-w-0 items-center justify-between gap-1">
      <div className="group/insert flex h-full min-w-0 flex-1 items-center">
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover/insert:opacity-100 focus-within:opacity-100">
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={props.editsDisabled}
            onClick={() => props.onInsert("code")}
          >
            <Plus /> {gt("Code", { $context: "inserts a code cell" })}
          </Button>
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={props.editsDisabled}
            onClick={() => props.onInsert("markdown")}
          >
            <Plus /> {gt("Text", { $context: "inserts a text cell" })}
          </Button>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/cell:opacity-100 group-hover/cell:opacity-100">
        {props.menu}
        {props.onAsk !== null ? (
          <CellAction label={gt("Ask in chat")} onClick={props.onAsk}>
            <MessageSquarePlus />
          </CellAction>
        ) : null}
        {props.editsDisabled ? null : (
          <>
            <CellAction label={gt("Move up")} onClick={() => props.onMove(-1)}>
              <ArrowUp />
            </CellAction>
            <CellAction label={gt("Move down")} onClick={() => props.onMove(1)}>
              <ArrowDown />
            </CellAction>
            <CellAction
              label={gt("Delete", { $context: "verb, deletes a cell" })}
              onClick={props.onDelete}
            >
              <Trash2 />
            </CellAction>
          </>
        )}
      </div>
    </div>
  );
}

function RenderedText(props: { readonly source: string; readonly live: boolean }) {
  return props.live ? (
    <ChatMarkdown
      text={props.source}
      cwd={undefined}
      parseRawHtml={false}
      extensions={NOTEBOOK_MARKDOWN}
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
  readonly editsDisabled?: boolean;
}) {
  const gt = useGT();
  const theme = useRenderedAppearance();
  const [wrapped, setWrapped] = useCodeBlockWordWrap();
  const { controller, cellId, handlers } = props;
  const cell = useStore(controller.store, (state) => state.cells[cellId]);
  const selected = useStore(controller.store, (state) => state.selected === cellId);
  const editing =
    useStore(controller.store, (state) => state.editing === cellId) && !props.editsDisabled;
  const caretRequest = useStore(controller.store, (state) =>
    state.editing === cellId ? state.caretRequest : 0,
  );
  const caret = useStore(controller.store, (state) => state.caret);
  const activity = useStore(controller.store, (state) => state.activity[cellId] ?? null);
  const liveRun = useStore(controller.store, (state) => state.liveRuns[cellId]);
  const stale = useStore(controller.store, (state) => state.stale.get(cellId) ?? null);
  const section = useRef<HTMLElement>(null);
  const outputsBox = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  /** The outputs' height when the cell left the view; a box this tall stands in for those outputs. */
  const [farOutputs, setFarOutputs] = useState<{
    readonly height: number;
    readonly outputs: unknown;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a cell mounts its editor and outputs only while it is near the view.
  useEffect(() => {
    if (section.current === null) return;
    return handlers.observeNear(section.current, (isNear) => {
      const height = outputsBox.current?.offsetHeight;
      if (!isNear && height !== undefined)
        setFarOutputs({ height, outputs: controller.store.getState().cells[cellId]?.outputs });
      setNear(isNear);
    });
  }, [handlers, controller, cellId]);
  const sectionHeading = useStore(controller.store, (state) =>
    state.sections.headingCells.has(cellId),
  );
  if (cell === undefined) return null;
  const isCode = cell.cellType === "code";
  const isText = cell.cellType === "markdown";
  const sourceFolded = cell.folded?.includes("source") === true && !editing;
  const outputsFolded = cell.folded?.includes("outputs") === true;
  const sectionFolded = cell.folded?.includes("section") === true;
  const rendered = isText && !editing && cell.source.trim() !== "";
  const live = near || selected;
  const farOutputsHeight = farOutputs?.outputs === cell.outputs ? farOutputs.height : null;
  const language = isCode ? props.language : isText ? "markdown" : "text";
  const onAsk =
    handlers.ask === null || cell.source.trim() === "" ? null : () => handlers.ask?.(cellId);
  const cellMenu =
    isCode || sectionHeading ? (
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" size="icon-xs" aria-label={gt("Cell actions")} />}
        >
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="end">
          {isCode ? (
            <>
              {cell.injectedParameters ? null : (
                <MenuItem
                  disabled={props.editsDisabled}
                  onClick={() => controller.setParameterCell(cellId, !cell.parameterCell)}
                >
                  {cell.parameterCell ? <T>Untag parameters</T> : <T>Tag as parameters</T>}
                </MenuItem>
              )}
              <MenuItem onClick={() => controller.setFold(cellId, "outputs", !outputsFolded)}>
                {outputsFolded ? <T>Show outputs</T> : <T>Hide outputs</T>}
              </MenuItem>
            </>
          ) : (
            <MenuItem onClick={() => controller.setFold(cellId, "section", !sectionFolded)}>
              {sectionFolded ? <T>Expand section</T> : <T>Collapse section</T>}
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    ) : null;
  const producedInLiveSession =
    liveRun !== undefined &&
    props.place.liveSessionGeneration != null &&
    liveRun.generation === props.place.liveSessionGeneration &&
    cell.run?.execution === liveRun.executionId;
  const writtenFiles = producedInLiveSession ? liveRun.writtenFiles : undefined;
  const changedFiles = producedInLiveSession ? liveRun.changedFiles : undefined;
  return (
    // `application` keeps command-mode keys here instead of the chat's type-to-focus.
    <section
      ref={section}
      data-notebook-cell={cellId}
      data-assistant-citation-source={cellId}
      role="application"
      aria-label={isCode ? gt("Code cell") : gt("Text cell")}
      tabIndex={-1}
      className="group/cell grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-1 pr-3 pl-1 outline-none [content-visibility:auto] [contain-intrinsic-size:auto_6rem]"
      onFocusCapture={() => controller.select(cellId)}
      onClick={() => controller.select(cellId)}
    >
      {isCode ? (
        <CellInsertStrip
          editsDisabled={props.editsDisabled}
          onInsert={(type) => handlers.insert(cellId, type)}
        />
      ) : (
        <CellRow
          editsDisabled={props.editsDisabled}
          onInsert={(type) => handlers.insert(cellId, type)}
          onAsk={onAsk}
          onMove={(offset) => controller.move(cellId, offset)}
          onDelete={() => handlers.delete(cellId)}
          menu={cellMenu}
        />
      )}
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
            "border transition-colors",
            isCode ? notebookCodeCardSurface : "rounded-md bg-background",
            editing
              ? "border-foreground/35"
              : selected
                ? "border-foreground/25"
                : rendered
                  ? "border-transparent"
                  : isCode
                    ? "border-(--markdown-code-block-border) group-hover/cell:border-border"
                    : "border-border/60",
          )}
        >
          {isCode ? (
            <CodeCellTopRow
              language={language}
              theme={theme}
              wrapped={wrapped}
              folded={sourceFolded}
              onFoldChange={(folded) => controller.setFold(cellId, "source", folded)}
              onWrapChange={setWrapped}
              readCode={() => cell.source}
              editsDisabled={props.editsDisabled}
              onAsk={onAsk}
              onMove={(offset) => controller.move(cellId, offset)}
              onDelete={() => handlers.delete(cellId)}
              menu={cellMenu}
            />
          ) : null}
          {sourceFolded && isCode ? null : sourceFolded ? (
            <div className="px-2 py-1">
              <Button
                variant="ghost-muted"
                size="xs"
                aria-expanded={false}
                onClick={() => controller.setFold(cellId, "source", false)}
              >
                <ChevronRight aria-hidden className="rtl:rotate-180" />
                <T>Show text</T>
              </Button>
            </div>
          ) : rendered ? (
            <div
              className="min-h-8 cursor-text px-3 py-1"
              onClick={(event) => {
                if (!selectingText()) {
                  handlers.edit(cellId, { x: event.clientX, y: event.clientY });
                }
              }}
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
              wrapped={wrapped}
              lineNumbers={isCode}
              theme={theme}
              onChange={(source) => controller.setSource(cellId, source)}
              onRun={(advance) => handlers.run(cellId, advance)}
              onEscape={() => handlers.escape(cellId)}
              onLeave={(edge) => handlers.leave(cellId, edge)}
              caret={caret}
              caretRequest={caretRequest}
            />
          ) : (
            <NotebookCodeSource
              source={cell.source}
              language={language}
              wrapped={wrapped}
              lineNumbers={isCode}
              theme={theme}
              near={live}
              onEdit={(offset) => handlers.edit(cellId, offset)}
            />
          )}
        </div>
        {sectionFolded && sectionHeading ? (
          <Button
            variant="ghost-muted"
            size="xs"
            focus="edge"
            aria-expanded={false}
            onClick={() => controller.setFold(cellId, "section", false)}
          >
            <ChevronRight aria-hidden className="rtl:rotate-180" />
            <T>Expand section</T>
          </Button>
        ) : null}
        {isCode && outputsFolded && cell.outputs.length > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => controller.setFold(cellId, "outputs", false)}
          >
            <T>Show outputs</T>
          </Button>
        ) : isCode && !outputsFolded && !live && farOutputsHeight !== null ? (
          <div style={{ height: farOutputsHeight }} />
        ) : isCode && !outputsFolded ? (
          <div
            ref={outputsBox}
            // Keeps the height the outputs had while their stored parts load again.
            style={farOutputsHeight === null ? undefined : { minHeight: farOutputsHeight }}
            className={cn("min-w-0 transition-opacity", stale !== null && "opacity-55")}
          >
            {activity === null &&
            cell.outputs.length > 0 &&
            !producedInLiveSession &&
            props.place.labelSavedOutputs === true ? (
              <p className="flex flex-wrap items-center gap-x-1.5 px-3 pt-1 text-[11px] leading-4 text-muted-foreground">
                <span>
                  <T>Saved output</T>
                </span>
                {cell.run !== null ? (
                  <>
                    <span aria-hidden>·</span>
                    <time dateTime={cell.run.at} className="tabular-nums">
                      {resultTime(cell.run.at)}
                    </time>
                  </>
                ) : null}
                <span aria-hidden>·</span>
                <span>
                  <T>Not run in this session</T>
                </span>
              </p>
            ) : null}
            <NotebookCellOutputs
              controller={controller}
              place={props.place}
              cell={cell}
              near={live}
            />
            {activity === null && (writtenFiles?.length ?? 0) + (changedFiles?.length ?? 0) > 0 ? (
              <ComputeWrittenFiles
                threadRef={props.place.threadRef}
                paths={writtenFiles}
                changed={changedFiles}
                className="px-3 pb-1.5"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
