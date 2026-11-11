import { describe, expect, it } from "vite-plus/test";
import { markdownFontSpanOpen, normalizeFontSize, parseMarkdownFontSpanOpen } from "./fontSpans.ts";

describe("font span forms", () => {
  it("reads and writes a size in points and a catalogue font", () => {
    expect(parseMarkdownFontSpanOpen('<span style="font-size:12pt">')).toEqual({ size: 12 });
    expect(parseMarkdownFontSpanOpen('<span style="font-size:10.5pt">')).toEqual({ size: 10.5 });
    expect(parseMarkdownFontSpanOpen(`<span style="font-family:'Times New Roman'">`)).toEqual({
      family: "Times New Roman",
    });
    expect(markdownFontSpanOpen({ size: 14 })).toBe('<span style="font-size:14pt">');
    expect(markdownFontSpanOpen({ family: "Arial" })).toBe(`<span style="font-family:'Arial'">`);
  });

  it("rejects every other form, size outside the range and unknown font names", () => {
    for (const style of [
      "font-size:1.2em",
      "font-size:12px",
      "font-size:0pt",
      "font-size:101pt",
      "font-size:12pt;color:red",
      "font-family:serif",
      `font-family:'Comic Sans MS'`,
      `font-family:'Arial';color:red`,
      `font-family:'Arial', serif`,
      `font-family:'x</span><script>'`,
    ]) {
      expect(parseMarkdownFontSpanOpen(`<span style="${style}">`), style).toBeNull();
    }
    expect(parseMarkdownFontSpanOpen('<span style="font-size:12pt" onclick="x">')).toBeNull();
  });

  it("rounds a size to two decimals and refuses values outside 1 to 100", () => {
    expect(normalizeFontSize(12.600000000000001)).toBe(12.6);
    expect(normalizeFontSize(0.5)).toBeNull();
    expect(normalizeFontSize(Number.NaN)).toBeNull();
  });
});
