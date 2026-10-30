// @effect-diagnostics nodeBuiltinImport:off -- a notebook is held as its bytes, keyed by size and mtime.
import * as NodeFSP from "node:fs/promises";

import {
  NotebookError,
  type ComputeNotebookOutputsInput,
  type ComputeNotebookOutputsResult,
  type NotebookCellView,
  type NotebookEdit,
  type NotebookEditInput,
  type NotebookOutputJson,
  type NotebookReadInput,
  type NotebookReadOutputInput,
  type NotebookRecordRunInput,
  type NotebookView,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  INLINE_OUTPUT_BYTES,
  indexNotebook,
  indexOutputs,
  notebookBytes,
  notebookText,
  type NotebookCellRecord,
  type NotebookIndex,
} from "./notebookIndex.ts";

/** Typing settles for this long before the file is written. */
const SAVE_DELAY = Duration.millis(400);
/** A notebook's first read stays small however many outputs it stores. */
const INLINE_BUDGET_BYTES = 4 * 1024 * 1024;
const MAX_OPEN_NOTEBOOKS = 4;

const fail = (message: string) => new NotebookError({ message });
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sourceLines = (source: string): string[] =>
  source.length === 0 ? [] : source.split(/(?<=\n)/);

function cellRun(fields: NotebookCellRecord["fields"]): NotebookCellView["run"] {
  const run = isRecord(fields.metadata) ? fields.metadata.scient : undefined;
  if (!isRecord(run)) return null;
  const { execution, code, at, ms } = run;
  if (typeof execution !== "string" || typeof code !== "string" || typeof at !== "string") {
    return null;
  }
  return { execution, code, at, ms: typeof ms === "number" ? ms : null };
}

function pendingExecution(fields: NotebookCellRecord["fields"]): string | null {
  const scient = isRecord(fields.metadata) ? fields.metadata.scient : undefined;
  return isRecord(scient) && typeof scient.pending === "string" ? scient.pending : null;
}

function cellView(cell: NotebookCellRecord, budget: { left: number }): NotebookCellView {
  const { fields } = cell;
  return {
    id: cell.id,
    cellType:
      fields.cell_type === "markdown" || fields.cell_type === "raw" ? fields.cell_type : "code",
    source: notebookText(fields.source),
    executionCount: typeof fields.execution_count === "number" ? fields.execution_count : null,
    run: cellRun(fields),
    pendingExecution: pendingExecution(fields),
    outputs: cell.outputIndex.map((output) => {
      const bytes = output.range.end - output.range.start;
      const inline = bytes <= INLINE_OUTPUT_BYTES && bytes <= budget.left;
      if (inline) budget.left -= bytes;
      return {
        outputType: output.outputType,
        mediaTypes: output.mediaTypes,
        bytes,
        json:
          inline && cell.outputs !== null
            ? cell.outputs.toString("utf8", output.range.start, output.range.end)
            : null,
      };
    }),
  };
}

function withOutputs(
  cell: NotebookCellRecord,
  outputs: ReadonlyArray<unknown>,
  fields: NotebookCellRecord["fields"],
): NotebookCellRecord {
  const bytes = Buffer.from(JSON.stringify(outputs, null, 1).replaceAll("\n", "\n   "));
  return { ...cell, fields, outputs: bytes, outputIndex: indexOutputs(bytes), saved: null };
}

function newCell(edit: Extract<NotebookEdit, { _tag: "insert" }>): NotebookCellRecord {
  const code = edit.cellType === "code";
  const fields = {
    cell_type: edit.cellType,
    id: edit.cellId,
    metadata: {},
    source: sourceLines(edit.source),
    ...(code ? { execution_count: null, outputs: null } : {}),
  };
  return {
    id: edit.cellId,
    fields,
    outputs: code ? Buffer.from("[]") : null,
    outputIndex: [],
    saved: null,
  };
}

function insertAfter(
  cells: ReadonlyArray<NotebookCellRecord>,
  afterCellId: string | null,
  cell: NotebookCellRecord,
): ReadonlyArray<NotebookCellRecord> {
  const index = afterCellId === null ? -1 : cells.findIndex((entry) => entry.id === afterCellId);
  return [...cells.slice(0, index + 1), cell, ...cells.slice(index + 1)];
}

