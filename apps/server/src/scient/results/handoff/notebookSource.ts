import {
  NOTEBOOK_DIGEST_VERSION,
  notebookExecutionDigest,
} from "../../notebook/notebookRevisionSource.ts";
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

export function notebookPackageDigest(cells: ReadonlyArray<string>, version?: number): string {
  return version === NOTEBOOK_DIGEST_VERSION
    ? notebookExecutionDigest(cells)
    : hashBytes(cells.join("\n"));
}

export function portableNotebook(
  sha256: string,
  recordedCells: ReadonlyArray<string> | undefined,
  version?: number,
  snapshot?: ReadonlyArray<string>,
  saved?: string,
): string {
  const matches = (cells: ReadonlyArray<string> | undefined) =>
    cells !== undefined && notebookPackageDigest(cells, version) === sha256;
  let code = [snapshot, recordedCells].find(matches);
  if (code === undefined && saved !== undefined && version === NOTEBOOK_DIGEST_VERSION) {
    try {
      const cells = notebookCode(saved).filter((cell) => cell.trim() !== "");
      if (matches(cells)) code = cells;
    } catch {
      // Unreadable source cannot establish a match.
    }
  }
  if (code == null) {
    throw handoffRefusal(
      "The cells that ran could not be confirmed. Run the saved notebook again to export its results.",
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
