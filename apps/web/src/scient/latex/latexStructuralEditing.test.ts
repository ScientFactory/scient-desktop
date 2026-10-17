import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";
import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import { invertLatexSourcePatches } from "./latexSourceEditPlan";
import {
  applyLatexVisualDocumentChange,
  projectLatexSourceEdit,
  projectLatexVisualDocument,
} from "./latexVisualDocument";

const document = (body: string) =>
  `\\documentclass{article}\r\n% untouched setup\r\n\\begin{document}\r\n${body}\r\n\\end{document}\r\n% untouched trailer`;
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("bounded structural source validation", () => {
  it("keeps authored boundary spaces owned after a split so later edits and undo cannot strand them", () => {
    const source = document("Before.\r\n\r\nMiddle.\r\n\r\nAfter.");
    const projection = projectLatexVisualDocument(source),
      original = projection.content.content![1]!;
    const block = projection.blocks[1]!;
    const content = {
      ...projection.content,
      content: [
        projection.content.content![0]!,
        { ...original, content: [{ type: "text", text: " Middle " }] },
        paragraph("Continuation."),
        projection.content.content![2]!,
      ],
    };
    const edit = {
      source,
      patches: [
        {
          start: block.from,
          end: block.to,
          expected: block.source,
          replacement: " Middle \r\n\r\nContinuation.",
        },
      ],
    };
    const changed = projectLatexSourceEdit(edit, content, source, projection)!;
    expect(changed).not.toBeNull();
    const next = {
      ...changed.projection.content,
      content: changed.projection.content.content!.map((node, index) =>
        index === 1 ? { ...node, content: [{ type: "text", text: "Rewritten." }] } : node,
      ),
    };
    const rewritten = applyLatexVisualDocumentChange(changed.source, changed.projection, next)!;
    expect(rewritten.source).toContain("\r\n\r\nRewritten.\r\n\r\nContinuation.");
    expect(
      projectLatexSourceEdit(
        { source: changed.source, patches: invertLatexSourcePatches(source, edit.patches) },
        projection.content,
        changed.source,
        changed.projection,
      )?.source,
    ).toBe(source);
  });
  it("splits formatted prose, keeps untouched source bytes and distinct block owners, and undoes exactly", () => {
    const source = document(
      "Before~this.\r\n\r\n\\textbf{One~two three~four.}\r\n\r\nAfter~this.\r\n\r\nKeep~last.",
    );
    const projection = projectLatexVisualDocument(source);
    const original = projection.content.content![1]!,
      run = original.content![0]!;
    const content = {
      ...projection.content,
      content: [
        projection.content.content![0]!,
        { ...original, content: [{ ...run, text: "One\u00a0two" }] },
        { ...original, content: [{ ...run, text: "three\u00a0four." }] },
        ...projection.content.content!.slice(2),
      ],
    };
    const changed = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(changed).not.toBeNull();
    expect(changed.source).toContain("One~two");
    expect(changed.source).toContain("three~four.");
    expect(changed.source.startsWith(source.slice(0, projection.blocks[1]!.from))).toBe(true);
    expect(changed.source.endsWith(source.slice(projection.blocks[2]!.from))).toBe(true);
    expect(new Set(changed.projection.blocks.map((block) => block.id)).size).toBe(
      changed.projection.blocks.length,
    );
    const inverse = invertLatexSourcePatches(source, changed.edit.patches);
    const undone = projectLatexSourceEdit(
      { source: changed.source, patches: inverse },
      projection.content,
      changed.source,
      changed.projection,
    )!;
    expect(undone.source).toBe(source);
    expect(applyDocumentSourcePatches(changed.source, inverse)).toBe(source);
    const redone = projectLatexSourceEdit(
      changed.edit,
      changed.projection.content,
      source,
      undone.projection,
    )!;
    expect(redone.source).toBe(changed.source);
  });
  it("joins paragraphs and preserves a source-only block outside the local edit window", () => {
    const source = document(
      "First~words.\r\n\r\nSecond~words.\r\n\r\nThird.\r\n\r\nFourth.\r\n\r\n\\unknown{keep these exact bytes}",
    );
    const projection = projectLatexVisualDocument(source);
    const content = {
      ...projection.content,
      content: [
        paragraph("First\u00a0words.Second\u00a0words."),
        ...projection.content.content!.slice(2),
      ],
    };
    const changed = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(changed).not.toBeNull();
    expect(changed.source).toContain("First~words.Second~words.");
    expect(changed.source.endsWith(source.slice(projection.blocks[2]!.from))).toBe(true);
    expect(
      projectLatexSourceEdit(
        { source: changed.source, patches: invertLatexSourcePatches(source, changed.edit.patches) },
        projection.content,
        changed.source,
        changed.projection,
      )?.source,
    ).toBe(source);
  });
  it("rejects an inverse whose content does not match its source edit even with a supplied projection", () => {
    const source = document("Before.\r\n\r\nMiddle.\r\n\r\nAfter.");
    const projection = projectLatexVisualDocument(source),
      block = projection.blocks[1]!;
    expect(
      projectLatexSourceEdit(
        {
          source,
          patches: [
            { start: block.from, end: block.to, expected: block.source, replacement: "Changed." },
          ],
        },
        projection.content,
        source,
        projection,
      ),
    ).toBeNull();
    expect(
      projectLatexSourceEdit(
        {
          source,
          patches: [
            { start: block.from, end: block.to, expected: "Wrong owner", replacement: "Changed." },
          ],
        },
        projection.content,
        source,
        projection,
      ),
    ).toBeNull();
  });
});
