import type { Element, Root } from "hast";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast, type MarkdownExtensions } from "~/markdown/wordsHast";
import { isScientMathCodeClassName } from "./scientWordsMath";

const chatHast = (markdown: string, extensions: MarkdownExtensions = {}, insights = false) =>
  wordsHast(markdown, {
    math: true,
    breaks: false,
    escapeHtml: false,
    insights,
    extensions,
    scient: { math: true, contentDirection: "ltr" },
  });

interface Formula {
  readonly kind: "inline" | "display";
  readonly tex: string;
  readonly source: unknown;
}

function formulas(node: Root | Element): Formula[] {
  return node.children.flatMap((child): Formula[] => {
    if (child.type !== "element") return [];
    const className = child.properties.className;
    if (child.tagName === "code" && Array.isArray(className) && className.includes("language-math"))
      return [
        {
          kind: className.includes("math-display") ? "display" : "inline",
          tex: child.children.map((text) => (text.type === "text" ? text.value : "")).join(""),
          source: child.properties.dataScientMathSource,
        },
      ];
    if (child.tagName === "pre" && child.properties.dataScientMathSource !== undefined) {
      return formulas(child).map((formula) => ({
        ...formula,
        source: child.properties.dataScientMathSource,
      }));
    }
    return formulas(child);
  });
}

describe("isScientMathCodeClassName", () => {
  it("recognizes the language-math token", () => {
    expect(isScientMathCodeClassName("language-math")).toBe(true);
    expect(isScientMathCodeClassName("language-math math-inline")).toBe(true);
  });

  it("rejects other languages and absent class names", () => {
    expect(isScientMathCodeClassName("language-ts")).toBe(false);
    expect(isScientMathCodeClassName("language-mathml")).toBe(false);
    expect(isScientMathCodeClassName(undefined)).toBe(false);
  });
});

