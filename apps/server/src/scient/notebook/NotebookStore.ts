// @effect-diagnostics nodeBuiltinImport:off -- a notebook is held as its bytes, keyed by size and mtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  NotebookError,
  type ComputeNotebookOutputsInput,
  type ComputeNotebookOutputsResult,
  type NotebookCellRun,
  type NotebookCellView,
  type NotebookEdit,
  type NotebookFold,
  type NotebookEditInput,
  type NotebookOutputJson,
  type NotebookReadInput,
  type NotebookReadOutputInput,
  type NotebookRecordRunInput,
  type NotebookView,
} from "@t3tools/contracts";
import { readNotebookParameters } from "@t3tools/shared/notebookParameters";
import { notebookCodeHash } from "@t3tools/shared/notebookStaleness";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import { isFileHistoryVersion } from "../workspace/FileHistory.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  INLINE_OUTPUT_BYTES,
  indexNotebook,
  indexOutputs,
  notebookBytes,
  notebookCellFieldBytes,
  notebookText,
  notebookWithMetadata,
  notebookCellTags,
  notebookSourceCell,
  type NotebookCellRecord,
  type NotebookIndex,
} from "./notebookIndex.ts";
import { NOTEBOOK_DIGEST_VERSION } from "./notebookRevisionSource.ts";

/** Typing settles for this long before the file is written. */
const SAVE_DELAY = Duration.millis(400);
/** A save that failed is tried again after this, doubling each time up to half a minute. */
const retryDelay = (failures: number) =>
  Duration.millis(Math.min(30_000, 1000 * 2 ** (failures - 1)));
/** Deleted cells kept for undo: this many per notebook, for this many notebooks. */
const MAX_DELETED_CELLS = 32;
const MAX_UNDO_NOTEBOOKS = 16;
/** Batches remembered per notebook, so one sent again after a lost reply is not applied twice. */
const MAX_RECEIPTS = 64;
/** A notebook's first read stays small however many outputs it stores. */
const INLINE_BUDGET_BYTES = 4 * 1024 * 1024;
const MAX_OPEN_NOTEBOOKS = 4;

const fail = (message: string) => new NotebookError({ message });

/** A notebook address runs can report to: relative, inside the project, naming a file. */
export const notebookPathAllowed = (path: string) => {
  const normal = NodePath.posix.normalize(path.replaceAll("\\", "/"));
  return (
    !NodePath.posix.isAbsolute(normal) &&
    !/^[A-Za-z]:/u.test(normal) &&
    normal !== "." &&
    normal !== ".." &&
    !normal.startsWith("../") &&
    !normal.endsWith("/")
  );
};
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

function freshRunBasis(index: NotebookIndex): string {
  const code = index.cells
    .filter((cell) => cell.fields.cell_type === "code")
    .map((cell) => {
      const tags = notebookCellTags(cell.fields);
      return [
        cell.id,
        notebookText(cell.fields.source),
        tags.includes("parameters"),
        tags.includes("injected-parameters"),
      ];
    });
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([index.language, code]))
    .digest("hex");
}

const HEADING_COLLAPSED = "jp-MarkdownHeadingCollapsed";

function cellFolds(fields: NotebookCellRecord["fields"]): NotebookFold[] {
  const metadata = isRecord(fields.metadata) ? fields.metadata : {};
  const jupyter = isRecord(metadata.jupyter) ? metadata.jupyter : {};
  if (fields.cell_type === "markdown") {
    return metadata[HEADING_COLLAPSED] === true ? ["section"] : [];
  }
  if (fields.cell_type !== "code") return [];
  const folded: NotebookFold[] = [];
  if (jupyter.source_hidden === true) folded.push("source");
  if (jupyter.outputs_hidden === true || metadata.collapsed === true) folded.push("outputs");
  return folded;
}

/**
 * Names one version of a cell's outputs. Outputs are replaced whenever they change, so a stored
 * output read later can be checked against the version its reader was shown.
 */
const outputTokens = new WeakMap<Buffer, string>();
function outputsToken(outputs: Buffer): string {
  let token = outputTokens.get(outputs);
  if (token === undefined) {
    token = NodeCrypto.randomUUID();
    outputTokens.set(outputs, token);
  }
  return token;
}

function cellView(cell: NotebookCellRecord, budget: { left: number }): NotebookCellView {
  const { fields } = cell;
  const source = notebookSourceCell(cell);
  const scient = isRecord(fields.metadata) ? fields.metadata.scient : undefined;
  const hints = source.parameterCell && isRecord(scient) ? scient.parameters : undefined;
  return {
    ...source,
    executionCount: typeof fields.execution_count === "number" ? fields.execution_count : null,
    run: cellRun(fields),
    pendingExecution: pendingExecution(fields),
    folded: cellFolds(fields),
    ...(isRecord(hints) ? { parameterHints: hints } : {}),
    outputs: cell.outputIndex.map((output) => {
      const bytes = output.range.end - output.range.start;
      const inline = bytes <= INLINE_OUTPUT_BYTES && bytes <= budget.left;
      if (inline) budget.left -= bytes;
      const stored = cell.outputs;
      return {
        outputType: output.outputType,
        mediaTypes: output.mediaTypes,
        bytes,
        ...(stored === null
          ? { json: null }
          : inline
            ? { json: stored.toString("utf8", output.range.start, output.range.end) }
            : { json: null, token: outputsToken(stored) }),
      };
    }),
  };
}

