// @effect-diagnostics nodeBuiltinImport:off -- Static parity audit of ChatMarkdown's plugin lists.
import * as NodeFS from "node:fs";

import remarkBreaks from "remark-breaks";
import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS,
  scientMarkdownRemarkPlugins,
} from "./scientMarkdownProfiles";

const chatMarkdown = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);

function chatPluginNames(constName: string): string[] {
  const match = new RegExp(`const ${constName} = \\[([^\\]]*)\\]`, "u").exec(chatMarkdown);
  if (!match?.[1]) throw new Error(`${constName} was not found in ChatMarkdown.tsx`);
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

const GRAMMAR_NAMES = [
  "remarkGfm",
  "remarkScientMath",
  "remarkScientSingleDollarMath",
  "remarkScientMathRefinements",
  "remarkGithubAlerts",
  "remarkNormalizeListItemIndentation",
];

describe("Scient Markdown profiles", () => {
  it("share chat's grammar, in chat's order, on both profiles", () => {
    expect(SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS).toHaveLength(GRAMMAR_NAMES.length);
    for (const name of [
      "CHAT_MARKDOWN_REMARK_PLUGINS",
      "CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS",
    ]) {
      expect(chatPluginNames(name).slice(0, GRAMMAR_NAMES.length)).toEqual(GRAMMAR_NAMES);
    }
  });

  it("keep single line breaks only in the chat profile, as chat does", () => {
    expect(chatPluginNames("CHAT_MARKDOWN_REMARK_PLUGINS")).not.toContain("remarkBreaks");
    expect(chatPluginNames("CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS")).toContain("remarkBreaks");
    expect(scientMarkdownRemarkPlugins("document")).toEqual(SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS);
    expect(scientMarkdownRemarkPlugins("chat")).toEqual([
      ...SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS,
      remarkBreaks,
    ]);
  });
});
