import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { MermaidDiagramCard } from "./MermaidDiagramCard";

vi.mock("gt-react", async (importOriginal) =>
  (await import("~/scient/testing/englishGTReact")).englishGTReact(await importOriginal()),
);

describe("MermaidDiagramCard server fallback", () => {
  it("keeps the settled source canonical before the lazy browser render starts", () => {
    const html = renderToStaticMarkup(
      createElement(MermaidDiagramCard, {
        source: "flowchart LR\n  A --> B\n",
        language: "mermaid",
        fenceMeta: 'title="study.mmd"',
        title: "study.mmd",
        theme: "light",
      }),
    );

    expect(html).toContain('role="figure"');
    expect(html).toContain("study.mmd");
    expect(html).toContain("Diagram will render when visible");
    expect(html).toContain("flowchart LR");
    expect(html).toContain("title=&quot;study.mmd&quot;");
    expect(html).not.toContain("scient-mermaid-inline");
  });

  it("labels an untitled diagram without changing its source", () => {
    const html = renderToStaticMarkup(
      createElement(MermaidDiagramCard, {
        source: "sequenceDiagram\n  A->>B: Sample",
        language: "mermaid",
        title: null,
        theme: "dark",
      }),
    );

    expect(html).toContain('aria-label="Mermaid diagram"');
    expect(html).toContain("sequenceDiagram");
  });
});
