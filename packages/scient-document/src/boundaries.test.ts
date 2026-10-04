// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const sourceDirectory = NodePath.resolve(NodeURL.fileURLToPath(new URL(".", import.meta.url)));
const packageDirectory = NodePath.dirname(sourceDirectory);

function sourceFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("document session package boundary", () => {
  it("has no runtime dependencies", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(packageDirectory, "package.json"), "utf8"),
    ) as { readonly dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("imports only its own modules, so no document format can leak in", () => {
    for (const file of sourceFiles(sourceDirectory)) {
      const source = NodeFS.readFileSync(file, "utf8");
      // Static, side-effect, re-export, and dynamic imports.
      const specifiers = [
        ...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)["']([^"']+)["']/gu),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        expect(specifier, `${NodePath.relative(packageDirectory, file)}`).toMatch(/^\.\.?\//u);
      }
    }
  });
});
