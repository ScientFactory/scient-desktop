import { handoffRefusal, hashBytes, jsonText } from "./handoffFiles.ts";

export function notebookCode(document: string): ReadonlyArray<string> {
  const decoded: unknown = JSON.parse(document);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("cells" in decoded) ||
    !Array.isArray(decoded.cells)
  )
    throw handoffRefusal("The saved notebook cannot be read.");
  const cells: ReadonlyArray<unknown> = decoded.cells;
  return cells.flatMap((cell) => {
    if (
      typeof cell !== "object" ||
      cell === null ||
      !("cell_type" in cell) ||
      cell.cell_type !== "code"
    )
      return [];
    const source = "source" in cell ? cell.source : null;
    if (typeof source === "string") return [source];
    if (Array.isArray(source) && source.every((line) => typeof line === "string")) {
      return [source.join("")];
    }
    throw handoffRefusal("A saved notebook cell cannot be read.");
  });
}

function savedNotebookCode(contents: string | null) {
  try {
    return contents === null ? null : notebookCode(contents);
  } catch {
    return null;
  }
}

export function portableNotebook(
  contents: string | null,
  sha256: string,
  recordedCells: ReadonlyArray<string> | undefined,
): string {
  const saved = savedNotebookCode(contents);
  const code = [saved, recordedCells].find(
    (cells) => cells != null && hashBytes(cells.join("\n")) === sha256,
  );
  if (code == null) {
    throw handoffRefusal(
      "The saved notebook cells do not match this run. Run the saved notebook again or restore the exact cells that ran.",
    );
  }
  // Outputs, author metadata and markdown are separate from the fingerprint of executed cells.
  return jsonText({
    nbformat: 4,
    nbformat_minor: 4,
    metadata: {},
    cells: code.map((source) => ({
      cell_type: "code",
      source,
      metadata: {},
      execution_count: null,
      outputs: [],
    })),
  });
}
