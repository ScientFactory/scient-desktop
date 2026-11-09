// @effect-diagnostics nodeBuiltinImport:off -- Static audit of the app's style sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it } from "vite-plus/test";

const root = NodeURL.fileURLToPath(new URL("../..", import.meta.url));

function sources(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(?:tsx?|css)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

// Universal sibling selectors restyle following siblings on every insertion, making Enter costly in
// long documents. Use :not(:first-child) for equivalent separators without that invalidation.
it("keeps universal sibling selectors out of app styles", () => {
  const offenders = sources(root).flatMap((path) => {
    const text = NodeFS.readFileSync(path, "utf8");
    return /\[&>\*\+\*\]|\*\s*[+~]\s*\*/u.test(text) ? [NodePath.relative(root, path)] : [];
  });
  expect(offenders).toEqual([]);
});

// In Chromium, a :has() anchored on body, html or :root made each keystroke in a controlled
// textarea restyle the whole document. Key such styles off an attribute on a small element.
// A source heuristic, not a CSS parser: it does not follow native nesting.
const rootHas =
  /(?<![\w.#-])(?:html|body|:root)(?:\[[^\]]*\]|[.#][\w-]+|:(?!has\()[\w-]+(?:\([^()]*\))?)*:has\(/u;

it("keeps :has() off the document root", () => {
  expect(
    ["body:has(.a) .b", "html:has(.a)", ":root:has(.a)", "body.x:hover:has(.a) .b"].filter(
      (selector) => !rootHas.test(selector),
    ),
  ).toEqual([]);
  expect(
    [".body:has(.a)", "#body:has(.a)", "tbody:has(.a)"].filter((s) => rootHas.test(s)),
  ).toEqual([]);
  const offenders = sources(root).flatMap((path) => {
    const text = NodeFS.readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
    return rootHas.test(text) ? [NodePath.relative(root, path)] : [];
  });
  expect(offenders).toEqual([]);
});

// In Chromium, a sibling :has(+ …) or :has(~ …) restyled every top-level LaTeX block on each
// block insertion: half the cost of showing a long document. Mark the block from the editor.
const siblingHas = /:has\(\s*[+~]/u;

it("keeps sibling :has() out of Scient styles", () => {
  expect(["p:has(+ .a)", "p:has( ~ .a)"].filter((selector) => !siblingHas.test(selector))).toEqual(
    [],
  );
  expect(["p:has(> .a)", "p:has(.a + .b)"].filter((selector) => siblingHas.test(selector))).toEqual(
    [],
  );
  const offenders = sources(NodePath.join(root, "scient")).flatMap((path) => {
    const text = NodeFS.readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
    return siblingHas.test(text) ? [NodePath.relative(root, path)] : [];
  });
  expect(offenders).toEqual([]);
});
