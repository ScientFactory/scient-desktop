// @effect-diagnostics nodeBuiltinImport:off - Repository verification reads tracked source files before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * The product is Scient. That misspelling has twice reached merged alignment
 * receipts and UPSTREAM.md, both times because `brand:check` only reads
 * product surfaces and never opened a documentation file. This guard reads the
 * whole tree instead, so a slip fails CI instead of shipping.
 */
const MISSPELLING = /sciant/i;

const SCANNED_EXTENSIONS: Record<string, true> = {
  ".md": true,
  ".ts": true,
  ".tsx": true,
  ".json": true,
  ".mjs": true,
  ".yml": true,
  ".yaml": true,
};

const SKIPPED_DIRECTORIES: Record<string, true> = {
  ".git": true,
  node_modules: true,
  dist: true,
  build: true,
  ".scient-next": true,
};

/** This file names the misspelling in its pattern and fixtures, so the guard must skip it. */
const GUARD_PATH = "scripts/check-scient-spelling.test.ts";

export interface MisspellingHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export function findMisspellings(
  files: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
): MisspellingHit[] {
  const hits: MisspellingHit[] = [];
  for (const file of files) {
    if (file.path === GUARD_PATH) continue;
    const lines = file.contents.split("\n");
    for (const [index, line] of lines.entries()) {
      if (MISSPELLING.test(line)) {
        hits.push({ path: file.path, line: index + 1, text: line.trim() });
      }
    }
  }
  return hits;
}

function collectScannableFiles(root: string): Array<{ path: string; contents: string }> {
  const files: Array<{ path: string; contents: string }> = [];
  const walk = (directory: string): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES[entry.name] === true) continue;
        walk(NodePath.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (SCANNED_EXTENSIONS[NodePath.extname(entry.name)] !== true) continue;
      const path = NodePath.join(directory, entry.name);
      files.push({
        path: NodePath.relative(root, path),
        contents: NodeFS.readFileSync(path, "utf8"),
      });
    }
  };
  walk(root);
  return files;
}

describe("Scient spelling guard", () => {
  it("reports each misspelled occurrence with its path and line", () => {
    expect(
      findMisspellings([
        {
          path: "docs/internals/note.md",
          contents: "Sciant keeps this.\nScient keeps that.",
        },
        { path: "UPSTREAM.md", contents: "kept by Sciant's rules" },
      ]),
    ).toEqual([
      { path: "docs/internals/note.md", line: 1, text: "Sciant keeps this." },
      { path: "UPSTREAM.md", line: 1, text: "kept by Sciant's rules" },
    ]);
  });

  it("accepts the correct spelling everywhere, including near-miss words", () => {
    expect(
      findMisspellings([
        { path: "docs/user/a.md", contents: "Scient's sidebar.\nscience and scientists\n" },
      ]),
    ).toEqual([]);
  });

  it("never scans itself, which names the misspelling on purpose", () => {
    expect(findMisspellings([{ path: GUARD_PATH, contents: "Sciant Sciant Sciant" }])).toEqual([]);
  });

  it("finds no misspelling anywhere in the repository", () => {
    const hits = findMisspellings(collectScannableFiles(NodePath.resolve("..")));
    expect(hits.map((hit) => `${hit.path}:${hit.line} ${hit.text}`).join("\n")).toBe("");
  });
});
