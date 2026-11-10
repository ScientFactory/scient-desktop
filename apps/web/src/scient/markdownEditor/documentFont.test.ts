import { describe, expect, it } from "vite-plus/test";
import {
  readMarkdownDocumentFont,
  writeMarkdownDocumentFont,
  type MarkdownDocumentFont,
} from "./documentFont";

const none: MarkdownDocumentFont = { fontFamily: null, fontSize: null };

describe("Markdown document font front matter", () => {
  it("reads the two keys, quoted or not, and ignores unknown values", () => {
    expect(
      readMarkdownDocumentFont('---\ntitle: T\nfont-size: "11pt"\nfont-family: sans-serif\n---'),
    ).toEqual({ fontFamily: "sans-serif", fontSize: "11pt" });
    expect(readMarkdownDocumentFont("---\nfont-size: 14pt\nfont-family: Arial\n---")).toEqual(none);
    expect(readMarkdownDocumentFont(null)).toEqual(none);
  });

  it("creates a block when there is none, and returns null when nothing is wanted", () => {
    expect(writeMarkdownDocumentFont(null, { fontFamily: "serif", fontSize: "12pt" })).toBe(
      "---\nfont-size: 12pt\nfont-family: serif\n---",
    );
    expect(writeMarkdownDocumentFont(null, none)).toBeNull();
  });

  it("keeps other keys, order and line endings", () => {
    const source = "---\r\ntitle: T\r\nfont-size: 10pt\r\ntags: [a]\r\n---";
    expect(writeMarkdownDocumentFont(source, { fontFamily: "monospace", fontSize: "12pt" })).toBe(
      "---\r\ntitle: T\r\ntags: [a]\r\nfont-size: 12pt\r\nfont-family: monospace\r\n---",
    );
  });

  it("keeps the blank lines of the block", () => {
    const source = "---\ntitle: T\n\n# notes\ntags: [a]\n\nfont-size: 10pt\n---";
    expect(writeMarkdownDocumentFont(source, { fontFamily: null, fontSize: "12pt" })).toBe(
      "---\ntitle: T\n\n# notes\ntags: [a]\nfont-size: 12pt\n\n---",
    );
  });

  it("removes the block when the last key goes, and refuses TOML", () => {
    expect(writeMarkdownDocumentFont("---\nfont-size: 10pt\n---", none)).toBeNull();
    expect(
      writeMarkdownDocumentFont("+++\ntitle = 'T'\n+++", { fontFamily: "serif", fontSize: null }),
    ).toBeUndefined();
  });
});
