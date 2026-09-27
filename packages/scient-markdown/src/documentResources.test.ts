import { describe, expect, it } from "vite-plus/test";

import {
  inspectMarkdownDocument,
  rewriteMarkdownImageDestinations,
  resolveMarkdownDocumentRelativePath,
} from "./documentResources.ts";

describe("Markdown document inspection", () => {
  it("collects inline, reference, and raw HTML image destinations once, in order", () => {
    const inspection = inspectMarkdownDocument(
      [
        "# Results *and* `data`",
        "",
        "![Plot](figures/plot.png) and ![again](figures/plot.png)",
        "",
        "![Reference][fig]",
        "",
        '<p><img alt="raw" src="raw/scan.jpg"></p>',
        "",
        "```md",
        "![Not an image](inside/code.png)",
        "```",
        "",
        "[fig]: <figures/with space.svg>",
      ].join("\n"),
    );
    expect(inspection.imageReferences).toEqual([
      "figures/plot.png",
      "figures/with space.svg",
      "raw/scan.jpg",
    ]);
    expect(inspection.title).toBe("Results and data");
    expect(inspection.hasRawHtml).toBe(true);
  });

  it("ignores front matter, math, and documents without a level-one heading", () => {
    const inspection = inspectMarkdownDocument(
      "---\ntitle: ignored\n---\n\n## Second level\n\n$$\n\\int_0^1 x\\,dx\n$$\n",
    );
    expect(inspection).toEqual({ imageReferences: [], title: null, hasRawHtml: false });
  });
});

describe("Markdown document relative paths", () => {
  it("resolves against the document directory and drops query and fragment", () => {
    expect(resolveMarkdownDocumentRelativePath("notes/report.md", "fig%201.png?raw#x")).toBe(
      "notes/fig 1.png",
    );
    expect(resolveMarkdownDocumentRelativePath("notes/deep/report.md", "../img/a.png")).toBe(
      "notes/img/a.png",
    );
    expect(resolveMarkdownDocumentRelativePath("report.md", "./a\\b.png")).toBe("a/b.png");
  });

  it("rejects absolute, scheme, escaping, and malformed destinations", () => {
    for (const destination of [
      "/etc/passwd",
      "https://example.com/a.png",
      "data:image/png;base64,AA",
      "file:///tmp/a.png",
      "../outside.png",
      "%E0%A4%A",
      "",
    ]) {
      expect(resolveMarkdownDocumentRelativePath("report.md", destination)).toBeNull();
    }
  });
});

describe("Markdown image destination rewriting", () => {
  it("rewrites inline, reference, and raw HTML images without touching other text", () => {
    const source = [
      "# Figures",
      "",
      'Inline ![Plot](figures/plot.png "Title") and a link [plot](figures/plot.png).',
      "",
      "![Ref][fig] ![Spaced](<figures/with space.png>)",
      "",
      "`![code](figures/plot.png)`",
      "",
      "<img alt='raw' src='raw/scan.jpg'>",
      "",
      "[fig]:",
      "  figures/ref.svg",
      "[unused]: figures/unused.png",
    ].join("\n");
    const mapping = new Map([
      ["figures/plot.png", "scient-asset:img-1"],
      ["figures/ref.svg", "scient-asset:img-2"],
      ["figures/with space.png", "scient-asset:img-3"],
      ["raw/scan.jpg", "scient-asset:img-4"],
      ["figures/unused.png", "scient-asset:never"],
    ]);
    const result = rewriteMarkdownImageDestinations(
      source,
      (destination) => mapping.get(destination) ?? null,
    );
    expect(result.unlocated).toEqual([]);
    expect(result.markdown).toBe(
      [
        "# Figures",
        "",
        'Inline ![Plot](scient-asset:img-1 "Title") and a link [plot](figures/plot.png).',
        "",
        "![Ref][fig] ![Spaced](<scient-asset:img-3>)",
        "",
        "`![code](figures/plot.png)`",
        "",
        "<img alt='raw' src='scient-asset:img-4'>",
        "",
        "[fig]:",
        "  scient-asset:img-2",
        "[unused]: figures/unused.png",
      ].join("\n"),
    );
    expect(inspectMarkdownDocument(result.markdown).imageReferences).toEqual([
      "scient-asset:img-1",
      "scient-asset:img-2",
      "scient-asset:img-3",
      "scient-asset:img-4",
    ]);
  });

  it("keeps destinations the callback declines and reports ones it cannot locate", () => {
    const source = "![a](https://example.com/a.png) ![b](fig&#46;png)\n";
    const result = rewriteMarkdownImageDestinations(source, (destination) =>
      destination.startsWith("https:") ? null : "scient-asset:x",
    );
    expect(result.markdown).toBe(source);
    expect(result.unlocated).toEqual(["fig.png"]);
  });
});
