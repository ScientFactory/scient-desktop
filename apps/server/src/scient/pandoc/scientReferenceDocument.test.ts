// @effect-diagnostics nodeBuiltinImport:off -- Writes the packed reference document to read it back as a ZIP.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { XMLValidator } from "fast-xml-parser";

import { readZipEntries } from "./pandocTestSupport.ts";
import {
  SCIENT_REFERENCE_STYLES,
  scientReferenceDocument,
  scientReferenceDocumentParts,
} from "./scientReferenceDocument.ts";

describe("scientReferenceDocument", () => {
  it("defines every style Pandoc's Word writer and Scient's preparation use", () => {
    const names = new Set(SCIENT_REFERENCE_STYLES.map((style) => style.name));
    for (const name of [
      "Normal",
      "Body Text",
      "First Paragraph",
      "Compact",
      "Title",
      "heading 1",
      "heading 6",
      "Block Text",
      "footnote text",
      "footnote reference",
      "caption",
      "Table Caption",
      "Image Caption",
      "Source Code",
      "Verbatim Char",
      "Hyperlink",
      "Bibliography",
      "Table",
      "Scient Work Log",
      "Scient Reasoning",
      "Scient Alert",
      "Scient Task List",
      "Scient Placeholder",
      "Scient Speaker User",
      "Scient Speaker Assistant",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    // Pandoc finds custom styles by name and writes the id with spaces removed.
    for (const style of SCIENT_REFERENCE_STYLES.filter((entry) =>
      entry.name.startsWith("Scient "),
    )) {
      expect(style.id).toBe(style.name.replaceAll(" ", ""));
    }
  });

  it("is well-formed XML in every part", () => {
    for (const [name, contents] of scientReferenceDocumentParts()) {
      expect(XMLValidator.validate(contents), name).toBe(true);
    }
  });

  it.effect("packs a reproducible Word package", () =>
    Effect.gen(function* () {
      const first = yield* scientReferenceDocument;
      const second = yield* scientReferenceDocument;
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-reference-"));
      try {
        const target = NodePath.join(directory, "reference.docx");
        NodeFS.writeFileSync(target, first);
        const entries = yield* Effect.promise(() => readZipEntries(target));
        expect([...entries.keys()].toSorted()).toEqual([
          "[Content_Types].xml",
          "_rels/.rels",
          "word/_rels/document.xml.rels",
          "word/document.xml",
          "word/styles.xml",
        ]);
        expect(entries.get("word/document.xml")?.toString("utf8")).toContain('w:w="11906"');
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );
});
