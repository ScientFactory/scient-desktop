import { describe, expect, it } from "vite-plus/test";
import type { JSONContent } from "@tiptap/core";
import fixture from "./fixtures/layouts.tex?raw";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";
import { latexMinipageSeparator, latexPageLayoutOpening } from "./latexPageLayouts";
import { latexVisualLayoutProfile } from "./latexVisualLayout";

describe("mixed column and panel layouts", () => {
  it("projects the full mixed-layout fixture without source-only blocks", () => {
    const projection = projectLatexVisualDocument(fixture);
    expect(
      projection.blocks
        .filter((block) => block.node.type === "latexRawBlock")
        .map((block) => block.node.attrs?.raw),
    ).toEqual([]);
    expect(projection.rawBlocks).toBe(0);
  });

  it.each([
    "First card",
    "Inner right text",
    "Bottom-aligned content",
    "The left column combines prose",
  ])("edits %s while preserving surrounding source", (text) => {
    const projection = projectLatexVisualDocument(fixture);
    const next = structuredClone(projection.content);
    let found = false;
    const visit = (node: JSONContent) => {
      if (node.type === "text" && node.text?.includes(text)) {
        node.text = node.text.replace(text, `${text} edited`);
        found = true;
      }
      node.content?.forEach(visit);
    };
    visit(next);
    expect(found).toBe(true);
    const changed = applyLatexVisualDocumentChange(fixture, projection, next);
    expect(changed?.source).toBe(fixture.replace(text, `${text} edited`));
    expect(changed?.projection.rawBlocks).toBe(0);
  });

  it("retains minipage height and independent inner alignment", () => {
    const opening = latexPageLayoutOpening(
      String.raw`\begin{minipage}[t][36mm][b]{0.46\linewidth}Body\end{minipage}`,
    );
    expect(opening?.layout).toMatchObject({
      kind: "minipage",
      alignment: "t",
      innerAlignment: "b",
      width: "46%",
    });
    expect(opening?.from).toBe(String.raw`\begin{minipage}[t][36mm][b]{0.46\linewidth}`.length);
  });

  it("uses document column spacing and rules", () => {
    expect(latexVisualLayoutProfile(fixture)).toMatchObject({ columnGapPt: 18, columnRulePt: 0.4 });
  });

  it("keeps paragraph terminators in source without inserting blank panel lines", () => {
    const source = String.raw`\begin{minipage}{0.5\linewidth}\textbf{Title}\par Body.\end{minipage}`;
    const projection = projectLatexVisualDocument(source);
    expect(projection.content.content?.[0]?.content).toHaveLength(2);
    const next = structuredClone(projection.content);
    next.content![0]!.content![1]!.content![0]!.text = "Edited body.";
    expect(applyLatexVisualDocumentChange(source, projection, next)?.source).toBe(
      source.replace("Body.", "Edited body."),
    );
    // An explicit editable empty paragraph remains available between blank lines.
    expect(projectLatexVisualDocument("First.\n\n\\par\n\nLast.").content.content).toHaveLength(3);
  });

  it("distinguishes spaces, comment joins, explicit gaps, and paragraph boundaries", () => {
    expect(latexMinipageSeparator(" \\begin{minipage}")?.gap).toBe("0.333333em");
    expect(latexMinipageSeparator("% join\n\\begin{minipage}")?.gap).toBe("0px");
    expect(latexMinipageSeparator("\\hspace{0.05\\linewidth}% join\n\\begin{minipage}")?.gap).toBe(
      "5%",
    );
    expect(latexMinipageSeparator("\n\n\\begin{minipage}")).toBeNull();
    expect(latexMinipageSeparator("\\hspace{\\unknown}\\begin{minipage}")).toBeNull();
  });

  it.each(["Inner right text", "This box stays", "The left column combines"])(
    "inserts math in %s without replacing the layout",
    (text) => {
      const projection = projectLatexVisualDocument(fixture);
      const next = structuredClone(projection.content);
      let found = false;
      const visit = (node: JSONContent) => {
        if (
          node.type === "paragraph" &&
          node.content?.some((child) => child.text?.includes(text))
        ) {
          node.content.push({ type: "latexInlineMath", attrs: { tex: "q^2", wrapper: "paren" } });
          found = true;
        } else node.content?.forEach(visit);
      };
      visit(next);
      expect(found).toBe(true);
      const changed = applyLatexVisualDocumentChange(fixture, projection, next);
      expect(changed?.source).toContain(String.raw`\(q^2\)`);
      expect(changed?.projection.rawBlocks).toBe(0);
      expect(changed?.source.match(/\\begin\{minipage\}/gu)).toHaveLength(11);
      expect(changed?.source.match(/\\begin\{multicols\}/gu)).toHaveLength(3);
    },
  );
});
