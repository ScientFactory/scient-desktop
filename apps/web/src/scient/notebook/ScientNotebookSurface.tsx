import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionId,
  type ComputeSessionId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowDown, ArrowUp, MessageSquarePlus, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { useStableCallback } from "~/hooks/useStableCallback";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  ComputeFileActions,
  type ComputeFileActionsHandle,
} from "~/scient/compute/ComputeFileActions";
import type { ComputeCodeSlice } from "~/scient/compute/computeSourceSlices";
import { ComputeOutputView } from "~/scient/compute/ComputeOutputView";
import { askInChatAboutCompute } from "~/scient/compute/computeAskInChat";
import { computeFileContextId } from "~/scient/compute/computeContextStore";
import { computeSourceLanguageForId } from "~/scient/compute/computeSourceLanguage";
import { createScientNestedCodeEditor } from "~/scient/markdownEditor/nodes/codeMirrorCodeEditor";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { NOTEBOOK_MARKDOWN_PLUGINS, NotebookOutputs } from "./NotebookOutputs";
import {
  emptyNotebookCell,
  insertNotebookCell,
  moveNotebookCell,
  parseNotebook,
  removeNotebookCell,
  serializeNotebook,
  updateNotebookCell,
  type NotebookCell,
  type NotebookCellType,
  type NotebookDocument,
} from "./notebookDocument";

interface CellRun {
  readonly cellId: string;
  readonly sessionId: ComputeSessionId;
  readonly executionId: ComputeExecutionId;
}

/** The notebook's code cells as one `%%` script, for the shared Run control's runtime checks. */
function notebookScript(document: NotebookDocument, marker: string): string {
  return document.cells
    .filter((cell) => cell.cellType === "code")
    .map((cell) => `${marker}\n${cell.source.replace(/\n$/, "")}`)
    .join("\n");
}

/** Without a returned value the kernel reports no count, so number the run after the latest. */
function nextExecutionCount(document: NotebookDocument): number {
  return Math.max(0, ...document.cells.map((cell) => cell.executionCount ?? 0)) + 1;
}

function cellMarkerFor(languageId: string): string {
  if (languageId === "matlab") return "%%";
  if (languageId === "sql") return "-- %%";
  return "# %%";
}

function CellEditor(props: {
  readonly cell: NotebookCell;
  readonly language: string;
  readonly autoFocus: boolean;
  readonly onChange: (source: string) => void;
  readonly onRun: (advance: boolean) => void;
  readonly onEscape: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<typeof createScientNestedCodeEditor> | null>(null);
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
    focus: props.autoFocus,
  });
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
    if (initial.current.focus) view.focus();
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [onChange, onEscape]);
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
        if (event.key !== "Enter" || !(event.shiftKey || event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        event.stopPropagation();
        props.onRun(event.shiftKey);
      }}
    />
  );
}

