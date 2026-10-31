import _sourceContract4 from "../../components/ChatMarkdown.tsx?raw";
import tableRendererSource from "../../components/chat/MarkdownTable.tsx?raw";
import cssSource from "./scient-markdown-editor.css?raw";
import previewCssSource from "../../index.css?raw";
import appStyles from "../../index.css?inline";
import editorStyles from "./scient-markdown-editor.css?inline";

import { describe, expect, it } from "vite-plus/test";

// Mounts the app reset and the editor stylesheet with a document fragment and
// removes both on dispose. The reset is what clears list markers.
function styledDocument(markup: string) {
  const style = document.createElement("style");
  style.textContent = `${appStyles}\n${editorStyles}`;
  document.head.append(style);
  const host = document.createElement("div");
  host.className = "scient-markdown-document";
  host.innerHTML = markup;
  document.body.append(host);
  return {
    host,
    [Symbol.dispose]() {
      host.remove();
      style.remove();
    },
  };
}

const computed = (host: HTMLElement, selector: string) =>
  getComputedStyle(host.querySelector(selector)!);

const previewRendererSource = _sourceContract4;

describe("rich Markdown document styles", () => {
  // regression: 6cb8d62aae fix(markdown): harden editor reliability
  it("computes visible nested markers while leaving task rows markerless", () => {
    using fixture = styledDocument(`
      <ul id="bullets"><li>One<ul id="nested-bullets"><li>Two</li></ul></li></ul>
      <ol id="numbers"><li>One<ol id="nested-numbers"><li>Two</li></ol></li></ol>
      <ul><li id="task" data-task-checked="false">Task</li></ul>
    `);
    const { host } = fixture;

    expect(computed(host, "#bullets").listStyleType).toBe("disc");
    expect(computed(host, "#nested-bullets").listStyleType).toBe("circle");
    expect(computed(host, "#numbers").listStyleType).toBe("decimal");
    expect(computed(host, "#nested-numbers").listStyleType).toBe("lower-alpha");
    expect(computed(host, "#task").listStyleType).toBe("none");
    expect(computed(host, "#task").listStyleImage).toBe("none");
  });

  it("keeps resolved and explicit direction isolated from surrounding prose", () => {
    using fixture = styledDocument(
      '<p>שלום world</p><p dir="ltr">שלום world</p><h2 dir="rtl">English עברית</h2><blockquote dir="rtl">English עברית</blockquote><table><tbody><tr><td dir="rtl">English עברית</td></tr></tbody></table>',
    );
    const { host } = fixture;

    for (const element of [...host.children].slice(0, 4)) {
      expect(getComputedStyle(element).unicodeBidi).toBe("isolate");
    }
    expect(computed(host, "td").unicodeBidi).toBe("isolate");
    expect(getComputedStyle(host.children[1]!).textAlign).toBe("start");
  });

  it("keeps authored GFM column alignment physical in both cell directions", () => {
    using fixture = styledDocument(`
      <table><tbody><tr>
        <td id="ltr-left" dir="ltr" data-alignment="left">Left</td>
        <td id="ltr-center" dir="ltr" data-alignment="center">Center</td>
        <td id="ltr-right" dir="ltr" data-alignment="right">Right</td>
        <td id="rtl-left" dir="rtl" data-alignment="left">يسار</td>
        <td id="rtl-center" dir="rtl" data-alignment="center">وسط</td>
        <td id="rtl-right" dir="rtl" data-alignment="right">يمين</td>
      </tr></tbody></table>
    `);

    for (const direction of ["ltr", "rtl"]) {
      for (const alignment of ["left", "center", "right"]) {
        expect(computed(fixture.host, `#${direction}-${alignment}`).textAlign).toBe(alignment);
      }
    }
  });

  // regression: 756d0e0134 fix(markdown): stabilize RTL tables and scrolling (#263)
  it("keeps automatic alignment physical and independent from cell text direction", () => {
    using fixture = styledDocument(`
      <table><tbody><tr>
        <td id="ltr-in-rtl-column" dir="ltr" data-scient-table-column-direction="rtl">TNBC</td>
        <td id="rtl-in-ltr-column" dir="rtl" data-scient-table-column-direction="ltr">טיפול</td>
      </tr></tbody></table>
    `);

    expect(computed(fixture.host, "#ltr-in-rtl-column").textAlign).toBe("right");
    expect(computed(fixture.host, "#rtl-in-ltr-column").textAlign).toBe("left");
  });
});

