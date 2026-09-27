// @vitest-environment happy-dom
import type { ScientDocumentPageInput } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as katex from "../math/katexRuntime";
import { countDocumentBlocks, DocumentPageTracker } from "./documentPageReadiness";
import { ScientDocumentPage, SHORT_CODE_BLOCK_LINES } from "./ScientDocumentPage";

const PARSE_ERROR =
  "Parse error on line 2:\nflowchart LR broken\n-------------^\nExpecting 'SEMI', 'NEWLINE', got 'NODE_STRING'";

vi.mock("../diagrams/mermaidRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diagrams/mermaidRuntime")>();
  return {
    ...actual,
    renderMermaidDiagram: vi.fn(async (source: string) => {
      if (source.includes("broken")) throw new actual.MermaidRenderError(new Error(PARSE_ERROR));
      if (source.includes("chunk")) {
        throw new actual.MermaidRenderError(
          new TypeError("Failed to fetch dynamically imported module: /assets/mermaid.js"),
        );
      }
      return { svg: '<svg data-test-diagram="yes"><text>Rendered diagram</text></svg>' };
    }),
  };
});

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  while (roots.length > 0) await act(() => roots.pop()!.unmount());
  document.body.replaceChildren();
});

const input = (markdown: string, overrides: Partial<ScientDocumentPageInput> = {}) =>
  ({
    protocol: 1,
    captureId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    documentKind: "workspace-file",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    profile: "document",
    title: "Fixture title",
    language: null,
    direction: "auto",
    createdAt: null,
    markdown,
    assets: [
      {
        id: "image-0001",
        role: "image",
        fileName: "plot.png",
        mediaType: "image/png",
        content: { _tag: "captured", path: "assets/0001.png" },
      },
      {
        id: "image-0002",
        role: "image",
        fileName: "missing.png",
        mediaType: "application/octet-stream",
        content: { _tag: "unavailable", reason: "missing" },
      },
      {
        id: "attachment-1",
        role: "attachment",
        fileName: "data.csv",
        mediaType: "text/csv",
        content: { _tag: "unavailable", reason: "unsupported" },
      },
    ],
    warnings: [{ code: "resource-unresolved", message: "Bundle warning one." }],
    ...overrides,
  }) satisfies ScientDocumentPageInput;

