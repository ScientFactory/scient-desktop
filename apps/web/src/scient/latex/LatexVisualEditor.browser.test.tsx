import { useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { clearVisualDraft } from "./visualDrafts";
import { pdfFitWidthScale } from "../pdf/pdfReaderModel";
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

  it("offers an accepted checkpoint before an outside update when recovery storage is occupied", async () => {
    const key = "browser-statement-test";
    const slot = `scient:latex-visual-draft:source:${key}`;
    const tex = (body: string) =>
      `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
    const theirs = JSON.stringify({ source: tex("Another view"), baseRevision: "r1" });
    let current = tex("Old base");
    let revision = "r1";
    const render = () =>
      root.render(
        <LatexVisualEditor
          source={current}
          fileRevision={revision}
          draftKey={key}
          disabled={false}
          singleFileDocument
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (current !== expected) return false;
            current = next;
            render();
            return true;
          }}
        />,
      );
    render();
    await expect.poll(() => container.querySelector(".scient-latex-visual-document")).toBeTruthy();
    const editor = (
      container.querySelector(".scient-latex-visual-document") as HTMLElement & { editor: Editor }
    ).editor;
    const original = Storage.prototype.setItem;
    const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      name,
      value,
    ) {
      if (name === `scient:latex-visual-draft:recovered:${key}`) throw new Error("quota");
      original.call(this, name, value);
    });
    try {
      localStorage.setItem(slot, theirs);
      editor.commands.setTextSelection(3);
      editor.commands.setNode("heading", { level: 1 });
      expect(current).toContain("\\section{Old base}");
      current = tex("Old base\n\nAgent paragraph.");
      revision = "r2";
      render();
      await expect
        .poll(() => container.querySelector(".scient-latex-visual-recovery-message")?.textContent)
        .toBe("Unsaved changes · keep this document open");
      expect(editor.isEditable).toBe(false);
      expect(container.querySelector(".ProseMirror")?.textContent).toContain("Agent paragraph.");
      expect(localStorage.getItem(slot)).toBe(theirs);
      await page.getByRole("button", { name: "Compare", exact: true }).click();
      await page.getByRole("button", { name: "Use recovered", exact: true }).click();
      await expect.poll(() => current).toContain("\\section{Old base}");
      expect(localStorage.getItem(slot)).toBe(theirs);
    } finally {
      quota.mockRestore();
    }
  });

  it("retains a composing title and its focus when document preparation is refused", async () => {
    let current = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}
\begin{document}
\begin{theorem}[Original title]
Body.
\end{theorem}
\end{document}`;
    const finishing = { current: null as (() => boolean) | null };
    const writes = vi.fn();
    function Harness() {
      const [source, setSource] = useState(current);
      return (
        <LatexVisualEditor
          source={source}
          disabled={false}
          draftKey="browser-statement-test"
          fileRevision="r1"
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          registerFinishEditing={(next) => {
            finishing.current = next;
          }}
          onEdit={(expected, next) => {
            writes(expected, next);
            if (current !== expected) return false;
            current = next;
            setSource(next);
            return true;
          }}
        />
      );
    }
    root.render(<Harness />);
    await expect
      .poll(() => container.querySelector(".scient-latex-statement-title-text"))
      .toBeTruthy();
    const editor = (
      container.querySelector(".scient-latex-visual-document") as HTMLElement & { editor: Editor }
    ).editor;
    let position = -1;
    editor.state.doc.descendants((node, offset) => {
      if (node.type.name === "latexScientific") position = offset;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    editor.commands.setNodeSelection(position);
    await page.getByRole("button", { name: "Edit statement title", exact: true }).click();
    const field = () =>
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Scientific statement title"]',
      );
    await expect.poll(field).toBeTruthy();
    const composing = field()!;
    composing.focus();
    composing.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, composed: true }),
    );
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      composing,
      "Composed title",
    );
    composing.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
    expect(finishing.current?.()).toBe(false);
    expect(field()).toBe(composing);
    expect(document.activeElement).toBe(composing);
    expect(writes).not.toHaveBeenCalled();
    composing.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, composed: true }),
    );
    await expect.poll(() => current).toContain("[Composed title]");
    expect(finishing.current?.()).toBe(true);
  });

  beforeEach(async () => {
    clearVisualDraft("browser-statement-test");
    await page.viewport(1400, 900);
    container = document.createElement("div");
    Object.assign(container.style, { width: "1200px", height: "900px" });
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    clearVisualDraft("browser-statement-test");
  });

  it("keeps PDF fit-width sizing through opening, resizing and a hidden pane", async () => {
    const source =
      "\\documentclass[letterpaper]{article}\n\\begin{document}\n" +
      "A paragraph with enough ordinary text to lay out the editor.\n\n".repeat(35) +
      "\\end{document}";
    const onEdit = vi.fn(() => true);
    root.render(
      <LatexVisualEditor
        draftKey="browser-statement-test"
        fileRevision="r1"
        source={source}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={onEdit}
      />,
    );
    const scroll = () => container.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
    const frame = () => container.querySelector<HTMLElement>(".scient-latex-page-zoom-frame")!;
    await expect.poll(scroll).toBeTruthy();
    const error = () =>
      Math.abs(
        Number.parseFloat(frame().style.width) / 816 - pdfFitWidthScale(scroll().clientWidth, 816)!,
      );
    await expect.poll(error).toBeLessThan(0.00001);
    container.style.width = "780px";
    await expect.poll(error).toBeLessThan(0.00001);
    const width = frame().style.width;
    container.style.display = "none";
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(frame().style.width).toBe(width);
    container.style.width = "1040px";
    container.style.display = "block";
    await expect.poll(error).toBeLessThan(0.00001);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("saves and undoes a compound prose edit without rewriting protected commands", async () => {
    const original =
      "\\documentclass{article}\n\\begin{document}\n" +
      String.raw`Before \protect\textit{italic} and \protect \ref{sec:one} after.` +
      "\n\\end{document}";
    let current = original;
    function Harness() {
      const [source, setSource] = useState(current);
      return (
        <LatexVisualEditor
          draftKey="browser-statement-test"
          fileRevision="r1"
          source={source}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (expected !== current) return false;
            current = next;
            setSource(next);
            return true;
          }}
        />
      );
    }
    root.render(<Harness />);
    const editor = () =>
      (
        container.querySelector(".scient-latex-visual-document") as
          | (HTMLElement & { editor?: Editor })
          | null
      )?.editor;
    await expect.poll(editor).toBeTruthy();
    expect(container.querySelector(".scient-latex-visual-raw")).toBeNull();
    const live = editor()!;
    let italicFrom = -1,
      afterFrom = -1;
    live.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "italic") italicFrom = pos;
      if (node.isText && node.text === " after.") afterFrom = pos;
    });
    expect(italicFrom).toBeGreaterThan(0);
    expect(afterFrom).toBeGreaterThan(italicFrom);
    live.view.dispatch(
      live.state.tr
        .insertText(" ending.", afterFrom, afterFrom + 7)
        .insertText("changed", italicFrom, italicFrom + 6),
    );
    const changed = original.replace("{italic}", "{changed}").replace(" after.", " ending.");
    await expect.poll(() => current).toBe(changed);
    live.commands.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.poll(() => current).toBe(original);
    expect(editor()).toBe(live);
    expect(container.querySelector(".scient-latex-visual-raw")).toBeNull();
  });

  it("retains undo while accepted source revisions arrive during paced typing", async () => {
    const original = "\\documentclass{article}\n\\begin{document}\nBefore words.\n\\end{document}";
    let current = original;
    let revision = 1;
    const editor = () =>
      (
        container.querySelector(".scient-latex-visual-document") as
          | (HTMLElement & { editor?: Editor })
          | null
      )?.editor;
    const acknowledgements: ReturnType<typeof setTimeout>[] = [];
    function Harness() {
      const [host, setHost] = useState({ source: original, revision: "r1" });
      return (
        <LatexVisualEditor
          draftKey="browser-statement-test"
          fileRevision={host.revision}
          source={host.source}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (expected !== current) return false;
            current = next;
            const acknowledgedRevision = `r${++revision}`;
            acknowledgements.push(
              setTimeout(() => setHost({ source: next, revision: acknowledgedRevision }), 150),
            );
            return true;
          }}
        />
      );
    }
    try {
      root.render(<Harness />);
      await expect.poll(editor).toBeTruthy();
      const live = editor()!;
      live.commands.setTextSelection(1);
      live.commands.focus();
      for (let index = 0; index < 12; index++) {
        await userEvent.keyboard("m");
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
      await expect.poll(() => current).toBe(original.replace("Before", "m".repeat(12) + "Before"));
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (let count = 0; count < 12 && current !== original; count++) {
        live.commands.focus();
        await userEvent.keyboard("{Control>}z{/Control}");
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await expect.poll(() => current).toBe(original);
      expect(editor()).toBe(live);
    } finally {
      for (const acknowledgement of acknowledgements) clearTimeout(acknowledgement);
    }
  });

  it.each(["Theorem", "Remark"])("inserts and edits %s through the actual menu", async (name) => {
    let current = "\\documentclass{article}\n\\begin{document}\nBefore\n\\end{document}";
    function Harness() {
      const [text, setText] = useState(current);
      return (
        <LatexVisualEditor
          draftKey="browser-statement-test"
          fileRevision="r1"
          source={text}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (expected !== current) return false;
            current = next;
            setText(next);
            return true;
          }}
        />
      );
    }
    root.render(<Harness />);
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    await page.getByRole("menuitem", { name: "Theorems & proofs", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    const body = page.getByLabelText("Scientific statement body", { exact: true });
    await body.fill("The statement is editable.");
    await expect.poll(() => current).toContain("The statement is editable.");
    await body.fill("The statement is editable. More text.");
    await expect.poll(() => current).toContain("The statement is editable. More text.");
    await page.getByRole("button", { name: "Add statement title", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Scientific statement title", exact: true })
      .fill("Main result");
    await expect.poll(() => current).toContain("\\begin{" + name.toLowerCase() + "}[Main result]");
    expect(container.querySelector(".scient-latex-scientific-structure")).not.toBeNull();
  });

  it("keeps statement bodies and backward selections in place through heading and position updates", async () => {
    const original = String.raw`\documentclass{article}
\usepackage{amsthm}
\newtheorem{theorem}{Theorem}
\begin{document}
Before.
\begin{theorem}[Original title]
Statement first second with \(x^2\).
\end{theorem}
\begin{proof}
Proof body.
\end{proof}
\end{document}`;
    let current = original;
    function Harness() {
      const [source, setSource] = useState(current);
      return (
        <LatexVisualEditor
          draftKey="browser-statement-test"
          fileRevision="r1"
          source={source}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (expected !== current) return false;
            current = next;
            setSource(next);
            return true;
          }}
        />
      );
    }
    root.render(<Harness />);
    const editor = () =>
      (
        container.querySelector(".scient-latex-visual-document") as
          | (HTMLElement & { editor?: Editor })
          | null
      )?.editor;
    await expect.poll(editor).toBeTruthy();
    await expect
      .poll(() => container.querySelectorAll(".scient-latex-scientific-body").length)
      .toBe(2);
    const live = editor()!;
    const statement = container.querySelector<HTMLElement>(
      '.scient-latex-scientific-structure[data-environment="theorem"]',
    )!;
    const body = statement.querySelector<HTMLElement>(
      ".scient-latex-scientific-body > [data-node-view-content-react]",
    )!;
    const proof = container.querySelector<HTMLElement>(
      '.scient-latex-scientific-structure[data-environment="proof"]',
    )!;
    let statementPosition = -1;
    let textPosition = -1;
    live.state.doc.descendants((node, position) => {
      if (node.type.name === "latexScientific" && node.attrs.environment === "theorem")
        statementPosition = position;
      if (node.isText && node.text?.startsWith("Statement first")) textPosition = position;
    });
    expect(statementPosition).toBeGreaterThan(0);
    expect(textPosition).toBeGreaterThan(statementPosition);
    live.view.dispatch(
      live.state.tr.setSelection(
        TextSelection.create(live.state.doc, textPosition + 15, textPosition + 3),
      ),
    );
    live.view.focus();
    const native = document.getSelection()!;
    await expect.poll(() => native.toString()).toBe("tement first");
    const selected = {
      anchor: native.anchorNode,
      focus: native.focusNode,
      anchorOffset: native.anchorOffset,
      focusOffset: native.focusOffset,
    };
    const moved: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      moved.push(...records.filter((record) => [...record.removedNodes].includes(body)));
    });
    observer.observe(container, { childList: true, subtree: true });
    try {
      const node = live.state.doc.nodeAt(statementPosition)!;
      live.view.dispatch(
        live.state.tr.setNodeMarkup(statementPosition, undefined, {
          ...node.attrs,
          title: "Changed title",
          titleSource: null,
        }),
      );
      await expect.poll(() => current).toContain("\\begin{theorem}[Changed title]");
      await expect.poll(() => statement.textContent).toContain("Changed title");
      expect(statement.querySelector(".scient-latex-scientific-body > div")).toBe(body);
      expect(native.anchorNode).toBe(selected.anchor);
      expect(native.focusNode).toBe(selected.focus);
      expect(native.anchorOffset).toBe(selected.anchorOffset);
      expect(native.focusOffset).toBe(selected.focusOffset);
      const transaction = live.state.tr.insertText("Prefix ", 1);
      live.view.dispatch(transaction);
      await expect.poll(() => current).toContain("Prefix Before.");
      expect(statement.querySelector(".scient-latex-scientific-body > div")).toBe(body);
      expect(live.state.selection.anchor).toBe(textPosition + 22);
      expect(live.state.selection.head).toBe(textPosition + 10);
      expect(native.toString()).toBe("tement first");
      expect(proof.dataset.proofEnd).toBe("square");
      expect(proof.querySelector(".scient-latex-scientific-body")?.textContent).toBe("Proof body.");
      expect(moved).toHaveLength(0);
      expect(container.querySelector(".scient-latex-visual-raw")).toBeNull();
    } finally {
      observer.disconnect();
    }
  });

  it("edits the exact source of a scientific block with unsupported commands", async () => {
    const raw =
      "\\begin{theorem}\nFor $u_0 \\in L^2(\\Omega)$, $t \\ge 0$.\n\\custom{Keep}\n\\end{theorem}";
    let current = "\\documentclass{article}\n\\begin{document}\n" + raw + "\n\\end{document}";
    function Harness() {
      const [text, setText] = useState(current);
      return (
        <LatexVisualEditor
          draftKey="browser-statement-test"
          fileRevision="r1"
          source={text}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (expected !== current) return false;
            current = next;
            setText(next);
            return true;
          }}
        />
      );
    }
    root.render(<Harness />);
    await page.getByRole("button", { name: "Edit this block’s LaTeX", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Block LaTeX source", exact: true })
      .fill(raw.replace("t \\ge 0", "t > 0"));
    await page.getByRole("button", { name: "Apply LaTeX", exact: true }).click();
    await expect.poll(() => current).toContain("$t > 0$");
    expect(current).toContain("$u_0 \\in L^2(\\Omega)$");
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

    await expect
      .poll(() => container.querySelector(".scient-latex-toc-preview li:last-child"))
      .toBeTruthy();
    await document.fonts.ready;
    const pageOf = (element: Element) => {
      const sheets = [...container.querySelectorAll<HTMLElement>(".scient-latex-page-sheet")].map(
        (sheet) => sheet.getBoundingClientRect(),
      );
      const bounds = element.getBoundingClientRect();
      return sheets.findIndex(
        (sheet) => bounds.top >= sheet.top - 1 && bounds.bottom <= sheet.bottom + 1,
      );
    };
    const contents = container.querySelector<HTMLElement>(".scient-latex-toc-preview")!;
    const firstSection = [...container.querySelectorAll<HTMLElement>("h1")].find((heading) =>
      heading.textContent?.includes("What Computer Science Research Involves"),
    )!;
    // The compiled article puts the end of this long Contents on page two;
    // its explicit newpage then starts the first section on page three.
    await expect.poll(() => pageOf(firstSection)).toBe(2);
    expect(pageOf(contents.querySelector("li:first-child")!)).toBe(0);
    expect(pageOf(contents.querySelector("li:last-child")!)).toBe(1);

    for (const element of container.querySelectorAll(
      ".scient-latex-visual-document > p, .scient-latex-rich-preview dl > div",
    ))
      expect(pageOf(element), element.textContent ?? element.tagName).toBeGreaterThanOrEqual(0);

    const preview = container.querySelector<HTMLElement>(".scient-latex-math-preview");
    expect(preview).not.toBeNull();
    expect(preview!.getBoundingClientRect().width).toBeGreaterThan(0);
    await userEvent.click(preview!.closest<HTMLElement>(".scient-latex-mathfield")!);
    await expect.poll(() => container.querySelector("math-field")).toBeTruthy();
    const math = container.querySelector("math-field[aria-label='Inline equation']") as
      | (HTMLElement & { value?: string })
      | null;
    expect(math).not.toBeNull();
    expect(math?.value).toContain("\\alpha");
    expect(math!.getBoundingClientRect().width).toBeGreaterThan(0);
  });
});