function withoutRun(fields: NotebookCellRecord["fields"]): NotebookCellRecord["fields"] {
  if (!isRecord(fields.metadata) || fields.metadata.scient === undefined) return fields;
  const { scient: _run, ...metadata } = fields.metadata;
  return { ...fields, metadata };
}

/** Applies one edit. `removed` keeps deleted cells so an undo restores their outputs. */
function applyEdit(
  index: NotebookIndex,
  edit: NotebookEdit,
  removed: Map<string, NotebookCellRecord>,
): NotebookIndex {
  const update = (cellId: string, change: (cell: NotebookCellRecord) => NotebookCellRecord) => ({
    ...index,
    cells: index.cells.map((cell) => (cell.id === cellId ? change(cell) : cell)),
  });
  switch (edit._tag) {
    case "set-source":
      return update(edit.cellId, (cell) => ({
        ...cell,
        fields: { ...cell.fields, source: sourceLines(edit.source) },
        saved: null,
      }));
    case "insert":
      return { ...index, cells: insertAfter(index.cells, edit.afterCellId, newCell(edit)) };
    case "delete": {
      const cell = index.cells.find((entry) => entry.id === edit.cellId);
      if (cell !== undefined) removed.set(cell.id, cell);
      return { ...index, cells: index.cells.filter((entry) => entry.id !== edit.cellId) };
    }
    case "restore": {
      const cell = removed.get(edit.cellId);
      if (cell === undefined) return index;
      removed.delete(edit.cellId);
      return { ...index, cells: insertAfter(index.cells, edit.afterCellId, cell) };
    }
    case "move": {
      const at = index.cells.findIndex((cell) => cell.id === edit.cellId);
      const target = at + edit.offset;
      if (at < 0 || target < 0 || target >= index.cells.length) return index;
      const cells = [...index.cells];
      const [cell] = cells.splice(at, 1);
      if (cell !== undefined) cells.splice(target, 0, cell);
      return { ...index, cells };
    }
    case "convert":
      return update(edit.cellId, (cell) => {
        const { outputs: _outputs, execution_count: _count, ...rest } = withoutRun(cell.fields);
        const code = edit.cellType === "code";
        return {
          ...cell,
          fields: {
            ...rest,
            cell_type: edit.cellType,
            ...(code ? { execution_count: null, outputs: null } : {}),
          },
          outputs: code ? Buffer.from("[]") : null,
          outputIndex: [],
          saved: null,
        };
      });
    case "expect-run":
      return update(edit.cellId, (cell) => {
        const metadata = isRecord(cell.fields.metadata) ? cell.fields.metadata : {};
        const scient = isRecord(metadata.scient) ? metadata.scient : {};
        return {
          ...cell,
          fields: {
            ...cell.fields,
            metadata: { ...metadata, scient: { ...scient, pending: edit.execution } },
          },
          saved: null,
        };
      });
    case "clear-outputs":
      return {
        ...index,
        cells: index.cells.map((cell) =>
          cell.outputs === null || cell.outputIndex.length === 0
            ? cell
            : {
                ...cell,
                fields: { ...cell.fields, execution_count: null },
                outputs: Buffer.from("[]"),
                outputIndex: [],
                saved: null,
              },
        ),
      };
  }
}

interface OpenNotebook {
  readonly cwd: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly lock: Semaphore.Semaphore;
  readonly removed: Map<string, NotebookCellRecord>;
  readonly loadId: number;
  index: NotebookIndex;
  version: number;
  mtimeMs: number;
  size: number;
  /** Edits not yet on disk, replayed if the file changes underneath them. */
  pending: ReadonlyArray<NotebookEdit>;
  /** Written by run results; kept in memory until the next save. */
  outputsPending: boolean;
  timer: Fiber.Fiber<void> | null;
}

const revisionOf = (notebook: OpenNotebook) => `${notebook.loadId}.${notebook.version}`;

