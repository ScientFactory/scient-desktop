import { describe, expect, it } from "vite-plus/test";
import { editLatexTable, type LatexTableAction } from "./latexTableAuthoring";
import {
  setLatexEnvironmentOption,
  setLatexLayoutOpening,
  setLatexPanelRow,
} from "./latexObjectProperties";
import { latexLabelInventory, renameLatexLabel } from "./latexLabelAuthoring";
import {
  projectLatexVisualDocument,
  applyLatexVisualDocumentChange,
  latexVisualTableSource,
} from "./latexVisualDocument";
import { ensureLatexPackages } from "./latexPackages";
import { latexDocumentColors } from "./latexColorBoxes";

const doc = (body: string, setup = "") =>
  `\\documentclass{article}\n${setup}\n\\begin{document}\n${body}\n\\end{document}`;
const sourceOf = (value: { source: string } | { error: string }) => {
  expect(value).not.toHaveProperty("error");
  return (value as { source: string }).source;
};
const bounds = { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 1 };
const table =
  "\\begin{table}[htbp]\n\\centering\n\\begin{tabular}{|lr|}\n\\hline\nFirst & $x^2$\\\\\nSecond & End\\\\\n\\hline\n\\end{tabular}\n\\caption{Caption}\\label{tab:one}\n\\end{table}";

function projectEdit(before: string, after: string) {
  const full = doc(before);
  const projection = projectLatexVisualDocument(full);
  const replacement = projectLatexVisualDocument(after, 0, full);
  expect(replacement.rawBlocks).toBe(0);
  const node = replacement.content.content![0]!;
  node.attrs = { ...node.attrs, sourceId: projection.content.content![0]!.attrs?.sourceId };
  const result = applyLatexVisualDocumentChange(full, projection, { type: "doc", content: [node] });
  expect(result).not.toBeNull();
  expect(result!.source).toContain(after);
  return result!;
}

describe("source-owned table operations", () => {
  it.each<LatexTableAction>([
    { kind: "background", color: "blue!10", scope: "row" },
    { kind: "foreground", color: "red", scope: "column" },
    { kind: "column", alignment: "right", width: "30mm", wrapping: "fixed" },
    { kind: "rule", edge: "above", enabled: true },
    { kind: "merge" },
    { kind: "caption-position", position: "above" },
    { kind: "placement", value: "H" },
    { kind: "multipage" },
  ])("preserves editable content through $kind", (action) => {
    const after = sourceOf(editLatexTable(table, bounds, action));
    const result = projectEdit(table, after);
    expect(result.source).toContain("$x^2$");
    expect(result.source).toContain("\\label{tab:one}");
  });
  it("splits a merged cell and retains all text", () => {
    const merged = sourceOf(editLatexTable(table, bounds, { kind: "merge" }));
    const split = sourceOf(editLatexTable(merged, bounds, { kind: "split" }));
    projectEdit(merged, split);
    expect(split).toContain("First $x^2$");
    expect(split).not.toContain("multicolumn");
  });
  it("colors span contents without stripping their wrappers", () => {
    const merged = sourceOf(editLatexTable(table, bounds, { kind: "merge" }));
    const colored = sourceOf(
      editLatexTable(merged, bounds, { kind: "background", scope: "cell", color: "blue!10" }),
    );
    projectEdit(merged, colored);
    expect(colored).toContain("\\multicolumn{2}{|c|}{\\cellcolor{blue!10}First $x^2$}");
  });
  it("keeps colors while editing a cell and supports empty inserted grids", () => {
    const colored = sourceOf(
      editLatexTable(latexVisualTableSource(2, 2, "plain"), bounds, {
        kind: "background",
        scope: "table",
        color: "yellow!20",
      }),
    );
    const source = doc(colored);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    const next = structuredClone(projection.content);
    next.content![0]!.attrs!.rows[1][0] = "Typed";
    const changed = applyLatexVisualDocumentChange(source, projection, next);
    expect(changed?.source).toContain("\\cellcolor{yellow!20}Typed");
  });
  it("merges and splits a rectangle across rows", () => {
    const area = { ...bounds, lastRow: 1 };
    const merged = sourceOf(editLatexTable(table, area, { kind: "merge" }));
    projectEdit(table, merged);
    expect(merged).toContain("\\multirow{2}{*}{First $x^2$ Second End}");
    projectEdit(merged, sourceOf(editLatexTable(merged, bounds, { kind: "split" })));
  });
  it("retains background when applying foreground color", () => {
    const colored = sourceOf(
      editLatexTable(table, bounds, { kind: "background", scope: "table", color: "yellow!20" }),
    );
    const text = sourceOf(
      editLatexTable(colored, bounds, { kind: "foreground", scope: "cell", color: "red" }),
    );
    projectEdit(colored, text);
    expect(text).toContain("\\cellcolor{yellow!20}\\textcolor{red}{First}");
  });
  it.each(["row", "column-structure"] as const)(
    "edits a colored %s without losing the color",
    (kind) => {
      const colored = sourceOf(
        editLatexTable(table, bounds, { kind: "background", scope: "table", color: "yellow!20" }),
      );
      for (const operation of ["insert-before", "insert-after", "delete", "next"] as const) {
        const next = sourceOf(editLatexTable(colored, bounds, { kind, operation }));
        projectEdit(colored, next);
        expect(next).toContain("\\cellcolor{yellow!20}");
      }
    },
  );
  it("adds repeated headers and a continuation footer to a longtable", () => {
    const long = sourceOf(editLatexTable(table, bounds, { kind: "multipage" }));
    const repeated = sourceOf(editLatexTable(long, bounds, { kind: "repeat-header", rows: 1 }));
    projectEdit(long, repeated);
    const foot = sourceOf(
      editLatexTable(repeated, bounds, { kind: "continuation", text: "Continued on next page" }),
    );
    projectEdit(repeated, foot);
    const colored = sourceOf(
      editLatexTable(foot, bounds, { kind: "background", scope: "cell", color: "blue!10" }),
    );
    projectEdit(foot, colored);
    expect(colored).toContain("Continued on next page");
  });
  it("applies alternating backgrounds without changing header text", () => {
    const striped = sourceOf(
      editLatexTable(table, bounds, {
        kind: "stripes",
        first: "blue!5",
        second: "white",
        startRow: 1,
      }),
    );
    projectEdit(table, striped);
    expect(striped).toContain("First & $x^2$");
    expect(striped).toContain("\\cellcolor{blue!5}Second");
  });
  it("colors table rules and restores their inherited color", () => {
    const colored = sourceOf(editLatexTable(table, bounds, { kind: "rule-color", color: "blue" }));
    projectEdit(table, colored);
    const projected = projectLatexVisualDocument(doc(colored));
    expect(projected.content.content![0]!.attrs!.sourceMeta.tableLayout[0][0].ruleColor).toContain(
      "blue",
    );
    projectEdit(
      colored,
      sourceOf(editLatexTable(colored, bounds, { kind: "rule-color", color: "" })),
    );
  });
  it("colors rules in every repeated longtable band", () => {
    const long = sourceOf(editLatexTable(table, bounds, { kind: "multipage" }));
    const repeated = sourceOf(editLatexTable(long, bounds, { kind: "repeat-header", rows: 1 }));
    projectEdit(
      repeated,
      sourceOf(editLatexTable(repeated, bounds, { kind: "rule-color", color: "blue" })),
    );
  });
  it("terminates a final row before adding its bottom rule", () => {
    const before = "\\begin{tabular}{lr}A & B\\end{tabular}";
    projectEdit(
      before,
      sourceOf(editLatexTable(before, bounds, { kind: "rule", edge: "below", enabled: true })),
    );
  });
  it("refuses a selection that starts inside an existing span", () => {
    const merged = sourceOf(editLatexTable(table, bounds, { kind: "merge" }));
    expect(
      editLatexTable(merged, { ...bounds, firstColumn: 1, lastRow: 1 }, { kind: "merge" }),
    ).toHaveProperty("error");
  });
});

