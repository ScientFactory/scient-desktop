import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";
import {
  adoptLatexVisualContent,
  applyLatexVisualDocumentChange,
  latexVisualFigureSource,
  latexVisualLayoutProfile,
  latexVisualScientificSource,
  latexVisualTableSource,
  latexVisualMathSource,
  parseLatexVisualMathSource,
  parseStructuredMathEnvironment,
  projectLatexVisualDocument,
  updateLatexVisualLayoutSource,
} from "./latexVisualDocument";
import { latexPreviewRebuildReason } from "./latexPreviewPolicy";

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
  it("changes only the edited range, retaining preamble, comments and unknown commands", () => {
    const source = document(
      "\\section*{Title}\n\nHello world.\n\n% keep this comment\n\\custom{opaque}",
    );
    const projected = projectLatexVisualDocument(source);
    const nodes = structuredClone(projected.content.content!);
    nodes[1] = paragraph("A better paragraph.");
    expect(edit(source, nodes)?.source).toBe(source.replace("Hello world.", "A better paragraph."));
    expect(projected.rawBlocks).toBe(2);
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
    expect(projection.content.content?.map((node) => node.attrs?.kind)).toEqual([
      "title",
      "abstract",
      "toc",
      "pagebreak",
    ]);
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
    abstractNodes[1]!.attrs = { ...abstractNodes[1]!.attrs, body: "A revised introduction." };
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
    const source = document("\\begin{equation}\nx^2\n\\end{equation}");
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
      ["Area", "Evidence"],
      ["Theory", "Proofs and formal models"],
      ["Systems", "Prototypes and measurements"],
    ]);
    expect(source).toContain(projection.blocks[0]!.source);
    expect(projection.blocks[0]!.source).toContain("\\end{table}");
    const nodes = structuredClone(projection.content.content!);
    (nodes[0]!.attrs!.rows as string[][])[1]![1] = "Proofs & verified models";
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
        ["Theory", "Proofs & models", "Ada"],
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
      caption: "Figure caption",
      label: "fig:image",
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
    const block = latexVisualScientificSource("claim")!;
    const source = document(block);
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]!.node.attrs).toMatchObject({
      kind: "scientific",
      environment: "claim",
      title: "Title",
      body: "Statement.",
      editable: true,
    });
    const nodes = structuredClone(projection.content.content!);
    Object.assign(nodes[0]!.attrs!, {
      environment: "theorem",
      title: "Main result",
      body: "Every supported edit round-trips.",
      label: "thm:main",
    });
    const changed = edit(source, nodes);
    expect(changed?.source).toContain("\\newtheorem{theorem}{Theorem}");
    expect(changed?.source).toContain(
      "\\begin{theorem}[Main result]\n\\label{thm:main}\nEvery supported edit round-trips.\n\\end{theorem}",
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
    expect(changed).toContain("\\documentclass[12pt,a4paper,twoside]{article}");
    expect(changed).toContain("\\usepackage[colorlinks]{hyperref}");
    expect(changed).toContain("\\usepackage[margin=2.5cm]{geometry}");
    expect(changed).toContain("\\setlength{\\parindent}{0pt}");
    expect(changed).toContain("\\setlength{\\parskip}{0.75em}");
    expect(changed).toContain("Text");
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
      ),
    ).toContain("\\documentclass[10pt,letterpaper]{article}\n\\usepackage[margin=1in]{geometry}");
  });

  it("keeps structurally complex table cells protected", () => {
    const source = document(`\\begin{tabular}{ll}
\\multicolumn{2}{c}{Heading} \\\\
Value & $x^2$ \\\\
\\end{tabular}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]!.node.type).toBe("latexRichPreview");
    expect(projection.blocks[0]!.editable).toBe(false);
    expect(edit(source, [paragraph("replacement")])).toBeNull();
  });

  it("does not interpret a commented environment end or a verbatim document end", () => {
    const source = document(
      "\\begin{verbatim}\n\\end{document}\n\\end{verbatim}\n\nHello\n\n\\begin{unknown}\n% \\end{unknown}\nkeep\n\\end{unknown}",
    );
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks.map((block) => block.node.type)).toEqual([
      "latexRawBlock",
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
    expect(projectLatexVisualDocument(document("\\cite[page 1]{key}")).rawBlocks).toBe(1);
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

describe("preview rebuild notices", () => {
  it("does not promise browser/TeX equivalence after a build", () => {
    expect(latexPreviewRebuildReason(document("A"), document("A"), true)).toBeNull();
    expect(latexPreviewRebuildReason(document("A"), document("B"), false)).toContain("pagination");
  });
  it("names preamble and macro invalidation", () => {
    expect(
      latexPreviewRebuildReason(document("A"), document("A").replace("article", "report"), false),
    ).toContain("preamble");
    expect(
      latexPreviewRebuildReason(document("A"), document("\\newcommand{\\x}{X}\nA"), false),
    ).toContain("macros");
  });
});
