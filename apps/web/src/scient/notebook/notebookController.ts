import type {
  ComputeExecutionRecord,
  NotebookCellRun,
  NotebookCellType,
  NotebookCellView,
  NotebookEdit,
  NotebookEditResult,
  NotebookOutputJson,
  NotebookOutputView,
  NotebookRecordRunInput,
  NotebookRecordRunResult,
  NotebookView,
} from "@t3tools/contracts";
import { createStore } from "zustand/vanilla";

import {
  notebookCodeHash,
  staleNotebookCells,
  type NotebookStaleness,
} from "@t3tools/shared/notebookStaleness";

export type NotebookCellActivity = "queued" | "running" | null;
/** An offset in the source, an end of it, or a point on screen (for a rendered Text cell). */
export type NotebookCaret = number | "start" | "end" | { readonly x: number; readonly y: number };

/** The server calls a controller needs; `null` from any of them means the call failed. */
export interface NotebookTransport {
  readonly read: (knownRevision: string | undefined) => Promise<NotebookView | null | "failed">;
  readonly readOutput: (cellId: string, index: number) => Promise<NotebookOutputJson | null>;
  readonly edit: (edits: ReadonlyArray<NotebookEdit>) => Promise<NotebookEditResult | null>;
  readonly recordRun: (
    input: Omit<NotebookRecordRunInput, "cwd" | "path">,
  ) => Promise<NotebookRecordRunResult | null>;
  readonly onError: (title: string) => void;
}

export interface NotebookLiveRun {
  readonly sessionId: string;
  readonly executionId: string;
}

export interface NotebookState {
  readonly status: "loading" | "ready" | "failed";
  readonly language: string;
  readonly order: ReadonlyArray<string>;
  readonly cells: Readonly<Record<string, NotebookCellView>>;
  readonly stale: ReadonlyMap<string, NotebookStaleness>;
  readonly activity: Readonly<Record<string, NotebookCellActivity>>;
  readonly liveRuns: Readonly<Record<string, NotebookLiveRun>>;
  readonly selected: string | null;
  /** The one cell with a live editor; every other cell shows static code. */
  readonly editing: string | null;
  /** Where that editor puts its caret; `caretRequest` changes for each new request. */
  readonly caret: NotebookCaret;
  readonly caretRequest: number;
}

/** Edits to one cell's text are sent together once typing pauses. */
const SOURCE_SEND_DELAY_MS = 150;
const STALE_DELAY_MS = 200;
const SAVE_RETRY_MS = 3000;

let generatedIds = 0;
function newCellId(): string {
  generatedIds += 1;
  return `${Date.now().toString(36)}${generatedIds.toString(36)}`.slice(-12);
}

