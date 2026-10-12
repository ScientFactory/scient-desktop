import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";
import template from "./fixtures/mock-medical-article.tex?raw";
import {
  projectLatexVisualDocument,
  applyLatexVisualDocumentChange,
  serializeLatexVisualBlock,
} from "./latexVisualDocument";
import { latexVisualCompatibility } from "./latexVisualCompatibility";
import { latexContentHeadingMacros } from "./latexContentLayouts";
import { latexListOptionsSource } from "./latexListOptions";

const document = (body: string, preamble = "") =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}`;
function descendants(node: JSONContent): JSONContent[] {
  return [node, ...(node.content ?? []).flatMap(descendants)];
}
function change(source: string, edit: (nodes: JSONContent[]) => void) {
  const projection = projectLatexVisualDocument(source);
  const content = structuredClone(projection.content);
  edit(descendants(content));
  return applyLatexVisualDocumentChange(source, projection, content);
}

describe("complete source-owned content layouts", () => {
  it("retains the full medical article including table notes, bars, and all custom headings", () => {
    const projection = projectLatexVisualDocument(template);
    const nodes = descendants(projection.content);
    expect(projection.rawBlocks).toBe(0);
    expect(nodes.filter((node) => node.attrs?.layout?.kind === "macroHeading")).toHaveLength(17);
    expect(nodes.filter((node) => node.attrs?.kind === "rule")).toHaveLength(2);
    expect(
      nodes.some((node) => node.attrs?.kind === "spacing" && node.attrs.environment === "vfill"),
    ).toBe(true);
    expect(nodes.some((node) => node.text?.includes("Adjusted mean difference"))).toBe(true);
    expect(nodes.some((node) => node.text === "]")).toBe(false);
    expect(applyLatexVisualDocumentChange(template, projection, projection.content)?.source).toBe(
      template,
    );
    expect(
      latexVisualCompatibility(template, projection).some((issue) =>
        issue.message.includes("Columns"),
      ),
    ).toBe(true);
  });
  it("patches a heading argument while retaining its macro definition and unrelated source", () => {
    const result = change(template, (nodes) => {
      nodes.find((node) => node.text === "Study design and oversight")!.text =
        "Updated study design";
    });
    expect(result?.source).toBe(
      template.replace(
        "\\subsectiontitle{Study design and oversight}",
        "\\subsectiontitle{Updated study design}",
      ),
    );
  });
  it("edits the table note inside its original paragraph box and float", () => {
    const result = change(template, (nodes) => {
      const note = nodes.find((node) => node.text?.includes("Adjusted mean difference"))!;
      note.text = note.text!.replace("Adjusted mean difference", "Updated mean difference");
    });
    expect(result?.source).toBe(
      template.replace("Adjusted mean difference", "Updated mean difference"),
    );
  });
  it("keeps opaque nested source visible and prevents implicit deletion while allowing surrounding edits", () => {
    const source = document(String.raw`{\small
Before.

\unsupported{keep}

After.}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(1);
    expect(
      latexVisualCompatibility(source, projection).some((issue) => issue.kind === "source"),
    ).toBe(true);
    expect(
      change(source, (nodes) => {
        nodes.find((node) => node.text === "After.")!.text = "Changed.";
      })?.source,
    ).toBe(source.replace("After.", "Changed."));
    const content = structuredClone(projection.content);
    content.content = [];
    expect(applyLatexVisualDocumentChange(source, projection, content)).toBeNull();
  });
  it("isolates recognized heading calls from subsequent prose and rejects unsafe definitions", () => {
    expect(latexContentHeadingMacros(String.raw`\newcommand{\bad}[1]{#1\input{secret}}`).size).toBe(
      0,
    );
    expect(
      latexContentHeadingMacros(
        String.raw`\ifdefined\flag\newcommand{\conditional}[1]{{\bfseries #1}\par}\fi`,
      ).size,
    ).toBe(0);
    const source = document(
      String.raw`\custom{Heading}
Following paragraph.`,
      String.raw`\newcommand{\custom}[1]{{\bfseries #1}\par}`,
    );
    const nodes = projectLatexVisualDocument(source).content.content!;
    expect(nodes[0]?.attrs?.layout?.kind).toBe("macroHeading");
    expect(nodes[1]?.type).toBe("paragraph");
  });
  it("preserves local list layout when changing numbering", () => {
    expect(latexListOptionsSource("leftmargin=1.45em,itemsep=2pt", 3, false)).toBe(
      "[start=3,leftmargin=1.45em,itemsep=2pt]",
    );
  });
  it("keeps a declared unsupported heading separate from its following paragraph", () => {
    const source = document(
      String.raw`\unsupportedHeading{Heading}
Following paragraph.`,
      String.raw`\newcommand{\unsupportedHeading}[1]{\framebox{#1}}`,
    );
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]?.source).toBe(String.raw`\unsupportedHeading{Heading}`);
    expect(projection.blocks[0]?.node.type).toBe("latexRawBlock");
    expect(projection.blocks[1]?.node.type).toBe("paragraph");
    expect(
      change(source, (nodes) => {
        nodes.find((node) => node.text === "Following paragraph.")!.text = "Updated paragraph.";
      })?.source,
    ).toBe(source.replace("Following paragraph.", "Updated paragraph."));
  });
  it("copies an imported custom heading as its authored call without requiring its declaration in the fragment", () => {
    const projection = projectLatexVisualDocument(template);
    const node = descendants(projection.content).find(
      (node) => node.attrs?.layout?.kind === "macroHeading",
    )!;
    expect(serializeLatexVisualBlock(node)).toBe(String.raw`\articleSection{Abstract}`);
  });
  it("protects content before and after a grid when its float metadata is unsupported", () => {
    const source = document(String.raw`\begin{table}[h]
\begin{tabular}{l}Cell\\\end{tabular}
\unknownnote{Important text}
\end{table}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(1);
    expect(
      descendants(projection.content).some((node) => node.attrs?.raw?.includes("Important text")),
    ).toBe(true);
  });
  it("retains text before the first description item instead of discarding it", () => {
    const source = document(String.raw`\begin{description}
Important introduction.
\item[Name] Value.
\end{description}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(1);
    expect(projection.blocks[0]?.node.attrs?.raw).toContain("Important introduction.");
  });
  it("retains declaration scopes and restores them when reopened", () => {
    const source = document(String.raw`{\fontsize{19}{22}\selectfont\bfseries Title}

Body.`);
    const result = change(source, (nodes) => {
      nodes.find((node) => node.text === "Title")!.text = "New title";
    });
    expect(result?.source).toBe(source.replace("Title", "New title"));
    expect(
      descendants(projectLatexVisualDocument(result!.source).content).some(
        (node) => node.attrs?.layout?.points === 19,
      ),
    ).toBe(true);
  });
});
