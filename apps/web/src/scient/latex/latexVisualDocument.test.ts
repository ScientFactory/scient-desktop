import type { JSONContent } from "@tiptap/core";
import hebrewTemplate from "./fixtures/hebrew-math-and-tables.tex?raw";
import { describe, expect, it } from "vite-plus/test";
import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import { invertLatexSourcePatches } from "./latexSourceEditPlan";
import { latexDocumentBoundary } from "./latexSourceSyntax";
import {
  adoptLatexVisualContent,
  applyLatexVisualDocumentChange,
  latexInlineCommandSource,
  latexVisualFigureSource,
  latexVisualLayoutProfile,
  latexVisualScientificSource,
  latexVisualTableSource,
  latexVisualMathSource,
  parseLatexVisualMathSource,
  parseStructuredMathEnvironment,
  serializeLatexVisualBlock,
  projectLatexVisualDocument,
  updateLatexVisualLayoutSource,
  prepareLatexDocumentTitle,
  latexVisualBlockSourceEdit,
} from "./latexVisualDocument";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  content: value ? [text(value)] : [],
});
const document = (body: string) =>
  `\\documentclass{article}\n% keep the preamble\n\\begin{document}\n${body}\n\\end{document}\n% keep the trailer\n`;
const edit = (source: string, content: JSONContent[]) =>
  applyLatexVisualDocumentChange(source, projectLatexVisualDocument(source), {
    type: "doc",
    content,
  });

