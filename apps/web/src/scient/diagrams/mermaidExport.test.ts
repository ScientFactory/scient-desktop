import { describe, expect, it } from "vite-plus/test";

import {
  diagramFileBaseName,
  mermaidMarkdownCopySource,
  prepareSvgForExport,
} from "./mermaidExport";

describe("diagram export helpers", () => {
  it("uses a stable, portable filename without discarding non-Latin titles", () => {
    expect(diagramFileBaseName("Research lifecycle.mmd")).toBe("Research-lifecycle");
    expect(diagramFileBaseName("תרשים ניסוי.svg")).toBe("תרשים-ניסוי");
    expect(diagramFileBaseName("***")).toBe("diagram");
    expect(diagramFileBaseName(null)).toBe("diagram");
  });

  it("preserves fence metadata and settled source in copied Markdown", () => {
    expect(
      mermaidMarkdownCopySource("flowchart LR\n  A --> B\n", "mermaid", 'title="study.mmd"'),
    ).toBe('```mermaid title="study.mmd"\nflowchart LR\n  A --> B\n```\n\n');
  });

  it("uses a longer fence when the diagram source contains triple backticks", () => {
    expect(mermaidMarkdownCopySource("flowchart LR\n  A[```]", "mermaid", undefined)).toBe(
      "````mermaid\nflowchart LR\n  A[```]\n````\n\n",
    );
  });

  it("makes exported SVG standalone and gives it the chosen appearance", () => {
    const exported = prepareSvgForExport('<svg viewBox="0 0 10 10"></svg>', "dark");
    expect(exported).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(exported).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(exported).toContain("color-scheme:dark");
    expect(exported).toContain("background:#171717");
  });
});
