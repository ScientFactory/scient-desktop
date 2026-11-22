import bidiCssSource from "./scient-bidi.css?raw";

import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { render } from "../../../test/render";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "~/markdown/wordsHast";

/** Chat's Words pipeline, with Scient's direction for a right-to-left message. */
function renderChatPipeline(markdown: string, escapeHtml: boolean) {
  return toJsxRuntime(
    wordsHast(markdown, {
      math: true,
      breaks: false,
      escapeHtml,
      insights: false,
      extensions: {},
      scient: { math: true, contentDirection: "rtl", requestedContentDirection: "auto" },
    }),
    { Fragment, jsx, jsxs },
  );
}

/** A user message: raw HTML stays literal. */
const renderUserPipeline = (markdown: string) => renderChatPipeline(markdown, true);
/** An assistant message: raw HTML is parsed and sanitized. */
const renderAssistantPipeline = (markdown: string) => renderChatPipeline(markdown, false);

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

  it("keeps raw parsing and sanitizing confined to messages that opt into HTML", async () => {
    const source = '<b>bold</b> <span onclick="x()">click</span>';
    await using literal = await render(renderUserPipeline(source), { router: false });
    expect(literal.container.querySelector("b")).toBeNull();
    expect(literal.container.textContent).toContain("<b>bold</b>");
    await using parsed = await render(renderAssistantPipeline(source), { router: false });
    expect(parsed.container.querySelector("b")?.textContent).toBe("bold");
    expect(parsed.container.innerHTML).not.toContain("onclick");
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
    // Words escapes the script as GFM's tag filter does; it is text, never an element.
    expect(html).not.toMatch(/<script(?:\s|>)/i);
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("globalThis.__scientXss = 2");
    expect((globalThis as { __scientXss?: unknown }).__scientXss).toBeUndefined();
  });
});