export default function ScientNotebookSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly persistence: MarkdownPersistenceLease;
}) {
  const { persistence } = props;
  const snapshot = useSyncExternalStore(persistence.subscribe, persistence.getSnapshot);
  const document = parseNotebook(snapshot.draftSource);
  const language = computeSourceLanguageForId(document?.language ?? "python");
  const contextId = computeFileContextId({
    environmentId: props.environmentId,
    threadId: props.threadRef.threadId,
    cwd: props.cwd,
    relativePath: props.relativePath,
  });
  const script =
    document === null || language === null
      ? null
      : notebookScript(document, cellMarkerFor(language.languageId));
  const actions = useRef<ComputeFileActionsHandle>(null);
  const [active, setActive] = useState<string | null>(null);
  const [editingMarkdown, setEditingMarkdown] = useState<string | null>(null);
  const [runs, setRuns] = useState<ReadonlyArray<CellRun>>([]);
  // Each submitted cell is known by the exact slice the Run control ran for it.
  const requested = useRef(new WeakMap<ComputeCodeSlice, string>());
  const runAll = useRef<string[]>([]);
  const readNotebookOutputs = useAtomCommand(computeEnvironment.notebookOutputs, {
    reportFailure: false,
  });
  const events = useEnvironmentQuery(
    computeEnvironment.events({ environmentId: props.environmentId, input: { cwd: props.cwd } }),
  );

  const commit = (update: (document: NotebookDocument) => NotebookDocument) => {
    const current = persistence.getSnapshot();
    const parsed = parseNotebook(current.draftSource);
    if (parsed === null) return;
    persistence.change(serializeNotebook(update(parsed)), current.editVersion);
  };

  /** Runs a cell; false when there is nothing to run, so Run all moves on. */
  const runCell = useStableCallback((cellId: string): boolean => {
    const cell = parseNotebook(persistence.getSnapshot().draftSource)?.cells.find(
      (candidate) => candidate.id === cellId,
    );
    if (cell === undefined || cell.cellType !== "code" || cell.source.trim() === "") return false;
    const slice = actions.current?.runCode(cell.source);
    if (slice !== undefined) requested.current.set(slice, cellId);
    return true;
  });
  const runNext = useStableCallback(() => {
    while (runAll.current.length > 0) {
      if (runCell(runAll.current.shift()!)) return;
    }
  });

  // A finished run's outputs are written into the cell, so the notebook keeps its results.
  const finishing = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- copies a run's outputs into the notebook file when the Compute stream reports it finished.
  useEffect(() => {
    for (const run of runs) {
      const execution = events.data?.executions.get(run.sessionId)?.get(run.executionId);
      const status = execution?.result?.status;
      if (status === undefined || !TERMINAL_COMPUTE_EXECUTION_STATUSES.has(status)) continue;
      if (finishing.current.has(run.executionId)) continue;
      finishing.current.add(run.executionId);
      void readNotebookOutputs({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, sessionId: run.sessionId, executionId: run.executionId },
      }).then((result) => {
        if (result._tag === "Success") {
          commit((current) =>
            updateNotebookCell(current, run.cellId, (cell) => ({
              ...cell,
              outputs: result.value.outputs,
              executionCount: result.value.executionCount ?? nextExecutionCount(current),
            })),
          );
        }
        setRuns((current) => current.filter((entry) => entry.executionId !== run.executionId));
        if (status === "succeeded") runNext();
        else runAll.current = [];
      });
    }
  }, [commit, events.data, props.cwd, props.environmentId, readNotebookOutputs, runNext, runs]);

  if (document === null || language === null || script === null) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {document === null
          ? "This notebook could not be read."
          : "This notebook's language is not set up in Scient."}
      </p>
    );
  }

  const addCell = (afterCellId: string | null, cellType: NotebookCellType) => {
    const cell = emptyNotebookCell(cellType);
    commit((current) => insertNotebookCell(current, afterCellId, cell));
    setActive(cell.id);
    if (cellType === "markdown") setEditingMarkdown(cell.id);
  };
  const runAndAdvance = (cell: NotebookCell, advance: boolean) => {
    runCell(cell.id);
    if (!advance) return;
    const index = document.cells.findIndex((candidate) => candidate.id === cell.id);
    const next = document.cells[index + 1];
    if (next === undefined) addCell(cell.id, "code");
    else setActive(next.id);
  };
  const liveRun = (cellId: string) => runs.findLast((run) => run.cellId === cellId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-2 py-1">
        <div className="min-w-22 flex-1">
          <ComputeFileActions
            ref={actions}
            language={language}
            environmentId={props.environmentId}
            cwd={props.cwd}
            relativePath={props.relativePath}
            contents={script}
            sourceRevision={snapshot.baselineRevision}
            sourcePending
            selection={null}
            editorSelection={null}
            contextId={contextId}
            onRunRequested={() => undefined}
            onShowMatlabOneShot={() => undefined}
            runAll={() => {
              runAll.current = document.cells
                .filter((cell) => cell.cellType === "code")
                .map((cell) => cell.id);
              runNext();
            }}
            onExecutionSubmitted={(sessionId, executionId, slice) => {
              const cellId = slice === undefined ? undefined : requested.current.get(slice);
              if (cellId !== undefined)
                setRuns((current) => [...current, { cellId, sessionId, executionId }]);
            }}
          />
        </div>
      </div>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl py-4">
          {document.cells.map((cell) => {
            const run = liveRun(cell.id);
            const session =
              run === undefined ? undefined : events.data?.sessions.get(run.sessionId);
            const live =
              run === undefined
                ? undefined
                : events.data?.outputs.get(`${run.sessionId}/${run.executionId}`);
            return (
              <section
                key={cell.id}
                className="group flex gap-2 pr-3 pl-1"
                onFocusCapture={() => setActive(cell.id)}
                onClick={() => setActive(cell.id)}
              >
                <div className="w-10 shrink-0 pt-8 text-right font-mono text-[11px] text-muted-foreground/70 tabular-nums">
                  {cell.cellType === "code"
                    ? run !== undefined
                      ? "*"
                      : cell.executionCount === null
                        ? ""
                        : cell.executionCount
                    : ""}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex h-6 items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    {cell.cellType === "code" ? (
                      <CellAction label="Run" onClick={() => runCell(cell.id)}>
                        <Play />
                      </CellAction>
                    ) : null}
                    {cell.cellType === "code" && cell.outputs.length > 0 ? (
                      <CellAction
                        label="Ask in chat"
                        onClick={() =>
                          askInChatAboutCompute({
                            threadRef: props.threadRef,
                            what: `Cell ${document.cells.indexOf(cell) + 1} of ${props.relativePath}`,
                          })
                        }
                      >
                        <MessageSquarePlus />
                      </CellAction>
                    ) : null}
                    <CellAction
                      label="Move up"
                      onClick={() => commit((current) => moveNotebookCell(current, cell.id, -1))}
                    >
                      <ArrowUp />
                    </CellAction>
                    <CellAction
                      label="Move down"
                      onClick={() => commit((current) => moveNotebookCell(current, cell.id, 1))}
                    >
                      <ArrowDown />
                    </CellAction>
                    <CellAction
                      label="Delete"
                      onClick={() => commit((current) => removeNotebookCell(current, cell.id))}
                    >
                      <Trash2 />
                    </CellAction>
                  </div>
                  {cell.cellType === "markdown" && editingMarkdown !== cell.id ? (
                    <div
                      className="min-h-8 cursor-text px-3 py-1"
                      onDoubleClick={() => setEditingMarkdown(cell.id)}
                    >
                      {cell.source.trim() ? (
                        <ChatMarkdown
                          text={cell.source}
                          cwd={undefined}
                          parseRawHtml={false}
                          extraRemarkPlugins={NOTEBOOK_MARKDOWN_PLUGINS}
                        />
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded-md border border-border/60 bg-background focus-within:border-ring">
                      <CellEditor
                        cell={cell}
                        language={cell.cellType === "code" ? language.languageId : "markdown"}
                        autoFocus={active === cell.id}
                        onChange={(source) =>
                          commit((current) =>
                            updateNotebookCell(current, cell.id, (entry) => ({ ...entry, source })),
                          )
                        }
                        onRun={(advance) => {
                          if (cell.cellType === "code") runAndAdvance(cell, advance);
                          else setEditingMarkdown(null);
                        }}
                        onEscape={() => setEditingMarkdown(null)}
                      />
                    </div>
                  )}
                  {cell.cellType === "code" ? (
                    run !== undefined && session !== undefined ? (
                      <div className="px-3 py-2">
                        <ComputeOutputView
                          cwd={props.cwd}
                          environmentId={props.environmentId}
                          session={session}
                          executionId={run.executionId}
                          outputs={live?.outputs ?? []}
                          threadRef={props.threadRef}
                        />
                      </div>
                    ) : (
                      <NotebookOutputs outputs={cell.outputs} label={`Cell ${cell.id}`} />
                    )
                  ) : null}
                </div>
              </section>
            );
          })}
          <div className="flex gap-1 py-3 pl-12">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addCell(document.cells.at(-1)?.id ?? null, "code")}
            >
              <Plus className="size-3.5" /> Code
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addCell(document.cells.at(-1)?.id ?? null, "markdown")}
            >
              <Plus className="size-3.5" /> Text
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CellAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactElement;
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
