import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import { describe, expect, it } from "vite-plus/test";
import type { JSONContent } from "@tiptap/core";
import {
  applyLatexVisualDocumentChange,
  latexVisualBlockSourceEdit,
  projectLatexVisualDocument,
} from "./latexVisualDocument";
import {
  assembleVisualProject,
  planVisualProjectEdit,
  type VisualProjectFile,
} from "./latexProjectVisual";
import { invertLatexSourcePatches, latexOwnedSourcePatch } from "./latexSourceEditPlan";

const nativeFile = (contents: string, documentId: string, editVersion = 0): VisualProjectFile => ({
  contents,
  revision: `revision-${documentId}`,
  truncated: false,
  owner: { documentId, editVersion },
});
const document = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`;

function project(root: string, includes: readonly [string, string][]) {
  const files = new Map<string, VisualProjectFile>();
  files.set("main.tex", nativeFile(root, "root-owner"));
  for (const [path, contents] of includes) files.set(path, nativeFile(contents, `owner-${path}`));
  return { files, assembled: assembleVisualProject("main.tex", files) };
}

function replacement(source: string, needle: string, value: string, from = 0) {
  const start = source.indexOf(needle, from);
  if (start < 0) throw new Error("Missing fixture range");
  return { start, end: start + needle.length, expected: needle, replacement: value };
}

describe("owned physical LaTeX edits", () => {
  it("routes only the edited included bytes, preserving wrappers, comments and CRLF", () => {
    const root = document("Root paragraph.\n\n\\input{chapter}");
    const chapter =
      "% untouched 😀 comment\r\n\\section{Chapter}\r\nBefore \\textit{original} after.\r\n";
    const { files, assembled } = project(root, [["chapter.tex", chapter]]);
    const patch = replacement(assembled.source, "original", "edited");
    const plan = planVisualProjectEdit(
      assembled,
      { source: assembled.source, patches: [patch] },
      files,
      "main.tex",
    );
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["chapter.tex"]);
    const edit = plan.edits.get("chapter.tex")!;
    expect(edit).toMatchObject({ documentId: "owner-chapter.tex", basedOnVersion: 0 });
    expect(applyDocumentSourcePatches(chapter, edit.patches)).toBe(
      chapter.replace("original", "edited"),
    );
    expect(files.get("main.tex")!.contents).toBe(root);
  });

  it("rejects a replacement crossing physical include owners without partial patches", () => {
    const root = document("\\input{first}\\input{second}");
    const { files, assembled } = project(root, [
      ["first.tex", "First.\n"],
      ["second.tex", "Second.\n"],
    ]);
    const start = assembled.source.indexOf("First.");
    const end = assembled.source.indexOf("Second.") + "Second.".length;
    const plan = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: [
          { start, end, expected: assembled.source.slice(start, end), replacement: "Merged." },
        ],
      },
      files,
      "main.tex",
    );
    expect(plan.error).not.toBeNull();
    expect([...plan.edits]).toEqual([]);
    expect(files.get("first.tex")!.contents).toBe("First.\n");
    expect(files.get("second.tex")!.contents).toBe("Second.\n");
    expect(files.get("main.tex")!.contents).toBe(root);
  });

  it("does not authorize synthetic include page breaks", () => {
    const root = document("\\include{chapter}");
    const { files, assembled } = project(root, [["chapter.tex", "Chapter.\n"]]);
    const separator = assembled.spans.find(
      (span) =>
        span.path === null && assembled.source.slice(span.from, span.to).includes("\\clearpage"),
    )!;
    const plan = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: [
          {
            start: separator.from,
            end: separator.to,
            expected: assembled.source.slice(separator.from, separator.to),
            replacement: "",
          },
        ],
      },
      files,
      "main.tex",
    );
    expect(plan.error).not.toBeNull();
    expect([...plan.edits]).toEqual([]);
    expect(files.get("main.tex")!.contents).toBe(root);
    expect(files.get("chapter.tex")!.contents).toBe("Chapter.\n");
  });

  it("requires an explicit side for boundary insertions instead of preferring the open file", () => {
    const root = document("\\input{chapter}");
    const { files, assembled } = project(root, [["chapter.tex", "Chapter.\n"]]);
    const offset = assembled.source.indexOf("Chapter.");
    const patches = [{ start: offset, end: offset, expected: "", replacement: "Inserted.\n" }];
    const unowned = planVisualProjectEdit(
      assembled,
      { source: assembled.source, patches },
      files,
      "main.tex",
    );
    expect([...unowned.edits]).toEqual([]);
    expect(unowned.error).not.toBeNull();
    const chapter = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: patches.map((patch) => ({ ...patch, insertionAffinity: "after" as const })),
      },
      files,
      "main.tex",
    );
    expect(chapter.error).toBeNull();
    expect([...chapter.edits.keys()]).toEqual(["chapter.tex"]);
    expect(
      applyDocumentSourcePatches("Chapter.\n", chapter.edits.get("chapter.tex")!.patches),
    ).toBe("Inserted.\nChapter.\n");
    const beforeInclude = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: patches.map((patch) => ({ ...patch, insertionAffinity: "before" as const })),
      },
      files,
      "main.tex",
    );
    expect(beforeInclude.error).toBeNull();
    expect([...beforeInclude.edits.keys()]).toEqual(["main.tex"]);
    expect(applyDocumentSourcePatches(root, beforeInclude.edits.get("main.tex")!.patches)).toBe(
      root.replace("\\input{chapter}", "Inserted.\n\\input{chapter}"),
    );
  });

  it("applies a repeated included range once and updates every assembled appearance", () => {
    const root = document("\\input{chapter}\n\\input{chapter}");
    const { files, assembled } = project(root, [["chapter.tex", "Original.\n"]]);
    const first = replacement(assembled.source, "Original.", "Changed.");
    const second = replacement(assembled.source, "Original.", "Changed.", first.end);
    const plan = planVisualProjectEdit(
      assembled,
      { source: assembled.source, patches: [first, second] },
      files,
      "main.tex",
    );
    expect(plan.error).toBeNull();
    const edit = plan.edits.get("chapter.tex")!;
    expect(edit.patches).toEqual([
      { start: 0, end: 9, expected: "Original.", replacement: "Changed." },
    ]);
    const changed = applyDocumentSourcePatches(files.get("chapter.tex")!.contents, edit.patches);
    files.set("chapter.tex", nativeFile(changed, "owner-chapter.tex", 1));
    expect(assembleVisualProject("main.tex", files).source).toBe(
      assembled.source.replaceAll("Original.", "Changed."),
    );
    expect(files.get("main.tex")!.contents).toBe(root);
  });

  it("refuses contradictory edits to two appearances of the same native range", () => {
    const { files, assembled } = project(document("\\input{chapter}\\input{chapter}"), [
      ["chapter.tex", "Original.\n"],
    ]);
    const first = replacement(assembled.source, "Original.", "First.");
    const second = replacement(assembled.source, "Original.", "Second.", first.end);
    const plan = planVisualProjectEdit(
      assembled,
      { source: assembled.source, patches: [first, second] },
      files,
      "main.tex",
    );
    expect(plan.error).not.toBeNull();
    expect([...plan.edits]).toEqual([]);
    expect(files.get("chapter.tex")!.contents).toBe("Original.\n");
  });

  it("allows multiple body and root patches in one physical file but refuses two-file requirements", () => {
    const root = document("Original.");
    const { files, assembled } = project(root, []);
    const packageAt = root.indexOf("\\begin{document}");
    const rootPatch = {
      start: packageAt,
      end: packageAt,
      expected: "",
      replacement: "\\usepackage{xcolor}\n",
    };
    const bodyPatch = replacement(assembled.source, "Original.", "Changed.");
    const plan = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: [bodyPatch],
        root: { source: root, patches: [rootPatch] },
      },
      files,
      "main.tex",
    );
    expect(plan.error).toBeNull();
    const edit = plan.edits.get("main.tex")!;
    const next = applyDocumentSourcePatches(root, edit.patches);
    expect(next).toBe(
      root
        .replace("\\begin{document}", "\\usepackage{xcolor}\n\\begin{document}")
        .replace("Original.", "Changed."),
    );
    expect(applyDocumentSourcePatches(next, invertLatexSourcePatches(root, edit.patches))).toBe(
      root,
    );

    const includedRoot = document("\\input{chapter}");
    const included = project(includedRoot, [["chapter.tex", "Original.\n"]]);
    const includedAt = includedRoot.indexOf("\\begin{document}");
    const refused = planVisualProjectEdit(
      included.assembled,
      {
        source: included.assembled.source,
        patches: [replacement(included.assembled.source, "Original.", "Changed.")],
        root: {
          source: includedRoot,
          patches: [{ ...rootPatch, start: includedAt, end: includedAt }],
        },
      },
      included.files,
      "main.tex",
    );
    expect(refused.error).not.toBeNull();
    expect([...refused.edits]).toEqual([]);
    expect(included.files.get("main.tex")!.contents).toBe(includedRoot);
    expect(included.files.get("chapter.tex")!.contents).toBe("Original.\n");
  });

  it("binds history to a stable document owner through a rename, not a stale path", () => {
    const root = document("Changed.");
    const files = new Map<string, VisualProjectFile>();
    files.set("renamed.tex", nativeFile(root, "stable-document", 8));
    const assembled = assembleVisualProject("renamed.tex", files);
    const plan = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: [],
        physical: [
          {
            path: "old.tex",
            documentId: "stable-document",
            source: root,
            patches: [replacement(root, "Changed.", "Original.")],
          },
        ],
      },
      files,
      "renamed.tex",
    );
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["renamed.tex"]);
    const edit = plan.edits.get("renamed.tex")!;
    expect(edit.basedOnVersion).toBe(8);
    expect(applyDocumentSourcePatches(root, edit.patches)).toBe(document("Original."));
    const stale = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: [],
        physical: [
          {
            path: "renamed.tex",
            documentId: "previous-owner",
            source: root,
            patches: edit.patches,
          },
        ],
      },
      files,
      "renamed.tex",
    );
    expect(stale.error).not.toBeNull();
    expect([...stale.edits]).toEqual([]);
    expect(files.get("renamed.tex")!.contents).toBe(root);
  });

  it.each(["surrogate", "crlf"])("rejects a %s split without a physical plan", (kind) => {
    const source = document("Emoji 😀.\r\nNext.");
    const { files, assembled } = project(source, []);
    const start = kind === "surrogate" ? source.indexOf("😀") + 1 : source.indexOf("\r\n") + 1;
    const plan = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: [{ start, end: start, expected: "", replacement: "broken" }],
      },
      files,
      "main.tex",
    );
    expect(plan.error).not.toBeNull();
    expect([...plan.edits]).toEqual([]);
    expect(files.get("main.tex")!.contents).toBe(source);
  });

  it("ignores literal/comment includes without shifting astral source offsets", () => {
    const root = document(
      "\\begin{comment}\n😀 \\input{absent}\n\\end{comment}\n\\verb|😀 \\input{absent}|\n\\input{chapter}",
    );
    const { files, assembled } = project(root, [["chapter.tex", "Original.\n"]]);
    expect(assembled.errors).toEqual([]);
    expect(assembled.missing).toEqual([]);
    expect(assembled.source).toBe(root.replace("\\input{chapter}", "Original.\n"));
    const plan = planVisualProjectEdit(
      assembled,
      {
        source: assembled.source,
        patches: [replacement(assembled.source, "Original.", "Changed.")],
      },
      files,
      "main.tex",
    );
    expect(plan.error).toBeNull();
    expect(applyDocumentSourcePatches("Original.\n", plan.edits.get("chapter.tex")!.patches)).toBe(
      "Changed.\n",
    );
  });
});

describe("owned source inverse boundaries", () => {
  it("minimizes Unicode and line-ending replacements without splitting source units", () => {
    const source = "Before 😀\r\nAfter.";
    const patch = latexOwnedSourcePatch(source, 0, source.length, "Before 😁\nAfter.")!;
    expect(applyDocumentSourcePatches(source, [patch])).toBe("Before 😁\nAfter.");
    expect(
      applyDocumentSourcePatches("Before 😁\nAfter.", invertLatexSourcePatches(source, [patch])),
    ).toBe(source);
  });

  it("inverts same-offset insertions and a replacement in their native application order", () => {
    const source = "Alpha.";
    const patches = [
      { start: 0, end: 0, expected: "", replacement: "First " },
      { start: 0, end: 0, expected: "", replacement: "Second " },
      { start: 0, end: 5, expected: "Alpha", replacement: "Beta" },
    ];
    const next = applyDocumentSourcePatches(source, patches);
    expect(next).toBe("First Second Beta.");
    expect(applyDocumentSourcePatches(next, invertLatexSourcePatches(source, patches))).toBe(
      source,
    );
  });
});

function appendOwnedText(node: JSONContent, needle: string, suffix: string): boolean {
  if (node.type === "text" && node.text === needle) {
    node.text += suffix;
    return true;
  }
  let changed = false;
  for (const child of node.content ?? [])
    if (appendOwnedText(child, needle, suffix)) changed = true;
  return changed;
}

describe("adapter insertion provenance through physical includes", () => {
  it("appends prose at included EOF without a newline and preserves its exact native inverse", () => {
    const root = document("Root.\n\n\\input{chapter}");
    const { files, assembled } = project(root, [["chapter.tex", "Ending."]]);
    const projection = projectLatexVisualDocument(assembled.source);
    const content = structuredClone(projection.content);
    if (!appendOwnedText(content, "Ending.", " More.")) throw new Error("Missing fixture prose");
    const change = applyLatexVisualDocumentChange(assembled.source, projection, content);
    if (!change) throw new Error("Owned prose append was refused");
    const plan = planVisualProjectEdit(assembled, change.edit, files, "main.tex");
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["chapter.tex"]);
    const edit = plan.edits.get("chapter.tex")!;
    const next = applyDocumentSourcePatches("Ending.", edit.patches);
    expect(next).toBe("Ending. More.");
    expect(
      applyDocumentSourcePatches(next, invertLatexSourcePatches("Ending.", edit.patches)),
    ).toBe("Ending.");
    expect(files.get("main.tex")!.contents).toBe(root);
  });

  it("keeps root prose ownership when the paragraph retains a following included comment", () => {
    const root = document("Alpha.\\input{chapter}");
    const chapter = "% untouched included comment\n\nBeta.";
    const { files, assembled } = project(root, [["chapter.tex", chapter]]);
    const projection = projectLatexVisualDocument(assembled.source);
    const content = structuredClone(projection.content);
    if (!appendOwnedText(content, "Alpha.", " More.")) throw new Error("Missing fixture prose");
    const change = applyLatexVisualDocumentChange(assembled.source, projection, content);
    if (!change) throw new Error("Owned root append was refused");
    const plan = planVisualProjectEdit(assembled, change.edit, files, "main.tex");
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["main.tex"]);
    expect(applyDocumentSourcePatches(root, plan.edits.get("main.tex")!.patches)).toBe(
      root.replace("Alpha.", "Alpha. More."),
    );
    expect(files.get("chapter.tex")!.contents).toBe(chapter);
  });

  it("owns every EOF insertion in a multi-block edit of repeated input", () => {
    const root = document("\\input{chapter}\n\\input{chapter}");
    const { files, assembled } = project(root, [["chapter.tex", "Ending."]]);
    const projection = projectLatexVisualDocument(assembled.source);
    const content = structuredClone(projection.content);
    if (!appendOwnedText(content, "Ending.", "!"))
      throw new Error("Missing repeated fixture prose");
    const change = applyLatexVisualDocumentChange(assembled.source, projection, content);
    if (!change) throw new Error("Owned repeated append was refused");
    const plan = planVisualProjectEdit(assembled, change.edit, files, "main.tex");
    expect(plan.error).toBeNull();
    const edit = plan.edits.get("chapter.tex")!;
    expect(applyDocumentSourcePatches("Ending.", edit.patches)).toBe("Ending.!");
    files.set("chapter.tex", nativeFile("Ending.!", "owner-chapter.tex", 1));
    expect(assembleVisualProject("main.tex", files).source).toBe(
      assembled.source.replaceAll("Ending.", "Ending.!"),
    );
  });

  it("owns a raw-block suffix at included EOF rather than its old block-start hint", () => {
    const root = document("Root.\n\n\\input{chapter}");
    const original = "\\unknown{value}";
    const { files, assembled } = project(root, [["chapter.tex", original]]);
    const projection = projectLatexVisualDocument(assembled.source);
    const block = projection.blocks.find((item) => item.node.type === "latexRawBlock")!;
    const edit = latexVisualBlockSourceEdit(assembled.source, block, original + "% suffix");
    if (!edit) throw new Error("Owned raw append was refused");
    const plan = planVisualProjectEdit(assembled, edit, files, "main.tex");
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["chapter.tex"]);
    expect(applyDocumentSourcePatches(original, plan.edits.get("chapter.tex")!.patches)).toBe(
      original + "% suffix",
    );
    expect(files.get("main.tex")!.contents).toBe(root);
  });
});

describe("empty and leading physical source boundaries", () => {
  it("prepends into an input-only root without inventing an empty parent owner", () => {
    const root = "\\input{chapter}";
    const { files, assembled } = project(root, [["chapter.tex", "Ending."]]);
    const projection = projectLatexVisualDocument(assembled.source);
    const content = structuredClone(projection.content);
    const paragraph = content.content?.find((node) => node.type === "paragraph");
    if (!paragraph) throw new Error("The native prose has no authoring paragraph");
    paragraph.content![0]!.text = "New Ending.";
    const change = applyLatexVisualDocumentChange(assembled.source, projection, content);
    if (!change) throw new Error("Owned prefix edit was refused");
    const plan = planVisualProjectEdit(assembled, change.edit, files, "main.tex");
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["chapter.tex"]);
    expect(applyDocumentSourcePatches("Ending.", plan.edits.get("chapter.tex")!.patches)).toBe(
      "New Ending.",
    );
    expect(files.get("main.tex")!.contents).toBe(root);
  });

  it.each(["", "\\endinput\nIgnored native suffix."])(
    "starts an empty visible native source and preserves ignored suffix bytes: %j",
    (source) => {
      const { files, assembled } = project(source, []);
      const projection = projectLatexVisualDocument(assembled.source);
      const content = structuredClone(projection.content);
      const paragraph = content.content?.find((node) => node.type === "paragraph");
      if (!paragraph) throw new Error("The empty native source has no authoring paragraph");
      paragraph.content = [{ type: "text", text: "New native prose." }];
      const change = applyLatexVisualDocumentChange(assembled.source, projection, content);
      if (!change) throw new Error("Initial native typing was refused");
      const plan = planVisualProjectEdit(assembled, change.edit, files, "main.tex");
      expect(plan.error).toBeNull();
      expect([...plan.edits.keys()]).toEqual(["main.tex"]);
      const patches = plan.edits.get("main.tex")!.patches;
      const native = applyDocumentSourcePatches(source, patches);
      expect(native).toBe("New native prose." + source);
      expect(applyDocumentSourcePatches(native, invertLatexSourcePatches(source, patches))).toBe(
        source,
      );
    },
  );

  it("restores a deleted whole native file through its known empty boundary", () => {
    const original = "Native 😀.\r\n";
    const erase = { start: 0, end: original.length, expected: original, replacement: "" };
    const { files, assembled } = project("", []);
    const plan = planVisualProjectEdit(
      assembled,
      { source: "", patches: invertLatexSourcePatches(original, [erase]) },
      files,
      "main.tex",
    );
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["main.tex"]);
    expect(applyDocumentSourcePatches("", plan.edits.get("main.tex")!.patches)).toBe(original);
  });
});

describe("generator composition preserves surrounding physical ownership", () => {
  const loop = "\\n=0\\loop\\advance\\n by 1 Paragraph \\the\\n.\\par\\ifnum\\n<2\\repeat";
  const root = (body: string) =>
    `\\documentclass{article}\n\\newcount\\n\n\\begin{document}\n${body}\n\\end{document}`;

  it("materializes the owning loop without discarding another owned insertion at included EOF", () => {
    const parent = root("\\input{chapter}");
    const original = loop + "\n\nAfter.";
    const { files, assembled } = project(parent, [["chapter.tex", original]]);
    const projection = projectLatexVisualDocument(assembled.source);
    const content = structuredClone(projection.content);
    appendOwnedText(content, "Paragraph 1.", " Edited.");
    appendOwnedText(content, "After.", " More.");
    const change = applyLatexVisualDocumentChange(assembled.source, projection, content);
    if (!change) throw new Error("Generator and EOF edit were refused");
    const plan = planVisualProjectEdit(assembled, change.edit, files, "main.tex");
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["chapter.tex"]);
    const patches = plan.edits.get("chapter.tex")!.patches;
    const native = applyDocumentSourcePatches(original, patches);
    expect(native).toBe("Paragraph 1. Edited.\\par\nParagraph 2.\\par\n\nAfter. More.");
    expect(applyDocumentSourcePatches(native, invertLatexSourcePatches(original, patches))).toBe(
      original,
    );
    expect(files.get("main.tex")!.contents).toBe(parent);
  });

  it("does not materialize an untouched loop when typing at its preceding owner boundary", () => {
    const parent = root("Before.\\input{chapter}");
    const { files, assembled } = project(parent, [["chapter.tex", loop]]);
    const projection = projectLatexVisualDocument(assembled.source);
    const content = structuredClone(projection.content);
    for (const node of content.content![0]!.content ?? [])
      if (node.type === "text") node.text = node.text!.replace("Before.", "Before. More.");
    const change = applyLatexVisualDocumentChange(assembled.source, projection, content);
    if (!change) throw new Error("Boundary edit was refused");
    const plan = planVisualProjectEdit(assembled, change.edit, files, "main.tex");
    expect(plan.error).toBeNull();
    expect([...plan.edits.keys()]).toEqual(["main.tex"]);
    expect(applyDocumentSourcePatches(parent, plan.edits.get("main.tex")!.patches)).toBe(
      parent.replace("Before.", "Before. More."),
    );
    expect(files.get("chapter.tex")!.contents).toBe(loop);
    expect(change.materializedGenerator).toBe(false);
  });

  it("refuses generator and parent changes before either native file is mutated", () => {
    const parent = root("\\input{chapter}\n\nAfter.");
    const { files, assembled } = project(parent, [["chapter.tex", loop]]);
    const projection = projectLatexVisualDocument(assembled.source);
    const content = structuredClone(projection.content);
    appendOwnedText(content, "Paragraph 1.", " Edited.");
    appendOwnedText(content, "After.", " More.");
    const change = applyLatexVisualDocumentChange(assembled.source, projection, content);
    if (!change) throw new Error("Fixture conversion was refused before ownership planning");
    const plan = planVisualProjectEdit(assembled, change.edit, files, "main.tex");
    expect(plan.error).not.toBeNull();
    expect([...plan.edits.keys()]).toEqual([]);
    expect(files.get("main.tex")!.contents).toBe(parent);
    expect(files.get("chapter.tex")!.contents).toBe(loop);
  });
});
