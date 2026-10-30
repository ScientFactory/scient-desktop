/**
 * A Jupyter notebook (nbformat 4) as an editable document. Unknown notebook, cell and output
 * fields survive a round trip, so Scient edits only what the user changed.
 */

export type NotebookCellType = "code" | "markdown" | "raw";

export type NotebookOutput = Readonly<Record<string, unknown>>;

export interface NotebookCell {
  readonly id: string;
  readonly cellType: NotebookCellType;
  readonly source: string;
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly executionCount: number | null;
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

let generatedIds = 0;
function newNotebookCellId(): string {
  generatedIds += 1;
  return `${Date.now().toString(36)}${generatedIds.toString(36)}`.slice(-12);
}

export function parseNotebook(text: string): NotebookDocument | null {
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
    cells: cells.filter(isRecord).map((cell) => {
      const cellType =
        cell.cell_type === "markdown" || cell.cell_type === "raw" ? cell.cell_type : "code";
      return {
        id: typeof cell.id === "string" && cell.id.length > 0 ? cell.id : newNotebookCellId(),
        cellType,
        source: notebookText(cell.source),
        outputs: Array.isArray(cell.outputs) ? cell.outputs.filter(isRecord) : [],
        executionCount: typeof cell.execution_count === "number" ? cell.execution_count : null,
        raw: cell,
      };
    }),
  };
}

function serializeCell(cell: NotebookCell): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...cell.raw,
    cell_type: cell.cellType,
    id: cell.id,
    metadata: isRecord(cell.raw.metadata) ? cell.raw.metadata : {},
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
  return `${JSON.stringify(
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
}

export function emptyNotebookCell(cellType: NotebookCellType): NotebookCell {
  return {
    id: newNotebookCellId(),
    cellType,
    source: "",
    outputs: [],
    executionCount: null,
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
