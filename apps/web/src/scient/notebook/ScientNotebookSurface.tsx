import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionRecord,
  type EnvironmentId,
  type NotebookCellType,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Plus, Square, Variable } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";

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
import { ComputePanel } from "~/scient/compute/ComputePanel";
import { askInChatAboutCompute } from "~/scient/compute/computeAskInChat";
import { computeFileContextId, useComputeContextStore } from "~/scient/compute/computeContextStore";
import type { ComputePanelView } from "~/scient/compute/computeFilePresentationStore";
import { computeSourceLanguageForId } from "~/scient/compute/computeSourceLanguage";
import { useComputePanelSessions } from "~/scient/compute/useComputePanelSessions";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { NotebookCell, type NotebookCellEdge, type NotebookCellHandlers } from "./NotebookCell";
import { notebookCommand, type NotebookCommand, type NotebookKeyPress } from "./notebookCommands";
import {
  createNotebookController,
  type NotebookCaret,
  type NotebookController,
} from "./notebookController";

/** Where focus goes next: the cell itself (command mode) or a place in its editor. */
type NotebookFocusTarget = "cell" | NotebookCaret;

/** Cells mount their editors and outputs this far ahead of the visible area. */
const NEAR_MARGIN = "1200px 0px";

/** Tells each cell once when it comes near the view, whatever the scroll container becomes. */
function createNearWatcher() {
  let observer: IntersectionObserver | null = null;
  const watched = new Map<Element, () => void>();
  return {
    setRoot: (root: HTMLDivElement | null) => {
      observer?.disconnect();
      observer =
        root === null
          ? null
          : new IntersectionObserver(
              (entries) => {
                for (const entry of entries) {
                  if (!entry.isIntersecting) continue;
                  observer?.unobserve(entry.target);
                  watched.get(entry.target)?.();
                  watched.delete(entry.target);
                }
              },
              { root, rootMargin: NEAR_MARGIN },
            );
      for (const node of watched.keys()) observer?.observe(node);
    },
    watch: (node: Element, onNear: () => void) => {
      watched.set(node, onNear);
      observer?.observe(node);
      return () => {
        watched.delete(node);
        observer?.unobserve(node);
      };
    },
  };
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

function useNotebookController(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}): NotebookController {
  const read = useAtomCommand(computeEnvironment.notebookRead, { reportFailure: false });
  const readOutput = useAtomCommand(computeEnvironment.notebookReadOutput, {
    reportFailure: false,
  });
  const edit = useAtomCommand(computeEnvironment.notebookEdit, { reportFailure: false });
  const recordRun = useAtomCommand(computeEnvironment.notebookRecordRun, { reportFailure: false });
  const { environmentId, cwd, relativePath: path } = props;
  const [controller] = useState(() =>
    createNotebookController({
      read: async (knownRevision) => {
        const result = await read({
          environmentId,
          input: { cwd, path, ...(knownRevision === undefined ? {} : { knownRevision }) },
        });
        return result._tag === "Success" ? result.value : "failed";
      },
      readOutput: async (cellId, index) => {
        const result = await readOutput({ environmentId, input: { cwd, path, cellId, index } });
        return result._tag === "Success" ? result.value : null;
      },
      edit: async (edits) => {
        const result = await edit({ environmentId, input: { cwd, path, edits } });
        return result._tag === "Success" ? result.value : null;
      },
      recordRun: async (input) => {
        const result = await recordRun({ environmentId, input: { cwd, path, ...input } });
        return result._tag === "Success" ? result.value : null;
      },
      onError: (title) => toastManager.add({ type: "error", title }),
    }),
  );
  return controller;
}

