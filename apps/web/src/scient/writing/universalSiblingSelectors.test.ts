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