function notebookView(notebook: OpenNotebook): NotebookView {
  const budget = { left: INLINE_BUDGET_BYTES };
  return {
    revision: revisionOf(notebook),
    language: notebook.index.language,
    cells: notebook.index.cells.map((cell) => cellView(cell, budget)),
  };
}

/**
 * The server owns each open notebook. Editors, agents and run results all change it here, and
 * it reaches the file through the workspace's atomic, retained write.
 */
export const makeNotebookStore = Effect.gen(function* () {
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const notebooks = new Map<string, OpenNotebook>();
  let loads = 0;

  const fileState = (absolutePath: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.stat(absolutePath),
      catch: (cause) => fail(`This notebook could not be opened: ${describe(cause)}`),
    });
  const readIndex = (absolutePath: string) =>
    Effect.tryPromise({
      try: async () => indexNotebook(await NodeFSP.readFile(absolutePath)),
      catch: (cause) => fail(`This notebook could not be read: ${describe(cause)}`),
    });

  /** Brings an open notebook up to date with the file, keeping edits not yet written. */
  const refresh = Effect.fn("NotebookStore.refresh")(function* (notebook: OpenNotebook) {
    const state = yield* fileState(notebook.absolutePath);
    if (state.mtimeMs === notebook.mtimeMs && state.size === notebook.size) return;
    let index = yield* readIndex(notebook.absolutePath);
    for (const edit of notebook.pending) index = applyEdit(index, edit, notebook.removed);
    notebook.index = index;
    notebook.mtimeMs = state.mtimeMs;
    notebook.size = state.size;
    notebook.version += 1;
  });

  const open = Effect.fn("NotebookStore.open")(function* (address: {
    readonly cwd: string;
    readonly path: string;
  }) {
    const { absolutePath, relativePath } = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: address.cwd, relativePath: address.path })
      .pipe(Effect.mapError(() => fail("This notebook is outside the project.")));
    const existing = notebooks.get(absolutePath);
    if (existing !== undefined) {
      notebooks.delete(absolutePath);
      notebooks.set(absolutePath, existing);
      yield* existing.lock.withPermits(1)(refresh(existing));
      return existing;
    }
    const state = yield* fileState(absolutePath);
    const notebook: OpenNotebook = {
      cwd: address.cwd,
      relativePath,
      absolutePath,
      lock: yield* Semaphore.make(1),
      removed: new Map(),
      loadId: (loads += 1),
      index: yield* readIndex(absolutePath),
      version: 0,
      mtimeMs: state.mtimeMs,
      size: state.size,
      pending: [],
      outputsPending: false,
      timer: null,
    };
    notebooks.set(absolutePath, notebook);
    for (const [path, candidate] of notebooks) {
      if (notebooks.size <= MAX_OPEN_NOTEBOOKS) break;
      if (candidate.pending.length === 0 && !candidate.outputsPending) notebooks.delete(path);
    }
    return notebook;
  });

  const save = (notebook: OpenNotebook) =>
    notebook.lock.withPermits(1)(
      Effect.gen(function* () {
        if (notebook.pending.length === 0 && !notebook.outputsPending) return;
        yield* refresh(notebook);
        const bytes = notebookBytes(notebook.index);
        yield* workspaceFileSystem
          .writeBinaryFile({
            cwd: notebook.cwd,
            relativePath: notebook.relativePath,
            bytes,
          })
          .pipe(Effect.mapError((cause) => fail(`This notebook could not be saved: ${cause}`)));
        const state = yield* fileState(notebook.absolutePath);
        notebook.pending = [];
        notebook.outputsPending = false;
        notebook.mtimeMs = state.mtimeMs;
        notebook.size = state.size;
      }),
    );

  const scheduleSave = Effect.fn("NotebookStore.scheduleSave")(function* (notebook: OpenNotebook) {
    if (notebook.timer !== null) yield* Fiber.interrupt(notebook.timer);
    notebook.timer = yield* Effect.sleep(SAVE_DELAY).pipe(
      Effect.andThen(Effect.uninterruptible(save(notebook))),
      Effect.catch((error) => Effect.logError(error.message)),
      Effect.forkDetach,
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...notebooks.values()], (notebook) => Effect.ignore(save(notebook)), {
      discard: true,
    }),
  );

  const read = Effect.fn("NotebookStore.read")(function* (request: NotebookReadInput) {
    const notebook = yield* open(request);
    return revisionOf(notebook) === request.knownRevision ? null : notebookView(notebook);
  });

  const readOutput = Effect.fn("NotebookStore.readOutput")(function* (
    request: NotebookReadOutputInput,
  ) {
    const notebook = yield* open(request);
    const cell = notebook.index.cells.find((entry) => entry.id === request.cellId);
    const range = cell?.outputIndex[request.index]?.range;
    return {
      json:
        cell?.outputs === null || cell?.outputs === undefined || range === undefined
          ? null
          : cell.outputs.toString("utf8", range.start, range.end),
    } satisfies NotebookOutputJson;
  });

  const edit = Effect.fn("NotebookStore.edit")(function* (request: NotebookEditInput) {
    const notebook = yield* open(request);
    yield* notebook.lock.withPermits(1)(
      Effect.sync(() => {
        for (const change of request.edits) {
          notebook.index = applyEdit(notebook.index, change, notebook.removed);
        }
        notebook.pending = [...notebook.pending, ...request.edits];
        notebook.version += 1;
      }),
    );
    yield* scheduleSave(notebook);
    return { revision: revisionOf(notebook) };
  });

  const recordRun = Effect.fn("NotebookStore.recordRun")(function* (
    request: NotebookRecordRunInput,
    notebookOutputs: (
      request: ComputeNotebookOutputsInput,
    ) => Effect.Effect<ComputeNotebookOutputsResult, { readonly message: string }>,
  ) {
    const notebook = yield* open(request);
    const known = notebook.index.cells.find((cell) => cell.id === request.cellId);
    if (known === undefined) return { revision: revisionOf(notebook), cell: null };
    if (cellRun(known.fields)?.execution === request.executionId) {
      return {
        revision: revisionOf(notebook),
        cell: cellView(known, { left: INLINE_BUDGET_BYTES }),
      };
    }
    const result = yield* notebookOutputs({
      cwd: request.cwd,
      sessionId: request.sessionId,
      executionId: request.executionId,
    }).pipe(Effect.mapError((cause) => fail(`A run's output could not be read: ${cause.message}`)));
    const recorded = yield* notebook.lock.withPermits(1)(
      Effect.sync(() => {
        const latest = Math.max(
          0,
          ...notebook.index.cells.map((cell) =>
            typeof cell.fields.execution_count === "number" ? cell.fields.execution_count : 0,
          ),
        );
        let written: NotebookCellRecord | null = null;
        notebook.index = {
          ...notebook.index,
          cells: notebook.index.cells.map((cell) => {
            if (cell.id !== request.cellId) return cell;
            const metadata = isRecord(cell.fields.metadata) ? cell.fields.metadata : {};
            // Replacing `scient` also clears the pending run this result answers.
            written = withOutputs(cell, result.outputs, {
              ...cell.fields,
              metadata: { ...metadata, scient: request.run },
              execution_count: request.executionCount ?? result.executionCount ?? latest + 1,
            });
            return written;
          }),
        };
        notebook.outputsPending = true;
        notebook.version += 1;
        return written;
      }),
    );
    yield* scheduleSave(notebook);
    return {
      revision: revisionOf(notebook),
      cell: recorded === null ? null : cellView(recorded, { left: INLINE_BUDGET_BYTES }),
    };
  });

  /** Writes anything still waiting, for a caller that next reads the file itself. */
  const flush = Effect.fn("NotebookStore.flush")(function* (address: {
    readonly cwd: string;
    readonly path: string;
  }) {
    const notebook = yield* open(address);
    if (notebook.timer !== null) yield* Fiber.interrupt(notebook.timer);
    yield* save(notebook);
  });

  return { read, readOutput, edit, recordRun, flush };
});

export class NotebookStore extends Context.Service<
  NotebookStore,
  Effect.Success<typeof makeNotebookStore>
>()("scient/notebook/NotebookStore") {}

export const layer = Layer.effect(NotebookStore, makeNotebookStore);
