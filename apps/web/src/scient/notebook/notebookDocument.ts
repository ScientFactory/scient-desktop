/**
 * A Jupyter notebook (nbformat 4) as an editable document. Unknown notebook, cell and output
 * fields survive a round trip, so Scient edits only what the user changed.
 */

export type NotebookCellType = "code" | "markdown" | "raw";

export type NotebookOutput = Readonly<Record<string, unknown>>;

/** Scient's record of a cell's last run, kept in the cell's `metadata.scient`. */
export interface NotebookCellRun {
  readonly execution: string;
  /** `notebookCodeHash` of the code that produced the outputs. */
  readonly code: string;
  readonly at: string;
  readonly ms: number | null;
}

export interface NotebookCell {
  readonly id: string;
  readonly cellType: NotebookCellType;
  readonly source: string;
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly executionCount: number | null;
  readonly run: NotebookCellRun | null;
  /** The cell as read, for fields Scient does not edit (metadata, attachments). */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface NotebookDocument {
  readonly cells: ReadonlyArray<NotebookCell>;
  /** Kernel language from the notebook's metadata; `python` when unstated. */
  readonly language: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** nbformat stores multiline text as a string or as a list of lines. */
export function notebookText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter((line) => typeof line === "string").join("") : "";
}

function sourceLines(source: string): string[] {
  return source.length === 0 ? [] : source.split(/(?<=\n)/);
}

/** A short hash, so a cell can tell whether its outputs came from the code it shows now. */
export function notebookCodeHash(code: string): string {
  let hash = 0x811c9dc5;
  const text = code.trimEnd();
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function readCellRun(metadata: unknown): NotebookCellRun | null {
  const run = isRecord(metadata) ? metadata.scient : undefined;
  if (!isRecord(run)) return null;
  const { execution, code, at, ms } = run;
  if (typeof execution !== "string" || typeof code !== "string" || typeof at !== "string") {
    return null;
  }
  return { execution, code, at, ms: typeof ms === "number" ? ms : null };
}

let generatedIds = 0;
function newNotebookCellId(): string {
  generatedIds += 1;
  return `${Date.now().toString(36)}${generatedIds.toString(36)}`.slice(-12);
}

/** The last notebook read or written; typing must not reparse every saved figure. */
let latest: { readonly text: string; readonly document: NotebookDocument | null } | null = null;

export function parseNotebook(text: string): NotebookDocument | null {
  if (latest?.text === text) return latest.document;
  const document = readNotebook(text);
  latest = { text, document };
  return document;
}

function readNotebook(text: string): NotebookDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim().length === 0 ? "{}" : text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const cells = Array.isArray(parsed.cells) ? parsed.cells : [];
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {};
  const kernelspec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {};
  const language =
    (typeof languageInfo.name === "string" && languageInfo.name) ||
    (typeof kernelspec.language === "string" && kernelspec.language) ||
    "python";
  return {
    raw: parsed,
    language: language.toLowerCase(),
    cells: cells.filter(isRecord).map((cell, index) => {
      const cellType =
        cell.cell_type === "markdown" || cell.cell_type === "raw" ? cell.cell_type : "code";
      return {
        // Older notebooks have no cell ids. Position-based ids stay the same on every read of the
        // same text until the first save writes them.
        id: typeof cell.id === "string" && cell.id.length > 0 ? cell.id : `cell-${index + 1}`,
        cellType,
        source: notebookText(cell.source),
        outputs: Array.isArray(cell.outputs) ? cell.outputs.filter(isRecord) : [],
        executionCount: typeof cell.execution_count === "number" ? cell.execution_count : null,
        run: readCellRun(cell.metadata),
        raw: cell,
      };
    }),
  };
}

function serializeCell(cell: NotebookCell): Record<string, unknown> {
  const { scient: _run, ...metadata } = isRecord(cell.raw.metadata) ? cell.raw.metadata : {};
  const base: Record<string, unknown> = {
    ...cell.raw,
    cell_type: cell.cellType,
    id: cell.id,
    metadata: cell.run === null ? metadata : { ...metadata, scient: cell.run },
    // An unedited cell keeps its saved form, so saving does not rewrite the whole file.
    source:
      cell.raw.source !== undefined && notebookText(cell.raw.source) === cell.source
        ? cell.raw.source
        : sourceLines(cell.source),
  };
  if (cell.cellType !== "code") {
    delete base.outputs;
    delete base.execution_count;
    return base;
  }
  return { ...base, execution_count: cell.executionCount, outputs: cell.outputs };
}

/** Jupyter's own layout: one-space indentation and a trailing newline. */
export function serializeNotebook(document: NotebookDocument): string {
  const nbformatMinor =
    typeof document.raw.nbformat_minor === "number" ? Math.max(document.raw.nbformat_minor, 5) : 5;
  const text = `${JSON.stringify(
    {
      ...document.raw,
      cells: document.cells.map(serializeCell),
      metadata: isRecord(document.raw.metadata) ? document.raw.metadata : {},
      nbformat: 4,
      nbformat_minor: nbformatMinor,
    },
    null,
    1,
  )}\n`;
  latest = { text, document };
  return text;
}

export function emptyNotebookCell(cellType: NotebookCellType): NotebookCell {
  return {
    id: newNotebookCellId(),
    cellType,
    source: "",
    outputs: [],
    executionCount: null,
    run: null,
    raw: {},
  };
}

export function updateNotebookCell(
  document: NotebookDocument,
  cellId: string,
  update: (cell: NotebookCell) => NotebookCell,
): NotebookDocument {
  return {
    ...document,
    cells: document.cells.map((cell) => (cell.id === cellId ? update(cell) : cell)),
  };
}

export function insertNotebookCell(
  document: NotebookDocument,
  afterCellId: string | null,
  cell: NotebookCell,
): NotebookDocument {
  const index =
    afterCellId === null
      ? -1
      : document.cells.findIndex((candidate) => candidate.id === afterCellId);
  const cells = [...document.cells];
  cells.splice(index + 1, 0, cell);
  return { ...document, cells };
}

export function removeNotebookCell(document: NotebookDocument, cellId: string): NotebookDocument {
  return { ...document, cells: document.cells.filter((cell) => cell.id !== cellId) };
}

export function clearNotebookOutputs(document: NotebookDocument): NotebookDocument {
  return {
    ...document,
    cells: document.cells.map((cell) =>
      cell.cellType === "code" ? { ...cell, outputs: [], executionCount: null, run: null } : cell,
    ),
  };
}

export function convertNotebookCell(
  document: NotebookDocument,
  cellId: string,
  cellType: NotebookCellType,
): NotebookDocument {
  return updateNotebookCell(document, cellId, (cell) => ({
    ...cell,
    cellType,
    outputs: [],
    executionCount: null,
    run: null,
  }));
}

export function moveNotebookCell(
  document: NotebookDocument,
  cellId: string,
  offset: -1 | 1,
): NotebookDocument {
  const index = document.cells.findIndex((cell) => cell.id === cellId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= document.cells.length) return document;
  const cells = [...document.cells];
  const [cell] = cells.splice(index, 1);
  if (cell !== undefined) cells.splice(target, 0, cell);
  return { ...document, cells };
}