describe("source-derived writing projection", () => {
  it("renders every block of the imported Hebrew template and preserves its complete source", () => {
    const projection = projectLatexVisualDocument(hebrewTemplate);
    expect(projection.blocks).toHaveLength(32);
    expect(projection.rawBlocks).toBe(0);
    const wrappingTable = projection.blocks.find(
      (block) => block.node.attrs?.tableKind === "stretch",
    )!;
    const tableLayout = wrappingTable.node.attrs?.sourceMeta.tableLayout;
    expect(tableLayout[0][1]).toMatchObject({
      topRule: "toprule",
      bottomRule: "midrule",
      justified: true,
    });
    expect(tableLayout[3][0]).toMatchObject({
      colSpan: 2,
      alignment: "right",
      bottomRule: "bottomrule",
      justified: false,
    });
    const longTable = projection.blocks.find((block) => block.node.attrs?.tableKind === "long")!;
    expect(longTable.node.attrs?.rows).toHaveLength(51);
    expect(longTable.node.attrs?.rows.at(-1)[0]).toBe("50");
    expect(
      applyLatexVisualDocumentChange(hebrewTemplate, projection, projection.content)?.source,
    ).toBe(hebrewTemplate);
    const code = projection.blocks.at(-1)!;
    expect(serializeLatexVisualBlock(code.node)).toBe(code.source);
  });
  it("edits and reopens rich framed figures without flattening their math or wrappers", () => {
    const source = document(String.raw`\begin{figure}[htbp]
\centering
\fbox{\parbox{0.78\linewidth}{\centering
\textbf{שלבי בדיקה}\par\medskip
קובץ מקור \(\longleftarrow\) עיבוד \(\longleftarrow\) תצוגה
\par\medskip
תרשים פשוט ללא קובץ תמונה חיצוני.}}
\caption{מסגרת, כיתוב בעברית וחצים.}\label{fig:hebrew}
\end{figure}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    expect(projection.content.content![0]!.attrs?.layout.kind).toBe("framedFigure");
    expect(applyLatexVisualDocumentChange(source, projection, projection.content)?.source).toBe(
      source,
    );
    const content = structuredClone(projection.content);
    content.content![0]!.content![0]!.content![0]!.content![0]!.text = "שלבים חדשים";
    content.content![0]!.attrs!.caption = "כיתוב חדש";
    const changed = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(changed.source).toBe(
      source
        .replace("שלבי בדיקה", "שלבים חדשים")
        .replace("מסגרת, כיתוב בעברית וחצים.", "כיתוב חדש"),
    );
    const reopened = projectLatexVisualDocument(changed.source);
    expect(reopened.rawBlocks).toBe(0);
    expect(
      applyLatexVisualDocumentChange(changed.source, reopened, projection.content)?.source,
    ).toBe(source);
  });
  it("composes English and alignment wrappers around editable literal code", () => {
    const source = document(String.raw`\begin{english}
\begin{flushleft}
\begin{verbatim}
def square(x):
    return x * x
\end{verbatim}
\end{flushleft}
\end{english}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    const content = structuredClone(projection.content);
    const code = content.content![0]!.content![0]!.content![0]!;
    expect(code.attrs?.kind).toBe("simple");
    code.attrs!.body = String(code.attrs!.body).replace("x * x", "x ** 2");
    const changed = applyLatexVisualDocumentChange(source, projection, content);
    expect(changed?.source).toBe(source.replace("x * x", "x ** 2"));
    expect(projectLatexVisualDocument(changed!.source).rawBlocks).toBe(0);
  });
  it("explains why unsupported structures stay in source", () => {
    const projection = projectLatexVisualDocument(
      document(String.raw`\begin{unknown}body\end{unknown}`),
    );
    expect(projection.content.content![0]!.attrs?.reason).toContain("unknown structure");
    expect(
      applyLatexVisualDocumentChange(
        document(String.raw`\begin{unknown}body\end{unknown}`),
        projection,
        projection.content,
      )?.source,
    ).toBe(document(String.raw`\begin{unknown}body\end{unknown}`));
  });
  it.each([String.raw`\ref{sec:one}`, String.raw`\protect \ref{sec:one}`, "$x+y$"])(
    "preserves authored wrappers during compound edits around an unchanged atom: %s",
    (atom) => {
      const source = document(String.raw`Before \protect\textit{italic} and ` + atom + " after.");
      const projection = projectLatexVisualDocument(source);
      expect(projection.rawBlocks).toBe(0);
      const content = structuredClone(projection.content);
      const nodes = content.content![0]!.content!;
      const italic = nodes.find((node) => node.marks?.some((mark) => mark.type === "italic"))!;
      italic.text = "changed";
      nodes.at(-1)!.text = " ending.";
      const changed = applyLatexVisualDocumentChange(source, projection, content);
      expect(changed?.source).toBe(
        source.replace("{italic}", "{changed}").replace(" after.", " ending."),
      );
      const reopened = projectLatexVisualDocument(changed!.source);
      expect(reopened.rawBlocks).toBe(0);
      const restored = applyLatexVisualDocumentChange(
        changed!.source,
        reopened,
        projection.content,
      );
      expect(restored?.source).toBe(source);
    },
  );

  it("retains protection when a reference argument changes", () => {
    const source = document(String.raw`See \protect \ref{old}.`);
    const projection = projectLatexVisualDocument(source);
    const content = structuredClone(projection.content);
    content.content![0]!.content!.find(
      (node) => node.type === "latexInlineCommand",
    )!.attrs!.argument = "new";
    expect(applyLatexVisualDocumentChange(source, projection, content)?.source).toBe(
      source.replace("{old}", "{new}"),
    );
    expect(latexInlineCommandSource("ref", "new", "", String.raw`\protect \ref{old}`)).toBe(
      String.raw`\protect \ref{new}`,
    );
  });

  it.each([
    String.raw`\protect\unknown{content}`,
    String.raw`\protect`,
    String.raw`\protection{content}`,
  ])("keeps unsupported protected commands as exact source: %s", (body) => {
    const projection = projectLatexVisualDocument(document(body));
    expect(projection.rawBlocks).toBe(1);
    expect(projection.blocks[0]!.source).toBe(body);
  });

  it.each([1, 12])(
    "undoes %s prose additions after marked text without changing command spelling or trailing spaces",
    (count) => {
      const source = document(
        "Before $x+y$.\n\n" +
          String.raw`Plain \textbf{bold} and \textit{italic} ending.` +
          "\n\nAfter $z^2$.",
      );
      const projection = projectLatexVisualDocument(source);
      const content = structuredClone(projection.content);
      const last = content.content![1]!.content!.at(-1)!;
      const addition = " additional wrapping words ".repeat(count);
      last.text += addition;
      const inserted = applyLatexVisualDocumentChange(source, projection, content);
      expect(inserted?.source).toBe(source.replace("ending.", "ending." + addition));
      const restored = applyLatexVisualDocumentChange(
        inserted!.source,
        inserted!.projection,
        projection.content,
      );
      expect(restored?.source).toBe(source);
    },
  );

  it("keeps text-run boundaries equivalent across TeX syntax and Unicode accents", () => {
    const body =
      "A long ordinary phrase ``quoted'' -- then --- \\textbf{bold prose}~" +
      "escaped \\% and \\& with cafe\u0301, \\'{e}, Hebrew שָ and emoji 🧪.";
    const source = document(body);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    const nodes = projection.content.content![0]!.content!;
    expect(nodes.map((node) => node.text ?? "").join("")).toBe(
      "A long ordinary phrase “quoted” – then — bold prose\u00a0" +
        "escaped % and & with cafe\u0301, é, Hebrew שָ and emoji 🧪.",
    );
    expect(nodes.find((node) => node.marks?.some((mark) => mark.type === "bold"))?.text).toBe(
      "bold prose",
    );
    expect(
      applyLatexVisualDocumentChange(source, projection, projection.content)?.source ?? source,
    ).toBe(source);
  });

  it("changes only the edited range, retaining preamble, comments and unknown commands", () => {
    const source = document(
      "\\section*{Title}\n\nHello world.\n\n% keep this comment\n\\custom{opaque}",
    );
    const projected = projectLatexVisualDocument(source);
    const nodes = structuredClone(projected.content.content!);
    nodes[1] = paragraph("A better paragraph.");
    expect(edit(source, nodes)?.source).toBe(source.replace("Hello world.", "A better paragraph."));
    expect(projected.rawBlocks).toBe(1);
  });

  it("accepts spaces while typing without losing session offsets", () => {
    let source = document("Hello");
    let projection = projectLatexVisualDocument(source);
    for (const value of [
      "Hello ",
      "Hello  ",
      "Hello  world",
      "Hello  world ",
      "Hello  world again",
    ]) {
      const content = { type: "doc", content: [paragraph(value)] };
      const change = applyLatexVisualDocumentChange(source, projection, content);
      expect(change, value).not.toBeNull();
      source = change!.source;
      projection = adoptLatexVisualContent(source, content);
    }
    expect(source).toBe(document("Hello  world again"));
  });

  it("supports Enter, typing in the empty paragraph and merging it back", () => {
    let source = document("First");
    for (const nodes of [
      [paragraph("First"), paragraph("")],
      [paragraph("First"), paragraph("Second")],
      [paragraph("FirstSecond")],
    ]) {
      const changed = edit(source, nodes);
      expect(changed).not.toBeNull();
      source = changed!.source;
    }
    expect(source).toBe(document("FirstSecond"));
  });

  it("handles heading level changes without trusting inherited source attributes", () => {
    const source = document("\\section*{Title}");
    expect(
      edit(source, [
        {
          type: "heading",
          attrs: { level: 2, latexCommand: "section", unnumbered: true },
          content: [text("New title")],
        },
      ])?.source,
    ).toBe(document("\\subsection*{New title}"));
  });

  it("projects and edits document front matter without replacing the document body", () => {
    const source = `\\documentclass{article}
\\title{Research Guide}
\\author{Nati}
\\date{\\today}
\\begin{document}
\\maketitle

\\begin{abstract}
A concise introduction.
\\end{abstract}

\\tableofcontents
\\newpage
\\end{document}
`;
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    expect(
      projection.content.content?.map((node) => node.attrs?.kind ?? node.attrs?.environment),
    ).toEqual(["title", "abstract", "toc", "pagebreak"]);
    const nodes = structuredClone(projection.content.content!);
    nodes[0]!.attrs = { ...nodes[0]!.attrs, title: "A Better Guide" };
    const titleChange = applyLatexVisualDocumentChange(source, projection, {
      type: "doc",
      content: nodes,
    });
    expect(titleChange?.source).toContain("\\title{A Better Guide}");
    expect(titleChange?.source).toContain("\\date{\\today}");
    expect(titleChange?.source).toContain("\\maketitle");

    const abstractNodes = structuredClone(titleChange!.projection.content.content!);
    abstractNodes[1]!.content = [paragraph("A revised introduction.")];
    const abstractChange = applyLatexVisualDocumentChange(
      titleChange!.source,
      titleChange!.projection,
      { type: "doc", content: abstractNodes },
    );
    expect(abstractChange?.source).toContain(
      "\\begin{abstract}\nA revised introduction.\n\\end{abstract}",
    );
  });

  it("models optional author and date metadata using LaTeX maketitle defaults", () => {
    const source = `\\documentclass{article}
\\title{Untitled Author}
\\begin{document}
\\maketitle
\\end{document}
`;
    const projection = projectLatexVisualDocument(source);
    const title = projection.content.content?.[0];
    expect(title).toBeDefined();
    expect(title?.attrs).toMatchObject({
      authorEnabled: false,
      dateEnabled: true,
      dateMode: "default",
    });
    expect(title?.attrs?.date).not.toBe("Today");

    const withAuthor = structuredClone(projection.content.content!);
    withAuthor[0]!.attrs = {
      ...withAuthor[0]!.attrs,
      author: "Nati",
      authorEnabled: true,
      date: "",
      dateEnabled: false,
      dateMode: "hidden",
    };
    const changed = applyLatexVisualDocumentChange(source, projection, {
      type: "doc",
      content: withAuthor,
    });
    expect(changed?.source).toContain("\\author{Nati}");
    expect(changed?.source).toContain("\\date{}");
  });

  it("round-trips nested lists and empty list items", () => {
    const nodes: JSONContent[] = [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph("One"),
              {
                type: "orderedList",
                attrs: { start: 1 },
                content: [{ type: "listItem", content: [paragraph("Nested")] }],
              },
            ],
          },
          { type: "listItem", content: [paragraph("")] },
        ],
      },
    ];
    const result = edit(document("Start"), nodes);
    expect(result).not.toBeNull();
    expect(projectLatexVisualDocument(result!.source).rawBlocks).toBe(0);
  });

  it("escapes typed TeX characters instead of executing them", () => {
    const result = edit(document("Hello"), [paragraph("50% & $2_# {yes} \\ ~ ^")]);
    expect(result).not.toBeNull();
    expect(result!.source).toContain(
      "50\\% \\& \\$2\\_\\# \\{yes\\} \\textbackslash{} \\textasciitilde{} \\textasciicircum{}",
    );
  });

  it("supports empty inline math and hard line breaks", () => {
    const result = edit(document("Start"), [
      {
        type: "paragraph",
        content: [
          text("Before "),
          { type: "latexInlineMath", attrs: { tex: "" } },
          { type: "hardBreak" },
          text("After"),
        ],
      },
    ]);
    expect(result).not.toBeNull();
    expect(result!.source).toContain("\\(\\)\\\\\nAfter");
  });

  it("preserves numbered math environments when editing an equation", () => {
    const source = document("\\begin{equation}\nx^2\n\\end{equation}").replace(
      "\\begin{document}",
      "\\usepackage{amsmath}\n\\begin{document}",
    );
    const nodes = structuredClone(projectLatexVisualDocument(source).content.content!);
    nodes[0]!.attrs!.tex = "\\frac{x}{2}";
    expect(edit(source, nodes)?.source).toBe(source.replace("x^2", "\\frac{x}{2}"));
  });

  it("preserves inline and display math wrappers while editing", () => {
    const source = document("Inline $x$ here.\n\n$$\ny^2\n$$");
    const nodes = structuredClone(projectLatexVisualDocument(source).content.content!);
    nodes[0]!.content![1]!.attrs!.tex = "z";
    nodes[1]!.attrs!.tex = "z^2";
    expect(edit(source, nodes)?.source).toBe(document("Inline $z$ here.\n\n$$\nz^2\n$$"));
  });

  it("validates complete math source and structured environments", () => {
    expect(parseLatexVisualMathSource("$x+1$", false)).toEqual({
      tex: "x+1",
      wrapper: "dollar",
    });
    expect(parseLatexVisualMathSource("x+1", false)).toBeNull();
    expect(
      latexVisualMathSource({ tex: "a &= b", environment: "align", wrapper: "bracket" }, true),
    ).toContain("\\begin{align}");
    expect(parseStructuredMathEnvironment("\\begin{bmatrix}a&b\\end{bmatrix}")).not.toBeNull();
    expect(parseStructuredMathEnvironment("\\begin{unknown}x\\end{unknown}")).toBeNull();
  });

  it("shows expanded safe commands while retaining unknown and structural commands as source", () => {
    const projection = projectLatexVisualDocument(
      document("See \\citeauthor{key} on \\pageref{page}.\n\n\\foo{value}\n\n\\input{chapter}"),
    );
    expect(projection.blocks[0]!.node.type).toBe("paragraph");
    expect(projection.blocks[1]!.node.type).toBe("latexRawBlock");
    expect(projection.blocks[2]!.node.type).toBe("latexRawBlock");
  });

  it("edits description labels and bodies while preserving environment options", () => {
    const source = document(`\\begin{description}[style=nextline,leftmargin=2.7cm]
  \\item[Algorithms] Design algorithms and prove their correctness.
  \\item[Complexity theory] Study resources and limits of efficient computation.
\\end{description}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]!.node.type).toBe("latexRichPreview");
    expect(projection.blocks[0]!.editable).toBe(true);
    expect(projection.blocks[0]!.node.attrs).toMatchObject({
      descriptionStyle: "nextline",
      descriptionLeftMargin: "2.7cm",
    });
    expect(projection.blocks[0]!.node.attrs?.items).toEqual([
      { label: "Algorithms", body: "Design algorithms and prove their correctness." },
      {
        label: "Complexity theory",
        body: "Study resources and limits of efficient computation.",
      },
    ]);
    const nodes = structuredClone(projection.content.content!);
    const items = nodes[0]!.attrs!.items as { label: string; body: string }[];
    items[0]!.label = "Algorithms & proofs";
    items[1]!.body = "Study time, memory, and computational limits.";
    const changed = edit(source, nodes);
    expect(changed?.source).toContain("\\begin{description}[style=nextline,leftmargin=2.7cm]");
    expect(changed?.source).toContain(
      "\\item[Algorithms \\& proofs] Design algorithms and prove their correctness.",
    );
    expect(changed?.source).toContain(
      "\\item[Complexity theory] Study time, memory, and computational limits.",
    );
  });

  it("adds and removes description items through the visual document", () => {
    const source = document(`\\begin{description}[style=nextline]
  \\item[Algorithms] Design and prove algorithms.
  \\item[Complexity] Study computational limits.
\\end{description}`);
    const projection = projectLatexVisualDocument(source);
    const nodes = structuredClone(projection.content.content!);
    const attributes = nodes[0]!.attrs!;
    attributes.items = [
      ...(attributes.items as object[]).slice(1),
      { label: "Cryptography", body: "Build secure protocols." },
    ];
    attributes.itemIds = [...(attributes.itemIds as string[]).slice(1), "description-new-test"];
    const changed = edit(source, nodes);
    expect(changed?.source).not.toContain("Algorithms");
    expect(changed?.source).toContain("\\item[Complexity] Study computational limits.");
    expect(changed?.source).toContain("\\item[Cryptography] Build secure protocols.");
    expect(changed?.projection.blocks[0]!.editable).toBe(true);
    expect(changed?.projection.blocks[0]!.node.attrs?.items).toHaveLength(2);
  });

  it("edits simple table cells while preserving the surrounding tabularx source", () => {
    const source = document(`\\begin{table}[htbp]
\\centering
\\caption{Research options.}
\\label{tab:areas}
\\begin{tabularx}{\\textwidth}{@{}p{2.7cm} X@{}}
\\toprule
\\textbf{Area} & \\textbf{Evidence} \\\\
\\midrule
Theory & Proofs and formal models \\\\
Systems & Prototypes~and measurements \\\\
\\bottomrule
\\end{tabularx}
\\end{table}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]!.node.type).toBe("latexRichPreview");
    expect(projection.blocks[0]!.editable).toBe(true);
    expect(projection.blocks[0]!.node.attrs?.caption).toBe("Research options.");
    expect(projection.blocks[0]!.node.attrs?.rows).toEqual([
      ["\\textbf{Area}", "\\textbf{Evidence}"],
      ["Theory", "Proofs and formal models"],
      ["Systems", "Prototypes~and measurements"],
    ]);
    expect(source).toContain(projection.blocks[0]!.source);
    expect(projection.blocks[0]!.source).toContain("\\end{table}");
    const nodes = structuredClone(projection.content.content!);
    (nodes[0]!.attrs!.rows as string[][])[1]![1] = "Proofs \\& verified models";
    nodes[0]!.attrs!.caption = "Research areas & evidence.";
    (nodes[0]!.attrs!.rows as string[][]).push(["Security", "Threat models"]);
    (nodes[0]!.attrs!.rowIds as string[]).push("table-new-test");
    const changed = edit(source, nodes);
    expect(changed?.source).toContain("\\caption{Research areas \\& evidence.}");
    expect(changed?.source).toContain("Theory & Proofs \\& verified models");
    expect(changed?.source).toContain("Security & Threat models \\\\");
    expect(changed?.source.indexOf("Security & Threat models")).toBeLessThan(
      changed!.source.indexOf("\\bottomrule"),
    );
    expect(changed?.source).toContain("\\textbf{Area}");
    expect(changed?.source).toContain("@{}p{2.7cm} X@{}");
    expect(changed?.source).toContain("\\label{tab:areas}");
    expect(changed?.source).toContain("Prototypes~and measurements");
    const nextNodes = structuredClone(changed!.projection.content);
    (nextNodes.content![0]!.attrs!.rows as string[][])[2]![0] = "Engineering";
    const changedAgain = applyLatexVisualDocumentChange(
      changed!.source,
      changed!.projection,
      nextNodes,
    );
    expect(changedAgain?.source).toContain("Theory & Proofs \\& verified models");
    expect(changedAgain?.source).toContain("Engineering & Prototypes~and measurements");
  });

  it("round-trips structural table edits through the supported table model", () => {
    const source = document(`\\begin{table}[htbp]
\\centering
\\caption{Research options.}
\\label{tab:areas}
\\begin{tabular}{ll}
\\toprule
\\textbf{Area} & \\textbf{Evidence} \\\\
\\midrule
Theory & Proofs \\\\
\\bottomrule
\\end{tabular}
\\end{table}`);
    const projection = projectLatexVisualDocument(source);
    const nodes = structuredClone(projection.content.content!);
    Object.assign(nodes[0]!.attrs!, {
      rows: [
        ["Area", "Evidence", "Owner"],
        ["Theory", "Proofs \\& models", "Ada"],
        ["Systems", "Measurements", "Grace"],
      ],
      rowIds: ["row-1", "row-2", "row-3"],
      columnIds: ["column-1", "column-2", "column-3"],
      columnAlignments: ["left", "center", "right"],
      tableStyle: "grid",
      tableKind: "stretch",
      hasHeader: true,
      tableCanonical: true,
      caption: "Research areas",
      label: "tab:research-areas",
    });
    const changed = edit(source, nodes);
    expect(changed).not.toBeNull();
    expect(changed?.source).toContain("\\caption{Research areas}");
    expect(changed?.source).toContain("\\label{tab:research-areas}");
    expect(changed?.source).toContain("\\begin{tabularx}{\\textwidth}");
    expect(changed?.source).toContain("\\hline");
    expect(changed?.source).not.toContain("\\toprule");
    expect(changed?.source).toContain("Theory & Proofs \\& models & Ada");
    expect(changed?.projection.blocks[0]!.node.attrs).toMatchObject({
      tableStyle: "grid",
      tableKind: "stretch",
      hasHeader: true,
      columnAlignments: ["left", "center", "right"],
    });
  });

  it("creates editable table sources for the table picker presets", () => {
    for (const preset of ["plain", "booktabs", "grid", "stretch"] as const) {
      const source = latexVisualTableSource(3, 4, preset);
      const projection = projectLatexVisualDocument(document(source));
      const block = projection.blocks[0]!;
      const rows = block.node.attrs?.rows as string[][];
      expect(block.editable, preset).toBe(true);
      expect(rows, preset).toHaveLength(3);
      expect(rows[0], preset).toHaveLength(4);
    }
  });

  it("edits a supported figure as a complete visual object", () => {
    const source = document(latexVisualFigureSource());
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]!.node.attrs).toMatchObject({
      kind: "figure",
      path: "figures/image.png",
      figureWidth: "0.8\\textwidth",
      figurePlacement: "htbp",
      figureAlignment: "center",
      caption: "",
      label: "",
      editable: true,
    });
    const nodes = structuredClone(projection.content.content!);
    Object.assign(nodes[0]!.attrs!, {
      path: "images/result.pdf",
      figureWidth: "\\linewidth",
      figureAlignment: "left",
      caption: "Measured result & uncertainty",
      label: "fig:result",
    });
    const changed = edit(source, nodes);
    expect(changed?.source).toContain("\\raggedright");
    expect(changed?.source).toContain("\\includegraphics[width=\\linewidth]{images/result.pdf}");
    expect(changed?.source).toContain("\\caption{Measured result \\& uncertainty}");
    expect(changed?.projection.blocks[0]!.node.attrs?.editable).toBe(true);
    const unsafe = structuredClone(projection.content.content!);
    unsafe[0]!.attrs!.figureWidth = "1],angle=90";
    expect(edit(source, unsafe)).toBeNull();
  });

  it("edits theorem-like scientific blocks and converts their semantic type", () => {
    expect(latexVisualScientificSource("claim")).toBe("\\begin{claim}\n\n\\end{claim}");
    const block = "\\begin{claim}[Title]\nStatement.\n\\end{claim}";
    const source = document(block);
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]!.node.attrs).toMatchObject({
      environment: "claim",
      title: "Title",
    });
    const nodes = structuredClone(projection.content.content!);
    Object.assign(nodes[0]!.attrs!, {
      environment: "theorem",
      title: "Main result",
    });
    nodes[0]!.content = [
      {
        type: "paragraph",
        content: [
          {
            type: "latexInlineCommand",
            attrs: { name: "label", argument: "thm:main", raw: "\\label{thm:main}" },
          },
          { type: "text", text: "Every supported edit round-trips." },
        ],
      },
    ];
    const changed = edit(source, nodes);
    expect(changed?.source).toContain("\\newtheorem{theorem}{Theorem}");
    expect(changed?.source).toContain(
      "\\begin{theorem}[Main result]\n\\label{thm:main}Every supported edit round-trips.\n\\end{theorem}",
    );
  });

  it("projects safe document layout settings without executing the preamble", () => {
    const profile = latexVisualLayoutProfile(`\\documentclass[12pt,a4paper]{report}
\\usepackage[margin=2cm,left=3cm]{geometry}
\\linespread{1.2}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{6pt}
\\begin{document}
Text
\\end{document}`);
    expect(profile).toMatchObject({
      documentClass: "report",
      paper: "a4",
      baseFontPt: 12,
      paragraphIndentEm: 0,
    });
    expect(profile.marginLeftIn).toBeCloseTo(3 / 2.54);
    expect(profile.marginRightIn).toBeCloseTo(2 / 2.54);
    expect(profile.lineHeight).toBeCloseTo(1.45);
    expect(profile.paragraphGapEm).toBeGreaterThan(0);
  });

  it("updates supported layout settings while preserving unrelated preamble options", () => {
    const source = `\\documentclass[twoside,11pt]{article}
\\usepackage[colorlinks]{hyperref}
\\begin{document}
Text
\\end{document}`;
    const changed = updateLatexVisualLayoutSource(source, {
      paper: "a4",
      baseFontPt: 12,
      margin: "2.5cm",
      paragraphStyle: "spaced",
    });
    expect(changed?.source).toContain("\\documentclass[twoside,12pt,a4paper]{article}");
    expect(changed?.source).toContain("\\usepackage[colorlinks]{hyperref}");
    expect(changed?.source).toContain("\\usepackage[margin=2.5cm,a4paper]{geometry}");
    expect(changed?.source).toContain("\\setlength{\\parindent}{0pt}");
    expect(changed?.source).toContain("\\setlength{\\parskip}{0.75em}");
    expect(changed?.source).toContain("Text");
    expect(applyDocumentSourcePatches(source, changed!.edit.patches)).toBe(changed!.source);
    expect(
      updateLatexVisualLayoutSource(source, {
        paper: "letter",
        baseFontPt: 10,
        margin: "wide",
        paragraphStyle: "indented",
      }),
    ).toBeNull();
    expect(
      updateLatexVisualLayoutSource(
        "\\documentclass{article}\\begin{document}Text\\end{document}",
        {
          paper: "letter",
          baseFontPt: 10,
          margin: "1in",
          paragraphStyle: "indented",
        },
      )?.source,
    ).toContain(
      "\\documentclass[10pt,letterpaper]{article}\n\\usepackage[margin=1in,letterpaper]{geometry}",
    );
  });

  it("keeps unsupported cell commands protected even in supported spans", () => {
    const source = document(`\\begin{tabular}{ll}
\\multicolumn{2}{c}{Heading} \\\\
Value & \\unsupported{x^2} \\\\
\\end{tabular}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]!.node.type).toBe("latexRawBlock");
    expect(projection.blocks[0]!.editable).toBe(false);
    expect(edit(source, [paragraph("replacement")])).toBeNull();
  });

  it("does not interpret a commented environment end or a verbatim document end", () => {
    const source = document(
      "\\begin{verbatim}\n\\end{document}\n\\end{verbatim}\n\nHello\n\n\\begin{unknown}\n% \\end{unknown}\nkeep\n\\end{unknown}",
    );
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks.map((block) => block.node.type)).toEqual([
      "latexRichPreview",
      "paragraph",
      "latexRawBlock",
    ]);
    const nodes = structuredClone(projection.content.content!);
    nodes[1] = paragraph("Changed");
    expect(edit(source, nodes)?.source).toBe(source.replace("Hello", "Changed"));
  });

  it("rejects deletion across raw blocks and stale source mappings", () => {
    const source = document("Hello\n\n\\unknown{keep}");
    expect(edit(source, [paragraph("Replacement")])).toBeNull();
    const projected = projectLatexVisualDocument(source);
    expect(applyLatexVisualDocumentChange(source + "\n", projected, projected.content)).toBeNull();
  });

  it("rejects unsupported pasted nodes and preserves optional arguments", () => {
    expect(edit(document("Hello"), [{ type: "image", attrs: { src: "x" } }])).toBeNull();
    expect(projectLatexVisualDocument(document("\\section[short]{Long title}")).rawBlocks).toBe(1);
    const source = document("\\cite[page 1]{key}");
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    const nodes = structuredClone(projection.content.content!);
    const citation = nodes[0]!.content![0]!;
    expect(citation.type).toBe("latexInlineCommand");
    expect(citation.attrs?.raw).toBe("\\cite[page 1]{key}");
    citation.attrs = { ...citation.attrs, argument: "other-key" };
    expect(edit(source, nodes)?.source).toBe(document("\\cite[page 1]{other-key}"));
  });

  it("preserves CRLF and supports a document with no body text", () => {
    const source = document("").replaceAll("\n", "\r\n");
    const result = edit(source, [paragraph("First"), paragraph("Second")]);
    expect(result?.source).toContain("First\r\n\r\nSecond");
    expect(result?.source.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("compares combined marks independently of schema attribute and mark order", () => {
    const source = document("\\emph{\\textbf{Hello}}");
    const result = edit(source, [
      {
        type: "paragraph",
        attrs: { sourceId: "copied", unnumbered: false },
        content: [{ type: "text", text: "Changed", marks: [{ type: "bold" }, { type: "italic" }] }],
      },
    ]);
    expect(result).not.toBeNull();
  });
});

describe("owned native source operations", () => {
  it("retains separate authored boundaries across a compound paragraph edit", () => {
    const source = document("First.\n \t\nSecond.\n\nUntouched.");
    const projection = projectLatexVisualDocument(source);
    const content = structuredClone(projection.content);
    content.content![0]!.content = [text("Edited first.")];
    content.content![1]!.content = [text("Edited second.")];
    const change = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(change.source).toBe(
      source.replace("First.", "Edited first.").replace("Second.", "Edited second."),
    );
    expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
    const gap = source.indexOf("\n \t\n");
    expect(
      change.edit.patches.every(
        (patch) => patch.end <= gap || patch.start >= gap + "\n \t\n".length,
      ),
    ).toBe(true);
    expect(
      applyDocumentSourcePatches(
        change.source,
        invertLatexSourcePatches(source, change.edit.patches),
      ),
    ).toBe(source);
  });

  it("retains independent title declaration ranges, comments and CRLF trivia", () => {
    const source =
      "\\documentclass{article}\r\n\\title {Old}\r\n% unrelated declaration trivia 😀\r\n\\author {Author}\r\n\\date{}\r\n\\begin{document}\r\n\\maketitle\r\n\r\nBody.\r\n\\end{document}";
    const projection = projectLatexVisualDocument(source);
    const content = structuredClone(projection.content);
    Object.assign(content.content![0]!.attrs!, { title: "New", author: "Writer" });
    const change = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(change.source).toBe(source.replace("{Old}", "{New}").replace("{Author}", "{Writer}"));
    expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
    expect(
      applyDocumentSourcePatches(
        change.source,
        invertLatexSourcePatches(source, change.edit.patches),
      ),
    ).toBe(source);
  });

  it("converts a title paragraph using original deletion and insertion coordinates", () => {
    const source = document("Research Title\n\nA body paragraph.");
    const change = prepareLatexDocumentTitle(source, 0)!;
    expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
    expect(change.source).toContain("\\title{Research Title}");
    expect(change.source).toContain("\n\\maketitle\n");
    expect(change.source).toContain("A body paragraph.");
    expect(
      applyDocumentSourcePatches(
        change.source,
        invertLatexSourcePatches(source, change.edit.patches),
      ),
    ).toBe(source);
  });

  it("keeps packages from assembled declaration files instead of duplicating them in the root", () => {
    const root =
      "\\documentclass{article}\n\\input{setup}\n\\begin{document}\n\\input{body}\n\\end{document}";
    const assembled =
      "\\documentclass{article}\n\\usepackage{amssymb}\n\\begin{document}\nText.\n\\end{document}";
    const source = "Text.";
    const projection = projectLatexVisualDocument(source, 0, assembled);
    const content: JSONContent = {
      type: "doc",
      content: [
        paragraph(""),
        {
          type: "latexDisplayMath",
          attrs: { tex: "\\mathbb{R}", wrapper: "bracket" },
        },
      ],
    };
    const change = applyLatexVisualDocumentChange(source, projection, content, {
      rootSource: root,
      setupSource: assembled,
      allowRootUpdates: true,
    })!;
    expect(change.edit.root).toBeUndefined();
    expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
    expect(change.source).toContain("\\mathbb{R}");
  });

  it("emits a physical-root requirement insertion without swallowing root includes", () => {
    const root =
      "\\documentclass{article}\n% keep root comment\n\\begin{document}\n\\input{body}\n\\end{document}";
    const source = "Text.";
    const content: JSONContent = {
      type: "doc",
      content: [
        {
          type: "latexDisplayMath",
          attrs: { tex: "\\mathbb{R}", wrapper: "bracket" },
        },
      ],
    };
    const change = applyLatexVisualDocumentChange(
      source,
      projectLatexVisualDocument(source, 0, root),
      content,
      { rootSource: root, setupSource: root, allowRootUpdates: true },
    )!;
    const changedRoot = applyDocumentSourcePatches(root, change.edit.root!.patches);
    expect(changedRoot).toContain("\\usepackage{amssymb}\n");
    expect(changedRoot).toContain("% keep root comment\n");
    expect(changedRoot).toContain("\\input{body}");
    expect(change.edit.root!.patches.every((patch) => patch.start === patch.end)).toBe(true);
    expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
  });

  it("edits list items independently and preserves surviving child and separator spelling", () => {
    const source = document(
      "\\begin{itemize}\r\n  \\item  Alpha~one.\r\n\r\n  \\item\tBeta~two.\r\n\\end{itemize}",
    );
    const projection = projectLatexVisualDocument(source);
    const content = structuredClone(projection.content);
    content.content![0]!.content![0]!.content![0]!.content![0]!.text = "Changed one.";
    content.content![0]!.content![1]!.content![0]!.content![0]!.text = "Changed two.";
    const change = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(change.source).toContain(
      "\\begin{itemize}\r\n  \\item  Changed one.\r\n\r\n  \\item\tChanged two.\r\n\\end{itemize}",
    );
    expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
    expect(
      applyDocumentSourcePatches(
        change.source,
        invertLatexSourcePatches(source, change.edit.patches),
      ),
    ).toBe(source);
  });

  it.each(["insert", "delete", "reorder", "convert"] as const)(
    "preserves surviving list item bytes during %s",
    (operation) => {
      const source = document(
        "\\begin{itemize}\n  \\item  First~item.\n\n  \\item\tSecond~item.\n\\end{itemize}",
      );
      const projection = projectLatexVisualDocument(source);
      const content = structuredClone(projection.content);
      const list = content.content![0]!;
      if (operation === "insert")
        list.content!.push({ type: "listItem", content: [paragraph("New item.")] });
      if (operation === "delete") list.content!.shift();
      if (operation === "reorder") list.content!.reverse();
      if (operation === "convert") list.type = "orderedList";
      const change = applyLatexVisualDocumentChange(source, projection, content)!;
      expect(change.source).toContain("\\item\tSecond~item.\n");
      if (operation !== "delete") expect(change.source).toContain("\\item  First~item.\n\n");
      expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
      expect(
        applyDocumentSourcePatches(
          change.source,
          invertLatexSourcePatches(source, change.edit.patches),
        ),
      ).toBe(source);
    },
  );

  it("splits list prose without normalizing surviving TeX token spelling", () => {
    const source = document("\\begin{itemize}\n  \\item  One~two three~four.\n\\end{itemize}");
    const projection = projectLatexVisualDocument(source);
    const content = structuredClone(projection.content);
    const list = content.content![0]!;
    const original = list.content![0]!;
    list.content = [
      { ...original, content: [paragraph("One\u00a0two")] },
      { ...original, content: [paragraph("three\u00a0four.")] },
    ];
    const change = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(change.source).toContain("One~two");
    expect(change.source).toContain("three~four.");
    expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
    expect(
      applyDocumentSourcePatches(
        change.source,
        invertLatexSourcePatches(source, change.edit.patches),
      ),
    ).toBe(source);
  });

  it.each(["join", "lift", "nest"] as const)(
    "preserves native list paragraph spelling during %s",
    (operation) => {
      const source = document(
        "\\begin{itemize}\n  \\item  First~item.\n\n  \\item\tSecond~item.\n\\end{itemize}",
      );
      const projection = projectLatexVisualDocument(source);
      const content = structuredClone(projection.content);
      const list = content.content![0]!;
      const first = list.content![0]!,
        second = list.content![1]!;
      if (operation === "join") {
        first.content = [
          {
            ...first.content![0],
            content: [...first.content![0]!.content!, ...second.content![0]!.content!],
          },
        ];
        list.content = [first];
      }
      if (operation === "lift") content.content = [first.content![0]!, second.content![0]!];
      if (operation === "nest") {
        first.content!.push({ ...list, content: [second] });
        list.content = [first];
      }
      const change = applyLatexVisualDocumentChange(source, projection, content)!;
      expect(change.source).toContain("First~item.");
      expect(change.source).toContain("Second~item.");
      expect(applyDocumentSourcePatches(source, change.edit.patches)).toBe(change.source);
      expect(
        applyDocumentSourcePatches(
          change.source,
          invertLatexSourcePatches(source, change.edit.patches),
        ),
      ).toBe(source);
    },
  );

  it("refreshes nested list ranges after an accepted structural edit before subsequent typing", () => {
    const source = document(
      "\\begin{itemize}\n\\item First~item.\n\\item Second~item.\n\\end{itemize}",
    );
    const projection = projectLatexVisualDocument(source);
    const reordered = structuredClone(projection.content);
    reordered.content![0]!.content!.reverse();
    const first = applyLatexVisualDocumentChange(source, projection, reordered)!;
    const typed = structuredClone(first.projection.content);
    typed.content![0]!.content![0]!.content![0]!.content![0]!.text += " Added.";
    const second = applyLatexVisualDocumentChange(first.source, first.projection, typed)!;
    expect(second.source).toBe(first.source.replace("Second~item.", "Second~item. Added."));
    expect(applyDocumentSourcePatches(first.source, second.edit.patches)).toBe(second.source);
  });

  it.each(["\\item[Custom] Label", "\\item First % native comment\n"] as const)(
    "keeps unsupported list syntax source-owned: %s",
    (item) => {
      const source = document(`\\begin{itemize}\n${item}\n\\end{itemize}`);
      const projection = projectLatexVisualDocument(source);
      expect(projection.rawBlocks).toBe(1);
      expect(
        applyLatexVisualDocumentChange(source, projection, {
          type: "doc",
          content: [paragraph("replacement")],
        }),
      ).toBeNull();
    },
  );

  it("keeps outside edits outside an owning generator and uses an exact inverse for materialization", () => {
    const source =
      "\\documentclass{article}\n\\newcount\\n\n\\begin{document}\nBefore.\n\n\\n=0\\loop\\advance\\n by 1 Paragraph \\the\\n.\\par\\ifnum\\n<2\\repeat\n\nAfter.\n\\end{document}";
    const projection = projectLatexVisualDocument(source);
    expect(projection.generated).toBeDefined();
    const outside = structuredClone(projection.content);
    outside.content!.at(-1)!.content = [text("Edited after.")];
    const outsideChange = applyLatexVisualDocumentChange(source, projection, outside)!;
    expect(outsideChange.source).toBe(source.replace("After.", "Edited after."));
    expect(outsideChange.materializedGenerator).toBe(false);
    expect(applyDocumentSourcePatches(source, outsideChange.edit.patches)).toBe(
      outsideChange.source,
    );
    const inside = structuredClone(projection.content);
    inside.content![1]!.content = [text("Edited generated paragraph.")];
    const insideChange = applyLatexVisualDocumentChange(source, projection, inside)!;
    expect(insideChange.materializedGenerator).toBe(true);
    expect(insideChange.source).toContain("Edited generated paragraph.");
    expect(insideChange.source).not.toContain("\\loop");
    expect(applyDocumentSourcePatches(source, insideChange.edit.patches)).toBe(insideChange.source);
    expect(
      applyDocumentSourcePatches(
        insideChange.source,
        invertLatexSourcePatches(source, insideChange.edit.patches),
      ),
    ).toBe(source);
  });

  it("guards explicit raw replacement ranges and preserves unrelated opaque neighbors", () => {
    const source = document("\\unknown{raw}\n\nText.");
    const projection = projectLatexVisualDocument(source);
    const block = projection.blocks[0]!;
    const edit = latexVisualBlockSourceEdit(source, block, "\\unknown{new}")!;
    expect(applyDocumentSourcePatches(source, edit.patches)).toBe(source.replace("{raw}", "{new}"));
    expect(
      latexVisualBlockSourceEdit(source.replace("{raw}", "{other}"), block, "\\unknown{new}"),
    ).toBeNull();
  });
});

describe("owned layout declaration boundaries", () => {
  it("edits only active geometry and paragraph declarations across unrelated preamble bytes", () => {
    const source =
      "\\documentclass{article}\r\n% \\usepackage[margin=9in]{geometry}\r\n\\usepackage[margin=1in]{geometry}\r\n% keep 😀 native comment\r\n\\setlength{\\parindent}{1.5em}\r\n\\input{unrelated-setup}\r\n\\setlength{\\parskip}{0pt plus 1pt}\r\n\\begin{document}\r\nBody.\r\n\\end{document}";
    const changed = updateLatexVisualLayoutSource(source, {
      margin: "2cm",
      paragraphStyle: "spaced",
    })!;
    expect(changed.source).toBe(
      source
        .replace("\\usepackage[margin=1in]{geometry}", "\\usepackage[margin=2cm]{geometry}")
        .replace("\\setlength{\\parindent}{1.5em}", "\\setlength{\\parindent}{0pt}")
        .replace("\\setlength{\\parskip}{0pt plus 1pt}", "\\setlength{\\parskip}{0.75em}"),
    );
    expect(applyDocumentSourcePatches(source, changed.edit.patches)).toBe(changed.source);
    expect(
      applyDocumentSourcePatches(
        changed.source,
        invertLatexSourcePatches(source, changed.edit.patches),
      ),
    ).toBe(source);
  });

  it("retains literal fake document boundaries and bytes after endinput", () => {
    const source =
      "\\documentclass{article}\n\\verb|\\begin{document}|\n\\begin{document}\nText.\n\\endinput\nIgnored \\unknown{opaque}";
    const projection = projectLatexVisualDocument(source);
    const content = structuredClone(projection.content);
    content.content![0]!.content = [text("Changed.")];
    const changed = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(changed.source).toBe(source.replace("Text.", "Changed."));
    expect(applyDocumentSourcePatches(source, changed.edit.patches)).toBe(changed.source);
  });
});

describe("title creation uses lossless document boundary facts", () => {
  it.each(["\\begin {document}", "\\begin % native boundary note\r\n{document}"])(
    "never inserts into the native opening command: %s",
    (opening) => {
      const source = "\\documentclass{article}\r\n" + opening + "\r\nBody.\r\n\\end{document}";
      const prepared = prepareLatexDocumentTitle(source);
      if (!prepared) throw new Error("Valid native title creation was refused");
      const boundary = latexDocumentBoundary(prepared.source);
      if (!boundary) throw new Error("Title creation corrupted the document boundary");
      expect(prepared.source.slice(boundary.from, boundary.bodyFrom)).toBe(opening);
      expect(prepared.source.slice(boundary.bodyFrom, boundary.bodyTo)).toBe(
        "\r\n\\maketitle\r\n\r\nBody.\r\n",
      );
      expect(
        applyDocumentSourcePatches(
          prepared.source,
          invertLatexSourcePatches(source, prepared.edit.patches),
        ),
      ).toBe(source);
    },
  );

  it("does not treat a literal title command as an existing printed title", () => {
    const source =
      "\\documentclass{article}\r\n\\begin{document}\r\n\\verb|\\maketitle| literal.\r\n\\end{document}";
    const prepared = prepareLatexDocumentTitle(source);
    if (!prepared) throw new Error("A literal command incorrectly prevented title creation");
    const boundary = latexDocumentBoundary(prepared.source)!;
    expect(prepared.source.slice(boundary.bodyFrom, boundary.bodyTo)).toBe(
      "\r\n\\maketitle\r\n\r\n\\verb|\\maketitle| literal.\r\n",
    );
    expect(
      applyDocumentSourcePatches(
        prepared.source,
        invertLatexSourcePatches(source, prepared.edit.patches),
      ),
    ).toBe(source);
  });
});
