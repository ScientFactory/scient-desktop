// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat-markdown seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const chatMarkdownSource = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);
const mermaidRuntimeSource = NodeFS.readFileSync(
  new URL("./mermaidRuntime.ts", import.meta.url),
  "utf8",
);
const diagramCardSource = NodeFS.readFileSync(
  new URL("./MermaidDiagramCard.tsx", import.meta.url),
  "utf8",
);

describe("ChatMarkdown diagram seam", () => {
  it("mounts one Scient-owned diagram component", () => {
    expect(chatMarkdownSource).toContain(
      'import { MermaidDiagramCard } from "../scient/diagrams/MermaidDiagramCard";',
    );
    expect(chatMarkdownSource.match(/<MermaidDiagramCard/gu)).toHaveLength(1);
  });

  it("renders only settled Mermaid fences and leaves streaming fences on the code path", () => {
    expect(chatMarkdownSource).toContain(
      'if (!isStreaming && language.toLowerCase() === "mermaid")',
    );
    const diagramBranch = chatMarkdownSource.indexOf("<MermaidDiagramCard");
    const ordinaryCodeBranch = chatMarkdownSource.indexOf("<MarkdownCodeBlock", diagramBranch);
    expect(diagramBranch).toBeGreaterThan(0);
    expect(ordinaryCodeBranch).toBeGreaterThan(diagramBranch);
  });

  it("passes canonical source, metadata, title, and theme across the seam", () => {
    for (const prop of [
      "fenceMeta={fenceMeta}",
      "language={language}",
      "source={codeBlock.code}",
      "theme={resolvedTheme}",
      "title={fenceTitle}",
    ]) {
      expect(chatMarkdownSource).toContain(prop);
    }
  });
});

describe("Mermaid runtime boundary", () => {
  it("keeps the heavy renderer behind a dynamic import", () => {
    expect(mermaidRuntimeSource).toContain('mermaidRuntimePromise ??= import("mermaid")');
    expect(mermaidRuntimeSource).not.toMatch(/from ["']mermaid["']/u);
  });

  it("uses strict local rendering without binding source-authored interactions", () => {
    expect(mermaidRuntimeSource).toContain('securityLevel: "strict"');
    expect(mermaidRuntimeSource).toContain("startOnLoad: false");
    expect(diagramCardSource).not.toMatch(/\.bindFunctions\s*\(/u);
  });
});