/** A run's result. It replays like any edit if the file changes before it is saved. */
interface RunResult {
  readonly _tag: "run-result";
  readonly cellId: string;
  readonly outputs: ReadonlyArray<unknown>;
  readonly executionCount: number | null;
  readonly run: NotebookCellRun;
  readonly truncated: boolean;
}
/** An undo carries the cell it puts back, so replaying it over a changed file still can. */
type Restore = Extract<NotebookEdit, { _tag: "restore" }> & { readonly cell?: NotebookCellRecord };
type StoreEdit =
  | Exclude<NotebookEdit, { _tag: "restore-file-version" | "restore" }>
  | Restore
  | RunResult;

/** Output that was not kept is not a run that printed nothing: what was saved stays, as its run's. */
function keepSavedOutput(cell: NotebookCellRecord, execution: string): NotebookCellRecord {
  if (pendingExecution(cell.fields) !== execution) return cell;
  const metadata = isRecord(cell.fields.metadata) ? cell.fields.metadata : {};
  const { pending: _pending, ...scient } = isRecord(metadata.scient) ? metadata.scient : {};
  return {
    ...cell,
    fields: { ...cell.fields, metadata: { ...metadata, scient } },
    saved: null,
  };
}

function applyRunResult(index: NotebookIndex, result: RunResult): NotebookIndex {
  const latest = Math.max(
    0,
    ...index.cells.map((cell) =>
      typeof cell.fields.execution_count === "number" ? cell.fields.execution_count : 0,
    ),
  );
  return {
    ...index,
    cells: index.cells.map((cell) => {
      if (cell.id !== result.cellId) return cell;
      if (result.truncated && result.outputs.length === 0)
        return keepSavedOutput(cell, result.run.execution);
      const metadata = isRecord(cell.fields.metadata) ? cell.fields.metadata : {};
      // A newer run submitted meanwhile must still be recorded when it ends.
      const pending = pendingExecution(cell.fields);
      const scient =
        pending === null || pending === result.run.execution
          ? {
              ...(isRecord(metadata.scient) ? metadata.scient : {}),
              ...result.run,
              pending: undefined,
            }
          : { ...(isRecord(metadata.scient) ? metadata.scient : {}), ...result.run, pending };
      const outputs = notebookCellFieldBytes(result.outputs);
      return {
        ...cell,
        fields: {
          ...cell.fields,
          metadata: { ...metadata, scient },
          execution_count: result.executionCount ?? latest + 1,
        },
        outputs,
        outputIndex: indexOutputs(outputs),
        saved: null,
      };
    }),
  };
}

/** Someone changed this cell after the writer last saw it, so its edit would overwrite them. */
function sourceMovedOn(index: NotebookIndex, edit: NotebookEdit): boolean {
  if (edit._tag !== "set-source" || edit.base === undefined) return false;
  const cell = index.cells.find((entry) => entry.id === edit.cellId);
  if (cell === undefined) return true;
  const current = notebookCodeHash(notebookText(cell.fields.source));
  return current !== edit.base && current !== notebookCodeHash(edit.source);
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
  const { scient, ...metadata } = fields.metadata;
  if (!isRecord(scient)) return { ...fields, metadata };
  const {
    execution: _execution,
    code: _code,
    at: _at,
    ms: _ms,
    pending: _pending,
    ...kept
  } = scient;
  return { ...fields, metadata: { ...metadata, scient: kept } };
}

