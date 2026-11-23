import type { Element, Root } from "hast";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "~/markdown/wordsHast";
import { NOTEBOOK_MARKDOWN } from "../notebook/NotebookOutputs";

function images(tree: Root | Element): Element[] {
  return tree.children.flatMap((child) =>
    child.type !== "element" ? [] : child.tagName === "img" ? [child] : images(child),
  );
}

describe("chat image cards", () => {
  it("marks standalone figures for image cards after chat's own sanitizer", () => {
    const cards = (markdown: string) =>
      images(
        wordsHast(markdown, {
          math: true,
          breaks: false,
          escapeHtml: false,
          insights: false,
          extensions: {},
          scient: { math: true, contentDirection: "ltr" },
        }),
      ).map((image) => image.properties.dataScientImageCard);
    expect(cards("![Figure](figure.png)")).toEqual([true]);
    expect(cards("See ![Figure](figure.png) inline")).toEqual([false]);
    expect(cards('<img src="figure.png" width="20">')).toEqual([false]);
    expect(cards("| a |\n| - |\n| ![Figure](figure.png) |")).toEqual([false]);
  });
});

const notebookHtml = (markdown: string) =>
  toHtml(
    wordsHast(markdown, {
      math: true,
      breaks: false,
      escapeHtml: false,
      insights: false,
      extensions: NOTEBOOK_MARKDOWN,
      scient: { math: true, contentDirection: "ltr" },
    }),
  );

describe("notebook cell Markdown", () => {
  it("keeps inline code and diagrams but no links, images or HTML", () => {
    const html = notebookHtml(
      "Run `fit()` on [the data](https://x.dev) ![plot](https://x.dev/p.png) <b>bold</b>\n\n```mermaid\ngraph TD; A-->B\n```",
    );
    expect(html).toMatch(/<code[^>]*>fit\(\)<\/code>/);
    expect(html).toContain("language-mermaid");
    expect(html).toContain("the data");
    expect(html).toContain("plot");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("https://x.dev");
  });
});
