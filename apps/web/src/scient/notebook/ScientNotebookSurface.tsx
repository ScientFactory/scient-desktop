import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
  type EnvironmentId,
  type NotebookCellType,
  type NotebookFreshRunInput,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { BookOpen, CircleAlert, ListTree, Plus, Square, Variable } from "lucide-react";
import { T, useGT } from "gt-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { useAtomValue } from "@effect/atom-react";

import { Button } from "~/components/ui/button";
import { ContextualConfirmation } from "~/components/ui/contextual-confirmation";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { MenuItem, MenuSeparator } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  ComputeFileActions,
  type ComputeFileActionsHandle,
} from "~/scient/compute/ComputeFileActions";
import { ComputePanel } from "~/scient/compute/ComputePanel";
import {
  ComputeQuoteActions,
  useAskAboutCompute,
  type ComputePlace,
} from "~/scient/compute/ComputeQuoteActions";
import {
  finishComputeQuoteReveal,
  showComputeQuote,
  usePendingComputeQuote,
} from "~/scient/compute/computeQuoteReveal";
import { computeFileContextId, useComputeContextStore } from "~/scient/compute/computeContextStore";
import type { ComputePanelView } from "~/scient/compute/computeFilePresentationStore";
import { computeSourceLanguageForId } from "~/scient/compute/computeSourceLanguage";
import { useComputePanelSessions } from "~/scient/compute/useComputePanelSessions";
import { ResultDeclaredInputs, useSavedResultRunSetup } from "~/scient/results/ResultRunSetup";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { NotebookCell, type NotebookCellEdge, type NotebookCellHandlers } from "./NotebookCell";
import { NotebookOutline } from "./NotebookOutline";
import { NotebookFreshRunWarning } from "./NotebookFreshRunWarning";
import { NotebookFreshRunStatus } from "./NotebookFreshRunStatus";
import { NotebookSweepDialog } from "./NotebookSweepDialog";
import {
  notebookParameterChanged,
  NotebookParameterControls,
  useNotebookParameters,
  validNotebookParameter,
} from "./NotebookParameters";
import { NotebookReader } from "./reader/NotebookReader";
import { useNotebookFreshRun } from "./useNotebookFreshRun";
import { notebookRunDraftKey, useNotebookRunDrafts } from "./notebookRunDrafts";
import { notebookCommand, type NotebookCommand, type NotebookKeyPress } from "./notebookCommands";
import {
  createNotebookController,
  type NotebookCaret,
  type NotebookController,
} from "./notebookController";
import { notebookBatchFailureSummary, notebookNeedsSetup } from "./notebookRunSummary";

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
      onNotice: (title) => toastManager.add({ type: "warning", title }),
    }),
  );
  return controller;
}

/** File names, with their folder only where two inputs share a name. */
function inputFileLabels(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const name = (path: string) => path.split("/").at(-1) ?? path;
  return paths.map((path) =>
    paths.some((other) => other !== path && name(other) === name(path)) ? path : name(path),
  );
}