/** Applies one edit. `removed` keeps deleted cells so an undo restores their outputs. */
function applyEdit(
  index: NotebookIndex,
  edit: StoreEdit,
  removed: Map<string, NotebookCellRecord>,
): NotebookIndex {
  const update = (cellId: string, change: (cell: NotebookCellRecord) => NotebookCellRecord) => ({
    ...index,
    cells: index.cells.map((cell) => (cell.id === cellId ? change(cell) : cell)),
  });
  switch (edit._tag) {
    case "run-result":
      return applyRunResult(index, edit);
    case "set-source":
      return update(edit.cellId, (cell) => ({
        ...cell,
        fields: { ...cell.fields, source: sourceLines(edit.source) },
        saved: null,
      }));
    case "insert":
      // Cell IDs are random, so one already here is this insert, sent again.
      if (index.cells.some((cell) => cell.id === edit.cellId)) return index;
      return { ...index, cells: insertAfter(index.cells, edit.afterCellId, newCell(edit)) };
    case "delete": {
      const cell = index.cells.find((entry) => entry.id === edit.cellId);
      if (cell !== undefined) {
        // Its own copy, so undo does not keep the whole file's buffer alive.
        removed.set(cell.id, {
          ...cell,
          outputs: cell.outputs === null ? null : Buffer.from(cell.outputs),
          saved: null,
          ...(cell.rawFields === undefined
            ? {}
            : {
                rawFields: new Map(
                  [...cell.rawFields].map(([key, raw]) => [
                    key,
                    { ...raw, bytes: Buffer.from(raw.bytes) },
                  ]),
                ),
              }),
        });
        if (removed.size > MAX_DELETED_CELLS) removed.delete(removed.keys().next().value ?? "");
      }
      return { ...index, cells: index.cells.filter((entry) => entry.id !== edit.cellId) };
    }
    case "restore": {
      // A cell already in the notebook, someone else's undo for one, stays as it is.
      if (index.cells.some((entry) => entry.id === edit.cellId)) return index;
      const cell = edit.cell ?? removed.get(edit.cellId);
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
    case "set-parameters": {
      const target = index.cells.find((cell) => cell.id === edit.cellId);
      if (
        target?.fields.cell_type !== "code" ||
        notebookCellTags(target.fields).includes("injected-parameters")
      ) {
        return index;
      }
      return {
        ...index,
        cells: index.cells.map((cell) => {
          const tags = notebookCellTags(cell.fields);
          if (cell.id !== edit.cellId && (!edit.enabled || !tags.includes("parameters")))
            return cell;
          const metadata = isRecord(cell.fields.metadata) ? cell.fields.metadata : {};
          return {
            ...cell,
            fields: {
              ...cell.fields,
              metadata: {
                ...metadata,
                tags: [
                  ...tags.filter((tag) => tag !== "parameters"),
                  ...(cell.id === edit.cellId && edit.enabled ? ["parameters"] : []),
                ],
              },
            },
            saved: null,
          };
        }),
      };
    }
    case "set-fold":
      return update(edit.cellId, (cell) => {
        const heading = edit.part === "section";
        if (cell.fields.cell_type !== (heading ? "markdown" : "code")) return cell;
        const metadata = isRecord(cell.fields.metadata) ? { ...cell.fields.metadata } : {};
        if (heading) {
          if (edit.folded) metadata[HEADING_COLLAPSED] = true;
          else delete metadata[HEADING_COLLAPSED];
        } else {
          const jupyter = isRecord(metadata.jupyter) ? { ...metadata.jupyter } : {};
          if (edit.part === "outputs") {
            delete jupyter.outputs_hidden;
            if (edit.folded) metadata.collapsed = true;
            else delete metadata.collapsed;
          } else if (edit.folded) {
            jupyter.source_hidden = true;
          } else {
            delete jupyter.source_hidden;
          }
          if (Object.keys(jupyter).length > 0) metadata.jupyter = jupyter;
          else delete metadata.jupyter;
        }
        return { ...cell, fields: { ...cell.fields, metadata }, saved: null };
      });
    case "expect-run":
      return update(edit.cellId, (cell) => {
        // A quick run can be recorded before this reaches the server.
        if (cellRun(cell.fields)?.execution === edit.execution) return cell;
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

/**
 * Replays edits not yet written over a file that changed. An edit made from text the file no longer
 * holds cannot go through, so what the file says stays and that edit's text gets a cell of its own.
 */
function replayPending(
  read: NotebookIndex,
  pending: ReadonlyArray<StoreEdit>,
  removed: Map<string, NotebookCellRecord>,
) {
  let index = read;
  const replayed: StoreEdit[] = [];
  const movedTo = new Map<string, string>();
  const apply = (edit: StoreEdit) => {
    index = applyEdit(index, edit, removed);
    replayed.push(edit);
  };
  for (const edit of pending) {
    const moved = edit._tag === "set-source" ? movedTo.get(edit.cellId) : undefined;
    if (edit._tag !== "set-source" || !(moved !== undefined || sourceMovedOn(index, edit))) {
      apply(edit);
    } else if (moved !== undefined) {
      apply({ _tag: "set-source", cellId: moved, source: edit.source });
    } else {
      const cell = index.cells.find((entry) => entry.id === edit.cellId);
      const cellId = NodeCrypto.randomUUID().slice(0, 12);
      movedTo.set(edit.cellId, cellId);
      apply({
        _tag: "insert",
        cellId,
        afterCellId: edit.cellId,
        cellType:
          cell?.fields.cell_type === "markdown" || cell?.fields.cell_type === "raw"
            ? cell.fields.cell_type
            : "code",
        source: edit.source,
      });
    }
  }
  return { index, pending: replayed };
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
  /** The bytes last read or written, whose revision a save must find on disk. */
  fileBytes: Buffer;
  /** Edits and run results not yet on disk, replayed if the file changes underneath them. */
  pending: ReadonlyArray<StoreEdit>;
  /** Saves the pending edits once typing settles, and keeps trying until they are on disk. */
  saver: Fiber.Fiber<void> | null;
  editedAt: number;
  /** Why the last save failed, until one succeeds. */
  saveProblem: string | null;
  /**
   * A write whose outcome is unknown: the bytes and how many pending edits they hold. If the file
   * later reads as these bytes, those edits are written and must not be replayed.
   */
  attempted: {
    readonly bytes: Buffer;
    readonly index: NotebookIndex;
    readonly edits: number;
  } | null;
  /** Requests using this notebook now. Only an unused, settled notebook leaves memory. */
  users: number;
  /** The cells each recent batch refused, by its request ID; kept per file, like undo. */
  readonly receipts: Map<string, EditOutcome>;
}

/** Revisions from an earlier server never match this one's. */
const serverEpoch = NodeCrypto.randomUUID().slice(0, 8);
/** What a batch did that its sender must hear: edits refused, and undos that came too late. */
interface EditOutcome {
  readonly refused: ReadonlyArray<string>;
  readonly expired: ReadonlyArray<string>;
}

const revisionOf = (notebook: OpenNotebook) =>
  `${serverEpoch}.${notebook.loadId}.${notebook.version}`;

function notebookView(notebook: OpenNotebook): NotebookView {
  const budget = { left: INLINE_BUDGET_BYTES };
  const cells = notebook.index.cells.map((cell) => cellView(cell, budget));
  const parameters = cells.findIndex((cell) => cell.parameterCell);
  const parameterCell = cells[parameters];
  if (parameterCell !== undefined) {
    const metadata = notebook.index.metadata;
    const scient = isRecord(metadata?.scient) ? metadata.scient.notebookRun : undefined;
    const papermill = isRecord(metadata?.papermill) ? metadata.papermill.parameters : undefined;
    const injections = cells.filter((cell) => cell.injectedParameters);
    const values =
      isRecord(scient) && scient.parameterCellId === parameterCell.id && isRecord(scient.parameters)
        ? Object.fromEntries(
            Object.entries(scient.parameters).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
    const injected = injections[0];
    const actualOverrides = new Map(
      readNotebookParameters(injected?.source ?? "", notebook.index.language).map(
        ({ name, value }) => [name, JSON.stringify(value)],
      ),
    );
    const mismatch =
      injections.length > 1 ||
      (isRecord(papermill) &&
        (Object.keys(papermill).length !== actualOverrides.size ||
          Object.entries(papermill).some(
            ([name, value]) => actualOverrides.get(name) !== JSON.stringify(value),
          ))) ||
      (isRecord(scient) &&
        scient.injectionSha256 !==
          (injected === undefined
            ? null
            : NodeCrypto.createHash("sha256").update(injected.source).digest("hex")));
    cells[parameters] = {
      ...parameterCell,
      ...(mismatch
        ? { parameterEvidenceMismatch: true }
        : values === undefined
          ? {}
          : { savedParameters: values }),
    };
  }
  return {
    revision: revisionOf(notebook),
    language: notebook.index.language,
    cells,
    ...(notebook.saveProblem === null ? {} : { saveProblem: notebook.saveProblem }),
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
  const opening = yield* Semaphore.make(1);
  const freshRuns = new Set<string>();
  /**
   * What a notebook leaving memory must keep: deleted cells for undo and recent batch receipts,
   * by path, for the notebooks most recently given either.
   */
  const kept = new Map<
    string,
    {
      readonly removed: Map<string, NotebookCellRecord>;
      readonly receipts: Map<string, EditOutcome>;
    }
  >();
  const storeScope = yield* Effect.scope;
  let loads = 0;

  /** Lets go of notebooks nobody is using and nothing is waiting to save. */
  const evictIdle = () => {
    for (const [path, candidate] of notebooks) {
      if (notebooks.size <= MAX_OPEN_NOTEBOOKS) break;
      if (candidate.users !== 0 || candidate.pending.length !== 0) continue;
      notebooks.delete(path);
      if (candidate.removed.size === 0 && candidate.receipts.size === 0) continue;
      kept.set(path, { removed: candidate.removed, receipts: candidate.receipts });
      if (kept.size > MAX_UNDO_NOTEBOOKS) kept.delete(kept.keys().next().value ?? "");
    }
  };

  const fileState = (absolutePath: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.stat(absolutePath),
      catch: (cause) => fail(`This notebook could not be opened: ${describe(cause)}`),
    });
  const readNotebookFile = (absolutePath: string) =>
    Effect.tryPromise({
      try: async () => {
        const fileBytes = await NodeFSP.readFile(absolutePath);
        return { fileBytes, index: indexNotebook(fileBytes) };
      },
      catch: (cause) => fail(`This notebook could not be read: ${describe(cause)}`),
    });

  /** Brings an open notebook up to date with the file, keeping edits not yet written. */
  const refresh = Effect.fn("NotebookStore.refresh")(function* (
    notebook: OpenNotebook,
    force = false,
  ) {
    const state = yield* fileState(notebook.absolutePath);
    if (!force && state.mtimeMs === notebook.mtimeMs && state.size === notebook.size) return;
    const { fileBytes, index: fromFile } = yield* readNotebookFile(notebook.absolutePath);
    const attempted = notebook.attempted;
    notebook.attempted = null;
    const written = attempted !== null && attempted.bytes.equals(fileBytes);
    const read = written ? attempted.index : fromFile;
    if (written) notebook.pending = notebook.pending.slice(attempted.edits);
    const replayed = replayPending(read, notebook.pending, notebook.removed);
    notebook.index = replayed.index;
    notebook.pending = replayed.pending;
    notebook.fileBytes = fileBytes;
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
      existing.users += 1;
      yield* existing.lock
        .withPermits(1)(refresh(existing))
        .pipe(Effect.onError(() => Effect.sync(() => (existing.users -= 1))));
      return existing;
    }
    return yield* opening.withPermits(1)(
      Effect.gen(function* () {
        // Another window may have opened it while this one waited.
        const opened = notebooks.get(absolutePath);
        if (opened !== undefined) {
          opened.users += 1;
          return opened;
        }
        const state = yield* fileState(absolutePath);
        const { fileBytes, index } = yield* readNotebookFile(absolutePath);
        const notebook: OpenNotebook = {
          cwd: address.cwd,
          relativePath,
          absolutePath,
          lock: yield* Semaphore.make(1),
          removed: kept.get(absolutePath)?.removed ?? new Map(),
          loadId: (loads += 1),
          index,
          version: 0,
          mtimeMs: state.mtimeMs,
          size: state.size,
          fileBytes,
          pending: [],
          saver: null,
          editedAt: 0,
          saveProblem: null,
          attempted: null,
          users: 1,
          receipts: kept.get(absolutePath)?.receipts ?? new Map(),
        };
        kept.delete(absolutePath);
        notebooks.set(absolutePath, notebook);
        evictIdle();
        return notebook;
      }),
    );
  });

  const publish = Effect.fn("NotebookStore.publish")(function* (
    notebook: OpenNotebook,
    index = notebook.index,
    keepPreviousVersion = false,
  ) {
    const bytes = notebookBytes(index);
    yield* workspaceFileSystem
      .writeBinaryFile({
        cwd: notebook.cwd,
        relativePath: notebook.relativePath,
        bytes,
        // A writer that gets in after the last read is found here, not overwritten.
        expectedRevision: bytesRevision(notebook.fileBytes),
        ...(keepPreviousVersion ? { keepPreviousVersion: true } : {}),
      })
      .pipe(
        // A write can fail after the bytes landed; then it happened, and must not be replayed.
        Effect.catch((error) =>
          Effect.promise(() => NodeFSP.readFile(notebook.absolutePath).catch(() => null)).pipe(
            Effect.flatMap((onDisk) => {
              if (onDisk?.equals(bytes)) return Effect.void;
              // Unreadable now: the next read of the file decides whether this write landed.
              if (onDisk === null)
                notebook.attempted = { bytes, index, edits: notebook.pending.length };
              return Effect.fail(error);
            }),
          ),
        ),
      );
    // The file holds these edits now, so nothing may replay them, whatever happens next.
    notebook.attempted = null;
    notebook.index = index;
    notebook.fileBytes = bytes;
    notebook.pending = [];
    const state = yield* fileState(notebook.absolutePath).pipe(Effect.option);
    notebook.mtimeMs = state._tag === "Some" ? state.value.mtimeMs : -1;
    notebook.size = state._tag === "Some" ? state.value.size : -1;
  });

  const noteSaveProblem = (notebook: OpenNotebook, problem: string | null) =>
    Effect.sync(() => {
      if (notebook.saveProblem === problem) return;
      notebook.saveProblem = problem;
      notebook.version += 1;
    });

  /** Writes pending edits now. Its outcome, success or failure, is the notebook's save state. */
  const save = (notebook: OpenNotebook) =>
    notebook.lock
      .withPermits(1)(
        Effect.gen(function* () {
          if (notebook.pending.length === 0) return;
          yield* refresh(notebook);
          yield* publish(notebook).pipe(
            Effect.catchTags({
              WorkspaceFileTargetChangedError: () =>
                refresh(notebook, true).pipe(Effect.andThen(publish(notebook))),
              WorkspaceFileRevisionConflictError: () =>
                refresh(notebook, true).pipe(Effect.andThen(publish(notebook))),
            }),
          );
        }).pipe(
          Effect.mapError((cause) => fail(`This notebook could not be saved: ${describe(cause)}`)),
        ),
      )
      .pipe(
        Effect.tapError((error) => noteSaveProblem(notebook, error.message)),
        Effect.tap(() => noteSaveProblem(notebook, null)),
      );

  const saveWhenSettled = Effect.fn("NotebookStore.saveWhenSettled")(function* (
    notebook: OpenNotebook,
  ) {
    let failures = 0;
    while (notebook.pending.length > 0) {
      yield* Effect.sleep(failures === 0 ? SAVE_DELAY : retryDelay(failures));
      const quiet = (yield* Clock.currentTimeMillis) - notebook.editedAt;
      if (failures === 0 && quiet < Duration.toMillis(SAVE_DELAY)) continue;
      failures = yield* Effect.uninterruptible(save(notebook)).pipe(
        Effect.as(0),
        Effect.catch((error) => Effect.logError(error.message).pipe(Effect.as(failures + 1))),
      );
    }
    evictIdle();
  });

  const scheduleSave = (notebook: OpenNotebook) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        notebook.editedAt = yield* Clock.currentTimeMillis;
        if (notebook.saver !== null) return;
        notebook.saver = yield* saveWhenSettled(notebook).pipe(
          Effect.ensuring(Effect.sync(() => (notebook.saver = null))),
          Effect.forkIn(storeScope),
        );
      }),
    );

  /** Opens a notebook for one request, which keeps it in memory until the request ends. */
  const openFor = (address: { readonly cwd: string; readonly path: string }) =>
    Effect.acquireRelease(open(address), (notebook) =>
      Effect.sync(() => {
        notebook.users -= 1;
        evictIdle();
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...notebooks.values()],
      (notebook) =>
        (notebook.saver === null ? Effect.void : Fiber.interrupt(notebook.saver)).pipe(
          Effect.andThen(Effect.ignore(save(notebook))),
        ),
      { discard: true },
    ),
  );

  const read = Effect.fn("NotebookStore.read")(function* (request: NotebookReadInput) {
    const notebook = yield* openFor(request);
    return revisionOf(notebook) === request.knownRevision ? null : notebookView(notebook);
  }, Effect.scoped);

  const readOutput = Effect.fn("NotebookStore.readOutput")(function* (
    request: NotebookReadOutputInput,
  ) {
    const notebook = yield* openFor(request);
    const cell = notebook.index.cells.find((entry) => entry.id === request.cellId);
    const range = cell?.outputIndex[request.index]?.range;
    if (cell?.outputs == null || range === undefined)
      return (
        request.token === undefined ? { json: null } : { json: null, stale: true }
      ) satisfies NotebookOutputJson;
    // The cell's outputs changed since its reader was shown them, so this index means another output.
    if (request.token !== undefined && request.token !== outputsToken(cell.outputs))
      return { json: null, stale: true } satisfies NotebookOutputJson;
    return {
      json: cell.outputs.toString("utf8", range.start, range.end),
    } satisfies NotebookOutputJson;
  }, Effect.scoped);

  const edit = Effect.fn("NotebookStore.edit")(function* (request: NotebookEditInput) {
    const notebook = yield* openFor(request);
    const outcome = yield* notebook.lock.withPermits(1)(
      Effect.gen(function* () {
        const pendingBefore = notebook.pending.length;
        const answered =
          request.requestId === undefined ? undefined : notebook.receipts.get(request.requestId);
        if (answered !== undefined) return answered;
        const remember = (outcome: EditOutcome) => {
          if (request.requestId === undefined) return outcome;
          notebook.receipts.set(request.requestId, outcome);
          if (notebook.receipts.size > MAX_RECEIPTS)
            notebook.receipts.delete(notebook.receipts.keys().next().value ?? "");
          return outcome;
        };
        if (
          freshRuns.has(notebook.absolutePath) &&
          request.edits.some((edit) => edit._tag !== "set-fold")
        ) {
          return yield* fail("Editing resumes when the fresh run finishes.");
        }
        const restore = request.edits.find((change) => change._tag === "restore-file-version");
        if (restore) {
          if (request.edits.length !== 1 || !isFileHistoryVersion(restore.versionId))
            return yield* fail("Choose one notebook version from File versions.");
          if (notebook.pending.length > 0)
            return yield* fail("Save pending notebook changes before restoring a version.");
          yield* refresh(notebook);
          const target = { cwd: notebook.cwd, relativePath: notebook.relativePath };
          const history = yield* workspaceFileSystem
            .listFileVersions(target)
            .pipe(Effect.mapError((cause) => fail(describe(cause))));
          const version = history.versions.find(({ versionId }) => versionId === restore.versionId);
          if (!version) return yield* fail("This retained notebook version is unavailable.");
          const { fileBytes, index } = yield* readNotebookFile(version.retainedPath);
          if (bytesRevision(fileBytes) !== version.revision)
            return yield* fail("This retained notebook version changed.");
          yield* workspaceFileSystem
            .writeBinaryFile({
              ...target,
              bytes: fileBytes,
              expectedRevision: bytesRevision(notebook.fileBytes),
              keepPreviousVersion: true,
            })
            .pipe(Effect.mapError((cause) => fail(describe(cause))));
          const state = yield* fileState(notebook.absolutePath);
          notebook.index = index;
          notebook.fileBytes = fileBytes;
          notebook.size = state.size;
          notebook.mtimeMs = state.mtimeMs;
          notebook.removed.clear();
          notebook.version += 1;
          return remember({ refused: [], expired: [] });
        }
        const refused: string[] = [];
        const expired: string[] = [];
        for (const change of request.edits) {
          if (change._tag === "restore-file-version") continue;
          if (sourceMovedOn(notebook.index, change)) {
            refused.push((change as Extract<NotebookEdit, { _tag: "set-source" }>).cellId);
            continue;
          }
          const record =
            change._tag === "restore" ? notebook.removed.get(change.cellId) : undefined;
          if (
            change._tag === "restore" &&
            record === undefined &&
            !notebook.index.cells.some((cell) => cell.id === change.cellId)
          ) {
            expired.push(change.cellId);
            continue;
          }
          const applied = (
            record === undefined ? change : { ...change, cell: record }
          ) as StoreEdit;
          notebook.index = applyEdit(notebook.index, applied, notebook.removed);
          notebook.pending = [...notebook.pending, applied];
        }
        if (request.edits.length > 0) notebook.version += 1;
        // A worker owns every pending edit before anything can interrupt this request.
        if (notebook.pending.length > pendingBefore) yield* scheduleSave(notebook);
        return remember({ refused, expired });
      }).pipe(Effect.uninterruptible),
    );
    const saveProblem = request.durable
      ? yield* save(notebook).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error.message)),
        )
      : (notebook.saveProblem ?? undefined);
    return {
      revision: revisionOf(notebook),
      refused: outcome.refused,
      ...(outcome.expired.length === 0 ? {} : { expired: outcome.expired }),
      ...(saveProblem === undefined ? {} : { saveProblem }),
    };
  }, Effect.scoped);

  const recordRun = Effect.fn("NotebookStore.recordRun")(function* (
    request: NotebookRecordRunInput,
    notebookOutputs: (
      request: ComputeNotebookOutputsInput,
    ) => Effect.Effect<ComputeNotebookOutputsResult, { readonly message: string }>,
  ) {
    const notebook = yield* openFor(request);
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
      Effect.gen(function* () {
        const cell = notebook.index.cells.find((entry) => entry.id === request.cellId);
        const last = cell === undefined ? null : cellRun(cell.fields);
        // The server and an open notebook both record a run, and a result never replaces a newer
        // one. Of two that finished in the same millisecond, the run the cell expects wins.
        if (
          cell === undefined ||
          (last !== null &&
            (last.at > request.run.at ||
              (last.at === request.run.at &&
                pendingExecution(cell.fields) !== request.executionId)))
        )
          return cell ?? null;
        // An unreadable copy keeps the cell's saved output, as a run whose output was not kept does.
        const edit: RunResult = {
          _tag: "run-result",
          cellId: request.cellId,
          outputs: result.incomplete ? [] : result.outputs,
          executionCount: request.executionCount ?? result.executionCount,
          run: request.run,
          truncated: result.truncated || result.incomplete === true,
        };
        notebook.index = applyEdit(notebook.index, edit, notebook.removed);
        notebook.pending = [...notebook.pending, edit];
        notebook.version += 1;
        yield* scheduleSave(notebook);
        return notebook.index.cells.find((cell) => cell.id === request.cellId) ?? null;
      }).pipe(Effect.uninterruptible),
    );
    return {
      revision: revisionOf(notebook),
      cell: recorded === null ? null : cellView(recorded, { left: INLINE_BUDGET_BYTES }),
    };
  }, Effect.scoped);

  /** A run cancelled before it started leaves its cell as it was, no longer waiting for it. */
  const forgetRun = Effect.fn("NotebookStore.forgetRun")(function* (request: {
    readonly cwd: string;
    readonly path: string;
    readonly cellId: string;
    readonly executionId: string;
  }) {
    const notebook = yield* openFor(request);
    yield* notebook.lock.withPermits(1)(
      Effect.gen(function* () {
        const cell = notebook.index.cells.find((entry) => entry.id === request.cellId);
        if (cell === undefined || pendingExecution(cell.fields) !== request.executionId) return;
        const edit: RunResult = {
          _tag: "run-result",
          cellId: request.cellId,
          outputs: [],
          executionCount: null,
          run: { execution: request.executionId, code: "", at: "", ms: null },
          truncated: true,
        };
        notebook.index = applyEdit(notebook.index, edit, notebook.removed);
        notebook.pending = [...notebook.pending, edit];
        notebook.version += 1;
        yield* scheduleSave(notebook);
      }).pipe(Effect.uninterruptible),
    );
  }, Effect.scoped);

  /** Writes anything still waiting, for a caller that next reads the file itself. */
  const flush = Effect.fn("NotebookStore.flush")(function* (address: {
    readonly cwd: string;
    readonly path: string;
  }) {
    const notebook = yield* openFor(address);
    yield* save(notebook);
  }, Effect.scoped);

  const reserveFreshRun = (address: NotebookReadInput) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const notebook = yield* openFor(address);
        const path = notebook.absolutePath;
        if (freshRuns.has(path)) return yield* fail("This notebook already has a fresh run.");
        freshRuns.add(path);
        return path;
      }),
      (path) =>
        Effect.sync(() => {
          freshRuns.delete(path);
        }),
    );

  const freshSnapshot = Effect.fn("NotebookStore.freshSnapshot")(function* (
    address: NotebookReadInput,
  ) {
    yield* flush(address);
    const notebook = yield* openFor(address);
    return yield* notebook.lock.withPermits(1)(
      Effect.gen(function* () {
        yield* refresh(notebook);
        if (notebook.pending.length > 0)
          return yield* fail("The notebook changed before the run could start.");
        return {
          revision: bytesRevision(notebook.fileBytes),
          executionBasis: freshRunBasis(notebook.index),
          language: notebook.index.language,
          cells: notebook.index.cells.map((cell) => cellView(cell, { left: 0 })),
        };
      }),
    );
  }, Effect.scoped);

  const saveFreshRun = Effect.fn("NotebookStore.saveFreshRun")(function* (
    request: NotebookReadInput & {
      readonly snapshot: string;
      readonly parameterCellId: string | undefined;
      readonly injection: { readonly id: string; readonly source: string } | undefined;
      readonly parameters: Readonly<Record<string, string>>;
      readonly overrides: Readonly<Record<string, unknown>>;
      readonly codeSha256: string;
      readonly executionId: string;
      readonly results: ReadonlyArray<RunResult>;
    },
  ) {
    const notebook = yield* openFor(request);
    yield* notebook.lock.withPermits(1)(
      Effect.gen(function* () {
        yield* refresh(notebook);
        if (freshRunBasis(notebook.index) !== request.snapshot) {
          return yield* fail(
            "The code changed during the run. The notebook's cell outputs were left as they were.",
          );
        }
        const cells = notebook.index.cells.filter(
          (cell) => !notebookCellTags(cell.fields).includes("injected-parameters"),
        );
        let index = { ...notebook.index, cells: cells as ReadonlyArray<NotebookCellRecord> };
        const injection = request.injection;
        if (injection !== undefined && request.parameterCellId !== undefined) {
          const cell = newCell({
            _tag: "insert",
            cellId: injection.id,
            afterCellId: request.parameterCellId,
            cellType: "code",
            source: injection.source,
          });
          index = {
            ...index,
            cells: insertAfter(cells, request.parameterCellId, {
              ...cell,
              fields: { ...cell.fields, metadata: { tags: ["injected-parameters"] } },
            }),
          };
        }
        const results = new Map(request.results.map((result) => [result.cellId, result]));
        index = {
          ...index,
          cells: index.cells.map((cell) => {
            const ran = results.get(cell.id);
            if (cell.fields.cell_type !== "code") return cell;
            const metadata = isRecord(cell.fields.metadata) ? cell.fields.metadata : {};
            const { pending: _pending, ...scient } = isRecord(metadata.scient)
              ? metadata.scient
              : {};
            const saved = ran?.outputs ?? [];
            const outputs = notebookCellFieldBytes(
              ran?.truncated
                ? [
                    ...saved,
                    {
                      output_type: "stream",
                      name: "stderr",
                      text: "Some cell output exceeded the saved output limit and was omitted.\n",
                    },
                  ]
                : saved,
            );
            return {
              ...cell,
              fields: {
                ...cell.fields,
                metadata: {
                  ...metadata,
                  scient: {
                    ...scient,
                    ...(ran === undefined
                      ? { execution: undefined, code: undefined, at: undefined, ms: undefined }
                      : ran.run),
                  },
                },
                execution_count: ran?.executionCount ?? null,
                outputs: null,
              },
              outputs,
              outputIndex: indexOutputs(outputs),
              saved: null,
            };
          }),
        };
        const metadata = index.metadata ?? {};
        const scient = isRecord(metadata.scient) ? metadata.scient : {};
        const papermill = isRecord(metadata.papermill) ? metadata.papermill : {};
        const papermillOverrides = Object.fromEntries(
          Object.entries(request.overrides).map(([name, value]) => {
            const json = request.parameters[name];
            return [
              name,
              typeof value === "number" && json !== undefined && /[.eE]/u.test(json)
                ? JSON.rawJSON(json)
                : value,
            ];
          }),
        );
        index = notebookWithMetadata(
          index,
          {
            ...metadata,
            papermill: { ...papermill, parameters: request.overrides },
            scient: {
              ...scient,
              notebookRun: {
                executionId: request.executionId,
                codeSha256: request.codeSha256,
                notebookDigestVersion: NOTEBOOK_DIGEST_VERSION,
                parameterCellId: request.parameterCellId ?? null,
                injectionSha256:
                  request.injection === undefined
                    ? null
                    : NodeCrypto.createHash("sha256")
                        .update(request.injection.source)
                        .digest("hex"),
                parameters: request.parameters,
              },
            },
          },
          (_key, value) => (value === request.overrides ? papermillOverrides : value),
        );
        yield* publish(notebook, index, true).pipe(
          Effect.mapError((cause) => fail(`The run could not be saved: ${describe(cause)}`)),
        );
        notebook.version += 1;
      }).pipe(Effect.uninterruptible),
    );
  }, Effect.scoped);

  return {
    read,
    readOutput,
    edit,
    recordRun,
    forgetRun,
    flush,
    reserveFreshRun,
    freshSnapshot,
    saveFreshRun,
  };
});

export class NotebookStore extends Context.Service<
  NotebookStore,
  Effect.Success<typeof makeNotebookStore>
>()("t3/scient/notebook/NotebookStore") {}

export const layer = Layer.effect(NotebookStore, makeNotebookStore);
