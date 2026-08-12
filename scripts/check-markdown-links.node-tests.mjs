import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  checkMarkdownFile,
  markdownDestinations,
  resolveLocalDestination,
} from "./check-markdown-links.mjs";

NodeTest.test("collects inline, image, and reference destinations", () => {
  const markdown = [
    "[Guide](./guide.md)",
    "![Diagram](<./images/diagram with spaces.png>)",
    "[Reference][architecture]",
    "[architecture]: ../architecture.md",
  ].join("\n");

  NodeAssert.deepEqual(markdownDestinations(markdown), [
    { destination: "./guide.md", line: 1 },
    { destination: "./images/diagram with spaces.png", line: 2 },
    { destination: "../architecture.md", line: 4 },
  ]);
});

NodeTest.test("ignores external URLs and document anchors", () => {
  const root = "/repository";
  const file = "/repository/docs/readme.md";
  NodeAssert.equal(resolveLocalDestination(file, "https://example.com", root), null);
  NodeAssert.equal(resolveLocalDestination(file, "mailto:test@example.com", root), null);
  NodeAssert.equal(resolveLocalDestination(file, "#section", root), null);
});

NodeTest.test("resolves repository-root and relative links without allowing escape", () => {
  const root = "/repository";
  const file = "/repository/docs/readme.md";
  NodeAssert.deepEqual(resolveLocalDestination(file, "/README.md", root), {
    resolved: "/repository/README.md",
  });
  NodeAssert.deepEqual(resolveLocalDestination(file, "./guide.md#start", root), {
    resolved: "/repository/docs/guide.md",
  });
  NodeAssert.deepEqual(resolveLocalDestination(file, "../../outside.md", root), {
    error: "target escapes the repository: ../../outside.md",
  });
});

NodeTest.test("reports missing local targets with their source line", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-doc-links-"));
  try {
    const docs = NodePath.join(root, "docs");
    NodeFS.mkdirSync(docs);
    NodeFS.writeFileSync(NodePath.join(docs, "exists.md"), "# Existing\n");
    const source = NodePath.join(docs, "source.md");
    NodeFS.writeFileSync(source, "[Good](./exists.md)\n[Missing](./missing.md)\n");

    NodeAssert.deepEqual(checkMarkdownFile(source, root), [
      `${source}:2: missing local target ./missing.md`,
    ]);
  } finally {
    NodeFS.rmSync(root, { force: true, recursive: true });
  }
});
