export const PDF_EDIT_MAX_BYTES = 50 * 1024 * 1024;
export const PDF_EDIT_MAX_PAGES = 5_000;
export const PDF_EDIT_TAGGED_MESSAGE =
  "This PDF has accessibility tags. You can rotate, move and insert pages, but not delete or duplicate them yet.";

let nextId = 0;
export const createPdfEditId = () => `pdf-edit-${++nextId}`;

export interface PdfEditPage {
  readonly id: string;
  readonly sourceId: string | null;
  readonly sourceIndex: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export interface PdfEditFrame {
  readonly pages: readonly PdfEditPage[];
  readonly selection: readonly string[];
}

export type PdfEditWorkerRequest =
  | {
      readonly id: number;
      readonly kind: "load";
      readonly sourceId: string;
      readonly bytes: Uint8Array;
    }
  | { readonly id: number; readonly kind: "build"; readonly pages: readonly PdfEditPage[] }
  | { readonly id: number; readonly kind: "release"; readonly sourceId: string };

export type PdfEditWorkerResponse =
  | {
      readonly id: number;
      readonly kind: "loaded";
      readonly pages: readonly PdfEditPage[];
      readonly tagged: boolean;
    }
  | { readonly id: number; readonly kind: "released" }
  | { readonly id: number; readonly kind: "built"; readonly bytes: Uint8Array }
  | { readonly id: number; readonly kind: "error"; readonly message: string };

/**
 * A tagged PDF's structure tree points at its pages, so every original page
 * must stay exactly once: deleting leaves dangling entries, duplicating
 * makes two pages claim the same ones.
 */
export function keepsEveryPageOnce(
  pages: readonly PdfEditPage[],
  sourceId: string,
  pageCount: number,
) {
  const counts = Array.from({ length: pageCount }, () => 0);
  for (const page of pages) if (page.sourceId === sourceId) counts[page.sourceIndex]! += 1;
  return counts.every((count) => count === 1);
}

export function parsePdfPageRange(value: string, count: number): number[] {
  if (!value.trim()) throw new Error("Enter pages, for example 1, 3–5.");
  const result = new Set<number>();
  for (const part of value.split(",")) {
    const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/u.exec(part);
    if (!match) throw new Error("Use page numbers and ranges, for example 1, 3–5.");
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > count) {
      throw new Error(`Pages must be between 1 and ${count}, with ranges in ascending order.`);
    }
    for (let page = start; page <= end; page++) result.add(page);
  }
  return [...result].sort((a, b) => a - b);
}

export function selectedPdfPages(frame: PdfEditFrame) {
  const selected = new Set(frame.selection);
  return frame.pages.filter((page) => selected.has(page.id));
}

export function pdfInsertionIndex(frame: PdfEditFrame, side: "before" | "after") {
  const indices = frame.pages.flatMap((page, index) =>
    frame.selection.includes(page.id) ? [index] : [],
  );
  if (!indices.length) throw new Error("Select a page to set the insertion position.");
  return side === "before" ? Math.min(...indices) : Math.max(...indices) + 1;
}

export function insertPdfPages(
  frame: PdfEditFrame,
  pages: readonly PdfEditPage[],
  index: number,
): PdfEditFrame {
  if (frame.pages.length + pages.length > PDF_EDIT_MAX_PAGES) {
    throw new Error(`Page editing supports up to ${PDF_EDIT_MAX_PAGES.toLocaleString()} pages.`);
  }
  return {
    pages: [...frame.pages.slice(0, index), ...pages, ...frame.pages.slice(index)],
    selection: pages.map((page) => page.id),
  };
}

export function movePdfPages(
  frame: PdfEditFrame,
  boundary: number,
  target: readonly string[] = frame.selection,
): PdfEditFrame {
  const moving = new Set(target);
  const selected = frame.pages.filter((page) => moving.has(page.id));
  if (!selected.length) return frame;
  const remaining = frame.pages.filter((page) => !moving.has(page.id));
  const index = frame.pages.slice(0, boundary).filter((page) => !moving.has(page.id)).length;
  const pages = [...remaining.slice(0, index), ...selected, ...remaining.slice(index)];
  return pages.every((page, i) => page.id === frame.pages[i]?.id) ? frame : { ...frame, pages };
}

/**
 * Insertion boundaries for the Move card. Steps are null when the order would not change.
 * `toPage(N)` puts the first moved page at page N of the result, from 1 to `lastPage`.
 */
export function pdfMoveDestinations(frame: PdfEditFrame, target: readonly string[]) {
  const moving = new Set(target);
  const indices = frame.pages.flatMap((page, index) => (moving.has(page.id) ? [index] : []));
  const staying = frame.pages.flatMap((page, index) => (moving.has(page.id) ? [] : [index]));
  const changes = (boundary: number) =>
    movePdfPages(frame, boundary, target) === frame ? null : boundary;
  return {
    start: changes(0),
    up: changes(Math.max(0, (indices[0] ?? 0) - 1)),
    down: changes(Math.min(frame.pages.length, (indices.at(-1) ?? 0) + 2)),
    end: changes(frame.pages.length),
    /** The page number the first moved page has now. */
    page: (indices[0] ?? 0) + 1,
    lastPage: staying.length + 1,
    toPage: (page: number) =>
      Number.isInteger(page) && page >= 1 && page <= staying.length + 1
        ? page === 1
          ? 0
          : staying[page - 2]! + 1
        : null,
  };
}
