import { describe, expect, it, vi } from "vite-plus/test";

import type { ReviewRenderableLineRow } from "./reviewModel";
import {
  highlightSourceFile,
  highlightCodeSnippet,
  highlightReviewSelectedLines,
} from "./shikiReviewHighlighter";

describe("highlightSourceFile", () => {
  // regression: b3e8c0334b T3 Code Mobile [WIP] (#2013)
  it("falls back to plain tokens for very long lines", async () => {
    const longLine = `const value = "${"a".repeat(1_100)}";`;

    const highlighted = await highlightSourceFile({
      path: "apps/mobile/src/example-long-line.ts",
      contents: longLine,
      theme: "light",
    });

    expect(highlighted).toEqual([
      [
        {
          content: longLine,
          color: null,
          fontStyle: null,
        },
      ],
    ]);
  });

  // regression: 77b655c47b perf(mobile): defer file preview highlighter startup (#9752)
  it("initializes source and snippet highlighting without a warmup", async () => {
    vi.resetModules();
    const highlighter = await import("./shikiReviewHighlighter");
    const source = "const answer: number = 42;";

    const highlighted = await highlighter.highlightSourceFile({
      path: "example.ts",
      contents: source,
      theme: "dark",
    });

    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
    const snippet = await highlighter.highlightCodeSnippet({
      code: source,
      language: "ts",
      theme: "dark",
    });
    // Shiki's time budget can yield different token boundaries on cold and warm runs.
    // Startup must preserve the source and produce highlighting in either case.
    expect(snippet).toHaveLength(1);
    expect(
      snippet
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(snippet.flat().some((token) => token.color !== null)).toBe(true);
  });
});

describe("highlightReviewSelectedLines", () => {
  // regression: b3e8c0334b T3 Code Mobile [WIP] (#2013)
  it("adds word-alt diff emphasis for paired deletion and addition lines", async () => {
    const lines: ReviewRenderableLineRow[] = [
      {
        kind: "line",
        id: "delete-1",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
        content: "const before = 1;",
        additionTokenIndex: null,
        deletionTokenIndex: 0,
        comparison: { change: "add", tokenIndex: 0 },
      },
      {
        kind: "line",
        id: "add-1",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        content: "const after = 2;",
        additionTokenIndex: 0,
        deletionTokenIndex: null,
        comparison: { change: "delete", tokenIndex: 0 },
      },
    ];

    const highlighted = await highlightReviewSelectedLines({
      filePath: "apps/mobile/src/example-inline-diff.txt",
      lines,
      theme: "light",
    });

    expect(highlighted["delete-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(highlighted["add-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
  });
});

describe("highlightCodeSnippet", () => {
  // regression: 4fed6cfb35 feat: add inline file previews and attachment chips across surfaces (#11265)
  it.each(["light", "dark"] as const)(
    "preserves diff-prefixed TSX review snippets in %s mode",
    async (theme) => {
      const lines = [
        "- onClick={() => submitOrder(cart)}",
        "+ onClick={handleSubmit}",
        "+ disabled={isSubmitting}",
      ];
      const highlighted = await highlightCodeSnippet({
        code: lines.join("\n"),
        language: "tsx",
        theme,
      });
      expect(highlighted.map((line) => line.map((token) => token.content).join(""))).toEqual(lines);
      expect(
        new Set(
          highlighted
            .flat()
            .map((token) => token.color)
            .filter(Boolean),
        ).size,
      ).toBeGreaterThan(1);
    },
  );

  // regression: 689a882045 [codex] Add native mobile composer and markdown (#3101)
  it("resolves language aliases and returns syntax-colored tokens", async () => {
    const source = "const answer: number = 42;";
    const highlighted = await highlightCodeSnippet({
      code: source,
      language: "ts",
      theme: "dark",
    });

    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
  });
});
