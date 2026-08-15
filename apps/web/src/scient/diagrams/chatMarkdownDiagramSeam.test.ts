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
const diagramStyles = NodeFS.readFileSync(
  new URL("./scient-diagrams.css", import.meta.url),
  "utf8",
);

describe("ChatMarkdown diagram seam", () => {
  it("mounts one Scient-owned rich-fence component", () => {
    expect(chatMarkdownSource).toContain('} from "../scient/presentation/ScientRichFence";');
    expect(chatMarkdownSource.match(/<ScientRichFence/gu)).toHaveLength(1);
    expect(chatMarkdownSource).not.toContain("MermaidDiagramCard");
  });

  it("renders only settled rich fences and leaves streaming fences on the code path", () => {
    expect(chatMarkdownSource).toContain(
      "const richFenceKind = !isStreaming ? resolveScientRichFenceKind(language) : null;",
    );
    const diagramBranch = chatMarkdownSource.indexOf("<ScientRichFence");
    const ordinaryCodeBranch = chatMarkdownSource.indexOf("<MarkdownCodeBlock", diagramBranch);
    expect(diagramBranch).toBeGreaterThan(0);
    expect(ordinaryCodeBranch).toBeGreaterThan(diagramBranch);
  });

  it("passes canonical source, metadata, title, and theme across the seam", () => {
    for (const prop of [
      "fenceMeta={fenceMeta}",
      "kind={richFenceKind}",
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

describe("Mermaid inline sizing", () => {
  it("preserves Mermaid's intrinsic maximum width while allowing large diagrams to shrink", () => {
    const inlineStyles = /\.scient-mermaid-inline svg\s*\{(?<rules>[^}]*)\}/u.exec(diagramStyles)
      ?.groups?.rules;

    expect(inlineStyles).toContain("width: 100%");
    expect(inlineStyles).toContain("height: auto");
    expect(inlineStyles).not.toContain("max-width:");
  });
});