export default function ScientNotebookSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  /** Changes when the file changes on disk. */
  readonly fileRevision: string;
}) {
  const controller = useNotebookController(props);
  const status = useStore(controller.store, (state) => state.status);
  const languageId = useStore(controller.store, (state) => state.language);
  const order = useStore(controller.store, (state) => state.order);
  const changed = useStore(controller.store, (state) => [...state.stale.keys()].join("\n"));
  const language = computeSourceLanguageForId(languageId);
  const contextId = computeFileContextId({
    environmentId: props.environmentId,
    threadId: props.threadRef.threadId,
    cwd: props.cwd,
    relativePath: props.relativePath,
  });
  const actions = useRef<ComputeFileActionsHandle>(null);
  const list = useRef<HTMLDivElement>(null);
  const deleted = useRef<Array<{ readonly cellId: string; readonly after: string | null }>>([]);
  const lastKey = useRef<NotebookKeyPress | null>(null);
  const restartedTo = useRef<number | null>(null);
  const [{ setRoot: setScroller, watch: watchNear }] = useState(createNearWatcher);
  const [focusedCell, setFocusedCell] = useState<{ readonly cellId: string } | null>(null);
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set());
  const [panelView, setPanelView] = useState<ComputePanelView | null>(null);
  const model = useComputePanelSessions({
    environmentId: props.environmentId,
    cwd: props.cwd,
    contextId,
  });
  const liveSession = model.liveSession;
  const interruptSession = useAtomCommand(computeEnvironment.interruptSession, {
    reportFailure: false,
  });
  const restartSession = useAtomCommand(computeEnvironment.restartSession, {
    reportFailure: false,
  });
  const cellRuns = latestCellRuns(model.executions, props.relativePath);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the notebook on open and whenever the file changes on disk.
  useEffect(() => {
    controller.fileChanged(props.fileRevision);
  }, [controller, props.fileRevision]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- text typed just before leaving still reaches the server.
  useEffect(() => () => controller.dispose(), [controller]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the session's runs: cell state, and settled results the file has not recorded.
  useEffect(() => {
    controller.observeRuns(
      cellRuns,
      TERMINAL_COMPUTE_EXECUTION_STATUSES as ReadonlySet<string> as Set<string>,
    );
  });

  const runCells = useStableCallback((cellIds: ReadonlyArray<string>) => {
    const { cells } = controller.store.getState();
    const runnable = cellIds.flatMap((id) => {
      const cell = cells[id];
      return cell?.cellType === "code" && cell.source.trim() !== ""
        ? [{ id, code: cell.source }]
        : [];
    });
    if (runnable.length === 0) return;
    const ids = runnable.map((cell) => cell.id);
    setSubmitting((waiting) => new Set([...waiting, ...ids]));
    void controller
      .flush()
      .then(() => actions.current?.runCells(runnable))
      .finally(() =>
        setSubmitting((waiting) => {
          const next = new Set(waiting);
          for (const id of ids) next.delete(id);
          return next;
        }),
      );
  });
  const codeCellIds = (from = 0, to?: number) => {
    const { order: ids, cells } = controller.store.getState();
    return ids.slice(from, to).filter((id) => cells[id]?.cellType === "code");
  };
  const runAllCells = useStableCallback(() => runCells(codeCellIds()));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the cell a command selected; a cell's editor places its own caret.
  useLayoutEffect(() => {
    if (focusedCell === null) return;
    const section = list.current?.querySelector<HTMLElement>(
      `[data-notebook-cell="${CSS.escape(focusedCell.cellId)}"]`,
    );
    section?.scrollIntoView({ block: "nearest" });
    if (controller.store.getState().editing !== focusedCell.cellId) {
      section?.focus({ preventScroll: true });
    }
  }, [controller, focusedCell]);

  // The Run control must see the restarted session before it can submit into it.
  const runAfterRestart = useStableCallback(() => {
    if (restartedTo.current === null || liveSession?.generation !== restartedTo.current) return;
    restartedTo.current = null;
    runAllCells();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the queued run when the session's new generation arrives.
  useEffect(() => runAfterRestart());

  const stop = useStableCallback(() => {
    if (liveSession === null) return;
    void interruptSession({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: liveSession.sessionId,
        expectedGeneration: liveSession.generation,
      },
    });
  });
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

  const focusCell = (cellId: string | undefined, target: NotebookFocusTarget) => {
    if (cellId === undefined) return;
    controller.select(cellId);
    if (target === "cell") controller.stopEditing();
    else controller.edit(cellId, target);
    setFocusedCell({ cellId });
  };
  const positionOf = (cellId: string) => controller.store.getState().order.indexOf(cellId);
  const cellAt = (index: number) => controller.store.getState().order[index];
  const addCell = (position: number, cellType: NotebookCellType) => {
    focusCell(controller.insert(position, cellType), "start");
  };
  const undoDelete = () => {
    const entry = deleted.current.pop();
    if (entry === undefined) return;
    controller.restore(entry.cellId, entry.after);
    focusCell(entry.cellId, "cell");
  };
  const deleteCell = (cellId: string) => {
    const index = positionOf(cellId);
    const next = cellAt(index + 1) ?? cellAt(index - 1);
    const removed = controller.remove(cellId);
    if (removed === null) return;
    deleted.current.push({ cellId, after: removed.after });
    focusCell(next, "cell");
    toastManager.add({
      type: "info",
      title: "Cell deleted",
      actionProps: { children: "Undo", onClick: undoDelete },
    });
  };
  const runAndAdvance = (cellId: string, advance: boolean) => {
    const cell = controller.store.getState().cells[cellId];
    if (cell === undefined) return;
    if (cell.cellType === "code") runCells([cellId]);
    const index = positionOf(cellId);
    if (!advance) {
      if (cell.cellType !== "code") focusCell(cellId, "cell");
      return;
    }
    if (cellAt(index + 1) === undefined) addCell(index + 1, "code");
    else focusCell(cellAt(index + 1), "start");
  };

  const runCommand = (command: NotebookCommand, cellId: string) => {
    const index = positionOf(cellId);
    const cell = controller.store.getState().cells[cellId];
    if (cell === undefined) return;
    switch (command) {
      case "edit":
        return focusCell(cellId, "end");
      case "previous":
        return focusCell(cellAt(index - 1), "cell");
      case "next":
        return focusCell(cellAt(index + 1), "cell");
      case "insert-above":
        return addCell(index, "code");
      case "insert-below":
        return addCell(index + 1, "code");
      case "delete":
        return deleteCell(cellId);
      case "undo-delete":
        return undoDelete();
      case "to-text":
        return controller.convert(cellId, "markdown");
      case "to-code":
        return controller.convert(cellId, "code");
      case "run":
        return runAndAdvance(cellId, false);
      case "run-and-next":
        return runAndAdvance(cellId, true);
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
    runCommand(command, cellId);
  };

  const handlers: NotebookCellHandlers = {
    run: useStableCallback(runAndAdvance),
    stop,
    escape: useStableCallback((cellId: string) => focusCell(cellId, "cell")),
    leave: useStableCallback((cellId: string, edge: NotebookCellEdge) => {
      const index = positionOf(cellId);
      focusCell(cellAt(index + (edge === "start" ? -1 : 1)), edge === "start" ? "end" : "start");
    }),
    insert: useStableCallback((cellId: string, cellType: NotebookCellType) =>
      addCell(positionOf(cellId), cellType),
    ),
    ask: useStableCallback((cellId: string) =>
      askInChatAboutCompute({
        threadRef: props.threadRef,
        what: `Cell ${positionOf(cellId) + 1} of ${props.relativePath}`,
      }),
    ),
    delete: useStableCallback(deleteCell),
    edit: useStableCallback(focusCell),
    observeNear: watchNear,
  };

  if (status === "failed") {
    return <p className="p-6 text-sm text-muted-foreground">This notebook could not be read.</p>;
  }
  if (language === null) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        This notebook's language is not set up in Scient.
      </p>
    );
  }

  const selectedIndex = (() => {
    const { selected } = controller.store.getState();
    return selected === null ? -1 : positionOf(selected);
  })();
  const outOfDate = changed === "" ? [] : changed.split("\n");
  const place = {
    environmentId: props.environmentId,
    cwd: props.cwd,
    threadRef: props.threadRef,
  };
  const busy =
    submitting.size > 0 ||
    [...cellRuns.values()].some(
      (execution) =>
        execution.result === null ||
        !TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status),
    );

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
            contents=""
            sourceRevision="notebook"
            sourcePending
            selection={null}
            editorSelection={null}
            contextId={contextId}
            onRunRequested={() => undefined}
            onShowMatlabOneShot={() => undefined}
            onExecutionSubmitted={() => model.refreshExecutions()}
            onCellsSubmitted={controller.expectRuns}
            runAll={runAllCells}
            runMenu={
              <>
                <MenuItem disabled={outOfDate.length === 0} onClick={() => runCells(outOfDate)}>
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
                  onClick={() => runCells(codeCellIds(selectedIndex))}
                >
                  Run from this cell
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onClick={() => void restartAndRunAll()}>
                  Restart and run all
                </MenuItem>
                <MenuItem disabled={busy} onClick={controller.clearOutputs}>
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
      <div ref={setScroller} className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
        <div ref={list} className="mx-auto max-w-4xl pb-4" onKeyDown={onCommandKey}>
          {order.map((cellId) => (
            <NotebookCell
              key={cellId}
              controller={controller}
              place={place}
              cellId={cellId}
              language={language.languageId}
              handlers={handlers}
            />
          ))}
          {status === "ready" ? (
            <div className="flex gap-1 pt-3 pl-9">
              <Button variant="ghost" size="sm" onClick={() => addCell(order.length, "code")}>
                <Plus className="size-3.5" /> Code
              </Button>
              <Button variant="ghost" size="sm" onClick={() => addCell(order.length, "markdown")}>
                <Plus className="size-3.5" /> Text
              </Button>
            </div>
          ) : null}
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
