// @effect-diagnostics nodeBuiltinImport:off - The test reads the print stylesheet it checks.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const stylesheet = NodeFS.readFileSync(
  new URL("./scient-document-page.css", import.meta.url),
  "utf8",
);

/** Selectors of every rule that keeps its box whole on one page. */
function keptWhole(css: string): ReadonlyArray<string> {
  const rules = css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{([^{}]*)\}/gu);
  return [...rules]
    .filter(([, , body]) => /break-inside:\s*avoid-page/u.test(body ?? ""))
    .flatMap(([, selectors]) =>
      // Split the selector list on top-level commas only, not those inside :where().
      (selectors ?? "").split(/,(?![^(]*\))/u).map((selector) => selector.trim()),
    );
}

describe("document page print stylesheet", () => {
  it("keeps words intact when sizing table columns", () => {
    const tableCells = stylesheet.match(
      /\.scient-document \.scient-document-table :where\(th, td\) \{([^}]*)\}/u,
    )?.[1];
    expect(tableCells).toMatch(/overflow-wrap:\s*break-word/u);
    expect(tableCells).toMatch(/word-break:\s*normal/u);
  });

  // The desktop prints this page without the HTML-export pagination defaults,
  // so this sheet alone decides what may split across pages.
  it("keeps only small units whole, so work logs, reasoning, and quotes flow", () => {
    const whole = keptWhole(stylesheet);
    expect(whole).toEqual(
      expect.arrayContaining([
        ".scient-document :where(h1, h2, h3, h4, h5, h6)",
        ".scient-document details > summary",
        ".scient-document blockquote[data-alert]",
        ".scient-document figure.scient-document-code[data-short]",
        ".scient-document .scient-document-table tr",
        ".scient-document .scient-document-image",
        ".scient-document figure.scient-document-diagram",
      ]),
    );
    for (const selector of whole) {
      expect(selector).not.toMatch(/(?:^|\s)(?:details|blockquote|pre|table)$/u);
      expect(selector).not.toMatch(/--conversation details|scient-document-notes$/u);
    }
  });
});
