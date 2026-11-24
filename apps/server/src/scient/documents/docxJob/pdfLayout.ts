import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface PdfTextItem {
  readonly str: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly size: number;
}

export interface PdfLayout {
  readonly pages: ReadonlyArray<ReadonlyArray<PdfTextItem>>;
  readonly fonts: ReadonlyArray<string>;
  readonly unembeddedFonts: ReadonlyArray<string>;
  readonly producer: string | null;
}

export class PdfLayoutError extends Schema.TaggedError<PdfLayoutError>()("PdfLayoutError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The PDF could not be read for layout checks.";
  }
}

const MAX_PAGES = 200;

interface FontObject {
  readonly name?: unknown;
  readonly missingFile?: unknown;
}

/** Positioned text and font facts of every page, as pdf.js reads them without rendering. */
export const readPdfLayout = Effect.fn("DocxJob.readPdfLayout")(function* (bytes: Uint8Array) {
  return yield* Effect.tryPromise({
    try: async (): Promise<PdfLayout> => {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = getDocument({
        data: Uint8Array.from(bytes),
        disableAutoFetch: true,
        disableFontFace: true,
        useSystemFonts: false,
        verbosity: 0,
      });
      try {
        const document = await task.promise;
        if (document.numPages > MAX_PAGES) throw new Error("Too many pages for layout checks.");
        const metadata = await document.getMetadata().catch(() => undefined);
        const info = metadata?.info as { readonly Producer?: unknown } | undefined;
        const fonts = new Set<string>();
        const unembedded = new Set<string>();
        const pages: PdfTextItem[][] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const page = await document.getPage(number);
          await page.getOperatorList();
          const content = await page.getTextContent();
          const items: PdfTextItem[] = [];
          for (const item of content.items) {
            if (!("str" in item)) continue;
            const font = page.commonObjs.has(item.fontName)
              ? (page.commonObjs.get(item.fontName) as FontObject | undefined)
              : undefined;
            const name = typeof font?.name === "string" ? font.name : item.fontName;
            if (item.str.trim() !== "") {
              fonts.add(name);
              if (font?.missingFile === true) unembedded.add(name);
            }
            const [a = 0, b = 0, , , x = 0, y = 0] = item.transform as ReadonlyArray<number>;
            items.push({ str: item.str, x, y, width: item.width, size: Math.hypot(a, b) });
          }
          pages.push(items);
        }
        return {
          pages,
          fonts: [...fonts].sort(),
          unembeddedFonts: [...unembedded].sort(),
          producer: typeof info?.Producer === "string" ? info.Producer : null,
        };
      } finally {
        await task.destroy();
      }
    },
    catch: (cause) => new PdfLayoutError({ cause }),
  });
});

export interface PdfCheck {
  readonly id:
    | "pdf-page-count"
    | "pdf-source-text-located"
    | "pdf-tracked-text-shown"
    | "pdf-edit-placement"
    | "pdf-earlier-pages-unchanged"
    | "pdf-text-sequence-preserved"
    | "pdf-fonts-embedded";
  readonly passed: boolean;
}

interface Located {
  readonly page: number;
  readonly offset: number;
  readonly item: PdfTextItem;
}

const strip = (value: string) => value.replace(/\s+/gu, "");

function indexPage(items: ReadonlyArray<PdfTextItem>) {
  let end = 0;
  const ends: number[] = [];
  const pieces = items.map((item) => {
    const piece = strip(item.str);
    end += piece.length;
    ends.push(end);
    return piece;
  });
  return {
    text: pieces.join(""),
    itemAt: (offset: number) => items[ends.findIndex((end) => offset < end)]!,
  };
}

function locate(pages: ReadonlyArray<ReturnType<typeof indexPage>>, needle: string) {
  const found: Located[] = [];
  if (needle === "") return found;
  for (const [page, { text, itemAt }] of pages.entries()) {
    for (
      let offset = text.indexOf(needle);
      offset !== -1;
      offset = text.indexOf(needle, offset + 1)
    ) {
      found.push({ page, offset, item: itemAt(offset) });
      if (found.length > 1) return found;
    }
  }
  return found;
}

const sameLine = (a: PdfTextItem, b: PdfTextItem) =>
  Math.abs(a.y - b.y) <= Math.max(a.size, b.size) * 0.5;

