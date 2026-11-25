import { describe, expect, it } from "vite-plus/test";

import { textContentText } from "../anchors/pdfTextLayer";
import {
  pdfOcrTextContent,
  type PdfOcrLine,
  type PdfOcrPageText,
  type PdfOcrViewport,
} from "./pdfOcrText";

const WIDTH = 612;
const HEIGHT = 792;
const upright: PdfOcrViewport = {
  width: WIDTH,
  height: HEIGHT,
  convertToPdfPoint: (x, y) => [x, HEIGHT - y],
};
// PDF.js at rotation 90: the image is the page turned clockwise, x along PDF y.
const turned: PdfOcrViewport = {
  width: HEIGHT,
  height: WIDTH,
  convertToPdfPoint: (x, y) => [y, x],
};

const word = (text: string, x0: number, x1: number, confidence = 90) => ({
  text,
  confidence,
  box: { x0, y0: 0.1, x1, y1: 0.12 },
});
const line = (rtl: boolean, words: PdfOcrLine["words"], y0 = 0.1): PdfOcrLine => ({
  rtl,
  box: { x0: 0, y0, x1: 1, y1: y0 + 0.02 },
  words,
});
const page = (lines: PdfOcrLine[], rotation = 0): PdfOcrPageText => ({
  recognizer: "test",
  rotation,
  lines,
});
const text = (value: PdfOcrPageText, viewport = upright) =>
  textContentText(pdfOcrTextContent(value, viewport, 0.8).items);

describe("recognized page text", () => {
  it("puts runs in the other direction back in their reading order", () => {
    // As Tesseract read the pilot's mixed page: Hebrew lines word by word from the right.
    const hebrew = page([
      line(true, [
        word("המינון", 0.8, 0.9),
        word("היה", 0.74, 0.79),
        word("‎mg‏", 0.69, 0.73),
        word("10-20", 0.6, 0.68),
        word("ליום.", 0.53, 0.58),
      ]),
      line(
        true,
        [
          word("נמדד", 0.66, 0.71),
          word("0.05", 0.6, 0.65),
          word(">", 0.58, 0.59),
          word("‎p‏", 0.55, 0.57),
          word("לאחר", 0.48, 0.54),
        ],
        0.2,
      ),
      // Numbers alone keep the line's order, and noise is dropped.
      line(true, [word("השתתפו", 0.8, 0.9), word("42", 0.7, 0.75), word("~", 0.6, 0.62, 12)], 0.3),
    ]);
    expect(text(hebrew)).toBe("המינון היה 10-20 mg ליום.\nנמדד p < 0.05 לאחר\nהשתתפו 42\n");

    // An English line read left to right reverses a Hebrew phrase inside it.
    const english = page([
      line(false, [word("See", 0.1, 0.15), word("עולם", 0.2, 0.25), word("שלום", 0.26, 0.31)]),
    ]);
    expect(text(english)).toBe("See שלום עולם\n");
  });

  it("spans each word's box at its line's height, in the page's own space", () => {
    const content = pdfOcrTextContent(
      page([line(false, [word("Dose", 0.1, 0.2), word("שלום", 0.3, 0.4)])]),
      upright,
      0.8,
    );
    const [dose, space, hebrew] = content.items;
    expect(dose).toMatchObject({ str: "Dose", dir: "ltr", hasEOL: false });
    expect(space).toMatchObject({ str: " ", hasEOL: false });
    expect(hebrew).toMatchObject({ str: "שלום", dir: "rtl", hasEOL: true });
    const lineHeight = 0.02 * HEIGHT;
    // The baseline sits at the text layer's ascent below the line's top.
    expect(dose!.transform[4]).toBeCloseTo(0.1 * WIDTH);
    expect(dose!.transform[5]).toBeCloseTo(HEIGHT - (0.1 * HEIGHT + 0.8 * lineHeight));
    expect(dose!.width).toBeCloseTo(0.1 * WIDTH);
    expect(dose!.height).toBeCloseTo(lineHeight);
    expect(dose!.transform.slice(0, 4).map((value) => Math.round(value * 1000) / 1000)).toEqual([
      Math.round(lineHeight * 1000) / 1000,
      0,
      0,
      Math.round(lineHeight * 1000) / 1000,
    ]);
    expect(content.styles[dose!.fontName]).toMatchObject({ ascent: 0.8, vertical: false });
  });

  it("keeps a page read turned a quarter turn as quarter-turn text", () => {
    const content = pdfOcrTextContent(
      page([line(false, [word("Sideways", 0.1, 0.3)])], 90),
      turned,
      0.8,
    );
    const [item] = content.items;
    // Along PDF y, upright in the turned view: what a quotable quarter turn needs.
    const [a, b, c, d] = item!.transform;
    expect(Math.abs(a!)).toBeLessThan(1e-9);
    expect(b!).toBeGreaterThan(0);
    expect(c!).toBeLessThan(0);
    expect(Math.abs(d!)).toBeLessThan(1e-9);
    expect(item!.width).toBeCloseTo(0.2 * HEIGHT);
    expect(textContentText(content.items)).toBe("Sideways\n");
  });
});
