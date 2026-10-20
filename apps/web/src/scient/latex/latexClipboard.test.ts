import { Fragment, Schema, Slice } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";
import { latexSelectionClipboard } from "./latexClipboard";
import { projectLatexVisualDocument } from "./latexVisualDocument";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", attrs: { sourceId: { default: null } } },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true },
    latexInlineCommand: {
      group: "inline",
      inline: true,
      atom: true,
      marks: "",
      attrs: {
        name: { default: "command" },
        argument: { default: "" },
        linkText: { default: null },
        raw: { default: "" },
      },
    },
    latexInlineMath: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { tex: { default: "" }, wrapper: { default: "dollar" } },
    },
    latexDisplayMath: {
      group: "block",
      atom: true,
      attrs: {
        tex: { default: "" },
        wrapper: { default: "bracket" },
        environment: { default: null },
      },
    },
    blockquote: { group: "block", content: "block+" },
    bulletList: { group: "block", content: "listItem+", attrs: { sourceMeta: { default: null } } },
    listItem: { content: "paragraph block*", attrs: { sourceMeta: { default: null } } },
    latexRawBlock: { group: "block", atom: true, attrs: { raw: { default: "" } } },
  },
  marks: { bold: {}, italic: {}, latexEnglish: {}, latexHebrew: {} },
});

function document(source: string) {
  const projected = projectLatexVisualDocument(source);
  expect(projected.rawBlocks).toBe(0);
  return schema.nodeFromJSON(projected.content);
}

function select(source: string) {
  const doc = document(source);
  return TextSelection.create(doc, 1, doc.content.size - 1).content();
}

describe("LaTeX selection clipboard", () => {
  it.each([
    String.raw`\ref{sec:one}`,
    String.raw`\eqref{eq:one}`,
    String.raw`\pageref{sec:one}`,
    String.raw`\autoref{sec:one}`,
    String.raw`\nameref{sec:one}`,
    String.raw`\subref{fig:one}`,
    String.raw`\cite{alpha}`,
    String.raw`\citet{alpha}`,
    String.raw`\citeauthor{alpha}`,
    String.raw`\citep[see][p.~7]{alpha,beta}`,
    String.raw`\parencite[page 7]{alpha}`,
    String.raw`\textcite{alpha}`,
    String.raw`\citeyear{alpha}`,
    String.raw`\href{https://example.test}{Read this}`,
    String.raw`\url{https://example.test}`,
    String.raw`\hyperref[sec:one]{Read this}`,
    String.raw`\hyperlink{target}{Read this}`,
    String.raw`\hypertarget{target}{Read this}`,
    String.raw`\footnote{Footnote text.}`,
    String.raw`\index{entry}`,
    String.raw`\verb|a_b%|`,
    String.raw`\protect \ref{sec:one}`,
  ])("preserves a selected command without requiring a formula: %s", (source) => {
    const copied = latexSelectionClipboard(select(source));
    expect(copied).toBe(source);
    expect(projectLatexVisualDocument(copied).rawBlocks).toBe(0);
  });

  it("preserves a command NodeSelection", () => {
    const doc = document(String.raw`\ref{sec:one}`);
    const slice = NodeSelection.create(doc, 1).content();
    expect(slice.openStart).toBe(0);
    expect(latexSelectionClipboard(slice)).toBe(String.raw`\ref{sec:one}`);
  });

  it.each([
    String.raw`See \ref{sec:one} now.`,
    String.raw`A \footnote{Footnote text.} B`,
    "לפני \\ref{sec:one} אחרי.",
    "First \\ref{sec:one}.\n\nSecond \\cite{alpha}.",
    String.raw`50\% \ref{sec:one} \& \#1.`,
    String.raw`\textbf{Before} \ref{sec:one} \emph{after}.`,
  ])("preserves commands and adjacent selected prose: %s", (source) => {
    expect(latexSelectionClipboard(select(source))).toBe(source);
  });

  it("serializes only the selected open paragraph range", () => {
    const doc = document(String.raw`Before \ref{sec:one} after.`);
    const slice = TextSelection.create(doc, 8, 9).content();
    expect(slice.openStart).toBe(1);
    expect(latexSelectionClipboard(slice)).toBe(String.raw`\ref{sec:one}`);
  });

  it("recognizes commands in a nested open selection without unselected siblings", () => {
    const doc = schema.node("doc", null, [
      schema.node("blockquote", null, [
        document(String.raw`Before \ref{sec:one} after.`).firstChild!,
      ]),
    ]);
    const slice = TextSelection.create(doc, 9, 10).content();
    expect(slice.openStart).toBe(2);
    const copied = latexSelectionClipboard(slice);
    expect(copied).toContain(String.raw`\ref{sec:one}`);
    expect(copied).not.toContain("Before");
    expect(copied).not.toContain("after");
  });

  it("copies only the selected command inside an imported list item", () => {
    const doc = document(
      String.raw`\begin{itemize}\item Before \ref{sec:one} after.\item Unselected sibling.\end{itemize}`,
    );
    let position: number | null = null;
    doc.descendants((node, at) => {
      if (node.type.name === "latexInlineCommand") position = at;
    });
    const slice = TextSelection.create(doc, position!, position! + 1).content();
    expect(slice.openStart).toBe(3);
    const copied = latexSelectionClipboard(slice);
    expect(copied).toContain(String.raw`\ref{sec:one}`);
    expect(copied).not.toContain("Before");
    expect(copied).not.toContain("after");
    expect(copied).not.toContain("Unselected sibling");
  });

  it("copies two thousand command atoms without dropping or reordering keys", () => {
    const source = Array.from(
      { length: 2000 },
      (_, index) => `Item ${index}: \\ref{key:${index}}.`,
    ).join(" ");
    const copied = latexSelectionClipboard(select(source));
    expect(copied).toBe(source);
    expect([...copied.matchAll(/\\ref\{key:(\d+)\}/gu)].map((match) => Number(match[1]))).toEqual(
      Array.from({ length: 2000 }, (_, index) => index),
    );
  });

  it.each(["Unknown", "input", "usepackage", "openout"])(
    "retains the fallback for an unsupported command %s",
    (name) => {
      const atom = schema.nodes.latexInlineCommand!.create({
        name,
        argument: "value",
        raw: `\\${name}{value}`,
      });
      expect(latexSelectionClipboard(new Slice(Fragment.from(atom), 0, 0))).toBe("");
    },
  );

  it.each(["Plain prose.", "First.\n\nSecond.", String.raw`See $x$ and \ref{sec:one}.`])(
    "retains existing plain and math clipboard behavior: %s",
    (source) => {
      expect(latexSelectionClipboard(select(source))).toBe(source);
    },
  );

  it("retains the plain fallback for an opaque-only selection", () => {
    const raw = String.raw`\unknown{opaque}`;
    const slice = new Slice(Fragment.from(schema.nodes.latexRawBlock!.create({ raw })), 0, 0);
    expect(latexSelectionClipboard(slice)).toBe("");
  });

  it("handles an empty selection without manufacturing a paragraph", () => {
    expect(latexSelectionClipboard(Slice.empty)).toBe("");
  });
});
