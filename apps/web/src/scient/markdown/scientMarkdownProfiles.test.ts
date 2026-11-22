// @effect-diagnostics nodeBuiltinImport:off -- Audit the actual chat math grammar mount.
import * as NodeFS from "node:fs";
import remarkBreaks from "remark-breaks";
import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS,
  scientMarkdownRemarkPlugins,
} from "./scientMarkdownProfiles";
import type { Element, Root } from "hast";
import { wordsHast } from "~/markdown/wordsHast";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./scientMarkdownPipeline";

const chatMathGrammar = NodeFS.readFileSync(
  new URL("../math/scientMathRanges.ts", import.meta.url),
  "utf8",
);

function images(tree: Root | Element): Element[] {
  return tree.children.flatMap((child) =>
    child.type !== "element" ? [] : child.tagName === "img" ? [child] : images(child),
  );
}

describe("Scient Markdown profiles", () => {
  it("shares the actual chat grammar and order through its canonical pipeline owner", () => {
    // The import boundary: chat's math grammar takes its plugins from the canonical pipeline owner.
    expect(chatMathGrammar).toContain('} from "../markdown/scientMarkdownPipeline";');
    for (const plugins of [
      CHAT_MARKDOWN_REMARK_PLUGINS,
      CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
    ]) {
      // Exact function identity catches a stale copied helper, not just matching names. Chat
      // also runs render-only steps documents must not save (linked file paths, kept list
      // numbers), so the grammar is checked in order among them.
      const grammar = new Set<unknown>(SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS);
      expect(plugins.filter((plugin) => grammar.has(plugin))).toEqual(
        SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS,
      );
      expect(plugins[0]).toBe(SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS[0]);
    }
  });

  it("marks standalone figures for image cards after chat's own sanitizer", () => {
    const cards = (markdown: string) =>
      images(
        wordsHast(markdown, {
          math: false,
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

  it("keeps single line breaks only in the chat profile, as chat does", () => {
    expect(CHAT_MARKDOWN_REMARK_PLUGINS).not.toContain(remarkBreaks);
    expect(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS).toContain(remarkBreaks);
    expect(scientMarkdownRemarkPlugins("document")).toEqual(SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS);
    expect(scientMarkdownRemarkPlugins("chat")).toEqual([
      ...SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS,
      remarkBreaks,
    ]);
  });
});
