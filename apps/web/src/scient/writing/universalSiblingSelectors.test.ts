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

// One stylesheet serves every surface. A universal sibling selector such as
// `> * + *` (Tailwind `[&>*+*]:…`) makes the browser restyle the following
// siblings of every inserted element anywhere in the page; in a long document
// that turned each Enter into half a second of style recalculation. Use
// `[&>:not(:first-child)]:…`, which draws the same separators.
it("keeps universal sibling selectors out of app styles", () => {
  const offenders = sources(root).flatMap((path) => {
    const text = NodeFS.readFileSync(path, "utf8");
    return /\[&>\*\+\*\]|\*\s*[+~]\s*\*/u.test(text) ? [NodePath.relative(root, path)] : [];
  });
  expect(offenders).toEqual([]);
});
