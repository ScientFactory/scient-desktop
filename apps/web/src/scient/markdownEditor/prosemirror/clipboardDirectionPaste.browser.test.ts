import { render as _fixtureRender } from "../../../../test/render";
import type { ReactNode } from "react";
import { act } from "../../../../test/render";

import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it, vi } from "vite-plus/test";

import { rehypeScientBidi } from "../../bidi/rehypeScientBidi";
import { markClipboardDirection } from "../../clipboard/clipboardDirection";
import { ScientMarkdownEditorView } from "./view";

async function _setupFixture0(_fixture: _Fixture) {
  await undefined;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(() => _fixture.editors.splice(0).forEach((editor) => editor.destroy()));

  vi.unstubAllGlobals();
}

async function editor(_fixture: _Fixture) {
  const view = new ScientMarkdownEditorView({
    source: "",
    revision: "r0",
    mode: "write",
    ariaLabel: "Paste target",
    onUserSourceChange: vi.fn(),
  });
  _fixture.editors.push(view);
  const host = document.createElement("div");

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

async function pasteHtml(
  _fixture: _Fixture,
  html: string,
  flavors?: Readonly<Record<string, string>>,
) {
  const target = await editor(_fixture);
  await act(() => {
    target.view!.pasteHTML(html, flavors ? pasteEvent(flavors) : undefined);
  });
  return target.session.session.draftSource;
}

async function pasteText(_fixture: _Fixture, text: string) {
  const target = await editor(_fixture);
  await act(() => {
    target.view!.pasteText(text);
  });
  return target.session.session.draftSource;
}

/** The chat renderer's direction pipeline, as the copied DOM carries it. */
async function renderedChat(_fixture: _Fixture, markdown: string): Promise<HTMLElement> {
  const container = await _nativeContainer(
    _fixture,
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const container = await renderedChat(_fixture, MIXED_MESSAGE);
    const unmarked = `<meta charset="utf-8">${container.innerHTML}`;
    markClipboardDirection(container, "rtl");
    const marked = `<meta charset="utf-8">${container.innerHTML}`;
    expect(marked).not.toBe(unmarked);
    const pastedUnmarked = await pasteHtml(_fixture, unmarked);
    expect(pastedUnmarked).toContain("npm test");
    expect(await pasteHtml(_fixture, marked)).toBe(pastedUnmarked);
  });

  it("produces the same text for an inline fragment wrapped in its paragraph direction", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const container = document.createElement("div");
    container.append("משפט חלקי עם ./src/app.ts בתוכו");
    const unmarked = `<meta charset="utf-8">${container.innerHTML}`;
    markClipboardDirection(container, "rtl");
    const marked = `<meta charset="utf-8">${container.innerHTML}`;
    expect(marked).toContain('<span dir="rtl"');
    expect(await pasteHtml(_fixture, marked)).toBe(await pasteHtml(_fixture, unmarked));
  });

  it("pastes the Copy message button's Markdown text rather than its rendered HTML", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const markdown = "## כותרת\n\n- פריט **מודגש**";
    const container = await renderedChat(_fixture, markdown);
    markClipboardDirection(container, "rtl");
    const html = `<meta charset="utf-8"><div data-scient-message-copy="">${container.innerHTML}</div>`;
    const pasted = await pasteHtml(_fixture, html, { "text/plain": markdown, "text/html": html });
    expect(pasted).toBe(await pasteText(_fixture, markdown));
    expect(pasted).not.toBe(await pasteHtml(_fixture, html));
  });

  it("still pastes ordinary rich HTML as HTML", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const html = "<p><strong>Bold</strong> text</p>";
    const pasted = await pasteHtml(_fixture, html, {
      "text/plain": "Bold text",
      "text/html": html,
    });
    expect(pasted).toBe("**Bold** text");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    editors: [] as ScientMarkdownEditorView[],
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

async function _nativeContainer(_fixture: _Fixture, ui: ReactNode): Promise<HTMLElement> {
  const screen = _fixture.stack.use(await _fixtureRender(ui, { router: false }));
  return screen.container;
}
