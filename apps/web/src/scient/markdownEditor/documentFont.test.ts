import { describe, expect, it } from "vite-plus/test";
import {
  canWriteMarkdownDocumentFont,
  readMarkdownDocumentFont,
  writeMarkdownDocumentFont,
  type MarkdownDocumentFont,
} from "./documentFont";

const none: MarkdownDocumentFont = { fontFamily: null, fontSize: null };

describe("Markdown document font front matter", () => {
  it("reads the two keys, quoted or not, with a trailing comment, and ignores unknown values", () => {
    expect(
      readMarkdownDocumentFont(
        '---\ntitle: T\nfontsize: "11pt" # base\nmainfont: Times New Roman\n---',
      ),
    ).toEqual({ fontFamily: "Times New Roman", fontSize: "11pt" });
    expect(readMarkdownDocumentFont("---\nfontsize: 14pt\nmainfont: Comic Sans\n---")).toEqual(
      none,
    );
    expect(readMarkdownDocumentFont(null)).toEqual(none);
  });

  it("creates a block when there is none, and returns null when nothing is wanted", () => {
    expect(writeMarkdownDocumentFont(null, { fontFamily: "Arial", fontSize: "12pt" })).toBe(
      "---\nfontsize: 12pt\nmainfont: Arial\n---",
    );
    expect(writeMarkdownDocumentFont(null, none)).toBeNull();
  });

  it("keeps other keys, order and line endings, and only rewrites the changed key", () => {
    const source = "---\r\ntitle: T\r\nfontsize: 10pt\r\ntags: [a]\r\n---";
    expect(writeMarkdownDocumentFont(source, { fontFamily: "Arial", fontSize: "10pt" })).toBe(
      "---\r\ntitle: T\r\nfontsize: 10pt\r\ntags: [a]\r\nmainfont: Arial\r\n---",
    );
  });

  it("leaves a size the card does not know when only the font changes", () => {
    const source = "---\nfontsize: 14pt # base size\ntitle: T\n---";
    expect(writeMarkdownDocumentFont(source, { fontFamily: "Arial", fontSize: null })).toBe(
      "---\nfontsize: 14pt # base size\ntitle: T\nmainfont: Arial\n---",
    );
  });

  it("keeps the comment when a recognised value changes", () => {
    expect(
      writeMarkdownDocumentFont("---\nfontsize: 10pt # base\n---", {
        fontFamily: null,
        fontSize: "12pt",
      }),
    ).toBe("---\nfontsize: 12pt # base\n---");
  });

  it("keeps the blank lines of the block", () => {
    const source = "---\ntitle: T\n\n# notes\ntags: [a]\n\n---";
    expect(writeMarkdownDocumentFont(source, { fontFamily: null, fontSize: "12pt" })).toBe(
      "---\ntitle: T\n\n# notes\ntags: [a]\nfontsize: 12pt\n\n---",
    );
  });

  it("removes the block when the last key goes, and refuses TOML", () => {
    expect(writeMarkdownDocumentFont("---\nfontsize: 10pt\n---", none)).toBeNull();
    expect(
      writeMarkdownDocumentFont("+++\ntitle = 'T'\n+++", { fontFamily: "Arial", fontSize: null }),
    ).toBeUndefined();
  });

  it("refuses a font key whose value spans several lines instead of corrupting the block", () => {
    const source = "---\ntitle: Original\nmainfont: |\n  Arial\n---";
    expect(canWriteMarkdownDocumentFont(source)).toBe(false);
    expect(
      writeMarkdownDocumentFont(source, { fontFamily: null, fontSize: "12pt" }),
    ).toBeUndefined();
  });
});
