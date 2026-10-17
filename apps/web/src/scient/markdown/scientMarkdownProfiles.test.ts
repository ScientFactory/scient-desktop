// @effect-diagnostics nodeBuiltinImport:off -- Audit the actual ChatMarkdown pipeline mount.
import * as NodeFS from "node:fs";
import remarkBreaks from "remark-breaks";
import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS,
  scientMarkdownRemarkPlugins,
} from "./scientMarkdownProfiles";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS as SHARED_REHYPE_PLUGINS,
  CHAT_MARKDOWN_SANITIZE_SCHEMA,
} from "@t3tools/shared/markdownPipeline";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
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
    expect(chatMarkdown).toContain("useScientMathRemarkPlugins(remarkPlugins, text)");
    expect(chatMarkdown).toContain("remarkPlugins={scientRemarkPlugins}");
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

  it("replaces the shared sanitizer in place and keeps every other shared rehype step", () => {
    const isSharedSanitizer = (plugin: unknown) =>
      Array.isArray(plugin) && plugin[1] === CHAT_MARKDOWN_SANITIZE_SCHEMA;
    expect(SHARED_REHYPE_PLUGINS.filter(isSharedSanitizer)).toHaveLength(1);
    expect(CHAT_MARKDOWN_REHYPE_PLUGINS.some(isSharedSanitizer)).toBe(false);
    // The shared sanitizer becomes Scient's image-card pass plus Scient's sanitizer.
    expect(CHAT_MARKDOWN_REHYPE_PLUGINS).toHaveLength(SHARED_REHYPE_PLUGINS.length + 1);
    const sharedIndex = SHARED_REHYPE_PLUGINS.findIndex(isSharedSanitizer);
    expect(CHAT_MARKDOWN_REHYPE_PLUGINS.slice(0, sharedIndex)).toEqual(
      SHARED_REHYPE_PLUGINS.slice(0, sharedIndex),
    );
    expect(CHAT_MARKDOWN_REHYPE_PLUGINS.slice(sharedIndex + 2)).toEqual(
      SHARED_REHYPE_PLUGINS.slice(sharedIndex + 1),
    );
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