async function renderPage(page: ScientDocumentPageInput, renderWarnings: string[] = []) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const tracker = new DocumentPageTracker();
  await act(async () => {
    root.render(
      <ScientDocumentPage
        input={page}
        inputUrl={new URL("https://environment.test/api/assets/token/document.json")}
        katex={katex}
        tracker={tracker}
        renderWarnings={renderWarnings}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { article: container.querySelector<HTMLElement>("article")!, tracker };
}

describe("ScientDocumentPage", () => {
  it("renders the complete document in print form without chat interaction", async () => {
    const longCode = Array.from({ length: SHORT_CODE_BLOCK_LINES + 5 }, (_, i) => `line ${i}`);
    const { article, tracker } = await renderPage(
      input(
        [
          "Intro with $x^2$ and a [web link](https://example.com) and [a file](notes/other.md).",
          "",
          "## Section",
          "",
          "$$",
          "\\frac{1}{2}",
          "$$",
          "",
          "```ts",
          "const short = 1;",
          "```",
          "",
          "```python",
          ...longCode,
          "```",
          "",
          "| A | B |",
          "| - | - |",
          "| 1 | 2 |",
          "",
          '![Plot](scient-asset:image-0001 "Figure caption") ![Gone](scient-asset:image-0002)',
          "",
          "![Remote](https://example.com/r.png) ![Local](figures/x.png)",
          "",
          "[data.csv](scient-asset:attachment-1)",
          "",
          "<details><summary>More</summary>Hidden text</details>",
          "",
          '<iframe src="https://example.com"></iframe>',
          "",
          "```mermaid",
          "flowchart LR",
          "  A --> B",
          "```",
          "",
          "```vega-lite",
          "{}",
          "```",
          "",
          "[jump](#section)",
        ].join("\n"),
      ),
      ["A limitation found while rendering."],
    );

    // The title becomes the level-one heading the PDF outline needs.
    expect(article.querySelector("h1")?.textContent).toBe("Fixture title");
    expect(article.querySelector("a[href='https://example.com']")?.textContent).toBe("web link");
    expect(article.querySelector(".scient-document-inert-link")?.textContent).toBe("a file");
    expect(article.querySelector("a[href*='notes/other.md']")).toBeNull();
    expect(article.querySelector(".scient-document-attachment")?.textContent).toBe(
      "data.csv (attachment: data.csv)",
    );
    const image = article.querySelector<HTMLImageElement>("img[data-scient-asset='image-0001']");
    expect(image?.getAttribute("src")).toBe(
      "https://environment.test/api/assets/token/assets/0001.png",
    );
    expect(article.textContent).toContain("Figure caption");
    expect(article.textContent).toContain("Image unavailable: missing.png (not found)");
    expect(article.textContent).toContain("Remote image not included: https://example.com/r.png");
    expect(article.textContent).toContain("Image unavailable: Local");
    expect(article.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(article.querySelector("iframe")).toBeNull();
    expect(article.querySelector("[data-scient-math='display'] .katex")).not.toBeNull();
    expect(article.querySelector("[data-scient-math='inline'] .katex")).not.toBeNull();
    const codeBlocks = article.querySelectorAll("[data-scient-code-block]");
    expect(codeBlocks).toHaveLength(3);
    expect(codeBlocks[0]?.hasAttribute("data-short")).toBe(true);
    expect(codeBlocks[1]?.hasAttribute("data-short")).toBe(false);
    expect(article.querySelector("[data-scient-diagram='rendered'] svg")).not.toBeNull();
    expect(article.querySelector(".scient-document-notes")?.textContent).toContain(
      "Bundle warning one.",
    );
    expect(article.querySelector(".scient-document-notes")?.textContent).toContain(
      "A limitation found while rendering.",
    );
    expect(countDocumentBlocks(article)).toMatchObject({
      headings: 3,
      tables: 1,
      codeBlocks: 3,
      inlineMath: 1,
      displayMath: 1,
      diagrams: 1,
      images: 1,
    });
    expect(tracker.diagnostics.map((diagnostic) => diagnostic.code).toSorted()).toEqual([
      "missing-image",
      "raw-html-sanitized",
      "remote-image-omitted",
      "unsupported-diagram-language",
    ]);
    expect(tracker.diagnostics.every((diagnostic) => diagnostic.severity === "warning")).toBe(true);
  });

  it("treats a Mermaid runtime failure as fatal, not as a labelled placeholder", async () => {
    const { article, tracker } = await renderPage(input("```mermaid\nchunk\n```\n"));
    expect(article.querySelector("[data-scient-diagram='error']")).not.toBeNull();
    expect(tracker.diagnostics).toEqual([
      expect.objectContaining({ severity: "fatal", code: "diagram-incomplete" }),
    ]);
  });

  it("prints the full Mermaid parse error in the export notes", async () => {
    const { tracker } = await renderPage(input("```mermaid\nbroken\n```\n"));
    const detail = tracker.diagnostics[0]?.detail ?? "";
    expect(detail).toBe(`A Mermaid diagram could not be rendered: ${PARSE_ERROR}`);
    const { article } = await renderPage(input("```mermaid\nbroken\n```\n"), [detail]);
    const note = article.querySelectorAll(".scient-document-notes li")[1];
    expect(note?.firstChild?.textContent).toBe(
      "A Mermaid diagram could not be rendered: Parse error on line 2:",
    );
    expect(note?.querySelector(".scient-document-note-detail")?.textContent).toBe(
      PARSE_ERROR.slice(PARSE_ERROR.indexOf("\n") + 1),
    );
  });

  it("prints failed diagrams and unparseable math as labelled source", async () => {
    const { article, tracker } = await renderPage(
      input("# Own title\n\n$$\n\\frac{\n$$\n\n```mermaid\nbroken\n```\n"),
    );
    expect(article.querySelectorAll("h1")).toHaveLength(1);
    expect(article.querySelector("h1")?.textContent).toBe("Own title");
    expect(article.querySelector("[data-scient-diagram='failed']")?.textContent).toContain(
      "Diagram could not be rendered",
    );
    expect(article.querySelector(".scient-document-math-source")?.textContent).toBe("$$\\frac{$$");
    expect(tracker.diagnostics.map((diagnostic) => diagnostic.code).toSorted()).toEqual([
      "diagram-failed",
      "math-unrendered",
    ]);
  });

  it("uses the conversation layout and the resolved text direction", async () => {
    const { article } = await renderPage(
      input("## You · 27 Sep 2026\n\nשלום עולם, זו שאלה ארוכה בעברית.\n", {
        profile: "chat",
        documentKind: "conversation",
      }),
    );
    expect(article.classList.contains("scient-document--conversation")).toBe(true);
    expect(article.getAttribute("dir")).toBe("rtl");
    expect(article.dataset.scientDocument).toBe("conversation");
  });
});
