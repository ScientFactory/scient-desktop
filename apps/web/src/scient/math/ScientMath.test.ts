import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { renderScientTexToHtml } from "./katexRuntime";
import { getScientKatexRuntimePromise, ScientDisplayMath, ScientInlineMath } from "./ScientMath";

describe("renderScientTexToHtml", () => {
  it("renders KaTeX markup for both modes", () => {
    const inline = renderScientTexToHtml("x^2", false);
    expect(inline).toContain("katex");
    expect(inline).toContain("<math");

    expect(renderScientTexToHtml("x^2", true)).toContain("katex-display");
  });

  it("returns null for TeX KaTeX cannot parse, instead of error markup", () => {
    expect(renderScientTexToHtml("\\badcmd", false)).toBeNull();
    expect(renderScientTexToHtml("{unbalanced", false)).toBeNull();
  });

  it("caps pathological sizes so layout stays bounded", () => {
    const html = renderScientTexToHtml("\\rule{500em}{500em}", true);

    // The MathML annotation echoes the source; the rendered styles must not.
    expect(html).not.toBeNull();
    expect(html).not.toMatch(/:500em/);
    expect(html).toContain(":50em");
  });
});

describe("getScientKatexRuntimePromise", () => {
  it("requests the runtime chunk once", async () => {
    const first = getScientKatexRuntimePromise();

    expect(getScientKatexRuntimePromise()).toBe(first);
    await expect(first).resolves.toHaveProperty("renderScientTexToHtml", renderScientTexToHtml);
  });
});

describe("math components", () => {
  it("falls back to the literal source carrying its markdown copy form", () => {
    const inline = renderToStaticMarkup(createElement(ScientInlineMath, { tex: "x^2" }));
    const display = renderToStaticMarkup(createElement(ScientDisplayMath, { tex: "E = mc^2" }));

    expect(inline).toContain("$x^2$");
    expect(inline).toContain('data-markdown-copy="$x^2$"');
    expect(display).toContain("$$E = mc^2$$");
    expect(display).toContain("data-markdown-copy");
  });
});
