// @vitest-environment happy-dom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { rehypeScientBidi } from "../../bidi/rehypeScientBidi";
import { markClipboardDirection } from "../../clipboard/clipboardDirection";
import { ScientMarkdownEditorView } from "./view";

const editors: ScientMarkdownEditorView[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => editors.splice(0).forEach((editor) => editor.destroy()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function editor() {
  const view = new ScientMarkdownEditorView({
    source: "",
    revision: "r0",
    mode: "write",
    ariaLabel: "Paste target",
    onUserSourceChange: vi.fn(),
  });
  editors.push(view);
  const host = document.createElement("div");
  document.body.append(host);
  await act(() => {
    view.mount(host);
  });
  return view;
}

function pasteEvent(flavors: Readonly<Record<string, string>>): ClipboardEvent {
  return {
    clipboardData: { files: [], getData: (type: string) => flavors[type] ?? "" },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
}

async function pasteHtml(html: string, flavors?: Readonly<Record<string, string>>) {
  const target = await editor();
  await act(() => {
    target.view!.pasteHTML(html, flavors ? pasteEvent(flavors) : undefined);
  });
  return target.session.session.draftSource;
}

async function pasteText(text: string) {
  const target = await editor();
  await act(() => {
    target.view!.pasteText(text);
  });
  return target.session.session.draftSource;
}

/** The chat renderer's direction pipeline, as the copied DOM carries it. */
function renderedChat(markdown: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [[rehypeScientBidi, { direction: "rtl", requestedDirection: "auto" }]],
      },
      markdown,
    ),
  );
  return container;
}

const MIXED_MESSAGE = [
  "## סיכום",
  "",
  "הרצנו את `npm test` ב-/Users/me/project/ עם Python, ראו https://example.com/docs/.",
  "",
  "An English paragraph with **bold** text.",
  "",
  "- פריט ראשון",
  "- פריט שני",
  "",
  "1. first",
  "2. second",
  "",
  "> ציטוט בעברית",
  "",
  "| עמודה | Column |",
  "| --- | ---: |",
  "| ערך | value |",
  "",
  "```ts",
  "const x = 1; // הערה",
  "```",
].join("\n");

describe("Markdown editor paste of direction-marked chat copies", () => {
  it("produces the same document with and without the clipboard direction marks", async () => {
    const container = renderedChat(MIXED_MESSAGE);
    const unmarked = `<meta charset="utf-8">${container.innerHTML}`;
    markClipboardDirection(container, "rtl");
    const marked = `<meta charset="utf-8">${container.innerHTML}`;
    expect(marked).not.toBe(unmarked);
    const pastedUnmarked = await pasteHtml(unmarked);
    expect(pastedUnmarked).toContain("npm test");
    expect(await pasteHtml(marked)).toBe(pastedUnmarked);
  });

  it("produces the same text for an inline fragment wrapped in its paragraph direction", async () => {
    const container = document.createElement("div");
    container.append("משפט חלקי עם ./src/app.ts בתוכו");
    const unmarked = `<meta charset="utf-8">${container.innerHTML}`;
    markClipboardDirection(container, "rtl");
    const marked = `<meta charset="utf-8">${container.innerHTML}`;
    expect(marked).toContain('<span dir="rtl"');
    expect(await pasteHtml(marked)).toBe(await pasteHtml(unmarked));
  });

  it("pastes the Copy message button's Markdown text rather than its rendered HTML", async () => {
    const markdown = "## כותרת\n\n- פריט **מודגש**";
    const container = renderedChat(markdown);
    markClipboardDirection(container, "rtl");
    const html = `<meta charset="utf-8"><div data-scient-message-copy="">${container.innerHTML}</div>`;
    const pasted = await pasteHtml(html, { "text/plain": markdown, "text/html": html });
    expect(pasted).toBe(await pasteText(markdown));
    expect(pasted).not.toBe(await pasteHtml(html));
  });

  it("still pastes ordinary rich HTML as HTML", async () => {
    const html = "<p><strong>Bold</strong> text</p>";
    const pasted = await pasteHtml(html, { "text/plain": "Bold text", "text/html": html });
    expect(pasted).toBe("**Bold** text");
  });
});
