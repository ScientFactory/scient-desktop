// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off -- Verifies the editor stylesheet contract directly.
import * as NodeFS from "node:fs";

import { afterEach, describe, expect, it } from "vite-plus/test";

const cssSource = NodeFS.readFileSync(
  `${process.cwd()}/src/scient/markdownEditor/scient-markdown-editor.css`,
  "utf8",
);

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
  it("contains selection and find controls instead of leaking outside narrow panes", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-selection-toolbar \{[^}]*max-width: calc\(100vw - 1rem\)[^}]*overflow-x: auto[^}]*scrollbar-width: none/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-find-bar \{[^}]*overflow-x: auto[^}]*overflow-y: hidden[^}]*scrollbar-width: none/su,
    );
    expect(cssSource).toMatch(/\.scient-markdown-find-bar > div \{[^}]*min-width: max-content/su);
  });

  it("gives every nested Markdown editor a visible keyboard focus boundary", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-wiki-link-source:focus-visible,[^}]*\.scient-markdown-image-editor input:focus-visible,[^}]*\.scient-markdown-reference-source:focus-visible,[^}]*\.scient-markdown-source-island-editor:focus-visible,[^}]*\.scient-markdown-math-source:focus-visible \{[^}]*outline: 2px solid[^}]*outline-offset: 1px/su,
    );
  });

  it("presents wiki links as selectable underlined text and one editing surface when selected", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-wiki-link \{[^}]*user-select: text[^}]*vertical-align: baseline/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-wiki-link-label \{[^}]*text-decoration-line: underline[^}]*text-underline-offset: 0\.16em/su,
    );
    expect(cssSource).not.toMatch(/\.scient-markdown-wiki-link:hover/su);
    expect(cssSource).toMatch(
      /\.scient-markdown-wiki-link\.is-selected \.scient-markdown-wiki-link-label \{\s*display: none;/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-wiki-link-source \{[^}]*border: 1px solid[^}]*background: var\(--background\)[^}]*box-shadow:/su,
    );
  });
});
