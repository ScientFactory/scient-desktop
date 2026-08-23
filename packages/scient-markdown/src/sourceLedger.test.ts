import { describe, expect, it } from "vite-plus/test";

import {
  applyMarkdownSourcePatches,
  createMarkdownSourceLedger,
  replaceMarkdownSourceBlocks,
} from "./sourceLedger.ts";

const SCIENTIFIC_FIXTURE = [
  "---\r",
  "title: ניסוי\r",
  "---\r",
  "\r",
  "# Results\r",
  "\r",
  "- parent\r",
  "  - nested **item**\r",
  "\r",
  "| Group | Mean |\r",
  "| :--- | ---: |\r",
  "| A | 2.4 |\r",
  "\r",
  "$$\r",
  "E = mc^2\r",
  "$$\r",
  "\r",
  '<section data-scient="raw">keep me</section>\r',
  "",
].join("\n");

describe("createMarkdownSourceLedger", () => {
  it("round-trips a mixed scientific document byte-for-byte", () => {
    const ledger = createMarkdownSourceLedger(SCIENTIFIC_FIXTURE);

    expect(ledger.lineEnding).toBe("\r\n");
    expect(ledger.hasFinalLineEnding).toBe(true);
    expect(ledger.blocks.map((block) => block.kind)).toEqual([
      "yaml",
      "heading",
      "list",
      "table",
      "math",
      "html",
    ]);
    expect(replaceMarkdownSourceBlocks(ledger, [])).toBe(SCIENTIFIC_FIXTURE);
  });

  it("preserves every outside byte when replacing one block", () => {
    const source = "# Title\n\nParagraph with  two spaces.\n\n- one\n  - two\n";
    const ledger = createMarkdownSourceLedger(source);
    const paragraph = ledger.blocks.find((block) => block.kind === "paragraph");
    expect(paragraph).toBeDefined();

    const next = replaceMarkdownSourceBlocks(ledger, [
      { id: paragraph!.id, markdown: "Changed paragraph." },
    ]);

    expect(next).toBe("# Title\n\nChanged paragraph.\n\n- one\n  - two\n");
    expect(next.slice(0, paragraph!.start)).toBe(source.slice(0, paragraph!.start));
    expect(next.endsWith("\n\n- one\n  - two\n")).toBe(true);
  });

  it("keeps trivia when a block is deleted", () => {
    const ledger = createMarkdownSourceLedger("One\n\nTwo\n");
    expect(
      replaceMarkdownSourceBlocks(ledger, [{ id: ledger.blocks[0]!.id, markdown: null }]),
    ).toBe("\n\nTwo\n");
  });

  it("retains whitespace-only documents as prefix source", () => {
    const source = " \t\r\n\r\n";
    const ledger = createMarkdownSourceLedger(source);
    expect(ledger.blocks).toEqual([]);
    expect(ledger.prefix).toBe(source);
    expect(replaceMarkdownSourceBlocks(ledger, [])).toBe(source);
  });

  it("rejects unknown and duplicate block replacements", () => {
    const ledger = createMarkdownSourceLedger("Text\n");
    expect(() => replaceMarkdownSourceBlocks(ledger, [{ id: "missing", markdown: "x" }])).toThrow(
      "Unknown Markdown source block",
    );
    expect(() =>
      replaceMarkdownSourceBlocks(ledger, [
        { id: ledger.blocks[0]!.id, markdown: "x" },
        { id: ledger.blocks[0]!.id, markdown: "y" },
      ]),
    ).toThrow("Duplicate replacement");
  });
});

describe("applyMarkdownSourcePatches", () => {
  it("applies multiple source patches without touching surrounding Unicode", () => {
    const source = "α 😀 beta\r\nsecond line\r\n";
    const betaStart = source.indexOf("beta");
    const secondStart = source.indexOf("second");
    expect(
      applyMarkdownSourcePatches(source, [
        { start: secondStart, end: secondStart + "second".length, replacement: "שנייה" },
        { start: betaStart, end: betaStart + "beta".length, replacement: "gamma" },
      ]),
    ).toBe("α 😀 gamma\r\nשנייה line\r\n");
  });

  it("rejects overlap, split Unicode, split CRLF, and invalid bounds", () => {
    expect(() =>
      applyMarkdownSourcePatches("abcdef", [
        { start: 1, end: 4, replacement: "x" },
        { start: 3, end: 5, replacement: "y" },
      ]),
    ).toThrow("overlap");
    expect(() =>
      applyMarkdownSourcePatches("😀", [{ start: 1, end: 1, replacement: "x" }]),
    ).toThrow("surrogate pair");
    expect(() =>
      applyMarkdownSourcePatches("a\r\nb", [{ start: 2, end: 2, replacement: "x" }]),
    ).toThrow("CRLF");
    expect(() =>
      applyMarkdownSourcePatches("abc", [{ start: -1, end: 2, replacement: "x" }]),
    ).toThrow("outside");
  });
});
