import { describe, expect, it } from "vite-plus/test";
import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import { composeLatexSourceEdits } from "./LatexSourceStep";
import { invertLatexSourcePatches, type LatexSourceEdit } from "./latexSourceEditPlan";
import {
  assembleVisualProject,
  planVisualProjectEdit,
  type VisualProjectFile,
} from "./latexProjectVisual";

const native = "  Alpha\r\n% Keep this comment\r\nBeta 😀\r\n";

describe("owned native history composition", () => {
  it("composes successive edits without claiming untouched trivia between them", () => {
    const first: LatexSourceEdit = {
      source: native,
      patches: [{ start: 2, end: 7, expected: "Alpha", replacement: "Longer" }],
    };
    const afterFirst = applyDocumentSourcePatches(native, first.patches);
    const start = afterFirst.indexOf("Beta");
    const second: LatexSourceEdit = {
      source: afterFirst,
      patches: [{ start, end: start + 4, expected: "Beta", replacement: "Second" }],
    };
    const composed = composeLatexSourceEdits(native, [first, second])!;
    expect(composed.patches).toEqual([
      { start: 2, end: 7, expected: "Alpha", replacement: "Longer" },
      {
        start: native.indexOf("Beta"),
        end: native.indexOf("Beta") + 4,
        expected: "Beta",
        replacement: "Second",
      },
    ]);
    const next = applyDocumentSourcePatches(native, composed.patches);
    expect(next).toBe(native.replace("Alpha", "Longer").replace("Beta", "Second"));
    expect(
      applyDocumentSourcePatches(next, invertLatexSourcePatches(native, composed.patches)),
    ).toBe(native);
  });

  it("preserves native ordering for same-offset inserts followed by replacement", () => {
    const source = "Before\r\nAfter";
    const first: LatexSourceEdit = {
      source,
      patches: [
        { start: 6, end: 6, expected: "", replacement: " one" },
        { start: 6, end: 6, expected: "", replacement: " two" },
        { start: 6, end: 8, expected: "\r\n", replacement: "\n" },
      ],
    };
    const next = applyDocumentSourcePatches(source, first.patches);
    expect(next).toBe("Before one two\nAfter");
    const inverse: LatexSourceEdit = {
      source: next,
      patches: invertLatexSourcePatches(source, first.patches),
    };
    const composed = composeLatexSourceEdits(next, [inverse])!;
    expect(applyDocumentSourcePatches(next, composed.patches)).toBe(source);
  });

  it("preserves per-patch ownership sides for suffix edits and equal-offset insertions", () => {
    const source = "Chapter";
    const edit: LatexSourceEdit = {
      source,
      patches: [
        { start: 7, end: 7, expected: "", replacement: " own suffix", insertionAffinity: "before" },
        {
          start: 7,
          end: 7,
          expected: "",
          replacement: " adjacent text",
          insertionAffinity: "after",
        },
      ],
    };
    const composed = composeLatexSourceEdits(source, [edit])!;
    expect(composed.patches).toEqual(edit.patches);
    expect(applyDocumentSourcePatches(source, composed.patches)).toBe(
      "Chapter own suffix adjacent text",
    );
    const first: LatexSourceEdit = { source, patches: [edit.patches[0]!] };
    const intermediate = applyDocumentSourcePatches(source, first.patches);
    const afterInserted: LatexSourceEdit = {
      source: intermediate,
      patches: [
        {
          start: intermediate.length,
          end: intermediate.length,
          expected: "",
          replacement: " more",
        },
      ],
    };
    expect(composeLatexSourceEdits(source, [first, afterInserted])!.patches).toEqual([
      {
        start: 7,
        end: 7,
        expected: "",
        replacement: " own suffix more",
        insertionAffinity: "before",
      },
    ]);
  });

  it.each(["", "replacement"])(
    "keeps an adjacent after-side insertion independent of a native deletion or replacement (%j)",
    (replacement) => {
      const root =
        "\\documentclass{article}\n\\begin{document}\n\\input{first}\\input{second}\n\\end{document}";
      const files = new Map<string, VisualProjectFile>([
        [
          "main.tex",
          {
            contents: root,
            revision: "root",
            truncated: false,
            owner: { documentId: "root", editVersion: 0 },
          },
        ],
        [
          "first.tex",
          {
            contents: "First.\n",
            revision: "first",
            truncated: false,
            owner: { documentId: "first", editVersion: 0 },
          },
        ],
        [
          "second.tex",
          {
            contents: "Second.\n",
            revision: "second",
            truncated: false,
            owner: { documentId: "second", editVersion: 0 },
          },
        ],
      ]);
      const assembled = assembleVisualProject("main.tex", files);
      const boundary = assembled.spans.find((span) => span.path === "second.tex")!.from;
      const edit: LatexSourceEdit = {
        source: assembled.source,
        patches: [
          { start: boundary - 1, end: boundary, expected: "\n", replacement },
          {
            start: boundary,
            end: boundary,
            expected: "",
            replacement: "Inserted.",
            insertionAffinity: "after",
          },
        ],
      };
      const first: LatexSourceEdit = { source: assembled.source, patches: [edit.patches[0]!] };
      const intermediate = applyDocumentSourcePatches(assembled.source, first.patches);
      const nextBoundary = boundary - 1 + replacement.length;
      const composed = composeLatexSourceEdits(assembled.source, [
        first,
        {
          source: intermediate,
          patches: [
            {
              start: nextBoundary,
              end: nextBoundary,
              expected: "",
              replacement: "Inserted.",
              insertionAffinity: "after",
            },
          ],
        },
      ])!;
      expect(applyDocumentSourcePatches(assembled.source, composed.patches)).toBe(
        applyDocumentSourcePatches(assembled.source, edit.patches),
      );
      const plan = planVisualProjectEdit(assembled, composed, files, "main.tex");
      expect(plan.error).not.toBeNull();
      expect([...plan.edits]).toEqual([]);
      expect(files.get("main.tex")!.contents).toBe(root);
      expect(files.get("first.tex")!.contents).toBe("First.\n");
      expect(files.get("second.tex")!.contents).toBe("Second.\n");
    },
  );

  it("routes legal ordered insertion and replacement composition to exact same-owner bytes", () => {
    const root = "\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}";
    const chapter = "% Preserve 😀\r\nBefore\r\nAfter\r\n";
    const files = new Map<string, VisualProjectFile>([
      [
        "main.tex",
        {
          contents: root,
          revision: "root",
          truncated: false,
          owner: { documentId: "root", editVersion: 0 },
        },
      ],
      [
        "chapter.tex",
        {
          contents: chapter,
          revision: "chapter",
          truncated: false,
          owner: { documentId: "chapter", editVersion: 0 },
        },
      ],
    ]);
    const assembled = assembleVisualProject("main.tex", files);
    const offset = assembled.source.indexOf("Before") + "Before".length;
    const edit: LatexSourceEdit = {
      source: assembled.source,
      patches: [
        {
          start: offset,
          end: offset,
          expected: "",
          replacement: " one",
          insertionAffinity: "before",
        },
        {
          start: offset,
          end: offset,
          expected: "",
          replacement: " two",
          insertionAffinity: "after",
        },
        { start: offset, end: offset + 2, expected: "\r\n", replacement: "\n" },
      ],
    };
    const intermediate = applyDocumentSourcePatches(assembled.source, edit.patches);
    const inserted = intermediate.indexOf("one");
    const composed = composeLatexSourceEdits(assembled.source, [
      edit,
      {
        source: intermediate,
        patches: [{ start: inserted, end: inserted + 3, expected: "one", replacement: "first" }],
      },
    ])!;
    const plan = planVisualProjectEdit(assembled, composed, files, "main.tex");
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["chapter.tex"]);
    const patches = plan.edits.get("chapter.tex")!.patches;
    const changed = applyDocumentSourcePatches(chapter, patches);
    expect(changed).toBe("% Preserve 😀\r\nBefore first two\nAfter\r\n");
    expect(applyDocumentSourcePatches(changed, invertLatexSourcePatches(chapter, patches))).toBe(
      chapter,
    );
    expect(files.get("main.tex")!.contents).toBe(root);
  });

  it("composes native inverses across a rename and restores the current stable owner's original bytes", () => {
    const original =
      "\\documentclass{article}\r\n% Preserve 😀\r\n\\begin{document}\r\nAlpha\r\nBeta\r\n\\end{document}\r\n";
    const files = new Map<string, VisualProjectFile>([
      [
        "old.tex",
        {
          contents: original,
          revision: "r0",
          truncated: false,
          owner: { documentId: "stable-owner", editVersion: 0 },
        },
      ],
    ]);
    const firstAssembly = assembleVisualProject("old.tex", files);
    const alpha = firstAssembly.source.indexOf("Alpha");
    const first = planVisualProjectEdit(
      firstAssembly,
      {
        source: firstAssembly.source,
        patches: [{ start: alpha, end: alpha + 5, expected: "Alpha", replacement: "Longer" }],
      },
      files,
      "old.tex",
    );
    expect(first.error).toBeNull();
    const firstPatches = first.edits.get("old.tex")!.patches;
    const afterFirst = applyDocumentSourcePatches(original, firstPatches);
    files.delete("old.tex");
    files.set("renamed.tex", {
      contents: afterFirst,
      revision: "r0",
      truncated: false,
      owner: { documentId: "stable-owner", editVersion: 1 },
    });
    const renamedAssembly = assembleVisualProject("renamed.tex", files);
    const beta = renamedAssembly.source.indexOf("Beta");
    const second = planVisualProjectEdit(
      renamedAssembly,
      {
        source: renamedAssembly.source,
        patches: [{ start: beta, end: beta + 4, expected: "Beta", replacement: "Second" }],
      },
      files,
      "renamed.tex",
    );
    expect(second.error).toBeNull();
    const secondPatches = second.edits.get("renamed.tex")!.patches;
    const afterSecond = applyDocumentSourcePatches(afterFirst, secondPatches);
    files.set("renamed.tex", {
      contents: afterSecond,
      revision: "r0",
      truncated: false,
      owner: { documentId: "stable-owner", editVersion: 2 },
    });
    const currentAssembly = assembleVisualProject("renamed.tex", files);
    const secondInverse: LatexSourceEdit = {
      source: currentAssembly.source,
      patches: [],
      physical: [
        {
          path: "renamed.tex",
          documentId: "stable-owner",
          source: afterSecond,
          patches: invertLatexSourcePatches(afterFirst, secondPatches),
        },
      ],
    };
    const firstInverse: LatexSourceEdit = {
      source: renamedAssembly.source,
      patches: [],
      physical: [
        {
          path: "old.tex",
          documentId: "stable-owner",
          source: afterFirst,
          patches: invertLatexSourcePatches(original, firstPatches),
        },
      ],
    };
    const composed = composeLatexSourceEdits(currentAssembly.source, [
      secondInverse,
      firstInverse,
    ])!;
    expect(composed.physical![0]!.path).toBe("old.tex");
    const undo = planVisualProjectEdit(currentAssembly, composed, files, "renamed.tex");
    expect(undo.error).toBeNull();
    expect([...undo.edits.keys()]).toEqual(["renamed.tex"]);
    files.set("renamed.tex", {
      ...files.get("renamed.tex")!,
      contents: applyDocumentSourcePatches(afterSecond, undo.edits.get("renamed.tex")!.patches),
    });
    expect(files.has("old.tex")).toBe(false);
    expect(files.get("renamed.tex")!.contents).toBe(original);
    expect(
      composeLatexSourceEdits(currentAssembly.source, [
        secondInverse,
        {
          ...firstInverse,
          physical: [{ ...firstInverse.physical![0]!, source: afterFirst + "stale" }],
        },
      ]),
    ).toBeNull();
    expect(
      composeLatexSourceEdits(currentAssembly.source, [
        secondInverse,
        {
          ...firstInverse,
          physical: [{ ...firstInverse.physical![0]!, documentId: "replaced-owner" }],
        },
      ]),
    ).toBeNull();
  });

  it("composes already-physical inverses for one included session without remapping appearances", () => {
    const source = "First appearance\n\nSecond appearance";
    const first: LatexSourceEdit = {
      source,
      patches: [],
      physical: [
        {
          path: "chapter.tex",
          documentId: "native-session",
          source: "ABCD\r\n",
          patches: [{ start: 0, end: 1, expected: "A", replacement: "X" }],
        },
      ],
    };
    const second: LatexSourceEdit = {
      source: "An intermediate assembly",
      patches: [],
      physical: [
        {
          path: "chapter.tex",
          documentId: "native-session",
          source: "XBCD\r\n",
          patches: [{ start: 3, end: 4, expected: "D", replacement: "Y" }],
        },
      ],
    };
    const composed = composeLatexSourceEdits(source, [first, second])!;
    expect(composed.patches).toEqual([]);
    expect(composed.physical).toEqual([
      {
        path: "chapter.tex",
        documentId: "native-session",
        source: "ABCD\r\n",
        patches: [
          { start: 0, end: 1, expected: "A", replacement: "X" },
          { start: 3, end: 4, expected: "D", replacement: "Y" },
        ],
      },
    ]);
    expect(
      applyDocumentSourcePatches(composed.physical![0]!.source, composed.physical![0]!.patches),
    ).toBe("XBCY\r\n");
    expect(
      composeLatexSourceEdits(source, [
        first,
        { ...second, physical: [{ ...second.physical![0]!, documentId: "retired-session" }] },
      ]),
    ).toBeNull();
  });

  it("refuses stale chains and unsafe CRLF or UTF16 boundaries before producing a plan", () => {
    expect(
      composeLatexSourceEdits(native, [{ source: native + "outside", patches: [] }]),
    ).toBeNull();
    const cr = native.indexOf("\r\n");
    const emoji = native.indexOf("😀");
    for (const offset of [cr + 1, emoji + 1])
      expect(
        composeLatexSourceEdits(native, [
          { source: native, patches: [{ start: offset, end: offset, replacement: "unsafe" }] },
        ]),
      ).toBeNull();
  });
});
