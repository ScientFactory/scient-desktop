/**
 * Recognized page text, as stored, and the PDF.js text content built from it. The text layer,
 * find, selection, quotes and annotations all read that content as they read a PDF's own text.
 */

/**
 * What produced a stored recognition: engine, language data and the rendering it read. A
 * change here invalidates cached recognitions.
 */
export const PDF_OCR_RECOGNIZER = "tesseract-5/tesseract.js-7.0.0/eng+heb-4.0.0_best_int/300dpi";
/** How stored words become text; a change re-derives text from cached recognitions. */
const PDF_OCR_TEXT_BUILD = "lines-v1";
/** Recorded with quotes and annotations taken from recognized text. */
export const PDF_OCR_ENGINE = `${PDF_OCR_RECOGNIZER} ${PDF_OCR_TEXT_BUILD}`;

/**
 * Recognized words in a text layer sit in a marked-content span whose id starts with this;
 * the rest of the id keeps it unique in the document.
 */
export const PDF_OCR_LAYER_ID = "scient-ocr-text-";

/** Whether a rendered PDF.js text layer holds recognized text. */
export function pdfTextLayerHasOcr(layer: Element): boolean {
  return layer.querySelector(`[id^="${PDF_OCR_LAYER_ID}"]`) !== null;
}

/** Fewer non-space characters than this, on a page mostly covered by images, is a scan. */
export const PDF_NATIVE_TEXT_LIMIT = 160;
/** Words read with less confidence are dropped as noise. */
const MIN_WORD_CONFIDENCE = 30;

/** A box in the recognized image, as fractions of its width and height (y down). */
export interface PdfOcrBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface PdfOcrWord {
  readonly text: string;
  readonly box: PdfOcrBox;
  readonly confidence: number;
}

export interface PdfOcrLine {
  readonly box: PdfOcrBox;
  /** The paragraph reads right to left. */
  readonly rtl: boolean;
  /** In the engine's reading order. */
  readonly words: ReadonlyArray<PdfOcrWord>;
}

export interface PdfOcrPageText {
  readonly recognizer: string;
  /** The page rotation the image was rendered with, in degrees (PDF.js viewport rotation). */
  readonly rotation: number;
  readonly lines: ReadonlyArray<PdfOcrLine>;
}

/** The parts of a PDF.js page viewport the builder uses: scale 1, the recognized rotation. */
export interface PdfOcrViewport {
  readonly width: number;
  readonly height: number;
  convertToPdfPoint(x: number, y: number): number[];
}

export interface PdfOcrTextItem {
  readonly str: string;
  readonly dir: "ltr" | "rtl";
  readonly width: number;
  readonly height: number;
  readonly transform: number[];
  readonly fontName: string;
  readonly hasEOL: boolean;
}

export interface PdfOcrTextContent {
  readonly items: ReadonlyArray<PdfOcrTextItem>;
  readonly styles: Record<
    string,
    { fontFamily: string; ascent: number; descent: number; vertical: boolean }
  >;
}

const OCR_FONT = "scient-ocr";
const DIRECTION_MARKS = /[؜‎‏‪-‮⁦-⁩]/gu;
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}]/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MIRRORED: Record<string, string> = {
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
  "«": "»",
  "»": "«",
};

interface PlacedWord {
  readonly text: string;
  readonly box: PdfOcrBox;
}

function mirror(text: string): string {
  return [...text].map((character) => MIRRORED[character] ?? character).join("");
}

/**
 * The engine reads a line in the paragraph's direction word by word, so a run in the other
 * direction comes out backwards: "10-20 mg" in a Hebrew line reads "mg 10-20", and its
 * brackets come out mirrored. Such runs are put back in their own reading order.
 */
