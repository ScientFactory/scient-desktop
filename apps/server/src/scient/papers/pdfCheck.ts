import * as Effect from "effect/Effect";
import type { Paper } from "./paperLookup.ts";

/** Below this much text a PDF is a scan, which says nothing about whose paper it is. */
const MIN_READABLE_TEXT = 200;
const TITLE_WORDS_NEEDED = 0.6;
const PAGES_READ = 2;

/** A supplement repeats the paper's title, so only its own heading gives it away. */
const SUPPLEMENT_HEADING =
  /^\W*(?:supplementary|supporting|supplemental)\s+(?:materials?|information|data|appendix)/iu;

export interface PdfFacts {
  readonly pages: number;
  /** Its embedded title and the text of its first pages. */
  readonly text: string;
  readonly firstPage: string;
}

const wordsOf = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 3);

/**
 * Whether these bytes are the paper that was asked for. A file that can't be read for text passes:
 * only evidence refuses a PDF, because a scanned paper is still the paper.
 */
export function pdfVerdict(
  paper: Pick<Paper, "doi" | "title" | "pages">,
  facts: PdfFacts,
): "the-paper" | "preview" | "supplement" | "another-paper" {
  if (paper.pages !== undefined && paper.pages > 2 && facts.pages * 2 < paper.pages)
    return "preview";
  if (facts.text.length < MIN_READABLE_TEXT) return "the-paper";
  if (SUPPLEMENT_HEADING.test(facts.firstPage)) return "supplement";
  const text = facts.text.toLowerCase();
  if (paper.doi !== undefined && text.includes(paper.doi.toLowerCase())) return "the-paper";
  const title = wordsOf(paper.title ?? "");
  if (title.length === 0) return "the-paper";
  const found = new Set(wordsOf(facts.text));
  const matched = title.filter((word) => found.has(word)).length;
  return matched / title.length >= TITLE_WORDS_NEEDED ? "the-paper" : "another-paper";
}

/** What a PDF says about itself; nothing when it can't be parsed. */
export const readPdfFacts = (bytes: Uint8Array) =>
  Effect.tryPromise(async (): Promise<PdfFacts> => {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      // pdf.js takes the buffer for its worker, and the caller still needs the bytes.
      data: Uint8Array.from(bytes),
      disableAutoFetch: true,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    try {
      const document = await task.promise;
      const parts: string[] = [];
      let firstPage = "";
      const metadata = await document.getMetadata().catch(() => undefined);
      const title = metadata?.metadata?.get("dc:title");
      if (typeof title === "string") parts.push(title);
      for (let number = 1; number <= Math.min(PAGES_READ, document.numPages); number += 1) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        if (number === 1) firstPage = text;
        parts.push(text);
      }
      return { pages: document.numPages, text: parts.join(" "), firstPage };
    } finally {
      await task.destroy();
    }
  }).pipe(Effect.orElseSucceed(() => undefined));
