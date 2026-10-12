// @vitest-environment happy-dom
import { expect, it } from "vite-plus/test";
import { latexVisualObjectSourceRange } from "./latexVisualObjectSourceRange";
import { projectLatexVisualDocument } from "./latexVisualDocument";
import type { LatexSelectionSnapshot } from "./latexSelectionSession";

it("identifies the second repeated Hebrew table cell by its authored slot", () => {
  const source = "\\begin{tabular}{ll}ראשונה & ראשונה\\\\\\end{tabular}";
  const block = projectLatexVisualDocument(source).blocks[0]!;
  const cell = document.createElement("div");
  cell.dataset.tableCell = "0-1";
  const snapshot: LatexSelectionSnapshot = {
    content: { from: 1, to: 7, text: "ראשונה", kind: "prose" },
    path: [],
    scopes: () => [],
    selection: () => [],
    restore: () => true,
  };
  const range = latexVisualObjectSourceRange(
    block.node,
    source,
    0,
    cell,
    { element: cell, snapshot },
    source,
  );
  expect(range).toEqual({
    from: source.lastIndexOf("ראשונה"),
    to: source.lastIndexOf("ראשונה") + 6,
  });
});

it("maps a caption's selected word past its optional short caption", () => {
  const source = "\\begin{figure}\\caption[קצר]{כיתוב בעברית וחצים.}\\end{figure}";
  const field = document.createElement("textarea");
  const caption = document.createElement("figcaption");
  caption.append(field);
  field.value = "כיתוב בעברית וחצים.";
  field.setSelectionRange(13, 18);
  const range = latexVisualObjectSourceRange({}, source, 20, field, null, source);
  expect(range).toEqual({
    from: 20 + source.indexOf("וחצים"),
    to: 20 + source.indexOf("וחצים") + 5,
  });
});

it("maps a title click to the current declaration rather than maketitle", () => {
  const source = "\\title{ישן}\\title{כותרת בעברית}\\begin{document}\\maketitle\\end{document}";
  const field = document.createElement("textarea");
  field.setAttribute("aria-label", "Document title");
  field.value = "כותרת בעברית";
  field.setSelectionRange(6, 12);
  const range = latexVisualObjectSourceRange(
    { attrs: { kind: "title" } },
    "\\maketitle",
    source.indexOf("\\maketitle"),
    field,
    null,
    source,
  );
  expect(range).toEqual({ from: source.indexOf("בעברית"), to: source.indexOf("בעברית") + 6 });
});

it("rejects a caption whose displayed draft differs from the source", () => {
  const source = "\\caption{כיתוב בעברית}";
  const field = document.createElement("textarea");
  document.createElement("figcaption").append(field);
  field.value = "שינוי בעברית";
  field.setSelectionRange(0, 5);
  expect(latexVisualObjectSourceRange({}, source, 0, field, null, source)).toBeNull();
});