export default function ScientNotebookSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  /** Changes when the file changes on disk. */
  readonly fileRevision: string;
}) {
  const gt = useGT();
  const controller = useNotebookController(props);
  const {
    parameters,
    saved: savedParameters,
    mismatch: parameterEvidenceMismatch,
  } = useNotebookParameters(controller);
  const fresh = useNotebookFreshRun({
    environmentId: props.environmentId,
    cwd: props.cwd,
    scriptPath: props.relativePath,
  });
  const settledFreshRun = fresh.settledRunId;
  const canRerun = useAtomValue(
    computeEnvironment.notebookFreshStart.permissionAtom(props.environmentId),
  );
  const canStopFresh = useAtomValue(
    computeEnvironment.notebookFreshStop.permissionAtom(props.environmentId),
  );
  const [readerOpen, setReaderOpen] = useState(false);
  const [inputFilesOpen, setInputFilesOpen] = useState(false);
  const [sweepParameter, setSweepParameter] = useState<
    Parameters<typeof validNotebookParameter>[0] | null
  >(null);
  const [preparingFresh, setPreparingFresh] = useState(false);
  const [freshConfirmation, setFreshConfirmation] = useState<Readonly<
    Record<string, string>
  > | null>(null);
  const runningFresh = preparingFresh || fresh.running;
  const outcome = fresh.job?.outcome;
  const runMessage =
    fresh.error ??
    (outcome?._tag === "failed" ? outcome.message : (outcome?.notebookMessage ?? null));
  const runStatus = (
    <NotebookFreshRunStatus
      job={fresh.job}
      running={runningFresh}
      message={runMessage}
      {...(canStopFresh ? { onStop: () => void fresh.stop() } : {})}
    />
  );
  const draftKey = notebookRunDraftKey(props.environmentId, props.cwd, props.relativePath);
  const draftParameters = useNotebookRunDrafts((state) => state.drafts[draftKey]?.parameters);
  const draftInputs = useNotebookRunDrafts((state) => state.drafts[draftKey]?.inputs);
  const setupTarget = {
    environmentId: props.environmentId,
    cwd: props.cwd,
    scriptPath: props.relativePath,
  };
  const { setup, retry: retrySetup } = useSavedResultRunSetup(setupTarget, settledFreshRun);
  const savedSetup = setup !== null && !("message" in setup) ? setup : undefined;
  const pendingParameters =
    draftParameters ??
    Object.fromEntries((savedSetup?.parameters ?? []).map(({ name, value }) => [name, value]));
  const inputs = draftInputs ?? savedSetup?.inputs;
  const status = useStore(controller.store, (state) => state.status);
  const languageId = useStore(controller.store, (state) => state.language);
  const order = useStore(controller.store, (state) => state.order);
  const firstCodeCell = useStore(controller.store, (state) =>
    state.order.find((id) => {
      const cell = state.cells[id];
      return cell?.cellType === "code" && cell.source.trim() !== "";
    }),
  );
  const sections = useStore(controller.store, (state) => state.sections);
  const selected = useStore(controller.store, (state) => state.selected);
  const [dockedOutline, setDockedOutline] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [outlinePopupOpen, setOutlinePopupOpen] = useState(false);
  const [notebookPane, setNotebookPane] = useState<HTMLDivElement | null>(null);
  const outlineButton = useRef<HTMLButtonElement>(null);
  const outlineDestination = useRef<
    { readonly cellId: string; readonly heading: number } | "trigger" | null
  >(null);
  const observeNotebookWidth = useStableCallback((node: HTMLDivElement | null) => {
    setNotebookPane(node);
    if (node === null) return;
    const measure = () => {
      const docked = node.clientWidth >= 640;
      setDockedOutline(docked);
      if (docked) setOutlinePopupOpen(false);
    };
    measure();
    return observeResize(node, measure);
  });
  const visibleOrder = order.filter((id) => !sections.hidden.has(id));
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
  const restartedTo = useRef<Pick<ComputeSessionRecord, "sessionId" | "generation"> | null>(null);
  const restartAnchor = useRef<HTMLDivElement>(null);
  const [restartTarget, setRestartTarget] = useState<ComputeSessionRecord | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [{ setRoot: setScroller, watch: watchNear }] = useState(createNearWatcher);
  const [scroller, setScrollerNode] = useState<HTMLDivElement | null>(null);
  const attachScroller = useStableCallback((node: HTMLDivElement | null) => {
    setScroller(node);
    setScrollerNode(node);
  });
  const [focusedCell, setFocusedCell] = useState<{
    readonly cellId: string;
    readonly heading?: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set());
  const [panelView, setPanelView] = useState<ComputePanelView | null>(null);
  const model = useComputePanelSessions({
    environmentId: props.environmentId,
    cwd: props.cwd,
    contextId,
    refreshAfterQueueDrains: true,
  });
  const liveSession = model.liveSession;
  const runtimeInspection = model.runtimes.data ?? null;
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

  const runCells = useStableCallback((cellIds: ReadonlyArray<string>, runAll: boolean = false) => {
    if (runningFresh) return;
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
      .then(() => actions.current?.runCells(runnable, runAll))
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
  const runAllCells = useStableCallback(() => runCells(codeCellIds(), true));
  const replayThroughCell = useStableCallback((cellId: string) => {
    const index = controller.store.getState().order.indexOf(cellId);
    if (index >= 0) runCells(codeCellIds(0, index + 1));
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the cell a command selected; a cell's editor places its own caret.
  useLayoutEffect(() => {
    if (focusedCell === null) return;
    const section = list.current?.querySelector<HTMLElement>(
      `[data-notebook-cell="${CSS.escape(focusedCell.cellId)}"]`,
    );
    const heading =
      focusedCell.heading === undefined
        ? undefined
        : section?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")[focusedCell.heading];
    (heading ?? section)?.scrollIntoView({ block: heading === undefined ? "nearest" : "start" });
    if (controller.store.getState().editing !== focusedCell.cellId) {
      if (heading !== undefined) heading.tabIndex = -1;
      (heading ?? section)?.focus({ preventScroll: true });
    }
  }, [controller, focusedCell]);

  // The Run control must see the restarted session before it can submit into it.
  const runAfterRestart = useStableCallback(() => {
    const target = restartedTo.current;
    if (
      target === null ||
      liveSession?.sessionId !== target.sessionId ||
      liveSession.generation !== target.generation
    )
      return;
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
  const restartAndRunAll = async (target: ComputeSessionRecord) => {
    if (
      liveSession?.sessionId !== target.sessionId ||
      liveSession.generation !== target.generation
    ) {
      toastManager.add({ type: "info", title: gt("The session changed") });
      return;
    }
    setRestarting(true);
    const restarted = await restartSession({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: target.sessionId,
        expectedGeneration: target.generation,
      },
    }).finally(() => setRestarting(false));
    if (restarted._tag !== "Success") {
      toastManager.add({ type: "error", title: gt("The session could not be restarted") });
      return;
    }
    if (
      !useComputeContextStore.getState().bindSession({
        contextId,
        sessionId: restarted.value.sessionId,
        generation: restarted.value.generation,
      })
    )
      return;
    restartedTo.current = restarted.value;
    runAfterRestart();
  };

  const focusCell = (cellId: string | undefined, target: NotebookFocusTarget, heading?: number) => {
    if (cellId === undefined) return;
    if (runningFresh) target = "cell";
    const state = controller.store.getState();
    for (const parent of state.sections.hidden.get(cellId) ?? []) {
      controller.setFold(parent, "section", false);
    }
    if (
      (target !== "cell" || heading !== undefined) &&
      state.cells[cellId]?.folded?.includes("source")
    ) {
      controller.setFold(cellId, "source", false);
    }
    controller.select(cellId);
    if (target === "cell") controller.stopEditing();
    else controller.edit(cellId, target);
    setFocusedCell({ cellId, ...(heading === undefined ? {} : { heading }) });
  };
  const jumpToCell = useStableCallback((cellId: string) => focusCell(cellId, "cell"));
  const positionOf = (cellId: string) => controller.store.getState().order.indexOf(cellId);
  const placeOfCell = useStableCallback((source: HTMLElement): ComputePlace | null => {
    const cellId = source.closest<HTMLElement>("[data-notebook-cell]")?.dataset.notebookCell;
    return cellId === undefined
      ? null
      : { _tag: "cell", path: props.relativePath, cellId, number: positionOf(cellId) + 1 };
  });
  const cellAt = (index: number) => controller.store.getState().order[index];
  const addCell = (position: number, cellType: NotebookCellType) => {
    if (!runningFresh) focusCell(controller.insert(position, cellType), "start");
  };
  const undoDelete = () => {
    if (runningFresh) return;
    const entry = deleted.current.pop();
    if (entry === undefined) return;
    controller.restore(entry.cellId, entry.after);
    focusCell(entry.cellId, "cell");
  };
  const deleteCell = (cellId: string) => {
    if (runningFresh) return;
    const index = positionOf(cellId);
    const next = cellAt(index + 1) ?? cellAt(index - 1);
    const removed = controller.remove(cellId);
    if (removed === null) return;
    deleted.current.push({ cellId, after: removed.after });
    focusCell(next, "cell");
    toastManager.add({
      type: "info",
      title: gt("Cell deleted"),
      actionProps: { children: gt("Undo"), onClick: undoDelete },
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
    else focusCell(cellAt(index + 1), "cell");
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
        if (!runningFresh) controller.convert(cellId, "markdown");
        return;
      case "to-code":
        if (!runningFresh) controller.convert(cellId, "code");
        return;
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
    const cellId = event.target.matches("h1, h2, h3, h4, h5, h6")
      ? event.target.closest<HTMLElement>("[data-notebook-cell]")?.dataset.notebookCell
      : event.target.dataset.notebookCell;
    if (cellId === undefined) return;
    const command = notebookCommand(event, lastKey.current, event.timeStamp);
    lastKey.current = { key: event.key, at: event.timeStamp };
    if (command === null) return;
    event.preventDefault();
    runCommand(command, cellId);
  };

  const askAbout = useAskAboutCompute({ threadRef: props.threadRef, cwd: props.cwd });
  const askAboutCell = useStableCallback((cellId: string, text: string) => {
    const source = list.current?.querySelector<HTMLElement>(
      `[data-notebook-cell="${CSS.escape(cellId)}"] [data-notebook-cell-box]`,
    );
    const place = source == null ? null : placeOfCell(source);
    if (source == null || place === null) return;
    askAbout?.({ source, place, text });
  });
  const ask = useStableCallback((cellId: string) =>
    askAboutCell(cellId, controller.store.getState().cells[cellId]?.source ?? ""),
  );
  const revealing = usePendingComputeQuote(props.threadRef, (citation) =>
    citation.place._tag === "cell" &&
    citation.place.path === props.relativePath &&
    citation.cwd === props.cwd
      ? citation
      : null,
  );
  const revealCell = useStableCallback(() => {
    if (revealing === null || revealing.place._tag !== "cell" || status === "loading") return;
    finishComputeQuoteReveal(revealing);
    if (status === "failed") return;
    const { cellId } = revealing.place;
    if (!order.includes(cellId)) {
      toastManager.add({ type: "warning", title: gt("That cell is no longer in this notebook") });
      return;
    }
    focusCell(cellId, "cell");
    const source = list.current?.querySelector<HTMLElement>(
      `[data-notebook-cell="${CSS.escape(cellId)}"]`,
    );
    if (source != null && scroller !== null) {
      showComputeQuote({ source, scroller, citation: revealing });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a quote's chip selects its cell once the notebook has loaded
  useEffect(() => revealCell());

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
    ask: askAbout === null ? null : ask,
    delete: useStableCallback(deleteCell),
    edit: useStableCallback(focusCell),
    observeNear: watchNear,
  };

  const overrides = Object.fromEntries(
    parameters.flatMap((parameter) => {
      const input = Object.hasOwn(pendingParameters, parameter.name)
        ? pendingParameters[parameter.name]
        : undefined;
      return input === undefined
        ? []
        : [[parameter.name, validNotebookParameter(parameter, input)]];
    }),
  );
  const validOverrides = Object.fromEntries(
    Object.entries(overrides).flatMap(([name, value]) => (value === null ? [] : [[name, value]])),
  );
  const invalidOverrides = Object.values(overrides).includes(null);
  const runSettings = (settings: Pick<NotebookFreshRunInput, "parameters" | "sweep">) => {
    if (inputs === undefined) return;
    controller.stopEditing();
    setPreparingFresh(true);
    void (async () => {
      await controller.flush();
      if (controller.saveIsFailing()) return;
      await fresh.start({ ...settings, inputs });
    })().finally(() => setPreparingFresh(false));
  };
  const refreshFreshRun = useStableCallback(() => {
    controller.reload();
    model.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a finished server job may have saved fresh notebook outputs and Results.
  useEffect(() => {
    if (settledFreshRun !== null) refreshFreshRun();
  }, [settledFreshRun, refreshFreshRun]);

  if (readerOpen) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center border-b border-border/60 px-2 py-1">
          <Button size="sm" variant="ghost" focus="edge" onClick={() => setReaderOpen(false)}>
            <T>Back to notebook</T>
          </Button>
        </div>
        {runStatus}
        <NotebookReader
          environmentId={props.environmentId}
          cwd={props.cwd}
          relativePath={props.relativePath}
          settledRunId={settledFreshRun}
          running={runningFresh}
          {...(canRerun && inputs !== undefined
            ? {
                onRunForValue: (values: Readonly<Record<string, string>>) =>
                  runSettings({ sweep: [values] }),
              }
            : {})}
        />
      </div>
    );
  }

  if (status === "failed") {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        <T>This notebook could not be read.</T>
      </p>
    );
  }

  const selectedIndex = selected === null ? -1 : positionOf(selected);
  let currentHeading = sections.headings.findLast(
    (heading) =>
      order.indexOf(heading.cellId) <= selectedIndex && !sections.hidden.has(heading.cellId),
  );
  if (focusedCell?.cellId === selected && focusedCell?.heading !== undefined) {
    currentHeading = sections.headings.filter((heading) => heading.cellId === selected)[
      focusedCell.heading
    ];
  }
  const outline = (
    <NotebookOutline
      headings={sections.headings}
      current={currentHeading}
      docked={dockedOutline}
      onSelect={(heading, index) => {
        const first = sections.headings.findIndex((entry) => entry.cellId === heading.cellId);
        if (dockedOutline) {
          focusCell(heading.cellId, "cell", index - first);
        } else {
          outlineDestination.current = { cellId: heading.cellId, heading: index - first };
          setOutlinePopupOpen(false);
        }
      }}
    />
  );
  const outOfDate = changed === "" ? [] : changed.split("\n");
  const busy =
    submitting.size > 0 ||
    [...cellRuns.values()].some(
      (execution) =>
        execution.result === null ||
        !TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status),
    );
  const hasParameterChanges = parameters.some((parameter) =>
    notebookParameterChanged(
      parameter,
      Object.hasOwn(draftParameters ?? {}, parameter.name)
        ? draftParameters?.[parameter.name]
        : undefined,
      Object.hasOwn(savedParameters ?? {}, parameter.name)
        ? savedParameters?.[parameter.name]
        : savedSetup?.parameters.find(({ name }) => name === parameter.name)?.value,
    ),
  );
  const runAllDisabled = busy || restarting || runningFresh;
  const freshRunDisabled = runAllDisabled || !canRerun || inputs === undefined || invalidOverrides;
  const batchFailure =
    busy || runningFresh
      ? null
      : notebookBatchFailureSummary({
          executions: model.executions,
          cellRuns,
          path: props.relativePath,
          order,
          cells: controller.store.getState().cells,
          lastNotebookBatch: liveSession?.lastNotebookBatch,
          liveSessionGeneration: liveSession?.generation ?? null,
        });
  // Promoted to the top of the Run menu when the selected cell reads setup that has not run.
  const selectedNeedsSetup =
    selected !== null &&
    notebookNeedsSetup({
      order,
      cells: controller.store.getState().cells,
      targetCellId: selected,
      cellRuns,
      liveSessionGeneration: liveSession?.generation ?? null,
    });
  const runThroughItem = (
    <MenuItem
      disabled={selectedIndex < 0}
      onClick={() => selected !== null && replayThroughCell(selected)}
    >
      <T>Run from top through this cell</T>
    </MenuItem>
  );
  const place = {
    environmentId: props.environmentId,
    cwd: props.cwd,
    threadRef: props.threadRef,
    path: props.relativePath,
    liveSessionGeneration: liveSession?.generation ?? null,
    runtimeInspection,
    dependencyRecovery: { contextId, onSettled: model.refresh },
    cellRuns,
    onJumpToCell: jumpToCell,
    askAboutCell: askAbout === null ? undefined : askAboutCell,
    replay:
      runAllDisabled || firstCodeCell === undefined
        ? undefined
        : { firstCodeCell, runThrough: replayThroughCell },
  };

  return (
    <div ref={observeNotebookWidth} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-2 py-1">
        <div ref={restartAnchor} className="min-w-22 flex-1">
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
            onExecutionSubmitted={() => undefined}
            onCellsSubmitted={controller.expectRuns}
            notebookRun={{
              label: hasParameterChanges ? gt("Run with changes") : gt("Run all"),
              requiresLiveRuntime: !hasParameterChanges,
              disabled: hasParameterChanges ? freshRunDisabled : runAllDisabled,
              run: hasParameterChanges ? () => setFreshConfirmation(validOverrides) : runAllCells,
              runAll: runAllCells,
              runAllDisabled,
              menu: (
                <>
                  {selectedNeedsSetup ? runThroughItem : null}
                  <MenuItem disabled={outOfDate.length === 0} onClick={() => runCells(outOfDate)}>
                    <T>Run out-of-date cells</T>
                  </MenuItem>
                  <MenuItem
                    disabled={selectedIndex <= 0}
                    onClick={() => runCells(codeCellIds(0, selectedIndex))}
                  >
                    <T>Run cells above</T>
                  </MenuItem>
                  {selectedNeedsSetup ? null : runThroughItem}
                  <MenuItem
                    disabled={selectedIndex < 0}
                    onClick={() => runCells(codeCellIds(selectedIndex))}
                  >
                    <T>Run from this cell</T>
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    disabled={freshRunDisabled}
                    onClick={() => setFreshConfirmation(validOverrides)}
                  >
                    <T>Run fresh and publish</T>
                  </MenuItem>
                  <MenuItem
                    disabled={!canRerun || runningFresh}
                    onClick={() => setInputFilesOpen(true)}
                  >
                    <T>Input files…</T>
                  </MenuItem>
                  {parameters.flatMap((parameter) =>
                    // A value set by code cannot be overridden, so it cannot be swept.
                    parameter.value === undefined
                      ? []
                      : [
                          <MenuItem
                            key={parameter.name}
                            disabled={freshRunDisabled}
                            onClick={() => setSweepParameter(parameter)}
                          >
                            {gt("Run for each {parameter} value", { parameter: parameter.name })}
                          </MenuItem>,
                        ],
                  )}
                  <MenuItem
                    disabled={runAllDisabled}
                    onClick={() => {
                      if (liveSession === null) runAllCells();
                      else setRestartTarget(liveSession);
                    }}
                  >
                    <T>Restart and run all</T>
                  </MenuItem>
                  <MenuItem disabled={busy || runningFresh} onClick={controller.clearOutputs}>
                    <T>Clear all outputs</T>
                  </MenuItem>
                </>
              ),
            }}
            leadingActions={
              <>
                {busy ? (
                  <ScientTooltip content={gt("Stop", { $context: "verb, stops running cells" })}>
                    <Button
                      size="icon-xs"
                      variant="outline"
                      focus="edge"
                      aria-label={gt("Stop", { $context: "verb, stops running cells" })}
                      onClick={stop}
                    >
                      <Square />
                    </Button>
                  </ScientTooltip>
                ) : null}
                <ScientTooltip content={gt("Reader view")}>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    focus="edge"
                    aria-label={gt("Reader view")}
                    onClick={() => setReaderOpen(true)}
                  >
                    <BookOpen />
                  </Button>
                </ScientTooltip>
                {dockedOutline ? (
                  <ScientTooltip content={gt("Notebook outline")}>
                    <Button
                      size="icon-xs"
                      variant={dockOpen ? "selected" : "ghost-muted"}
                      focus="edge"
                      aria-label={gt("Notebook outline")}
                      aria-expanded={dockOpen}
                      onClick={() => setDockOpen(!dockOpen)}
                    >
                      <ListTree />
                    </Button>
                  </ScientTooltip>
                ) : (
                  <Popover
                    open={outlinePopupOpen}
                    onOpenChange={(open, details) => {
                      if (!open && details.reason === "escape-key") {
                        outlineDestination.current = "trigger";
                      }
                      setOutlinePopupOpen(open);
                    }}
                    onOpenChangeComplete={(open) => {
                      if (open) return;
                      const target = outlineDestination.current;
                      outlineDestination.current = null;
                      if (target === "trigger") outlineButton.current?.focus();
                      else if (target !== null) focusCell(target.cellId, "cell", target.heading);
                    }}
                  >
                    <ScientTooltip content={gt("Notebook outline")}>
                      <PopoverTrigger
                        ref={outlineButton}
                        aria-label={gt("Notebook outline")}
                        render={
                          <Button
                            size="icon-xs"
                            variant={outlinePopupOpen ? "selected" : "ghost-muted"}
                            focus="edge"
                          />
                        }
                      >
                        <ListTree />
                      </PopoverTrigger>
                    </ScientTooltip>
                    <PopoverPopup
                      aria-label={gt("Notebook outline")}
                      align="end"
                      width="md"
                      padding="tight"
                      className="max-w-(--available-width)"
                      collisionBoundary={notebookPane ?? undefined}
                      finalFocus={false}
                    >
                      {outline}
                    </PopoverPopup>
                  </Popover>
                )}
                <ScientTooltip content={gt("Variables")}>
                  <Button
                    size="icon-xs"
                    variant={panelView === null ? "ghost-muted" : "selected"}
                    focus="edge"
                    aria-label={gt("Variables")}
                    aria-pressed={panelView !== null}
                    onClick={() => setPanelView(panelView === null ? "variables" : null)}
                  >
                    <Variable />
                  </Button>
                </ScientTooltip>
              </>
            }
          />
          <ContextualConfirmation
            open={freshConfirmation !== null}
            onOpenChange={(open) => {
              if (!open) setFreshConfirmation(null);
            }}
            anchor={restartAnchor}
            title={gt("Run fresh and replace saved outputs?")}
            description={
              <>
                <NotebookFreshRunWarning />
                {inputs !== undefined && inputs.length > 0 ? (
                  <span className="mt-1 block wrap-anywhere">
                    {gt("Records {files}", { files: inputFileLabels(inputs).join(", ") })}
                  </span>
                ) : null}
              </>
            }
            confirmLabel={gt("Run fresh")}
            destructive
            onConfirm={() => {
              if (freshConfirmation !== null) runSettings({ parameters: freshConfirmation });
            }}
          />
          <ContextualConfirmation
            open={restartTarget !== null}
            onOpenChange={(open) => {
              if (!open) setRestartTarget(null);
            }}
            anchor={restartAnchor}
            title={gt("Restart and run all?")}
            description={gt("Current variables will be lost. Run history is kept.")}
            confirmLabel={gt("Restart and run all")}
            destructive
            onConfirm={() => {
              if (restartTarget !== null) void restartAndRunAll(restartTarget);
            }}
          />
        </div>
      </div>
      {batchFailure === null ? null : (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-destructive/5 px-3 py-1.5 text-xs"
        >
          <p className="flex min-w-0 items-center gap-1.5 text-destructive">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate font-medium">
              {batchFailure.skippedCount > 0
                ? gt(
                    "Cell {cell} failed · {count, plural, one {# later cell skipped} other {# later cells skipped}}",
                    { cell: batchFailure.cellNumber, count: batchFailure.skippedCount },
                  )
                : gt("Cell {cell} failed", { cell: batchFailure.cellNumber })}
            </span>
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            focus="edge"
            onClick={() => jumpToCell(batchFailure.cellId)}
          >
            {gt("Jump to cell {cell}", { cell: batchFailure.cellNumber })}
          </Button>
        </div>
      )}
      {parameters.length === 0 ? null : (
        <div className="max-h-40 shrink-0 overflow-auto border-b border-border/60">
          <NotebookParameterControls
            parameters={parameters}
            pending={
              runningFresh ? (fresh.job?.parameters ?? pendingParameters) : pendingParameters
            }
            saved={savedParameters}
            mismatch={parameterEvidenceMismatch}
            disabled={runningFresh}
            onChange={(name, value) => {
              const { drafts, update } = useNotebookRunDrafts.getState();
              update(draftKey, {
                parameters: {
                  ...(drafts[draftKey]?.parameters ?? pendingParameters),
                  [name]: value,
                },
              });
            }}
          />
        </div>
      )}
      <Dialog open={inputFilesOpen} onOpenChange={setInputFilesOpen}>
        <DialogPopup layer="above-popovers" bottomStickOnMobile={false} gap="none">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              <T>Input files</T>
            </DialogTitle>
            <DialogDescription className="wrap-anywhere">
              <bdi>{props.relativePath}</bdi>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="min-w-0">
            {inputs !== undefined ? (
              <ResultDeclaredInputs
                {...setupTarget}
                inputs={inputs}
                suggestedInputs={savedSetup?.suggestedInputs ?? []}
                disabled={!canRerun || runningFresh}
                onChange={(next) =>
                  useNotebookRunDrafts.getState().update(draftKey, { inputs: next })
                }
              />
            ) : setup !== null && "message" in setup ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <p role="alert">{setup.message}</p>
                <Button size="xs" variant="outline" onClick={retrySetup}>
                  <T>Try again</T>
                </Button>
              </div>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                <T>Loading run setup…</T>
              </p>
            )}
          </DialogPanel>
          <DialogFooter className="shrink-0">
            <Button type="button" onClick={() => setInputFilesOpen(false)}>
              <T>Done</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {runStatus}
      <div className="flex min-h-0 flex-1">
        {dockedOutline && dockOpen ? (
          <nav
            aria-label={gt("Notebook outline")}
            className="w-56 shrink-0 overflow-auto border-e border-border/60 p-2"
          >
            {outline}
          </nav>
        ) : null}
        <div
          ref={attachScroller}
          data-assistant-citation-viewport=""
          className="scrollbar-gutter-both min-h-0 min-w-0 flex-1 overflow-auto"
        >
          <ComputeQuoteActions
            viewport={scroller}
            threadRef={props.threadRef}
            cwd={props.cwd}
            placeOf={placeOfCell}
          />
          <div ref={list} className="mx-auto max-w-4xl pb-4" onKeyDown={onCommandKey}>
            {visibleOrder.map((cellId) => (
              <NotebookCell
                key={cellId}
                controller={controller}
                place={place}
                cellId={cellId}
                language={language.languageId}
                handlers={handlers}
                editsDisabled={runningFresh}
              />
            ))}
            {status === "ready" && !runningFresh ? (
              <div className="flex gap-1 pt-3 pl-9">
                <Button variant="ghost" size="sm" onClick={() => addCell(order.length, "code")}>
                  <Plus className="size-3.5" /> {gt("Code", { $context: "inserts a code cell" })}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => addCell(order.length, "markdown")}>
                  <Plus className="size-3.5" /> {gt("Text", { $context: "inserts a text cell" })}
                </Button>
              </div>
            ) : null}
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
      {sweepParameter === null ? null : (
        <NotebookSweepDialog
          parameter={sweepParameter}
          onClose={() => setSweepParameter(null)}
          onRun={(values) => {
            setSweepParameter(null);
            runSettings({
              sweep: values.map((value) => ({ ...validOverrides, [sweepParameter.name]: value })),
            });
          }}
        />
      )}
    </div>
  );
}
