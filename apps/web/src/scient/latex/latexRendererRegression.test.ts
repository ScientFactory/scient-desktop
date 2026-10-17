import { describe, expect, it } from "vite-plus/test";
import {
  applyLatexVisualDocumentChange,
  latexVisualTablePresentation,
  projectLatexVisualDocument,
} from "./latexVisualDocument";
import { latexGraphicsOptions, latexGraphicsPaths } from "./latexGraphics";

const document = (body: string, preamble = "") =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

describe("renderer coverage and retained source", () => {
  it("renders wrapped mixed-width cells and edits one without rewriting the table", () => {
    const source = document(String.raw`\begin{table}[htbp]
\centering
\caption{Topics}\label{tab:topics}
\scriptsize
\begin{tabularx}{\textwidth}{@{}>{\raggedright\arraybackslash}p{2.0cm}>{\raggedright\arraybackslash}X>{\raggedright\arraybackslash}X>{\raggedright\arraybackslash}X@{}}
\toprule
\textbf{Topic} & \textbf{Theory} & \textbf{Application} & \textbf{Project} \\
\midrule
Algorithms & Complexity analysis,
 approximation & Scheduling and routing & Cloud scheduling \\
Privacy & Security definitions & Messaging & Private analytics \\
\bottomrule
\end{tabularx}
\end{table}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    const table = projection.blocks[0]!.node;
    expect(table.attrs?.rows).toHaveLength(3);
    expect(table.attrs?.rows.every((row: string[]) => row.length === 4)).toBe(true);
    expect(latexVisualTablePresentation(source)).toMatchObject({
      columnKinds: ["fixed", "flexible", "flexible", "flexible"],
      size: "scriptsize",
      trimLeft: true,
      trimRight: true,
    });
    const next = structuredClone(projection.content);
    next.content![0]!.attrs!.rows[2][3] = "Revised project";
    const changed = applyLatexVisualDocumentChange(source, projection, next);
    expect(changed?.source).toBe(source.replace("Private analytics", "Revised project"));
  });

  it("keeps all longtable rows and does not poison following math with a local declaration", () => {
    const rows = Array.from(
      { length: 120 },
      (_, index) => `${index + 1} & Item ${index + 1} \\\\`,
    ).join("\n");
    const source = document(
      String.raw`\begin{table}
\renewcommand{\arraystretch}{1.35}
\begin{tabular}{ll}A & B \\\end{tabular}
\end{table}

\begin{longtable}{ll}
` +
        rows +
        String.raw`
\end{longtable}

\[\mathbf{n}\]`,
    );
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    expect(projection.blocks[1]!.node.attrs?.rows).toHaveLength(120);
    expect(projection.blocks[1]!.node.attrs?.rows.at(-1)).toEqual(["120", "Item 120"]);
    expect(projection.blocks[2]!.node.type).toBe("latexDisplayMath");
    expect(applyLatexVisualDocumentChange(source, projection, projection.content)?.source).toBe(
      source,
    );
  });

  it("renders underscore image paths, subfigure alignment and explicit gallery rows", () => {
    const panel = String.raw`\begin{subfigure}[t]{0.48\linewidth}\centering
\includegraphics[width=\linewidth,height=0.2\textheight,keepaspectratio]{photo_01.jpg}
\caption{Panel}\end{subfigure}`;
    const source = document(
      String.raw`\begin{figure}\centering
` +
        panel +
        String.raw`\par\medskip
` +
        panel +
        String.raw`\caption{Gallery}\end{figure}`,
    );
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    expect(projection.blocks[0]!.node.attrs?.sourceMeta.panels[1]).toMatchObject({
      path: "photo_01.jpg",
      rowBreakBefore: true,
    });
    expect(applyLatexVisualDocumentChange(source, projection, projection.content)?.source).toBe(
      source,
    );
  });

  it("preserves prose macro calls and image options while editing surrounding prose", () => {
    const source = document(
      String.raw`\includegraphics[width=31mm,height=22mm,keepaspectratio]{photo_01.jpg}
Before \fixtureparagraph After.`,
      String.raw`\newcommand{\fixtureparagraph}{Text with \textbf{bold} and \(\mathbf{n}\).}`,
    );
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    const next = structuredClone(projection.content);
    const text = next.content![0]!.content!.find(
      (node) => node.type === "text" && node.text?.includes("After"),
    )!;
    text.text = text.text!.replace("After", "Changed");
    expect(applyLatexVisualDocumentChange(source, projection, next)?.source).toBe(
      source.replace("After.", "Changed."),
    );
  });

  it("keeps unknown image operations and dynamic global definitions visible as source", () => {
    const source = document(String.raw`\includegraphics[unknown=1]{photo_01.jpg}

\global\def\custom{changed}

\custom`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(3);
    expect(applyLatexVisualDocumentChange(source, projection, projection.content)?.source).toBe(
      source,
    );
  });

  it("renders literal image crops while retaining their exact source", () => {
    const source = document(String.raw`\begin{figure}
\includegraphics[trim=1 2 3 4,clip]{photo_01.jpg}
\caption{Do not silently drop the crop.}
\end{figure}`);
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    expect(projection.blocks[0]!.source).toContain("trim=1 2 3 4,clip");
    expect(applyLatexVisualDocumentChange(source, projection, projection.content)?.source).toBe(
      source,
    );
  });
});

it("reads literal graphics search paths and rejects unknown transformations", () => {
  expect(latexGraphicsPaths(String.raw`\graphicspath{{images/}{figures/}}`)).toEqual([
    "images/",
    "figures/",
  ]);
  expect(
    latexGraphicsOptions(String.raw`width=\linewidth,height=.6\textheight,keepaspectratio`),
  ).toMatchObject({ keepAspectRatio: true });
  expect(latexGraphicsOptions("trim=1 2 3 4,clip")).toMatchObject({
    trim: [1 / 72, 2 / 72, 3 / 72, 4 / 72],
    clip: true,
  });
  expect(latexGraphicsOptions("viewport=0 0 10 10")).toBeNull();
});
