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
