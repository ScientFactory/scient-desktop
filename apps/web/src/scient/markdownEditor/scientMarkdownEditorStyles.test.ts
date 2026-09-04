// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off -- Verifies the editor stylesheet contract directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const cssSource = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "scient-markdown-editor.css"),
  "utf8",
);
const previewCssSource = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../../index.css"),
  "utf8",
);
const previewSurfaceSource = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../../components/files/FileMarkdownPreview.tsx"),
  "utf8",
);
const previewRendererSource = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../../components/ChatMarkdown.tsx"),
  "utf8",
);

describe("rich Markdown preview presentation parity", () => {
  it("retains the established preview table expansion and export controls", () => {
    for (const label of [
      '"Collapse table cells"',
      '"Expand table cells"',
      "Copy as Markdown",
      "Copy as CSV",
    ]) {
      expect(previewRendererSource).toContain(label);
    }
  });

  it("keeps the same document measure, inset, type scale, and contrast as the established preview", () => {
    expect(previewSurfaceSource).toContain('className="mx-auto max-w-4xl px-6 py-5"');
    expect(previewRendererSource).toContain(
      "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80",
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document \{[^}]*width: min\(100%, 56rem\)[^}]*padding: 1\.25rem 1\.5rem 5rem;[^}]*color: color-mix\(in oklab, var\(--foreground\) 80%, transparent\)[^}]*font-size: 0\.875rem[^}]*line-height: 1\.625[^}]*white-space: pre-wrap/su,
    );
    expect(cssSource).not.toContain("text-wrap: balance");
  });

  it("tracks the preview's headings, rhythm, links, quotes, inline code, and image bound", () => {
    for (const declaration of [
      "margin: 1.25rem 0 0.5rem",
      "font-weight: 600",
      "font-size: 1.25rem",
      "font-size: 1.125rem",
      "margin: 0.65rem 0",
      "color: var(--info-foreground)",
      "padding-left: 0.8rem",
      "font-size: 0.75rem",
    ]) {
      expect(previewCssSource).toContain(declaration);
    }
    expect(cssSource).toMatch(
      /\.scient-markdown-document h1,[^}]*margin-block: 1\.25rem 0\.5rem[^}]*font-weight: 600[^}]*line-height: 1\.3/su,
    );
    expect(cssSource).toMatch(/\.scient-markdown-document h1 \{\s*font-size: 1\.25rem/su);
    expect(cssSource).toMatch(/\.scient-markdown-document h2 \{\s*font-size: 1\.125rem/su);
    expect(cssSource).toMatch(/\.scient-markdown-document p,[^}]*margin-block: 0\.65rem/su);
    expect(cssSource).toMatch(
      /\.scient-markdown-document\.is-read a,[^}]*color: var\(--info-foreground\)[^}]*text-decoration: none/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document blockquote \{[^}]*padding-inline-start: 0\.8rem[^}]*border-inline-start: 2px solid var\(--contrast-border\)[^}]*color: var\(--contrast-muted-foreground\)/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document :not\(pre\) > code \{[^}]*border: 1px solid var\(--contrast-border\)[^}]*font-size: 0\.75rem/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-image-render \{[^}]*max-height: min\(30rem, 70vh\)/su,
    );
  });

  it("uses the same interrupted row separators while retaining editor-only table affordances", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-document table \{[^}]*min-width: max-content[^}]*font-size: 0\.75rem/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document th,[^}]*min-width: 5rem[^}]*border-block-end: 1px solid transparent[^}]*background-position: center bottom[^}]*background-repeat: no-repeat[^}]*background-size: calc\(100% - 1rem\) 1px/su,
    );
    expect(previewCssSource).toMatch(
      /\.chat-markdown thead th,\s*\.chat-markdown tbody td \{[^}]*border-bottom: 1px solid transparent[^}]*background-position: center bottom[^}]*background-repeat: no-repeat[^}]*background-size: calc\(100% - 1rem\) 1px/su,
    );
    expect(cssSource).toContain(".scient-markdown-table-select");
    expect(cssSource).toContain(".scient-markdown-document .selectedCell::after");
    expect(cssSource).not.toContain("text-overflow: ellipsis");
    expect(cssSource).not.toContain("max-width: 24rem");
  });

  it("keeps the table-size picker scrollbar horizontal, thin, faint, and locally scoped", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-table-size-viewport \{[^}]*scrollbar-color: color-mix\([^}]*var\(--contrast-muted-foreground\) 18%[^}]*scrollbar-width: thin/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-table-size-viewport::-(?:webkit-scrollbar) \{[^}]*width: 0;[^}]*height: 2px;/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-table-size-viewport::-webkit-scrollbar-thumb \{[^}]*border-radius: 999px;[^}]*var\(--contrast-muted-foreground\) 18%/su,
    );
  });

  it("lets the shared scientific renderer own its presentation without ordinary code chrome", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-code-block\[data-scient-markdown-rich-fence\] \{[^}]*margin-block: 0\.75rem[^}]*overflow: visible[^}]*border: 0[^}]*border-radius: 0[^}]*background: transparent[^}]*color: inherit/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-code-block\[data-scient-markdown-rich-fence\] > \.scient-markdown-code-header \{\s*display: none;/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-code-block\[data-scient-markdown-rich-fence\] > \.scient-markdown-code-render \{[^}]*overflow: visible[^}]*padding: 0[^}]*font-family: inherit[^}]*font-size: inherit[^}]*line-height: inherit[^}]*white-space: normal[^}]*overflow-wrap: normal/su,
    );
    expect(cssSource).toMatch(/> \[data-scient-visual-card\] \{\s*margin-block: 0;/su);
    expect(cssSource).toMatch(
      /\.scient-markdown-code-block\[data-scient-markdown-rich-fence\] \.scient-markdown-code-editor \{[^}]*border: 1px solid[^}]*--markdown-code-block-background/su,
    );
  });

  it("shares one deliberate quiet code-card surface with the established preview", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-code-block \{[^}]*background: var\([^}]*--markdown-code-block-background/su,
    );
    expect(previewCssSource).toMatch(
      /--markdown-code-block-background:\s*color-mix\([^;]+var\(--code-background\) 95%[^;]+var\(--code-foreground\) 5%/su,
    );
    expect(previewCssSource).toMatch(
      /html\[data-theme-id\] \.chat-markdown \.chat-markdown-codeblock \{[^}]*background-color: var\(--markdown-code-block-background\)/su,
    );
    expect(previewCssSource).toMatch(
      /\.chat-markdown \.chat-markdown-codeblock \{[^}]*background-color: var\(--markdown-code-block-background\)/su,
    );
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
});

