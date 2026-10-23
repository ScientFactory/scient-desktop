import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import katex from "katex";

import { renderScientTexToHtml } from "./katexRuntime";
import {
  getScientKatexRuntimePromise,
  renderCachedScientMath,
  ScientDisplayMath,
  ScientInlineMath,
} from "./ScientMath";

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

    // Both forms are double-dollar: single-dollar spans are not recognized,
    // so only `$$...$$` re-renders as math when a copied message is pasted.
    expect(inline).toContain("$$x^2$$");
    expect(inline).toContain('data-markdown-copy="$$x^2$$"');
    expect(display).toContain("$$E = mc^2$$");
    expect(display).toContain("data-markdown-copy");
  });
});

it.each(["x_{cache_unique}", "\\badcmd_{cache_unique}"])(
  "shares valid and failed validation with presentation: %s",
  (tex) => {
    const render = vi.fn(renderScientTexToHtml);
    const runtime = { renderScientTexToHtml: render };
    const html = renderCachedScientMath(runtime, tex, true);
    expect(renderCachedScientMath(runtime, tex, true)).toBe(html);
    const output = renderToStaticMarkup(createElement(ScientDisplayMath, { tex }));
    expect(output).toContain(html === null ? "badcmd" : "katex");
    expect(render).toHaveBeenCalledOnce();
  },
);

it.each([ScientInlineMath, ScientDisplayMath])(
  "keeps keyboard scrolling in messages without adding a nested preview tab stop",
  (Component) => {
    const message = renderToStaticMarkup(createElement(Component, { tex: "x^2" }));
    expect(message).toContain('tabindex="0"');
    expect(message).toContain('role="group"');
    const preview = renderToStaticMarkup(
      createElement(Component, { tex: "x^2", focusable: false }),
    );
    expect(preview).not.toContain("tabindex");
    expect(preview).not.toContain('role="group"');
    expect(preview).toContain("data-markdown-copy");
  },
);

it.each([
  String.raw`\href{https://example.test}{x}`,
  String.raw`\includegraphics{https://example.test/a.png}`,
])("keeps active TeX commands inert: %s", (tex) => {
  const html = renderScientTexToHtml(tex, false);
  expect(html).not.toBeNull();
  expect(html).toContain("katex");
  expect(html).toContain("<math");
  expect(html).not.toMatch(/<(?:a|img)\b/u);
  expect(html).not.toMatch(/(?:href|src)=["']https:/u);

  // The same active command would create a resource/link if trust were enabled.
  const trusted = katex.renderToString(tex, { trust: true, throwOnError: true, strict: "ignore" });
  expect(trusted).toMatch(/(?:href|src)=["']https:\/\/example\.test/u);
});
