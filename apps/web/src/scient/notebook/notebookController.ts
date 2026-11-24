import type {
  ComputeExecutionRecord,
  NotebookCellType,
  NotebookCellView,
  NotebookEdit,
  NotebookEditResult,
  NotebookFold,
  NotebookOutputJson,
  NotebookOutputView,
  NotebookRecordRunInput,
  NotebookRecordRunResult,
  NotebookView,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { createStore } from "zustand/vanilla";

import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";

import {
  notebookCellRun,
  notebookCodeHash,
  notebookHeadings,
  staleNotebookCells,
  type NotebookStaleness,
} from "@t3tools/shared/notebookStaleness";

export type NotebookCellActivity = "queued" | "running" | null;
/** An offset in the source, an end of it, or a point on screen (for a rendered Text cell). */
export type NotebookCaret = number | "start" | "end" | { readonly x: number; readonly y: number };

/** The server calls a controller needs; `null` from any of them means the call failed. */
export interface NotebookTransport {
  readonly read: (knownRevision: string | undefined) => Promise<NotebookView | null | "failed">;
  readonly readOutput: (
    cellId: string,
    index: number,
    token: string | undefined,
  ) => Promise<NotebookOutputJson | null>;
  readonly edit: (input: {
    readonly edits: ReadonlyArray<NotebookEdit>;
    readonly requestId?: string;
    readonly durable?: boolean;
  }) => Promise<NotebookEditResult | null>;
  readonly recordRun: (
    input: Omit<NotebookRecordRunInput, "cwd" | "path">,
  ) => Promise<NotebookRecordRunResult | null>;
  readonly onError: (title: string) => void;
  readonly onNotice: (title: string) => void;
}

export interface NotebookLiveRun {
  readonly sessionId: string;
  readonly executionId: string;
  readonly generation: number;
  readonly writtenFiles?: ReadonlyArray<string> | undefined;
}

export interface NotebookState {
  readonly status: "loading" | "ready" | "failed";
  readonly language: string;
  readonly order: ReadonlyArray<string>;
  readonly cells: Readonly<Record<string, NotebookCellView>>;
  readonly sections: ReturnType<typeof notebookSections>;
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
/** Once typing has paused this long, the editor asks whether the notebook reached the disk. */
const SETTLE_DELAY_MS = 1500;

function newCellId(): string {
  return randomUUID();
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

function notebookSections(state: Pick<NotebookState, "order" | "cells">) {
  const headings: Array<ReturnType<typeof notebookHeadings>[number] & { cellId: string }> = [];
  const hidden = new Map<string, ReadonlyArray<string>>();
  const collapsed: Array<{ cellId: string; level: number }> = [];
  for (const cellId of state.order) {
    const cell = state.cells[cellId];
    const cellHeadings = cell?.cellType === "markdown" ? notebookHeadings(cell.source) : [];
    const first = cellHeadings[0];
    if (first !== undefined) {
      while ((collapsed.at(-1)?.level ?? 0) >= first.level) collapsed.pop();
      headings.push(...cellHeadings.map((heading) => ({ ...heading, cellId })));
    }
    if (collapsed.length > 0)
      hidden.set(
        cellId,
        collapsed.map((section) => section.cellId),
      );
    if (first !== undefined && cell?.folded?.includes("section")) {
      collapsed.push({ cellId, level: first.level });
    }
  }
  return { headings, hidden, headingCells: new Set(headings.map((heading) => heading.cellId)) };
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
    sections: { headings: [], hidden: new Map(), headingCells: new Set() },
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
  /** The batch on its way. It goes again, unchanged and under its ID, until it is answered. */
  let inflight: {
    readonly requestId: string;
    readonly edits: ReadonlyArray<NotebookEdit>;
    readonly sources: Map<string, string>;
  } | null = null;
  let sending: Promise<void> | null = null;
  let failing = false;
  let refusals = 0;
  /** Showing another writer's text and keeping this person's in a copy; no run meanwhile. */
  let recovering: Promise<void> | null = null;
  /** Edits the server has that it has not yet said are on disk. */
  let unsettled = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The server's save problem last shown, so one problem is reported once. */
  let shownSaveProblem: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const removed = new Map<string, NotebookCellView>();
  const outputs = new Map<string, Promise<string | null>>();
  const recording = new Set<string>();
  /** What the server last held for each cell, which is what an edit here was made from. */
  let serverSources = new Map<string, string>();
  /** Cells someone else changed while this person typed. Their text stays until it is kept. */
  const refused = new Set<string>();
  /** The latest text typed into a refused cell, which recovery keeps in a copy. */
  const drafts = new Map<string, NotebookCellView>();
  let reloadWanted = false;

  const orderedCells = (state: NotebookState) =>
    state.order.flatMap((id) => {
      const cell = state.cells[id];
      return cell === undefined ? [] : [cell];
    });
  const refreshSections = () => {
    store.setState({ sections: notebookSections(store.getState()) });
  };
  store.subscribe((state, previous) => {
    if (state.order !== previous.order) refreshSections();
  });
  const refreshStale = () => {
    store.setState({ stale: staleNotebookCells(orderedCells(store.getState())) });
  };
  const scheduleStale = () => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(refreshStale, STALE_DELAY_MS);
  };

  const showSaveProblem = (problem: string | undefined) => {
    if (problem !== undefined && problem !== shownSaveProblem) {
      transport.onError(m(msg("This notebook could not be saved. Trying again.")));
    }
    shownSaveProblem = problem;
  };
  /** Asks the server to save now, and shows whether that worked. */
  const settle = async () => {
    clearTimeout(settleTimer);
    if (!unsettled || sending !== null || inflight !== null || queue.length > 0) return;
    unsettled = false;
    const result = await transport.edit({ edits: [], durable: true });
    if (result !== null) showSaveProblem(result.saveProblem);
    // Asked again until the server answers that the notebook is on disk.
    if (result === null || result.saveProblem !== undefined) {
      unsettled = true;
      settleTimer = setTimeout(() => void settle(), SAVE_RETRY_MS);
    }
  };
  const send = async () => {
    clearTimeout(settleTimer);
    while (inflight !== null || queue.length > 0) {
      if (inflight === null) {
        const edits = queue.filter(
          (edit) => edit._tag !== "set-source" || !refused.has(edit.cellId),
        );
        queue = [];
        const sources = new Map(serverSources);
        const sent = edits.map((edit) => {
          if (edit._tag === "insert") sources.set(edit.cellId, notebookCodeHash(edit.source));
          if (edit._tag !== "set-source") return edit;
          const base = sources.get(edit.cellId);
          sources.set(edit.cellId, notebookCodeHash(edit.source));
          return base === undefined ? edit : { ...edit, base };
        });
        inflight = { requestId: randomUUID(), edits: sent, sources };
      }
      const result = await transport.edit({
        edits: inflight.edits,
        requestId: inflight.requestId,
      });
      if (result === null) {
        // What was typed stays on screen, and the same batch goes again when the server answers.
        if (!failing) transport.onError(m(msg("This notebook could not be saved. Trying again.")));
        failing = true;
        retryTimer = setTimeout(() => void startSending(), SAVE_RETRY_MS);
        return;
      }
      failing = false;
      unsettled = true;
      showSaveProblem(result.saveProblem);
      revision = result.revision;
      serverSources = inflight.sources;
      inflight = null;
      if (result.refused.length > 0) refusals += 1;
      // What was typed when the server refused it is kept from now on, whatever arrives next.
      for (const cellId of result.refused) {
        const typed = store.getState().cells[cellId];
        if (typed !== undefined && !drafts.has(cellId)) drafts.set(cellId, typed);
      }
      if ((result.expired?.length ?? 0) > 0) {
        // An undo the server could no longer do: show the notebook as it is, and run nothing first.
        refusals += 1;
        revision = undefined;
        reloadWanted = true;
      }
      for (const cellId of result.refused) refused.add(cellId);
    }
    settleTimer = setTimeout(() => void settle(), SETTLE_DELAY_MS);
  };
  /** Shows what the other writer did, and keeps what this person typed in a new cell below it. */
  const keepRefusedText = async (): Promise<void> => {
    // The other writer's text is read once nothing of this person's is still on its way; what
    // this person typed is taken as it stands just before that read, typing since included.
    revision = undefined;
    let before = store.getState();
    while (!(await load())) {
      await new Promise((resolve) => setTimeout(resolve, SAVE_RETRY_MS));
      before = store.getState();
    }
    const kept = [...refused].flatMap((id) => {
      const cell = drafts.get(id) ?? before.cells[id];
      return cell === undefined ? [] : [{ cell, at: before.order.indexOf(id) }];
    });
    refused.clear();
    drafts.clear();
    let editing: string | null = null;
    for (const { cell, at } of kept) {
      const { order } = store.getState();
      const current = order.indexOf(cell.id);
      const id = insert(
        current < 0 ? Math.min(at, order.length) : current + 1,
        cell.cellType,
        cell.source,
      );
      if (before.editing === cell.id) editing = id;
    }
    transport.onNotice("Someone else changed this cell. What you typed is in a new cell below it.");
    if (editing !== null) controller.edit(editing, "end");
  };
  const startSending = (): Promise<void> => {
    sending ??= send().finally(() => {
      sending = null;
      if (refused.size > 0 && recovering === null)
        recovering = keepRefusedText().finally(() => {
          recovering = null;
        });
      else if (reloadWanted && queue.length === 0) {
        reloadWanted = false;
        // An edit's reply may already count the change this read is for.
        revision = undefined;
        void load();
      }
    });
    return sending;
  };
  const enqueue = (edit: NotebookEdit) => {
    queue.push(edit);
    void startSending();
  };
  /**
   * Sends everything typed so far, and says whether the server has it all.
   * A run must never miss the last keystroke.
   */
  const flush = async (): Promise<boolean> => {
    clearTimeout(sourceTimer);
    clearTimeout(retryTimer);
    const refusedBefore = refusals;
    await startSending();
    while ((queue.length > 0 || inflight !== null) && !failing) await startSending();
    if (recovering !== null) return false;
    return !failing && queue.length === 0 && inflight === null && refusals === refusedBefore;
  };

  const update = (cellId: string, change: (cell: NotebookCellView) => NotebookCellView) => {
    const state = store.getState();
    const cell = state.cells[cellId];
    if (cell !== undefined) store.setState({ cells: { ...state.cells, [cellId]: change(cell) } });
  };

  /** Reads the notebook, unless text is on its way; says whether the page now shows the file. */
  async function load(): Promise<boolean> {
    // Text still on its way must not be replaced, so the newer file is read once it has gone.
    const typing = () => queue.length > 0 || inflight !== null || sending !== null;
    if (typing()) {
      reloadWanted = true;
      return false;
    }
    const view = await transport.read(revision);
    if (view === "failed") {
      store.setState((state) => (state.order.length === 0 ? { status: "failed" } : state));
      return false;
    }
    if (view === null) return true;
    if (typing()) {
      reloadWanted = true;
      return false;
    }
    showSaveProblem(view.saveProblem);
    revision = view.revision;
    // Outputs loaded for the cells this replaces may belong to another version of them.
    outputs.clear();
    serverSources = new Map(view.cells.map((cell) => [cell.id, notebookCodeHash(cell.source)]));
    store.setState({
      status: "ready",
      language: view.language,
      order: view.cells.map((cell) => cell.id),
      cells: Object.fromEntries(view.cells.map((cell) => [cell.id, cell])),
    });
    refreshStale();
    return true;
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

  const controller = {
    store,
    /** Reads the notebook on open, and again whenever the file changes on disk. */
    fileChanged: (fileRevision: string) => {
      if (fileRevision === seenFileRevision) return;
      seenFileRevision = fileRevision;
      void load();
    },
    flush,
    reload: () => {
      void load();
    },
    insert,
    setParameterCell: (cellId: string, enabled: boolean) => {
      const state = store.getState();
      store.setState({
        cells: Object.fromEntries(
          state.order.flatMap((id) => {
            const cell = state.cells[id];
            if (cell === undefined) return [];
            if (id === cellId || (enabled && cell.parameterCell)) {
              return [[id, { ...cell, parameterCell: id === cellId && enabled }]];
            }
            return [[id, cell]];
          }),
        ),
      });
      enqueue({ _tag: "set-parameters", cellId, enabled });
      revision = undefined;
      reloadWanted = true;
    },
    setFold: (cellId: string, part: NotebookFold, folded: boolean) => {
      update(cellId, (cell) => ({
        ...cell,
        folded: [
          ...(cell.folded ?? []).filter((entry) => entry !== part),
          ...(folded ? [part] : []),
        ],
      }));
      if (part === "section") refreshSections();
      if (part === "source" && folded && store.getState().editing === cellId) {
        store.setState({ editing: null });
      }
      enqueue({ _tag: "set-fold", cellId, part, folded });
    },
    setSource: (cellId: string, source: string) => {
      update(cellId, (cell) => ({ ...cell, source }));
      const typed = store.getState().cells[cellId];
      if (refused.has(cellId) && typed !== undefined) drafts.set(cellId, typed);
      if (store.getState().cells[cellId]?.cellType === "markdown") refreshSections();
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
    /** Undo can no longer bring this cell back, so its copy here goes. */
    forgetRemoved: (cellId: string) => {
      removed.delete(cellId);
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
      refreshSections();
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
      const key = `${cellId}:${index}:${output.token ?? ""}`;
      const existing = outputs.get(key);
      if (existing !== undefined) return existing;
      const loading = transport.readOutput(cellId, index, output.token).then((result) => {
        // A failed read is tried again next time; outputs that changed are shown from a fresh read.
        if (result?.json == null) outputs.delete(key);
        if (result?.stale) {
          revision = undefined;
          void load();
        }
        return result?.json ?? null;
      });
      outputs.set(key, loading);
      return loading;
    },
    /** Each submitted cell durably expects its run, so its result survives a reload. */
    expectRuns: (runs: ReadonlyArray<{ readonly cellId: string; readonly execution: string }>) => {
      const cells = { ...store.getState().cells };
      for (const { cellId, execution } of runs) {
        const cell = cells[cellId];
        if (cell !== undefined) cells[cellId] = { ...cell, pendingExecution: execution };
        queue.push({ _tag: "expect-run", cellId, execution });
      }
      store.setState({ cells });
      void startSending();
    },
    /** Follows the session's runs: what each cell is doing, and results it has not recorded. */
    observeRuns: (runs: ReadonlyMap<string, ComputeExecutionRecord>, settled: Set<string>) => {
      const state = store.getState();
      const activity: Record<string, NotebookCellActivity> = {};
      const liveRuns: Record<string, NotebookLiveRun> = {};
      const toRecord: Array<{ cellId: string; execution: ComputeExecutionRecord }> = [];
      for (const [cellId, execution] of runs) {
        const { executionId, sessionId, generation } = execution.request;
        const writtenFiles = execution.result?.writtenFiles;
        const prior = state.liveRuns[cellId];
        liveRuns[cellId] =
          prior?.executionId === executionId &&
          prior.sessionId === sessionId &&
          prior.generation === generation &&
          prior.writtenFiles === writtenFiles
            ? prior
            : {
                sessionId,
                executionId,
                generation,
                ...(writtenFiles === undefined ? {} : { writtenFiles }),
              };
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
            transport.onError(m(msg("This cell's output could not be saved")));
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
      void flush().then(settle);
    },
  };
  return controller;
}

export type NotebookController = ReturnType<typeof createNotebookController>;