function editIsPlaced(original: PdfTextItem, deleted: PdfTextItem, inserted: PdfTextItem) {
  if (!sameLine(deleted, original)) return false;
  const onSameLine = sameLine(inserted, deleted);
  const tolerance = Math.max(original.size, deleted.size, inserted.size) * 1.5;
  const left = onSameLine ? Math.min(deleted.x, inserted.x) : deleted.x;
  const right = onSameLine
    ? Math.max(deleted.x + deleted.width, inserted.x + inserted.width)
    : deleted.x + deleted.width;
  if (left > original.x + original.width + tolerance || right < original.x - tolerance)
    return false;
  if (onSameLine) {
    if (inserted === deleted) return true;
    const gap = Math.min(
      Math.abs(inserted.x - (deleted.x + deleted.width)),
      Math.abs(deleted.x - (inserted.x + inserted.width)),
    );
    return gap <= tolerance;
  }
  const drop = deleted.y - inserted.y;
  return drop > 0 && drop <= Math.max(inserted.size, deleted.size) * 2.5;
}

const pageSignature = (items: ReadonlyArray<PdfTextItem>) =>
  JSON.stringify(items.map((item) => [item.str, Math.round(item.x * 10), Math.round(item.y * 10)]));

export interface PdfPlacement {
  readonly checks: ReadonlyArray<PdfCheck>;
  readonly passed: boolean;
  readonly pageCount: number;
  /** 1-based page of the edit, when it was found. */
  readonly editPage: number | null;
}

/**
 * The candidate render against the source render: same page count, the tracked deletion where
 * the original text was, the insertion beside it or on the next line, earlier pages unchanged,
 * and the whole text in order with only the insertion added. LibreOffice draws recorded changes,
 * so both the deleted and the inserted text appear.
 */
export function checkPdfPlacement(
  source: PdfLayout,
  candidate: PdfLayout,
  find: string,
  replace: string,
): PdfPlacement {
  const checks: PdfCheck[] = [];
  checks.push({ id: "pdf-page-count", passed: source.pages.length === candidate.pages.length });
  const needle = strip(find);
  const addition = strip(replace);
  const sourcePages = source.pages.map(indexPage);
  const candidatePages = candidate.pages.map(indexPage);
  const original = locate(sourcePages, needle);
  checks.push({ id: "pdf-source-text-located", passed: original.length === 1 });
  const at = original.length === 1 ? original[0] : undefined;
  const editedPage = at === undefined ? undefined : candidatePages[at.page];
  const edits: Array<{ deleted: PdfTextItem; inserted: PdfTextItem }> = [];
  if (at !== undefined && editedPage !== undefined && addition !== "") {
    const { offset } = at;
    const span = editedPage.text.slice(offset, offset + needle.length + addition.length);
    if (span === needle + addition) {
      edits.push({
        deleted: editedPage.itemAt(offset),
        inserted: editedPage.itemAt(offset + needle.length),
      });
    }
    if (span === addition + needle) {
      edits.push({
        deleted: editedPage.itemAt(offset + addition.length),
        inserted: editedPage.itemAt(offset),
      });
    }
  }
  checks.push({ id: "pdf-tracked-text-shown", passed: edits.length > 0 });
  checks.push({
    id: "pdf-edit-placement",
    passed:
      at !== undefined &&
      edits.some(({ deleted, inserted }) => editIsPlaced(at.item, deleted, inserted)),
  });

  const earlier =
    at !== undefined &&
    source.pages
      .slice(0, at.page)
      .every((items, page) => pageSignature(items) === pageSignature(candidate.pages[page] ?? []));
  checks.push({ id: "pdf-earlier-pages-unchanged", passed: earlier });

  const sourceText = sourcePages.map(({ text }) => text).join("");
  const candidateText = candidatePages.map(({ text }) => text).join("");
  const index =
    at === undefined
      ? -1
      : sourcePages.slice(0, at.page).reduce((sum, { text }) => sum + text.length, at.offset);
  const sequence =
    index !== -1 &&
    addition !== "" &&
    [index, index + needle.length].some(
      (offset) =>
        candidateText === sourceText.slice(0, offset) + addition + sourceText.slice(offset),
    );
  checks.push({ id: "pdf-text-sequence-preserved", passed: sequence });
  checks.push({ id: "pdf-fonts-embedded", passed: candidate.unembeddedFonts.length === 0 });
  return {
    checks,
    passed: checks.every((check) => check.passed),
    pageCount: candidate.pages.length,
    editPage: at === undefined ? null : at.page + 1,
  };
}
