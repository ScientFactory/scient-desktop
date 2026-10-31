import bidiCssSource from "./scient-bidi.css?raw";

import { createElement } from "react";
import { render } from "../../../test/render";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { rehypeScientBidi } from "./rehypeScientBidi";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
} from "../markdown/scientMarkdownPipeline";

function renderUserPipeline(markdown: string) {
  return createElement(
    ReactMarkdown,
    {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [[rehypeScientBidi, { direction: "rtl", requestedDirection: "auto" }]],
      skipHtml: false,
    },
    markdown,
  );
}

function renderAssistantPipeline(markdown: string) {
  return createElement(
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
  );
}

describe("ChatMarkdown BiDi seam", () => {
  it("keeps computed column alignment consistent across mixed cell directions", async () => {
    const source = [
      "| Term / מונח | Meaning / משמעות | Example |",
      "| --- | --- | --- |",
      "| Blood pressure | לחץ דם | 120/80 mm Hg |",
      "| טיפול | Treatment | Medication and follow-up |",
      "| Remote monitoring | ניטור מרחוק | Daily home measurements |",
      "| תופעות לוואי | Adverse events | No serious events reported |",
      "| Patient adherence | היענות המטופל | 24 of 30 measurements completed |",
    ].join("\n");
    const style = document.createElement("style");
    style.textContent = bidiCssSource;
    const host = document.createElement("div");
    host.className = "chat-markdown";
    host.dataset.scientContentDirection = "ltr";
    await using _screen = await render(renderAssistantPipeline(source), {
      container: host,
      router: false,
    });
    document.head.append(style);
    try {
      for (const row of host.querySelectorAll("tr")) {
        expect(Array.from(row.cells, (cell) => getComputedStyle(cell).textAlign)).toEqual([
          "left",
          "right",
          "left",
        ]);
      }
    } finally {
      style.remove();
    }
  });

  it("keeps raw parsing and sanitizing confined to the opted-in HTML plugin set", () => {
    expect(
      CHAT_MARKDOWN_REHYPE_PLUGINS.some(
        (plugin) => typeof plugin === "function" && plugin.name === "rehypeRawWhenPresent",
      ),
    ).toBe(true);
    expect(
      CHAT_MARKDOWN_REHYPE_PLUGINS.some(
        (plugin) => Array.isArray(plugin) && plugin[0] === rehypeSanitize,
      ),
    ).toBe(true);
    expect(CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW).not.toContain(rehypeRaw);
    expect(
      CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW.some(
        (plugin) => Array.isArray(plugin) && plugin[0] === rehypeSanitize,
      ),
    ).toBe(false);
  });

  // regression: 3f2929e54b fix(web): thicken thin RTL flow arrows without boxing every glyph
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
  it("gives Hebrew structure local direction while keeping user HTML literal", async () => {
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(
      await render(
        renderUserPipeline(
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
        ),
        { router: false },
      ),
    );
    const html = screen.container.innerHTML;

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("<ul");
    expect(html).toContain("<table");
    expect(html).toContain("&lt;script&gt;globalThis.__scientXss = 1&lt;/script&gt;");
    expect(html).toContain("onerror=");
    expect(html).not.toMatch(/<script(?:\s|>)/i);
    expect(html).not.toMatch(/<img(?:\s|>)/i);
  });
});

describe("assistant Markdown plus Scient BiDi", () => {
  it("sanitizes executable HTML before applying direction", async () => {
    await using screen = await render(
      renderAssistantPipeline(
        [
          "התשובה כאן",
          "",
          '<script>globalThis.__scientXss = 1</script><img src="x" onerror="globalThis.__scientXss = 2">',
        ].join("\n"),
      ),
      { router: false },
    );
    const html = screen.container.innerHTML;

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("התשובה כאן");
    expect(html).not.toMatch(/<script(?:\s|>)/i);
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("globalThis.__scientXss");
  });
});
