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
  readonly item: PdfTextItem;
}

const strip = (value: string) => value.replace(/\s+/gu, "");

function locate(layout: PdfLayout, needle: string): ReadonlyArray<Located> {
  const wanted = strip(needle);
  const found: Located[] = [];
  layout.pages.forEach((items, page) => {
    let stream = "";
    const owner: number[] = [];
    items.forEach((item, index) => {
      for (const c of strip(item.str)) {
        stream += c;
        for (let unit = 0; unit < c.length; unit += 1) owner.push(index);
      }
    });
    for (let at = stream.indexOf(wanted); at !== -1; at = stream.indexOf(wanted, at + 1)) {
      found.push({ page, item: items[owner[at]!]! });
    }
  });
  return found;
}

const sameLine = (a: PdfTextItem, b: PdfTextItem) =>
  Math.abs(a.y - b.y) <= Math.max(a.size, b.size) * 0.5;

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
  const original = locate(source, find);
  checks.push({ id: "pdf-source-text-located", passed: original.length === 1 });
  const deleted = locate(candidate, find);
  const sourceReplacements = locate(source, replace).length;
  const inserted = locate(candidate, replace);
  const at = original[0];
  const shown =
    at !== undefined &&
    deleted.length === 1 &&
    deleted[0]!.page === at.page &&
    inserted.length === sourceReplacements + 1 &&
    inserted.some((entry) => entry.page === at.page);
  checks.push({ id: "pdf-tracked-text-shown", passed: shown });

  let placed = false;
  if (shown) {
    const del = deleted[0]!.item;
    placed =
      sameLine(del, at.item) &&
      inserted.some(({ page, item }) => {
        if (page !== at.page) return false;
        if (sameLine(item, del)) {
          const gap = Math.min(
            Math.abs(item.x - (del.x + del.width)),
            Math.abs(del.x - (item.x + item.width)),
          );
          return gap <= Math.max(item.size, del.size) * 1.5;
        }
        const drop = del.y - item.y;
        return drop > 0 && drop <= Math.max(item.size, del.size) * 2.5;
      });
  }
  checks.push({ id: "pdf-edit-placement", passed: placed });

  const earlier =
    at !== undefined &&
    source.pages
      .slice(0, at.page)
      .every((items, page) => pageSignature(items) === pageSignature(candidate.pages[page] ?? []));
  checks.push({ id: "pdf-earlier-pages-unchanged", passed: earlier });

  const whole = (layout: PdfLayout) =>
    layout.pages.map((items) => items.map((item) => strip(item.str)).join("")).join("");
  const sourceText = whole(source);
  const candidateText = whole(candidate);
  const needle = strip(find);
  const index = sourceText.indexOf(needle);
  const addition = strip(replace);
  const sequence =
    index !== -1 &&
    sourceText.indexOf(needle, index + 1) === -1 &&
    (candidateText ===
      sourceText.slice(0, index + needle.length) +
        addition +
        sourceText.slice(index + needle.length) ||
      candidateText === sourceText.slice(0, index) + addition + sourceText.slice(index));
  checks.push({ id: "pdf-text-sequence-preserved", passed: sequence });
  checks.push({ id: "pdf-fonts-embedded", passed: candidate.unembeddedFonts.length === 0 });
  return {
    checks,
    passed: checks.every((check) => check.passed),
    pageCount: candidate.pages.length,
    editPage: at === undefined ? null : at.page + 1,
  };
}
