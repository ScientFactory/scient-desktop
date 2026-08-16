// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat-markdown seam.
import * as NodeFS from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { rehypeScientBidi } from "./rehypeScientBidi";

const chatMarkdownSource = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);
const timelineSource = NodeFS.readFileSync(
  new URL("../../components/chat/MessagesTimeline.tsx", import.meta.url),
  "utf8",
);
const bidiCssSource = NodeFS.readFileSync(new URL("./scient-bidi.css", import.meta.url), "utf8");

function renderUserPipeline(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [[rehypeScientBidi, { direction: "rtl", requestedDirection: "auto" }]],
        skipHtml: false,
      },
      markdown,
    ),
  );
}

function renderAssistantPipeline(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [
          rehypeRaw,
          [rehypeSanitize, defaultSchema],
          [rehypeScientBidi, { direction: "rtl", requestedDirection: "auto" }],
        ],
        skipHtml: false,
      },
      markdown,
    ),
  );
}

describe("ChatMarkdown BiDi seam", () => {
  it("keeps T3 HTML plugins behind parseRawHtml and always appends Scient BiDi", () => {
    expect(chatMarkdownSource).toMatch(
      /\.\.\.\(parseRawHtml \? CHAT_MARKDOWN_REHYPE_PLUGINS : \[\]\),\s*\[\s*rehypeScientBidi,/u,
    );
    expect(chatMarkdownSource).not.toMatch(/rehypePlugins=\{\s*parseRawHtml\s*\?/u);
  });

  it("routes user messages through literal HTML and assistant messages through the default parser", () => {
    expect(timelineSource.match(/parseRawHtml=\{false\}/gu)?.length).toBeGreaterThanOrEqual(1);
    const assistantMount = timelineSource.match(
      /function AssistantTimelineRow[\s\S]*?<ChatMarkdown\b([\s\S]*?)\/>/u,
    )?.[1];
    expect(assistantMount).toBeDefined();
    expect(assistantMount).not.toContain("parseRawHtml");
  });

  it("thickens flow arrows inline and boxes only the lifted long arrow", () => {
    expect(bidiCssSource).toContain(".chat-markdown .scient-flow-arrow {");
    expect(bidiCssSource).toContain(".chat-markdown .scient-flow-arrow-long {");
    expect(bidiCssSource).toMatch(
      /\.chat-markdown \.scient-flow-arrow \{[^}]*-webkit-text-stroke:/u,
    );
    expect(bidiCssSource).not.toMatch(/\.chat-markdown \.scient-flow-arrow \{[^}]*display:/u);
    expect(bidiCssSource).toMatch(
      /\.chat-markdown \.scient-flow-arrow-long \{[^}]*display:\s*inline-block;/u,
    );
  });
});

describe("user Markdown plus Scient BiDi", () => {
  it("gives Hebrew structure local direction while keeping user HTML literal", () => {
    const html = renderUserPipeline(
      [
        "הפסקה הראשונה",
        "",
        "- פריט אחד",
        "- English item",
        "",
        "| עמודה | value |",
        "| --- | --- |",
        "| עברית | latin |",
        "",
        '<script>globalThis.__scientXss = 1</script><img src="x" onerror="globalThis.__scientXss = 2">',
      ].join("\n"),
    );

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("<ul");
    expect(html).toContain("<table");
    expect(html).toContain("&lt;script&gt;globalThis.__scientXss = 1&lt;/script&gt;");
    expect(html).toContain("onerror=");
    expect(html).not.toMatch(/<script(?:\s|>)/i);
    expect(html).not.toMatch(/<img(?:\s|>)/i);
  });

  it("reverses RTL prose arrows and leaves arrows in code unchanged", () => {
    const html = renderUserPipeline(
      ["שלב ראשון → שלב שני", "", "```", "שלום → עולם", "```"].join("\n"),
    );

    expect(html).toContain("שלב ראשון ← שלב שני");
    expect(html).toContain("שלום → עולם");
  });

  it("emits thickening and lift classes for the styled RTL arrows", () => {
    const doubleArrow = renderUserPipeline("שלב ראשון ⇒ שלב שני");
    expect(doubleArrow).toContain("scient-flow-arrow");
    expect(doubleArrow).toContain("⇐");
    expect(doubleArrow).not.toContain("scient-flow-arrow-long");

    const longArrow = renderUserPipeline("שלב ראשון ⟶ שלב שני");
    expect(longArrow).toContain("scient-flow-arrow-long");
    expect(longArrow).toContain("⟵");
  });
});

describe("assistant Markdown plus Scient BiDi", () => {
  it("sanitizes executable HTML before applying direction", () => {
    const html = renderAssistantPipeline(
      [
        "התשובה כאן",
        "",
        '<script>globalThis.__scientXss = 1</script><img src="x" onerror="globalThis.__scientXss = 2">',
      ].join("\n"),
    );

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("התשובה כאן");
    expect(html).not.toMatch(/<script(?:\s|>)/i);
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("globalThis.__scientXss");
  });
});
