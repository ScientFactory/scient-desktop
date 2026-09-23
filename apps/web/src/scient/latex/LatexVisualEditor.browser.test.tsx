import { type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import "./scient-latex.css";

const source = `\\documentclass[10pt,letterpaper]{article}
\\title{Research Options in Computer Science}
\\date{September 23, 2026}
\\begin{document}
\\maketitle

\\begin{abstract}
Computer science research ranges from mathematical foundations to the design of software,
hardware, and intelligent systems used in the real world. This guide summarizes the main
research areas, common research methods, and practical ways to choose a direction.
\\end{abstract}

\\tableofcontents
\\newpage

\\section{What Computer Science Research Involves}
Computer science research asks questions about computation: what can be computed, how
efficiently it can be computed, how systems should be built, and how people and organizations
use those systems.

\\begin{enumerate}
\\item defining a focused question or problem;
\\item studying what is already known;
\\item selecting a method for producing evidence; and
\\item communicating a result that others can evaluate or reproduce.
\\item I don't know if it's good now $\\alpha^2 - 5x = \\lambda$
\\end{enumerate}

\\section{new section}
this is a new section

A useful research question is narrow enough to answer, significant enough to matter, and
precise enough that success can be assessed. The result may be a theorem, algorithm, system,
dataset, empirical finding, design framework, or new understanding of users and organizations.

\\section{Major Research Areas}
The boundaries between areas are flexible.
\\subsection{Theory and Foundations}
\\subsection{Artificial Intelligence and Data}
\\subsection{Systems, Software, and Hardware}
\\subsection{Human-Centered and Applied Computing}
\\section{Comparing Research Options}
\\section{Hybrid Theoretical--Applied Topics}
\\section{Common Research Methods}
\\subsection{Theoretical and Formal Methods}
\\subsection{Algorithm Design and Evaluation}
\\subsection{Systems Building}
\\subsection{User and Field Studies}
\\subsection{Data-Driven and Mixed Methods}
\\section{How to Choose a Research Direction}
\\section{Example Research Questions}
\\section{Possible Research Pathways}
\\subsection{Undergraduate or Short Project}
\\subsection{Master's Thesis}
\\subsection{Doctoral Research}
\\subsection{Research in Industry or Public Organizations}
\\section{Checklist for a First Research Proposal}
\\section{Conclusion}
\\end{document}
`;

describe("visual LaTeX page layout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await page.viewport(1400, 900);
    container = document.createElement("div");
    Object.assign(container.style, { width: "1200px", height: "900px" });
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it("keeps content out of gaps and honors the explicit break after Contents", async () => {
    root.render(
      <LatexVisualEditor
        draftKey="browser-pagination-test"
        fileRevision="r1"
        source={source}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={() => true}
      />,
    );
    await expect
      .poll(() =>
        container
          .querySelector<HTMLElement>(".scient-latex-page-break")
          ?.style.getPropertyValue("--scient-latex-page-break-space"),
      )
      .not.toBe("");

    const sheets = [...container.querySelectorAll<HTMLElement>(".scient-latex-page-sheet")].map(
      (sheet) => sheet.getBoundingClientRect(),
    );
    const pageOf = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return sheets.findIndex(
        (sheet) => bounds.top >= sheet.top - 1 && bounds.bottom <= sheet.bottom + 1,
      );
    };
    const contents = container.querySelector<HTMLElement>(".scient-latex-toc-preview")!;
    const firstSection = [...container.querySelectorAll<HTMLElement>("h1")].find((heading) =>
      heading.textContent?.includes("What Computer Science Research Involves"),
    )!;
    expect(pageOf(contents.querySelector("li:last-child")!)).toBe(0);
    expect(pageOf(firstSection)).toBe(1);

    for (const element of container.querySelectorAll(
      ".scient-latex-visual-document > p, .scient-latex-rich-preview dl > div",
    ))
      expect(pageOf(element), element.textContent ?? element.tagName).toBeGreaterThanOrEqual(0);

    const math = container.querySelector("math-field[aria-label='Inline equation']") as
      | (HTMLElement & { value?: string })
      | null;
    expect(math).not.toBeNull();
    expect(math?.value).toContain("\\alpha");
    expect(math!.getBoundingClientRect().width).toBeGreaterThan(0);
  });
});
