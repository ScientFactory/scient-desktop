import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionRecord,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Plus, Square, Variable } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";

import { Button } from "~/components/ui/button";
import { MenuItem, MenuSeparator } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  ComputeFileActions,
  type ComputeFileActionsHandle,
} from "~/scient/compute/ComputeFileActions";
import { ComputeOutputView } from "~/scient/compute/ComputeOutputView";
import { ComputePanel } from "~/scient/compute/ComputePanel";
import { askInChatAboutCompute } from "~/scient/compute/computeAskInChat";
import { computeFileContextId, useComputeContextStore } from "~/scient/compute/computeContextStore";
import type { ComputePanelView } from "~/scient/compute/computeFilePresentationStore";
import { computeSourceLanguageForId } from "~/scient/compute/computeSourceLanguage";
import { useComputePanelSessions } from "~/scient/compute/useComputePanelSessions";
import type { ScientNestedCodeEditor } from "~/scient/markdownEditor/nodes/codeMirrorCodeEditor";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { NotebookCell, type NotebookCellActivity, type NotebookCellEdge } from "./NotebookCell";
import { notebookCommand, type NotebookCommand, type NotebookKeyPress } from "./notebookCommands";
import { NotebookOutputs } from "./NotebookOutputs";
import {
  clearNotebookOutputs,
  convertNotebookCell,
  emptyNotebookCell,
  insertNotebookCell,
  moveNotebookCell,
  notebookCodeHash,
  parseNotebook,
  removeNotebookCell,
  serializeNotebook,
  updateNotebookCell,
  type NotebookCell as Cell,
  type NotebookCellType,
  type NotebookDocument,
} from "./notebookDocument";
import { staleNotebookCells } from "./notebookStaleness";

interface SettledCellRun {
  readonly cellId: string;
  readonly execution: ComputeExecutionRecord;
}

/** Where focus goes next: the cell itself (command mode) or its editor. */
type NotebookFocus = { readonly cellId: string; readonly target: "cell" | NotebookCellEdge };

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

/** The latest run of each cell, from the session's durable history. */
function latestCellRuns(
  executions: ReadonlyArray<ComputeExecutionRecord>,
  path: string,
): ReadonlyMap<string, ComputeExecutionRecord> {
  const latest = new Map<string, ComputeExecutionRecord>();
  for (const execution of executions) {
    const { source, submittedAt } = execution.request;
    if (source._tag !== "document" || source.path !== path || source.cell === undefined) continue;
    const current = latest.get(source.cell);
    if (current === undefined || submittedAt >= current.request.submittedAt) {
      latest.set(source.cell, execution);
    }
  }
  return latest;
}

function isSettled(execution: ComputeExecutionRecord): boolean {
  return (
    execution.result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
  );
}

function activityOf(execution: ComputeExecutionRecord | undefined): NotebookCellActivity {
  if (execution === undefined || isSettled(execution)) return null;
  const status = execution.result?.status;
  return status === undefined || status === "queued" || status === "submitting"
    ? "queued"
    : "running";
}