describe("Scient math on Words", () => {
  it("reads the math Words reads and keeps prices and shell variables as text", () => {
    const tree = chatHast(
      "Area $\\pi r^2$ costs $5 and $10, $3.50 to $4.00; $HOME/$USER and $PATH$ stay.",
    );
    expect(formulas(tree)).toEqual([{ kind: "inline", tex: "\\pi r^2", source: "$\\pi r^2$" }]);
    expect(toHtml(tree)).toContain(
      "costs $5 and $10, $3.50 to $4.00; $HOME/$USER and $PATH$ stay.",
    );
  });

  it("lets math bind tighter than emphasis, as a code span does", () => {
    expect(formulas(chatHast("$b* c$"))).toEqual([
      { kind: "inline", tex: "b* c", source: "$b* c$" },
    ]);
  });

  it("keeps authored backslash intent: \\( inline, \\[ display that breaks its paragraph", () => {
    const tree = chatHast("Before \\(x\\) and\n\\[\nE = mc^2\n\\]\nafter.");
    expect(formulas(tree)).toEqual([
      { kind: "inline", tex: "x", source: "\\(x\\)" },
      { kind: "display", tex: "E = mc^2", source: "\\[\nE = mc^2\n\\]" },
    ]);
    expect(
      tree.children.flatMap((child) => (child.type === "element" ? [child.tagName] : [])),
    ).toEqual(["p", "pre", "p"]);
  });

  it("shows $$ alone on its line as display math and $$ beside prose inline", () => {
    expect(formulas(chatHast("$$x$$")).map((formula) => formula.kind)).toEqual(["display"]);
    expect(formulas(chatHast("- $$x$$")).map((formula) => formula.kind)).toEqual(["display"]);
    const ownLine = chatHast("text\n$$x$$\nmore");
    expect(formulas(ownLine).map((formula) => formula.kind)).toEqual(["display"]);
    expect(
      ownLine.children.flatMap((child) => (child.type === "element" ? [child.tagName] : [])),
    ).toEqual(["p", "pre", "p"]);
    expect(formulas(chatHast("p $$x$$ q")).map((formula) => formula.kind)).toEqual(["inline"]);
    expect(formulas(chatHast("- item $$x$$")).map((formula) => formula.kind)).toEqual(["inline"]);
  });

  it("keeps table rows whole when a formula holds pipes", () => {
    const tree = chatHast(
      "| Name | Formula |\n| --- | --- |\n| Norm | $|x|$ and \\(\\|y\\|\\) |\n| Price | $5 and $10 |",
    );
    expect(formulas(tree).map((formula) => formula.tex)).toEqual(["|x|", "\\|y\\|"]);
    expect(toHtml(tree).match(/<tr/g)).toHaveLength(3);
    expect(toHtml(tree).match(/<td/g)).toHaveLength(4);
  });

  it("leaves code, raw code regions and unclosed blocks literal", () => {
    expect(formulas(chatHast("`$x$` and <code>$y$</code>"))).toEqual([]);
    expect(toHtml(chatHast("`$x$` and <code>$y$</code>"))).toContain('dir="ltr">$y$</code>');
    const fence = chatHast("```math\nx^2");
    expect(formulas(fence)).toEqual([]);
    expect(toHtml(fence)).not.toContain("language-math");
    const streaming = chatHast("$$\nx + y");
    expect(formulas(streaming)).toEqual([]);
    expect(toHtml(streaming)).toBe('<p dir="ltr">$$\nx + y</p>');
    const oversized = chatHast(`$$\n${"x".repeat(1001)}\n$$`);
    expect(formulas(oversized)).toEqual([]);
    expect(toHtml(oversized)).toContain(`<pre><code>$$\n${"x".repeat(1001)}\n$$</code></pre>`);
    expect(formulas(chatHast("```math\nx^2\n```"))).toEqual([
      { kind: "display", tex: "x^2", source: "```math\nx^2\n```" },
    ]);
  });

  it("reads display math in an over-indented list item that Words renders again", () => {
    expect(formulas(chatHast("-       intro\n\n        $$\n        x^2\n        $$"))).toEqual([
      expect.objectContaining({ kind: "display", tex: "x^2" }),
    ]);
  });

  it("keeps math inline in a one-line preview", () => {
    const tree = chatHast("Plan\n\n$$\nx\n$$\n\nand $y$", {
      preview: { fallback: "", maxLength: 80 },
    });
    expect(formulas(tree).map((formula) => formula.kind)).toEqual(["inline", "inline"]);
  });

  it("keeps the block after a display formula a block", () => {
    for (const formula of ["$$\nx^2\n$$", "```math\nx^2\n```", "\\[x^2\\]"]) {
      const tree = chatHast(`${formula}\n---\nafter`);
      expect(formulas(tree)).toEqual([expect.objectContaining({ kind: "display", tex: "x^2" })]);
      const html = toHtml(tree);
      expect(html).toContain("<hr>");
      expect(html).not.toContain("<h1");
      expect(html).not.toContain("<h2");
    }
    const atx = toHtml(chatHast("# \\[x\\]\n---"));
    expect(atx).toMatch(/<h1[^>]*>/);
    expect(atx.match(/<hr>/g)).toHaveLength(1);
    expect(toHtml(chatHast("\\[x^2\\]\n===\nafter"))).toMatch(/<\/pre>\n<p[^>]*>===<\/p>/);
    const indented = toHtml(chatHast("```math\nx\n```\n    code line"));
    expect(indented).toMatch(/<pre[^>]*><code[^>]*>code line/);
    expect(toHtml(chatHast("> $$\n> y\n> $$\n> ---"))).toContain("<hr>");
    const crlf = toHtml(chatHast("$$\r\nx\r\n$$\r\n---\r\nafter"));
    expect(crlf).toContain("<hr>");
    expect(crlf).not.toContain("<h2");
  });

  it("keeps a heading the author wrote", () => {
    const html = toHtml(chatHast("# Title $x$\n\n$$\ny\n$$"));
    expect(html).toMatch(/<h1[^>]*>Title /);
    expect(formulas(chatHast("# Title $x$\n\n$$\ny\n$$")).map((f) => f.kind)).toEqual([
      "inline",
      "display",
    ]);
  });

  it("keeps the message's own source for a formula inside an insight block", () => {
    const tree = chatHast("`★ Insight ─────`\n$$\nx\ny\n$$\n`─────`", {}, true);
    expect(formulas(tree)).toEqual([{ kind: "display", tex: "x\ny", source: "$$\nx\ny\n$$" }]);
  });

  it("restores a formula's source wherever it cannot be math", () => {
    const html = toHtml(chatHast("![a $x$ b](img.png) and [see](https://x.dev/$y$)"));
    expect(html).toContain('alt="a $x$ b"');
    expect(html).not.toMatch(/[\uFDD0\uFDD1]/u);
  });
});