describe("rich Markdown list marker styles", () => {
  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("restores ordered and unordered markers after the application reset", () => {
    expect(cssSource).toMatch(/\.scient-markdown-document ul \{\s*list-style-type: disc;/su);
    expect(cssSource).toMatch(/\.scient-markdown-document ol \{\s*list-style-type: decimal;/su);
    expect(cssSource).toMatch(/\.scient-markdown-document ul ul \{\s*list-style-type: circle;/su);
    expect(cssSource).toMatch(
      /\.scient-markdown-document ol ol \{\s*list-style-type: lower-alpha;/su,
    );
  });

  it("keeps task-list rows markerless so their interactive checkbox is the marker", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-document li\[data-task-checked\] \{[^}]*list-style: none;/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-task-content > :first-child \{\s*margin-block-start: 0;/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-task-content > :last-child \{\s*margin-block-end: 0;/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-task-checkbox \{[^}]*margin-block-start: calc\(\(1\.625em - 0\.95rem\) \/ 2\)[^}]*margin-inline-start: -1\.25rem[^}]*margin-inline-end: 0\.3rem/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-task-content > ul,[^}]*\.scient-markdown-task-content > ol \{\s*margin-block: 0\.2em;/su,
    );
  });

  it("computes visible nested markers while leaving task rows markerless", () => {
    const style = document.createElement("style");
    style.textContent = cssSource;
    document.head.append(style);
    document.body.innerHTML = `
      <div class="scient-markdown-document">
        <ul id="bullets"><li>One<ul id="nested-bullets"><li>Two</li></ul></li></ul>
        <ol id="numbers"><li>One<ol id="nested-numbers"><li>Two</li></ol></li></ol>
        <ul><li id="task" data-task-checked="false">Task</li></ul>
      </div>
    `;

    expect(getComputedStyle(document.querySelector("#bullets")!).listStyleType).toBe("disc");
    expect(getComputedStyle(document.querySelector("#nested-bullets")!).listStyleType).toBe(
      "circle",
    );
    expect(getComputedStyle(document.querySelector("#numbers")!).listStyleType).toBe("decimal");
    expect(getComputedStyle(document.querySelector("#nested-numbers")!).listStyleType).toBe(
      "lower-alpha",
    );
    expect(getComputedStyle(document.querySelector("#task")!).listStyle).toBe("none");
  });
});

describe("rich Markdown compact-surface styles", () => {
  it("shows the table handle only in the active editable table without contributing layout height", () => {
    const style = document.createElement("style");
    style.textContent = cssSource;
    document.head.append(style);
    const host = document.createElement("div");
    host.className = "scient-markdown-document is-write";
    host.innerHTML =
      '<div class="scient-markdown-table"><button class="scient-markdown-table-select"></button><table dir="rtl"><tbody><tr><td>English</td></tr></tbody></table></div>';
    document.body.append(host);
    try {
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
      expect(getComputedStyle(host.querySelector("td")!).unicodeBidi).toBe("isolate");
      host.classList.remove("is-write");
      expect(getComputedStyle(button).display).toBe("none");
      host.querySelector("table")!.removeAttribute("dir");
      // happy-dom retains descendant computed styles after an ancestor attribute
      // changes. Recreate that subtree for this selector test; Chromium separately
      // qualifies the live directed -> auto transition without replacing nodes.
      const table = host.querySelector("table")!;
      table.replaceWith(table.cloneNode(true));
      expect(getComputedStyle(host.querySelector("td")!).unicodeBidi).toBe("isolate");
    } finally {
      host.remove();
      style.remove();
    }
  });
  it("keeps resolved and explicit direction isolated from surrounding prose", () => {
    const style = document.createElement("style");
    style.textContent = cssSource;
    document.head.append(style);
    const host = document.createElement("div");
    host.className = "scient-markdown-document";
    host.innerHTML =
      '<p>שלום world</p><p dir="ltr">שלום world</p><h2 dir="rtl">English עברית</h2><blockquote dir="rtl">English עברית</blockquote><table><tbody><tr><td dir="rtl">English עברית</td></tr></tbody></table>';
    document.body.append(host);
    try {
      expect(getComputedStyle(host.children[0]!).unicodeBidi).toBe("isolate");
      expect(getComputedStyle(host.children[1]!).unicodeBidi).toBe("isolate");
      expect(getComputedStyle(host.children[2]!).unicodeBidi).toBe("isolate");
      expect(getComputedStyle(host.children[3]!).unicodeBidi).toBe("isolate");
      expect(getComputedStyle(host.querySelector("td")!).unicodeBidi).toBe("isolate");
      expect(getComputedStyle(host.children[1]!).textAlign).toBe("start");
    } finally {
      host.remove();
      style.remove();
    }
  });

  it("keeps authored GFM column alignment physical in both cell directions", () => {
    const style = document.createElement("style");
    style.textContent = cssSource;
    document.head.append(style);
    const host = document.createElement("div");
    host.className = "scient-markdown-document";
    host.innerHTML = `
      <table><tbody><tr>
        <td id="ltr-left" dir="ltr" data-alignment="left">Left</td>
        <td id="ltr-center" dir="ltr" data-alignment="center">Center</td>
        <td id="ltr-right" dir="ltr" data-alignment="right">Right</td>
        <td id="rtl-left" dir="rtl" data-alignment="left">يسار</td>
        <td id="rtl-center" dir="rtl" data-alignment="center">وسط</td>
        <td id="rtl-right" dir="rtl" data-alignment="right">يمين</td>
      </tr></tbody></table>
    `;
    document.body.append(host);
    try {
      for (const direction of ["ltr", "rtl"]) {
        for (const alignment of ["left", "center", "right"]) {
          expect(
            getComputedStyle(host.querySelector(`#${direction}-${alignment}`)!).textAlign,
          ).toBe(alignment);
        }
      }
    } finally {
      host.remove();
      style.remove();
    }
  });

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

  it("contains selection and find controls instead of leaking outside narrow panes", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-selection-toolbar \{[^}]*max-width: calc\(100vw - 1rem\)[^}]*overflow-x: auto[^}]*scrollbar-width: none/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-find-bar \{[^}]*overflow-x: auto[^}]*overflow-y: hidden[^}]*scrollbar-width: none/su,
    );
    expect(cssSource).toMatch(/\.scient-markdown-find-bar > div \{[^}]*min-width: max-content/su);
  });

  it("keeps math editing visually quiet while retaining visible focus boundaries", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-reference-source:focus-visible \{[^}]*outline: 2px solid[^}]*outline-offset: 1px/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-source-island:not\(\[data-scient-markdown-source-kind="html"\]\):is\([^}]*:focus-within[^}]*border-color:/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-math-source:focus-visible \{[^}]*border-color: color-mix\(in oklab, var\(--muted-foreground\) 45%, var\(--border\)\)[^}]*outline: none/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-document \.scient-markdown-math\.ProseMirror-selectednode \{\s*outline: none;/su,
    );
    expect(cssSource).not.toMatch(/\.scient-markdown-math\.is-selected \{[^}]*outline:/su);
    expect(cssSource).toMatch(
      /\.scient-markdown-document\.is-write \.scient-markdown-math-render:hover \{[^}]*background: color-mix\(in oklab, var\(--muted\) 55%, transparent\)[^}]*box-shadow:/su,
    );
    expect(cssSource).toMatch(
      /textarea\.scient-markdown-math-source \{[^}]*field-sizing: content[^}]*min-height: 2rem[^}]*max-height: 14rem[^}]*overflow-y: auto[^}]*resize: vertical/su,
    );
  });

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

  it("keeps ordinary code geometry stable and removes active-row chrome", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-code-editor \.cm-content,[^}]*\.scient-markdown-code-editor \.cm-line \{\s*padding: 0;/su,
    );
    expect(cssSource).not.toContain(".scient-markdown-code-editor .cm-activeLine");
    expect(cssSource).not.toMatch(/\.scient-markdown-code-editor \.cm-editor \{[^}]*max-height:/su);
  });

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

  it("keeps reference definitions directly editable and invisible in read mode", () => {
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

  it("presents wiki links as selectable underlined text without a second inline editor", () => {
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