function readingOrder(line: PdfOcrLine): PlacedWord[] {
  const words = line.words
    .filter((word) => word.confidence >= MIN_WORD_CONFIDENCE)
    .map((word) => ({
      text: word.text.replace(DIRECTION_MARKS, "").normalize("NFC"),
      box: word.box,
    }))
    .filter((word) => word.text.trim().length > 0);
  const inRun = (text: string) => (line.rtl ? !RTL_LETTER.test(text) : RTL_LETTER.test(text));
  const anchorsRun = (text: string) => (line.rtl ? LATIN_LETTER.test(text) : RTL_LETTER.test(text));
  const ordered: PlacedWord[] = [];
  let index = 0;
  while (index < words.length) {
    if (!inRun(words[index]!.text)) {
      ordered.push(words[index]!);
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && inRun(words[end]!.text)) end += 1;
    // Bare punctuation at a run's edge belongs to the surrounding line.
    let first = index;
    let last = end;
    while (first < last && !LETTER_OR_DIGIT.test(words[first]!.text)) first += 1;
    while (last > first && !LETTER_OR_DIGIT.test(words[last - 1]!.text)) last -= 1;
    const run = words.slice(first, last);
    ordered.push(...words.slice(index, first));
    if (run.length > 1 && run.some((word) => anchorsRun(word.text))) {
      const sorted = run.toSorted((a, b) => (line.rtl ? a.box.x0 - b.box.x0 : b.box.x1 - a.box.x1));
      ordered.push(
        ...(line.rtl ? sorted.map((word) => ({ ...word, text: mirror(word.text) })) : sorted),
      );
    } else {
      ordered.push(...run);
    }
    ordered.push(...words.slice(last, end));
    index = end;
  }
  return ordered;
}

function subtract(a: number[], b: number[]): [number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!];
}

/**
 * Text content for a recognized page. Each word is an item spanning its box across the line's
 * height, so selections and highlights cover words, not glyphs. Words are separated by a space
 * item and lines end with a line break, the profile the text layer and quotes use. `ascent` is
 * the text layer's measured ascent ratio for its font, so spans sit on the recognized line.
 */
export function pdfOcrTextContent(
  page: PdfOcrPageText,
  viewport: PdfOcrViewport,
  ascent: number,
): PdfOcrTextContent {
  const items: PdfOcrTextItem[] = [];
  const toPdf = (x: number, y: number) =>
    viewport.convertToPdfPoint(x * viewport.width, y * viewport.height);
  for (const line of page.lines) {
    const words = readingOrder(line);
    const top = line.box.y0;
    const bottom = line.box.y1;
    if (!(bottom > top)) continue;
    const baseline = top + (bottom - top) * ascent;
    let previous: PdfOcrTextItem | null = null;
    for (const word of words) {
      const origin = toPdf(word.box.x0, baseline);
      const along = subtract(toPdf(word.box.x1, baseline), origin);
      const up = subtract(toPdf(word.box.x0, baseline - (bottom - top)), origin);
      const width = Math.hypot(along[0], along[1]);
      const size = Math.hypot(up[0], up[1]);
      if (!(width > 0) || !(size > 0)) continue;
      const dir = RTL_LETTER.test(word.text) || (line.rtl && !LETTER_OR_DIGIT.test(word.text));
      const transform = [
        (along[0] * size) / width,
        (along[1] * size) / width,
        up[0],
        up[1],
        origin[0]!,
        origin[1]!,
      ];
      if (previous) {
        // A space after the previous word, just past its trailing edge.
        const [a, b, , , e, f] = previous.transform;
        const unit = [a! / previous.height, b! / previous.height];
        const step = previous.dir === "rtl" ? -0.3 * previous.height : previous.width;
        const at = [e! + unit[0]! * step, f! + unit[1]! * step];
        items.push({
          str: " ",
          dir: previous.dir,
          width: 0,
          height: previous.height,
          transform: [...previous.transform.slice(0, 4), at[0]!, at[1]!],
          fontName: OCR_FONT,
          hasEOL: false,
        });
      }
      previous = {
        str: word.text,
        dir: dir ? "rtl" : "ltr",
        width,
        height: size,
        transform,
        fontName: OCR_FONT,
        hasEOL: false,
      };
      items.push(previous);
    }
    if (previous) items[items.length - 1] = { ...previous, hasEOL: true };
  }
  return {
    items,
    styles: {
      [OCR_FONT]: { fontFamily: "sans-serif", ascent, descent: ascent - 1, vertical: false },
    },
  };
}

/** Non-space characters in PDF.js text content items. */
export function textContentCharacters(items: ReadonlyArray<object>): number {
  let count = 0;
  for (const item of items) {
    if ("str" in item && typeof item.str === "string") count += item.str.replace(/\s/gu, "").length;
  }
  return count;
}
