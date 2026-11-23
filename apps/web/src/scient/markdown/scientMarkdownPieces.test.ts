import { splitMarkdown } from "@t3tools/shared/markdownChunks";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "../../markdown/wordsHast";
import { splitScientFileMarkdown } from "./scientMarkdownPieces";

const WHOLE_FILE_MAX_CHARS = 32 * 1024;

const paragraph =
  "The cohort was followed for twelve months, and outcomes were recorded at each visit by " +
  "assessors blinded to the allocation.";

function sections(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `## Section ${index + 1}\n\n${`${paragraph} `.repeat(4)}\n`,
  );
}

function draft(count: number): string {
  return [
    "# A paper draft",
    "",
    "Prior work disagrees on the effect size.[^1] We follow the protocol of the pilot.[^pilot]",
    "",
    ...sections(count),
    "[^1]: Smith and Lee report a smaller effect.",
    "[^pilot]: Registered before enrolment.",
  ].join("\n");
}

/** A reference near the top and `ending` many pieces later. */
function noted(reference: string, ending: string): string {
  return [`# Notes\n\nThe effect was replicated.${reference}\n`, ...sections(12), ending].join(
    "\n",
  );
}

function renderedPieces(text: string): string {
  return splitScientFileMarkdown(text)
    .chunks.map((chunk) =>
      toHtml(
        wordsHast(chunk.text, {
          math: true,
          breaks: false,
          escapeHtml: false,
          insights: false,
          extensions: {},
        }),
      ),
    )
    .join("\n");
}

const crlf = (text: string) => text.replace(/\n/g, "\r\n");

describe("splitScientFileMarkdown", () => {
  it("resolves a footnote referenced near the top of a paper and defined at its end", () => {
    const text = draft(12);
    expect(splitMarkdown(text).chunks.length).toBeGreaterThan(1);

    const html = renderedPieces(text);

    expect(html).not.toContain("[^");
    expect(html.match(/data-footnote-ref/g)).toHaveLength(2);
    expect(html.match(/<section data-footnotes/g)).toHaveLength(1);
    expect(html).toContain("Smith and Lee report a smaller effect.");
  });

  describe.each([
    ["LF", (text: string) => text],
    ["CRLF", crlf],
  ])("with %s line endings", (_endings, endings) => {
    it.each([
      ["a quote", "[^a]", "> [^a]: A quoted note."],
      ["a nested quote", "[^a]", "> Aside.\n>\n> > [^a]: A quoted note."],
      ["a list item", "[^a]", "- [^a]: A listed note."],
      ["an ordered item's continuation", "[^a]", "10. Notes.\n\n    [^a]: A listed note."],
      ["a tab-indented continuation", "[^a]", "- Notes.\n\n\t[^a]: A listed note."],
      ["a quoted list item", "[^a]", "> 1. Notes.\n>\n>    [^a]: A listed note."],
      ["a quote inside a list item", "[^a]", "- Notes.\n\n  > [^a]: A quoted note."],
      ["an escaped bracket in its label", "[^a\\]b]", "[^a\\]b]: An escaped note."],
    ])("resolves a footnote defined in %s", (_case, reference, definition) => {
      const text = endings(noted(reference, definition));
      expect(splitMarkdown(text).chunks.length).toBeGreaterThan(1);

      const html = renderedPieces(text);

      expect(html).not.toContain("[^");
      expect(html.match(/data-footnote-ref/g)).toHaveLength(1);
      expect(html).toMatch(/An? \w+ note\./);
    });

    it("keeps a small file whole for a definition-like line in code, which costs one parse", () => {
      const text = endings(noted("", "```markdown\n[^a]: Shown as code.\n```"));
      expect(splitScientFileMarkdown(text).chunks).toHaveLength(1);
      expect(renderedPieces(text)).toContain("[^a]: Shown as code.");
    });
  });

  it("keeps a footnoted file whole up to the size the preview parses at once", () => {
    const text = draft(12);
    const padded = (length: number) => `${text}\n\n${"a".repeat(length - text.length - 2)}`;

    expect(splitScientFileMarkdown(padded(WHOLE_FILE_MAX_CHARS)).chunks).toHaveLength(1);
    const over = padded(WHOLE_FILE_MAX_CHARS + 1);
    expect(splitScientFileMarkdown(over)).toEqual(splitMarkdown(over));
  });

  it("keeps the pieces for long lines of markers that define nothing", () => {
    const line = "[^".repeat(WHOLE_FILE_MAX_CHARS / 2 - 1);
    expect(splitScientFileMarkdown(line)).toEqual(splitMarkdown(line));
    // A definition's `]:` on a later line does not pair with an earlier line's marker.
    const lines = `${Array.from({ length: 400 }, () => "[^ open").join("\n")}\nclosed ]: here`;
    expect(splitScientFileMarkdown(lines)).toEqual(splitMarkdown(lines));
  });

  it("keeps the large-file pieces for a file without footnotes", () => {
    const text = draft(12).replace(/\[\^/g, "[");
    expect(splitScientFileMarkdown(text)).toEqual(splitMarkdown(text));
  });
});
