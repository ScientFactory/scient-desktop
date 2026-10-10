// @effect-diagnostics nodeBuiltinImport:off -- Audit the actual ChatMarkdown pipeline mount.
import * as NodeFS from "node:fs";
import remarkBreaks from "remark-breaks";
import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS,
  scientMarkdownRemarkPlugins,
} from "./scientMarkdownProfiles";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./scientMarkdownPipeline";

const chatMarkdown = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);

describe("Scient Markdown profiles", () => {
  it("shares the actual chat grammar and order through its canonical pipeline owner", () => {
    expect(chatMarkdown).toContain('} from "../scient/markdown/scientMarkdownPipeline";');
    expect(chatMarkdown).toContain(
      "lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS",
    );
    expect(chatMarkdown).toContain("remarkPlugins={remarkPlugins}");
    expect(SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS).toHaveLength(7);
    for (const plugins of [
      CHAT_MARKDOWN_REMARK_PLUGINS,
      CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
    ]) {
      // Exact function identity catches a stale copied helper, not just matching names.
      expect(plugins.slice(0, SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS.length)).toEqual(
        SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS,
      );
    }
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