describe("container property operations", () => {
  it("retains literal brackets in citation notes", () => {
    projectEdit("See \\cite[Section 2]{sample}.", "See \\cite[{Section [3]}]{sample}.");
  });
  it.each([
    ["\\begin{multicols}{2}\nText\n\\end{multicols}", { columns: 3 }],
    [
      "\\begin{minipage}[t]{0.46\\linewidth}\nText\n\\end{minipage}",
      { width: "0.3\\linewidth", alignment: "c", height: "30mm" },
    ],
  ] as const)("changes a layout wrapper losslessly", (before, options) => {
    projectEdit(before, sourceOf(setLatexLayoutOpening(before, options)));
  });
  it("adds a third panel and preserves its existing nested content", () => {
    const before =
      "\\begin{minipage}[t]{0.46\\linewidth}\nLeft $x^2$.\n\\end{minipage}\\hfill\n\\begin{minipage}[t]{0.46\\linewidth}\nRight\n\\end{minipage}";
    const after = sourceOf(setLatexPanelRow(before, [2, 1, 1], "auto"));
    projectEdit(before, after);
    expect(after).toContain("Left $x^2$.");
    expect(after.match(/\\begin\{minipage\}/gu)).toHaveLength(3);
  });
  it.each(["colback", "boxsep", "breakable", "title"])("changes a box %s", (key) => {
    const before =
      "\\begin{tcolorbox}[colback=blue!5,colframe=black]\nText with $x^2$.\n\\end{tcolorbox}";
    projectEdit(
      before,
      sourceOf(
        setLatexEnvironmentOption(
          before,
          "tcolorbox",
          key,
          key === "colback"
            ? "green!10"
            : key === "boxsep"
              ? "4mm"
              : key === "title"
                ? "{Heading}"
                : "",
        ),
      ),
    );
  });
  it("loads the breakable library only when required", () => {
    const source = doc("", "\\usepackage{tcolorbox}");
    const next = ensureLatexPackages(source, ["tcolorbox-breakable"], "\n");
    expect(next).toContain("\\tcbuselibrary{breakable}");
    expect(ensureLatexPackages(next, ["tcolorbox-breakable"], "\n")).toBe(next);
  });
  it("edits listing options without interpreting literal TeX", () => {
    const before =
      "\\begin{lstlisting}[language=Python]\n\\section{literal}\nprint(1)\n\\end{lstlisting}";
    projectEdit(
      before,
      sourceOf(setLatexEnvironmentOption(before, "lstlisting", "numbers", "left")),
    );
  });
});

describe("document labels and colors", () => {
  it("renames labels only in known arguments", () => {
    const source = doc(
      "\\section{Target}\\label{sec:a}\n\\ref{sec:a}, \\hyperref[sec:a]{Target}.\n\\verb|\\ref{sec:a}|\n% \\ref{sec:a}",
    );
    const next = sourceOf(renameLatexLabel(source, "sec:a", "sec:b"));
    expect(next).toContain("\\hyperref[sec:b]");
    expect(next).toContain("\\verb|\\ref{sec:a}|");
    expect(latexLabelInventory(next).targets[0]?.uses).toBe(2);
  });
  it("reads colors after boolean declarations without executing conditionals", () => {
    expect(
      latexDocumentColors(doc("", "\\newif\\ifdraft\n\\definecolor{accent}{HTML}{245A81}")),
    ).toHaveProperty("accent", "#245A81");
  });
});