function runDuration(execution: ComputeExecutionRecord): number | null {
  const startedAt = execution.result?.startedAt;
  const finishedAt = execution.result?.finishedAt;
  if (!startedAt || !finishedAt) return null;
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
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
  const list = useRef<HTMLDivElement>(null);
  const editors = useRef(new Map<string, ScientNestedCodeEditor>());
  const deleted = useRef<Array<{ readonly cell: Cell; readonly after: string | null }>>([]);
  const lastKey = useRef<NotebookKeyPress | null>(null);
  const finishing = useRef(new Set<string>());
  const restartedTo = useRef<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<NotebookFocus | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set());
  const [panelView, setPanelView] = useState<ComputePanelView | null>(null);
  const model = useComputePanelSessions({
    environmentId: props.environmentId,
    cwd: props.cwd,
    contextId,
  });
  const liveSession = model.liveSession;
  const readNotebookOutputs = useAtomCommand(computeEnvironment.notebookOutputs, {
    reportFailure: false,
  });
  const interruptSession = useAtomCommand(computeEnvironment.interruptSession, {
    reportFailure: false,
  });
  const restartSession = useAtomCommand(computeEnvironment.restartSession, {
    reportFailure: false,
  });
  const cellRuns = latestCellRuns(model.executions, props.relativePath);
  const stale = staleNotebookCells(document?.cells ?? []);

  const commit = useStableCallback((update: (document: NotebookDocument) => NotebookDocument) => {
    const current = persistence.getSnapshot();
    const parsed = parseNotebook(current.draftSource);
    if (parsed === null) return;
    persistence.change(serializeNotebook(update(parsed)), current.editVersion);
  });

  const runCells = useStableCallback((cellIds: ReadonlyArray<string>) => {
    const current = parseNotebook(persistence.getSnapshot().draftSource);
    if (current === null) return;
    // A run is tied to its cell by id, so an older notebook's ids must reach the file first.
    if (current.cells.some((cell) => cell.raw.id !== cell.id)) commit((same) => same);
    const cells = cellIds.flatMap((id) => {
      const cell = current.cells.find((candidate) => candidate.id === id);
      return cell?.cellType === "code" && cell.source.trim() !== ""
        ? [{ id, code: cell.source }]
        : [];
    });
    if (cells.length === 0) return;
    const ids = cells.map((cell) => cell.id);
    setSubmitting((waiting) => new Set([...waiting, ...ids]));
    void actions.current?.runCells(cells).finally(() =>
      setSubmitting((waiting) => {
        const next = new Set(waiting);
        for (const id of ids) next.delete(id);
        return next;
      }),
    );
  });
  const runAllCells = useStableCallback(() => {
    runCells(
      parseNotebook(persistence.getSnapshot().draftSource)
        ?.cells.filter((cell) => cell.cellType === "code")
        .map((cell) => cell.id) ?? [],
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the cell or editor a command just asked for.
  useLayoutEffect(() => {
    if (focus === null) return;
    const section = list.current?.querySelector<HTMLElement>(
      `[data-notebook-cell="${CSS.escape(focus.cellId)}"]`,
    );
    section?.scrollIntoView({ block: "nearest" });
    const editor = editors.current.get(focus.cellId);
    if (focus.target === "cell" || editor === undefined) section?.focus({ preventScroll: true });
    else editor.focusEdge(focus.target);
  }, [focus]);

  // A run belongs to its cell on the server, so outputs reach the file however long the notebook
  // was closed: a settled run the cell has not recorded yet is written here, once, in run order.
  const writeSettledRuns = useStableCallback(async (settled: ReadonlyArray<SettledCellRun>) => {
    for (const { cellId, execution } of settled) {
      const { executionId, sessionId, code } = execution.request;
      const outputs = await readNotebookOutputs({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, sessionId, executionId },
      });
      if (outputs._tag !== "Success") {
        finishing.current.delete(executionId);
        toastManager.add({ type: "error", title: "This cell's output could not be saved" });
        continue;
      }
      commit((current) =>
        updateNotebookCell(current, cellId, (entry) => ({
          ...entry,
          outputs: outputs.value.outputs,
          executionCount: outputs.value.executionCount ?? nextExecutionCount(current),
          run: {
            execution: executionId,
            code: notebookCodeHash(code),
            at: execution.result?.finishedAt ?? execution.request.submittedAt,
            ms: runDuration(execution),
          },
        })),
      );
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- copies settled runs from the session's history into the notebook file.
  useEffect(() => {
    const settled: SettledCellRun[] = [];
    for (const cell of document?.cells ?? []) {
      const execution = cellRuns.get(cell.id);
      if (execution === undefined || cell.cellType !== "code" || !isSettled(execution)) continue;
      const { executionId } = execution.request;
      if (cell.run?.execution === executionId || execution.result?.startedAt == null) continue;
      if (finishing.current.has(executionId)) continue;
      finishing.current.add(executionId);
      settled.push({ cellId: cell.id, execution });
    }
    if (settled.length === 0) return;
    void writeSettledRuns(
      settled.toSorted((left, right) =>
        left.execution.request.submittedAt.localeCompare(right.execution.request.submittedAt),
      ),
    );
  }, [cellRuns, document, writeSettledRuns]);

  // The Run control must see the restarted session before it can submit into it.
  const runAfterRestart = useStableCallback(() => {
    if (restartedTo.current === null || liveSession?.generation !== restartedTo.current) return;
    restartedTo.current = null;
    runAllCells();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the queued run when the session's new generation arrives.
  useEffect(() => runAfterRestart());

  if (document === null || language === null || script === null) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {document === null
          ? "This notebook could not be read."
          : "This notebook's language is not set up in Scient."}
      </p>
    );
  }

  const stop = () => {
    if (liveSession === null) return;
    void interruptSession({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: liveSession.sessionId,
        expectedGeneration: liveSession.generation,
      },
    });
  };
  const restartAndRunAll = async () => {
    if (liveSession === null) {
      runAllCells();
      return;
    }
    const restarted = await restartSession({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: liveSession.sessionId,
        expectedGeneration: liveSession.generation,
      },
    });
    if (restarted._tag !== "Success") {
      toastManager.add({ type: "error", title: "The session could not be restarted" });
      return;
    }
    useComputeContextStore.getState().bindSession({
      contextId,
      sessionId: restarted.value.sessionId,
      generation: restarted.value.generation,
    });
    restartedTo.current = restarted.value.generation;
    runAfterRestart();
  };

  const addCell = (index: number, cellType: NotebookCellType) => {
    const cell = emptyNotebookCell(cellType);
    const after = document.cells[index - 1]?.id ?? null;
    commit((current) => insertNotebookCell(current, after, cell));
    if (cellType === "markdown") setEditingText(cell.id);
    setSelected(cell.id);
    setFocus({ cellId: cell.id, target: "start" });
  };
  const undoDelete = () => {
    const entry = deleted.current.pop();
    if (entry === undefined) return;
    commit((current) => insertNotebookCell(current, entry.after, entry.cell));
    setSelected(entry.cell.id);
    setFocus({ cellId: entry.cell.id, target: "cell" });
  };
  const deleteCell = (index: number) => {
    const cell = document.cells[index];
    if (cell === undefined) return;
    deleted.current.push({ cell, after: document.cells[index - 1]?.id ?? null });
    commit((current) => removeNotebookCell(current, cell.id));
    const next = document.cells[index + 1] ?? document.cells[index - 1];
    if (next !== undefined) {
      setSelected(next.id);
      setFocus({ cellId: next.id, target: "cell" });
    }
    toastManager.add({
      type: "info",
      title: "Cell deleted",
      actionProps: { children: "Undo", onClick: undoDelete },
    });
  };
  const moveSelection = (index: number, target: NotebookFocus["target"]) => {
    const cell = document.cells[index];
    if (cell === undefined) return;
    setSelected(cell.id);
    setFocus({ cellId: cell.id, target });
  };
  const runAndAdvance = (index: number, advance: boolean) => {
    const cell = document.cells[index];
    if (cell === undefined) return;
    if (cell.cellType === "code") runCells([cell.id]);
    else setEditingText(null);
    if (!advance) {
      if (cell.cellType !== "code") setFocus({ cellId: cell.id, target: "cell" });
      return;
    }
    if (document.cells[index + 1] === undefined) addCell(index + 1, "code");
    else moveSelection(index + 1, "start");
  };

  const runCommand = (command: NotebookCommand, index: number) => {
    const cell = document.cells[index];
    if (cell === undefined) return;
    switch (command) {
      case "edit":
        if (cell.cellType !== "code") setEditingText(cell.id);
        return moveSelection(index, "end");
      case "previous":
        return moveSelection(index - 1, "cell");
      case "next":
        return moveSelection(index + 1, "cell");
      case "insert-above":
        return addCell(index, "code");
      case "insert-below":
        return addCell(index + 1, "code");
      case "delete":
        return deleteCell(index);
      case "undo-delete":
        return undoDelete();
      case "to-text":
        return commit((current) => convertNotebookCell(current, cell.id, "markdown"));
      case "to-code":
        return commit((current) => convertNotebookCell(current, cell.id, "code"));
      case "run":
        return runAndAdvance(index, false);
      case "run-and-next":
        return runAndAdvance(index, true);
      case "interrupt":
        return stop();
    }
  };
  const onCommandKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const cellId = event.target.dataset.notebookCell;
    if (cellId === undefined) return;
    const command = notebookCommand(event, lastKey.current, event.timeStamp);
    lastKey.current = { key: event.key, at: event.timeStamp };
    if (command === null) return;
    event.preventDefault();
    runCommand(
      command,
      document.cells.findIndex((cell) => cell.id === cellId),
    );
  };

  const selectedIndex = document.cells.findIndex((cell) => cell.id === selected);
  const codeCellIds = (from: number, to: number) =>
    document.cells
      .slice(from, to)
      .filter((cell) => cell.cellType === "code")
      .map((cell) => cell.id);
  const changed = [...stale.keys()];
  const busy =
    submitting.size > 0 ||
    [...cellRuns.values()].some((execution) => activityOf(execution) !== null);

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
            onExecutionSubmitted={() => model.refreshExecutions()}
            runAll={runAllCells}
            runMenu={
              <>
                <MenuItem disabled={changed.length === 0} onClick={() => runCells(changed)}>
                  Run out-of-date cells
                </MenuItem>
                <MenuItem
                  disabled={selectedIndex <= 0}
                  onClick={() => runCells(codeCellIds(0, selectedIndex))}
                >
                  Run cells above
                </MenuItem>
                <MenuItem
                  disabled={selectedIndex < 0}
                  onClick={() => runCells(codeCellIds(selectedIndex, document.cells.length))}
                >
                  Run from this cell
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onClick={() => void restartAndRunAll()}>
                  Restart and run all
                </MenuItem>
                <MenuItem disabled={busy} onClick={() => commit(clearNotebookOutputs)}>
                  Clear all outputs
                </MenuItem>
              </>
            }
            leadingActions={
              <>
                {busy ? (
                  <ScientTooltip content="Stop">
                    <Button size="icon-xs" variant="outline" aria-label="Stop" onClick={stop}>
                      <Square />
                    </Button>
                  </ScientTooltip>
                ) : null}
                <ScientTooltip content="Variables">
                  <Button
                    size="icon-xs"
                    variant={panelView === null ? "ghost-muted" : "secondary"}
                    aria-label="Variables"
                    aria-pressed={panelView !== null}
                    onClick={() => setPanelView(panelView === null ? "variables" : null)}
                  >
                    <Variable />
                  </Button>
                </ScientTooltip>
              </>
            }
          />
        </div>
      </div>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
        <div ref={list} className="mx-auto max-w-4xl pb-4" onKeyDown={onCommandKey}>
          {document.cells.map((cell, index) => {
            const execution = cellRuns.get(cell.id);
            const activity = submitting.has(cell.id) ? "queued" : activityOf(execution);
            const session =
              execution === undefined
                ? undefined
                : model.events.data?.sessions.get(execution.request.sessionId);
            const live =
              execution === undefined
                ? undefined
                : model.events.data?.outputs.get(
                    `${execution.request.sessionId}/${execution.request.executionId}`,
                  );
            const showsRun =
              execution !== undefined &&
              session !== undefined &&
              live !== undefined &&
              (activityOf(execution) !== null ||
                (cell.run?.execution === execution.request.executionId && cell.outputs.length > 0));
            return (
              <NotebookCell
                key={cell.id}
                cell={cell}
                index={index}
                language={cell.cellType === "code" ? language.languageId : "markdown"}
                selected={selected === cell.id}
                editingText={editingText === cell.id}
                activity={activity}
                stale={stale.get(cell.id) ?? null}
                output={
                  showsRun ? (
                    <div className="px-3 py-2">
                      <ComputeOutputView
                        cwd={props.cwd}
                        environmentId={props.environmentId}
                        session={session}
                        executionId={execution.request.executionId}
                        outputs={live.outputs}
                        threadRef={props.threadRef}
                      />
                    </div>
                  ) : (
                    <NotebookOutputs outputs={cell.outputs} label={`Cell ${index + 1}`} />
                  )
                }
                onSelect={() => setSelected(cell.id)}
                onEditText={() => {
                  setEditingText(cell.id);
                  setFocus({ cellId: cell.id, target: "end" });
                }}
                onChange={(source) =>
                  commit((current) =>
                    updateNotebookCell(current, cell.id, (entry) => ({ ...entry, source })),
                  )
                }
                onRun={(advance) => runAndAdvance(index, advance)}
                onStop={stop}
                onEscape={() => {
                  setEditingText(null);
                  setFocus({ cellId: cell.id, target: "cell" });
                }}
                onLeave={(edge) =>
                  moveSelection(
                    index + (edge === "start" ? -1 : 1),
                    edge === "start" ? "end" : "start",
                  )
                }
                onInsert={(type) => addCell(index, type)}
                onAsk={() =>
                  askInChatAboutCompute({
                    threadRef: props.threadRef,
                    what: `Cell ${index + 1} of ${props.relativePath}`,
                  })
                }
                onMove={(offset) => commit((current) => moveNotebookCell(current, cell.id, offset))}
                onDelete={() => deleteCell(index)}
                registerEditor={(editor) => {
                  if (editor === null) editors.current.delete(cell.id);
                  else editors.current.set(cell.id, editor);
                }}
              />
            );
          })}
          <div className="flex gap-1 pt-3 pl-9">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addCell(document.cells.length, "code")}
            >
              <Plus className="size-3.5" /> Code
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addCell(document.cells.length, "markdown")}
            >
              <Plus className="size-3.5" /> Text
            </Button>
          </div>
        </div>
      </div>
      {panelView === null ? null : (
        <div className="flex h-2/5 min-h-44 shrink-0 flex-col border-t border-border/60">
          <ComputePanel
            environmentId={props.environmentId}
            cwd={props.cwd}
            threadRef={props.threadRef}
            sourcePath={props.relativePath}
            contextId={contextId}
            panelView={panelView}
            onPanelViewChange={setPanelView}
            embedded
          />
        </div>
      )}
    </div>
  );
}