// Source-text guards: each is the only test of its CSS rule (a local mutation of
// each rule left every behavioral test green, 2026-10-25).
describe("rich Markdown style rules guarded by source", () => {
  // regression: 017821d992 fix(web): improve platform cursor behavior (#301)
  it("lets the platform choose the pointer over the Markdown canvas", () => {
    expect(cssSource).not.toMatch(/\.scient-markdown-document-shell\s*\{[^}]*cursor:\s*text/su);
    expect(cssSource).not.toMatch(/\.scient-markdown-document\.is-read\s*\{[^}]*cursor:\s*text/su);
    expect(cssSource).toMatch(
      /\.scient-markdown-document\.is-write\s*\{[^}]*caret-color:\s*var\(--foreground\)/su,
    );
  });

  // regression: f9b1555499 fix(markdown): stabilize persistent source editing
  it("shares one deliberate quiet code-card surface with the established preview", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-code-block \{[^}]*background: var\([^}]*--markdown-code-block-background/su,
    );
    expect(previewCssSource).toMatch(
      /--markdown-code-block-background:\s*color-mix\([^;]+var\(--code-background\) 95%[^;]+var\(--code-foreground\) 5%/su,
    );
    expect(previewCssSource).toMatch(
      /html\[data-theme-id\] :is\(\.chat-markdown, \.composer-tiptap\) \.chat-markdown-codeblock \{[^}]*background-color: var\(--markdown-code-block-background\)/su,
    );
    expect(previewCssSource).toMatch(
      /:is\(\.chat-markdown, \.composer-tiptap\) \.chat-markdown-codeblock \{[^}]*background-color: var\(--markdown-code-block-background\)/su,
    );
    // The inherited themed rule stays byte-identical; the Scient override wins by order.
    const inheritedThemedCodeblock = previewCssSource.indexOf(
      "html[data-theme-id] :is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock {\n  background-color: var(--code-background)",
    );
    expect(inheritedThemedCodeblock).toBeGreaterThanOrEqual(0);
    expect(
      previewCssSource.indexOf(
        "html[data-theme-id] :is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock {\n  background-color: var(--markdown-code-block-background)",
      ),
    ).toBeGreaterThan(inheritedThemedCodeblock);
    expect(cssSource).toMatch(
      /\.scient-markdown-code-render \{[^}]*padding: 0\.55rem 0\.8rem 0\.75rem[^}]*font-size: 0\.8rem[^}]*line-height: 1\.55/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-code-editor \.cm-editor \{[^}]*background: transparent[^}]*font-size: 0\.8rem/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-code-editor \.cm-scroller \{[^}]*padding: 0\.55rem 0\.8rem 0\.75rem[^}]*line-height: 1\.55/su,
    );
  });

  // regression: d6a8a97115 fix(markdown): preserve drafts, source fidelity, and table navigation
  it("keeps caret and cell-selection decorations out of table layout", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-document p,\s*\.scient-markdown-document ul,\s*\.scient-markdown-document ol,\s*\.scient-markdown-document blockquote,\s*\.scient-markdown-document pre,\s*\.scient-markdown-document table \{\s*margin-block: 0\.65rem;/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document \{[^}]*position: relative[^}]*white-space: pre-wrap/su,
    );
    expect(cssSource).toMatch(/\.scient-markdown-document \.tableWrapper \{\s*overflow-x: auto/su);
    expect(cssSource).toMatch(/\.scient-markdown-document td \{[^}]*position: relative/su);
    expect(cssSource).toMatch(
      /\.scient-markdown-document \.ProseMirror-gapcursor \{[^}]*display: none[^}]*position: absolute[^}]*pointer-events: none/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document\.ProseMirror-focused \.ProseMirror-gapcursor \{\s*display: block/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document \.selectedCell::after \{[^}]*position: absolute[^}]*pointer-events: none/su,
    );
  });

  // regression: d24fef7a0e fix(markdown): streamline footnote editing
  it("uses quiet numbered footnote navigation with one borderless definition field", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-reference\[data-scient-markdown-reference="footnote_reference"\] \{[^}]*display: inline;[^}]*background: transparent;[^}]*padding: 0;[^}]*cursor: pointer/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-footnote-marker:hover \{[^}]*background: color-mix\(in oklab, var\(--muted\) 62%, transparent\)/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-footnote-marker:focus-visible \{[^}]*outline: 1px solid color-mix\(in oklab, var\(--muted-foreground\) 55%, transparent\)/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-reference\.is-missing \.scient-markdown-footnote-marker \{[^}]*color: var\(--muted-foreground\);[^}]*text-decoration-style: dotted/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-footnote-definition textarea\.scient-markdown-reference-source \{[^}]*grid-column: 2;[^}]*field-sizing: content;[^}]*appearance: none;[^}]*min-height: 1lh;[^}]*max-height: 14rem;[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none;[^}]*padding: 0;[^}]*font: inherit;[^}]*overflow-y: auto;[^}]*resize: none/su,
    );
    expect(cssSource).not.toContain(".scient-markdown-footnote-definition.is-selected");
    expect(cssSource).toMatch(
      /\.scient-markdown-footnote-backlink-tooltip \{[^}]*pointer-events: none;[^}]*opacity: 0/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-footnote-backlink:is\(:hover, :focus-visible\)[^}]*\.scient-markdown-footnote-backlink-tooltip \{[^}]*opacity: 1/su,
    );
    expect(cssSource).toMatch(
      /footnote_reference[^}]*\.ProseMirror-selectednode,[^}]*footnote_reference[^}]*\.is-selected,[^}]*footnote-definition\.ProseMirror-selectednode \{\s*outline: none/su,
    );
    expect(cssSource).not.toMatch(/footnote_reference[^}]*\.scient-markdown-reference-source/su);
  });

  // regression: 83f42be984 fix(markdown): make source-like content directly editable
  it("presents citations as one unboxed direct-edit field", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-reference\[data-scient-markdown-reference="citation"\] \{[^}]*gap: 0;[^}]*background: transparent;[^}]*padding: 0;[^}]*color: inherit/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document\.is-write[^}]*citation[^}]*::before \{\s*content: "\[";/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-reference\[data-scient-markdown-reference="citation"\][^}]*\.scient-markdown-reference-source \{[^}]*field-sizing: content;[^}]*border: 0;[^}]*background: transparent;[^}]*padding: 0;[^}]*font: inherit/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-reference\[data-scient-markdown-reference="citation"\]\.is-selected \{\s*outline: none;/su,
    );
  });

  // regression: 83f42be984 fix(markdown): make source-like content directly editable
  it("keeps ordinary code geometry stable and removes active-row chrome", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-code-editor \.cm-content,[^}]*\.scient-markdown-code-editor \.cm-line \{\s*padding: 0;/su,
    );
    expect(cssSource).not.toContain(".scient-markdown-code-editor .cm-activeLine");
    expect(cssSource).not.toMatch(/\.scient-markdown-code-editor \.cm-editor \{[^}]*max-height:/su);
  });

  // regression: f9b1555499 fix(markdown): stabilize persistent source editing
  it("uses the persistent code surface for multiline raw YAML and HTML source", () => {
    expect(cssSource).not.toContain(".scient-markdown-source-island-preview");
    expect(cssSource).toMatch(
      /\.scient-markdown-source-island \{[^}]*border: 1px solid var\(--markdown-code-block-border, var\(--border\)\)[^}]*background: var\(--markdown-code-block-background/su,
    );
    expect(cssSource).toMatch(/\.scient-markdown-source-island-code-editor \{[^}]*min-width: 0/su);
    expect(cssSource).toMatch(
      /\.scient-markdown-source-island\[data-scient-markdown-source-kind="yaml"\] \{[^}]*background: color-mix\([^}]*--markdown-code-block-background[^}]*88%[^}]*var\(--muted\)/su,
    );
  });

  // regression: a9bf7dc0aa fix(markdown): finish table selection and main integration
  it("shows the table handle only in the active editable table without contributing layout height", () => {
    using fixture = styledDocument(
      '<div class="scient-markdown-table"><button class="scient-markdown-table-select"></button><table dir="rtl"><tbody><tr><td>English</td></tr></tbody></table></div>',
    );
    const { host } = fixture;
    host.classList.add("is-write");
    const wrapper = host.firstElementChild!;
    const button = host.querySelector("button")!;
    expect(getComputedStyle(button).display).toBe("none");
    wrapper.classList.add("is-active-table");
    expect(getComputedStyle(button).display).toBe("flex");
    expect(getComputedStyle(button).position).toBe("absolute");
    expect(cssSource).toMatch(
      /\.scient-markdown-table-select \{[^}]*width: 1\.25rem[^}]*height: 1\.25rem[^}]*color: color-mix\(in oklab, var\(--muted-foreground\) 70%, transparent\)/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-table-select > svg \{[^}]*width: 0\.75rem[^}]*height: 0\.75rem/su,
    );
    host.classList.remove("is-write");
    expect(getComputedStyle(button).display).toBe("none");
  });

  // regression: d157041a90 feat(markdown): integrate rich editor quality improvements
  it("keeps reference definitions directly editable and invisible in read mode", async () => {
    await using _fixture = _createFixture();

    expect(cssSource).toMatch(
      /\.scient-markdown-source-island\[data-scient-markdown-source-kind="definition"\] \{[^}]*display: grid[^}]*grid-template-columns: auto minmax\(0, 1fr\)[^}]*border-block-start: 1px solid var\(--border\)[^}]*background: transparent[^}]*padding: 0\.35rem 0\.5rem/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document\.is-read\s+\.scient-markdown-source-island\[data-scient-markdown-source-kind="definition"\] \{[^}]*display: none/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-source-island\[data-scient-markdown-source-kind="definition"\][^}]*\.scient-markdown-source-island-editor \{[^}]*min-height: 1\.75rem[^}]*max-height: 10rem[^}]*padding: 0\.15rem 0\.25rem/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document\.is-write[^}]*\.scient-markdown-source-island\[data-scient-markdown-source-kind="definition"\][^}]*\.scient-markdown-source-island-editor:not\(\[readonly\]\) \{\s*resize: none/su,
    );
    expect(cssSource).not.toContain("scient-markdown-reference-definition-toggle");
    expect(cssSource).not.toContain("scient-markdown-reference-definition-summary");
  });

  // regression: d157041a90 feat(markdown): integrate rich editor quality improvements
  it("presents wiki links as selectable underlined text without a second inline editor", async () => {
    await using _fixture = _createFixture();

    expect(cssSource).toMatch(
      /\.scient-markdown-wiki-link \{[^}]*user-select: text[^}]*vertical-align: baseline/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-wiki-link-label \{[^}]*text-decoration-line: underline[^}]*text-underline-offset: 0\.16em/su,
    );
    expect(cssSource).not.toMatch(/\.scient-markdown-wiki-link:hover/su);
    expect(cssSource).not.toContain(".scient-markdown-wiki-link.is-selected");
    expect(cssSource).not.toContain(".scient-markdown-wiki-link-source");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

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

// regression: c66c948db0 chore(upstream): merge t3 through 81dea7821d
it("retains the established preview table export controls", async () => {
  await using _fixture = _createFixture();

  expect(previewRendererSource).toContain('from "./chat/MarkdownTable"');
  expect(previewRendererSource).toContain("<MarkdownTable {...props} dir={tableDirection} />");
  // Upstream removed the expand/collapse toggle: tables always open fitted.
  for (const label of ["Copy as Markdown", "Copy as CSV"]) {
    expect(tableRendererSource).toContain(label);
  }
});
