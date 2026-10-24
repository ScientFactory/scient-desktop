import editorStyles from "./scient-markdown-editor.css?inline";

import { describe, expect, it } from "vite-plus/test";

// Mounts the editor stylesheet with a document fragment and removes both on dispose.
function styledDocument(markup: string) {
  const style = document.createElement("style");
  style.textContent = editorStyles;
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