function runDuration(execution: ComputeExecutionRecord): number | null {
  const startedAt = execution.result?.startedAt;
  const finishedAt = execution.result?.finishedAt;
  if (!startedAt || !finishedAt) return null;
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function notebookCellRun(execution: ComputeExecutionRecord): NotebookCellRun {
  return {
    execution: execution.request.executionId,
    code: notebookCodeHash(execution.request.code),
    at: execution.result?.finishedAt ?? execution.request.submittedAt,
    ms: runDuration(execution),
  };
}

function emptyCell(id: string, cellType: NotebookCellType, source: string): NotebookCellView {
  return {
    id,
    cellType,
    source,
    executionCount: null,
    run: null,
    pendingExecution: null,
    outputs: [],
  };
}

/**
 * One open notebook in the page. It holds the cells outside React, so typing in one cell
 * re-renders that cell alone, and it sends every change to the server, which owns the file.
 */
export function createNotebookController(transport: NotebookTransport) {
  const store = createStore<NotebookState>(() => ({
    status: "loading",
    language: "python",
    order: [],
    cells: {},
    stale: new Map(),
    activity: {},
    liveRuns: {},
    selected: null,
    editing: null,
    caret: "start",
    caretRequest: 0,
  }));
  let revision: string | undefined;
  let seenFileRevision: string | undefined;
  let queue: NotebookEdit[] = [];
  let sending: Promise<void> | null = null;
  let failing = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const removed = new Map<string, NotebookCellView>();
  const outputs = new Map<string, Promise<string | null>>();
  const recording = new Set<string>();

  const orderedCells = (state: NotebookState) =>
    state.order.flatMap((id) => {
      const cell = state.cells[id];
      return cell === undefined ? [] : [cell];
    });
  const refreshStale = () => {
    store.setState({ stale: staleNotebookCells(orderedCells(store.getState())) });
  };
  const scheduleStale = () => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(refreshStale, STALE_DELAY_MS);
  };

  const send = async () => {
    while (queue.length > 0) {
      const edits = queue;
      queue = [];
      const result = await transport.edit(edits);
      if (result === null) {
        // What was typed stays on screen and in the queue, and goes out when the server answers.
        queue = [...edits, ...queue];
        if (!failing) transport.onError("This notebook could not be saved. Trying again.");
        failing = true;
        retryTimer = setTimeout(() => void startSending(), SAVE_RETRY_MS);
        return;
      }
      failing = false;
      revision = result.revision;
    }
  };
  const startSending = (): Promise<void> => {
    sending ??= send().finally(() => {
      sending = null;
    });
    return sending;
  };
  const enqueue = (edit: NotebookEdit) => {
    queue.push(edit);
    void startSending();
  };
  /** Everything typed so far reaches the server. A run must never miss the last keystroke. */
  const saveIsFailing = () => failing;
  const flush = async () => {
    clearTimeout(sourceTimer);
    clearTimeout(retryTimer);
    await startSending();
    while (queue.length > 0 && !saveIsFailing()) await startSending();
  };

  const update = (cellId: string, change: (cell: NotebookCellView) => NotebookCellView) => {
    const state = store.getState();
    const cell = state.cells[cellId];
    if (cell !== undefined) store.setState({ cells: { ...state.cells, [cellId]: change(cell) } });
  };

  async function load() {
    if (queue.length > 0 || sending !== null) return;
    const view = await transport.read(revision);
    if (view === "failed") {
      store.setState((state) => (state.order.length === 0 ? { status: "failed" } : state));
      return;
    }
    if (view === null) return;
    if (queue.length > 0 || sending !== null) return;
    revision = view.revision;
    store.setState({
      status: "ready",
      language: view.language,
      order: view.cells.map((cell) => cell.id),
      cells: Object.fromEntries(view.cells.map((cell) => [cell.id, cell])),
    });
    refreshStale();
  }

  const insert = (position: number, cellType: NotebookCellType, source = ""): string => {
    const state = store.getState();
    const id = newCellId();
    const order = [...state.order];
    order.splice(position, 0, id);
    store.setState({ order, cells: { ...state.cells, [id]: emptyCell(id, cellType, source) } });
    enqueue({
      _tag: "insert",
      cellId: id,
      afterCellId: state.order[position - 1] ?? null,
      cellType,
      source,
    });
    return id;
  };

  return {
    store,
    /** Reads the notebook on open, and again whenever the file changes on disk. */
    fileChanged: (fileRevision: string) => {
      if (fileRevision === seenFileRevision) return;
      seenFileRevision = fileRevision;
      void load();
    },
    flush,
    insert,
    setSource: (cellId: string, source: string) => {
      update(cellId, (cell) => ({ ...cell, source }));
      const last = queue.at(-1);
      if (last?._tag === "set-source" && last.cellId === cellId) {
        queue[queue.length - 1] = { ...last, source };
      } else {
        queue.push({ _tag: "set-source", cellId, source });
      }
      clearTimeout(sourceTimer);
      sourceTimer = setTimeout(() => void startSending(), SOURCE_SEND_DELAY_MS);
      scheduleStale();
    },
    remove: (cellId: string): { readonly after: string | null } | null => {
      const state = store.getState();
      const at = state.order.indexOf(cellId);
      const cell = state.cells[cellId];
      if (at < 0 || cell === undefined) return null;
      removed.set(cellId, cell);
      const { [cellId]: _removed, ...cells } = state.cells;
      store.setState({ order: state.order.filter((id) => id !== cellId), cells });
      enqueue({ _tag: "delete", cellId });
      scheduleStale();
      return { after: state.order[at - 1] ?? null };
    },
    restore: (cellId: string, after: string | null) => {
      const cell = removed.get(cellId);
      if (cell === undefined) return;
      removed.delete(cellId);
      const state = store.getState();
      const order = [...state.order];
      order.splice(after === null ? 0 : order.indexOf(after) + 1, 0, cellId);
      store.setState({ order, cells: { ...state.cells, [cellId]: cell } });
      enqueue({ _tag: "restore", cellId, afterCellId: after });
      scheduleStale();
    },
    move: (cellId: string, offset: -1 | 1) => {
      const state = store.getState();
      const at = state.order.indexOf(cellId);
      const target = at + offset;
      if (at < 0 || target < 0 || target >= state.order.length) return;
      const order = [...state.order];
      order.splice(at, 1);
      order.splice(target, 0, cellId);
      store.setState({ order });
      enqueue({ _tag: "move", cellId, offset });
      scheduleStale();
    },
    convert: (cellId: string, cellType: NotebookCellType) => {
      update(cellId, (cell) => ({ ...emptyCell(cell.id, cellType, cell.source) }));
      enqueue({ _tag: "convert", cellId, cellType });
      scheduleStale();
    },
    clearOutputs: () => {
      const state = store.getState();
      store.setState({
        cells: Object.fromEntries(
          Object.entries(state.cells).map(([id, cell]) => [
            id,
            cell.cellType === "code" ? { ...cell, outputs: [], executionCount: null } : cell,
          ]),
        ),
      });
      enqueue({ _tag: "clear-outputs" });
    },
    /** A large stored output, once, the first time its cell comes on screen. */
    readOutput: (cellId: string, index: number, output: NotebookOutputView) => {
      if (output.json !== null) return Promise.resolve<string | null>(output.json);
      const run = store.getState().cells[cellId]?.run?.execution ?? "";
      const key = `${cellId}:${index}:${run}`;
      const existing = outputs.get(key);
      if (existing !== undefined) return existing;
      const loading = transport.readOutput(cellId, index).then((result) => result?.json ?? null);
      outputs.set(key, loading);
      return loading;
    },
    /** Each submitted cell durably expects its run, so its result survives a reload. */
    expectRuns: (runs: ReadonlyArray<{ readonly cellId: string; readonly execution: string }>) => {
      for (const { cellId, execution } of runs) {
        update(cellId, (cell) => ({ ...cell, pendingExecution: execution }));
        queue.push({ _tag: "expect-run", cellId, execution });
      }
      void startSending();
    },
    /** Follows the session's runs: what each cell is doing, and results it has not recorded. */
    observeRuns: (runs: ReadonlyMap<string, ComputeExecutionRecord>, settled: Set<string>) => {
      const state = store.getState();
      const activity: Record<string, NotebookCellActivity> = {};
      const liveRuns: Record<string, NotebookLiveRun> = {};
      const toRecord: Array<{ cellId: string; execution: ComputeExecutionRecord }> = [];
      for (const [cellId, execution] of runs) {
        const { executionId, sessionId } = execution.request;
        liveRuns[cellId] = { sessionId, executionId };
        const status = execution.result?.status;
        if (status === undefined || status === "queued" || status === "submitting") {
          activity[cellId] = "queued";
        } else if (!settled.has(status)) {
          activity[cellId] = "running";
        } else if (
          state.cells[cellId]?.cellType === "code" &&
          state.cells[cellId]?.pendingExecution === executionId &&
          execution.result?.startedAt != null &&
          !recording.has(executionId)
        ) {
          recording.add(executionId);
          toRecord.push({ cellId, execution });
        }
      }
      store.setState({ activity, liveRuns });
      toRecord.sort((left, right) =>
        left.execution.request.submittedAt.localeCompare(right.execution.request.submittedAt),
      );
      void (async () => {
        for (const { cellId, execution } of toRecord) {
          const { executionId, sessionId } = execution.request;
          const result = await transport.recordRun({
            cellId,
            sessionId,
            executionId,
            executionCount: execution.result?.executionCount ?? null,
            run: notebookCellRun(execution),
          });
          if (result === null) {
            recording.delete(executionId);
            transport.onError("This cell's output could not be saved");
            continue;
          }
          revision = result.revision;
          const cell = result.cell;
          if (cell !== null) {
            // Typing and a newer run may have moved on while this result was on its way.
            update(cellId, (current) => ({
              ...cell,
              source: current.source,
              pendingExecution:
                current.pendingExecution === executionId
                  ? cell.pendingExecution
                  : current.pendingExecution,
            }));
            scheduleStale();
          }
        }
      })();
    },
    select: (cellId: string | null) => {
      if (store.getState().selected !== cellId) store.setState({ selected: cellId });
    },
    edit: (cellId: string, caret: NotebookCaret) =>
      store.setState((state) => ({
        editing: cellId,
        caret,
        caretRequest: state.caretRequest + 1,
      })),
    stopEditing: () => store.setState({ editing: null }),
    dispose: () => {
      clearTimeout(staleTimer);
      void flush();
    },
  };
}

export type NotebookController = ReturnType<typeof createNotebookController>;
