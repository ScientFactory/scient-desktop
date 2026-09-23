// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Test the actual ProseMirror transaction/save boundary. MathLive's native
// shadow-DOM keyboard is checked in the running desktop, not simulated here.
vi.mock("./LatexMathField", () => ({
  LatexMathField: ({ value }: { value: string }) => <span>{value}</span>,
}));
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { mathSourceCompletions } from "./latexMathCompletion";

describe("writing editor source transactions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let current: string;
  const writes = vi.fn();
  const tex = (body: string) =>
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    writes.mockReset();
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  function editor(): Editor {
    return (container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  }
  async function mount(body = "Hello") {
    current = tex(body);
    function Harness() {
      const [source, setSource] = useState(current);
      return (
        <LatexVisualEditor
          draftKey="synthetic-editor-test"
          fileRevision="r1"
          source={source}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (current !== expected) return false;
            writes(expected, next);
            current = next;
            setSource(next);
            return true;
          }}
        />
      );
    }
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("does not write on mount; spaces, Enter and undo save real source", async () => {
    await mount();
    expect(writes).not.toHaveBeenCalled();
    await act(async () => {
      editor().commands.setTextSelection(6);
      editor().commands.insertContent(" world");
    });
    expect(current).toBe(tex("Hello world"));
    await act(async () => {
      editor().commands.splitBlock();
    });
    expect(current).toContain("Hello world\n\n\\par");
    await act(async () => {
      editor().commands.insertContent("Next");
    });
    expect(current).toContain("Hello world\n\nNext");
    await act(async () => {
      editor().commands.undo();
    });
    expect(current).not.toContain("Next");
    await act(async () => {
      editor().commands.redo();
    });
    expect(current).toContain("Next");
  });

  it("applies toolbar formatting and inserts math without a build", async () => {
    await mount();
    await act(async () => {
      editor().commands.setTextSelection({ from: 1, to: 6 });
      editor().commands.toggleBold();
    });
    expect(current).toContain("\\textbf{Hello}");
    await act(async () => {
      editor().commands.setTextSelection(6);
      editor().commands.insertContent({ type: "latexInlineMath", attrs: { tex: "x^2" } });
    });
    expect(current).toContain("\\(x^2\\)");
  });

  it("opens complete math source without replacing the rendered equation", async () => {
    await mount("Inline $x^2$ here");
    const equation = container.querySelector(".scient-latex-visual-inline-math") as HTMLElement;
    await act(async () => equation.click());
    const source = container.querySelector(
      "textarea[aria-label='Complete LaTeX equation source']",
    ) as HTMLTextAreaElement;
    expect(source.value).toBe("$x^2$");
    expect(container.textContent).toContain("x^2");
    expect(document.body.querySelector("[aria-label='Math tools']")).not.toBeNull();
    expect(document.body.querySelector("[aria-label='Fraction']")).not.toBeNull();
  });

  it("changes a display wrapper from the compact source popover", async () => {
    await mount("\\[\nx^2\n\\]");
    const equation = container.querySelector(".scient-latex-visual-display-math") as HTMLElement;
    await act(async () => equation.click());
    const type = container.querySelector<HTMLSelectElement>("select[aria-label='Equation type']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        type,
        "environment:equation",
      );
      type.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(current).toContain("\\begin{equation}\nx^2\n\\end{equation}");
  });

  it("changes centered math to a standalone inline formula", async () => {
    await mount("\\[\nx^2\n\\]");
    const equation = container.querySelector(".scient-latex-visual-display-math") as HTMLElement;
    await act(async () => equation.click());
    const type = container.querySelector<HTMLSelectElement>("select[aria-label='Equation type']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        type,
        "inline-paren",
      );
      type.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(current).toBe(tex("\\(x^2\\)"));
  });

  it("offers bounded command and environment completions", () => {
    expect(mathSourceCompletions("\\[\n\\fra", 7)[0]).toMatchObject({
      label: "\\frac",
      replacement: "\\frac{}{}",
    });
    expect(mathSourceCompletions("\\[\n\\begin{ali", 13)[0]).toMatchObject({
      label: "\\begin{align}",
      replacement: "\\begin{align}\n\n\\end{align}",
    });
  });

  it("converts a completely typed supported math environment", async () => {
    await mount("Replace me");
    const matrix = "\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}";
    await act(async () => {
      editor().commands.selectAll();
      editor().commands.insertContent(matrix);
    });
    expect(editor().getJSON().content?.[0]?.type).toBe("latexDisplayMath");
    expect(current).toContain(`\\[\n${matrix}\n\\]`);
  });

  it("edits description and table structures without opening source", async () => {
    await mount(`\\begin{description}[style=nextline]
\\item[Algorithms] Design and prove algorithms.
\\item[Complexity] Study computational limits.
\\end{description}

\\begin{table}
\\caption{Research options.}
\\begin{tabular}{ll}
Area & Evidence \\\\
Theory & Proofs \\\\
\\end{tabular}
\\end{table}`);
    expect(container.querySelectorAll(".scient-latex-rich-preview")).toHaveLength(2);
    expect(container.querySelector(".scient-latex-visual-raw")).toBeNull();
    expect(container.textContent).toContain("Editable structure");
    const descriptionLabel = container.querySelector<HTMLInputElement>(
      "input[aria-label='Description item 1 label']",
    )!;
    const descriptionBody = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Description item 1 body']",
    )!;
    expect(descriptionLabel.value).toBe("Algorithms");
    expect(descriptionBody.value).toBe("Design and prove algorithms.");
    expect(
      container.querySelector<HTMLInputElement>("input[aria-label='Table caption']")?.value,
    ).toBe("Research options.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        descriptionLabel,
        "Algorithms & proofs",
      );
      descriptionLabel.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        descriptionBody,
        "Design verified algorithms.",
      );
      descriptionBody.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current).toContain("\\item[Algorithms \\& proofs] Design verified algorithms.");
    const caption = container.querySelector<HTMLInputElement>("input[aria-label='Table caption']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        caption,
        "Research areas & evidence.",
      );
      caption.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current).toContain("\\caption{Research areas \\& evidence.}");
    const evidence = container.querySelector<HTMLInputElement>(
      "input[aria-label='Table row 2 column 2']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        evidence,
        "Verified proofs",
      );
      evidence.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current).toContain("Theory & Verified proofs");
    expect(
      container.querySelector<HTMLInputElement>("input[aria-label='Table row 2 column 2']"),
    ).toBe(evidence);
    const addRow = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "+ Row",
    )!;
    await act(async () => addRow.click());
    expect(current).toContain(" &  \\\\");
    expect(container.querySelector("input[aria-label='Table row 3 column 1']")).not.toBeNull();
    const addColumn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "+ Column",
    )!;
    await act(async () => addColumn.click());
    expect(container.querySelector("input[aria-label='Table row 1 column 3']")).not.toBeNull();
    const style = container.querySelector<HTMLSelectElement>("select[aria-label='Table style']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        style,
        "grid",
      );
      style.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(current).toContain("\\hline");
    const reference = container.querySelector<HTMLInputElement>(
      "input[aria-label='Table reference label']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        reference,
        "tab:research",
      );
      reference.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current).toContain("\\label{tab:research}");
  });

  it("inserts a table from the document toolbar picker", async () => {
    await mount("Before");
    const tableSummary = container.querySelector<HTMLElement>(
      "summary[aria-label='Insert table']",
    )!;
    await act(async () => tableSummary.click());
    const insert = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Insert 3 by 4 table']",
    )!;
    await act(async () => insert.click());
    expect(current).toContain("\\begin{table}[htbp]");
    expect(current).toContain("\\begin{tabular}");
    expect(container.querySelector("input[aria-label='Table row 3 column 4']")).not.toBeNull();
  });

  it("inserts and edits theorem-like scientific statements", async () => {
    await mount("Before");
    const insertion = container.querySelector<HTMLSelectElement>(
      "select[aria-label='Insert scientific statement']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        insertion,
        "claim",
      );
      insertion.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const title = container.querySelector<HTMLInputElement>(
      "input[aria-label='Scientific statement title']",
    )!;
    const body = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Scientific statement body']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        title,
        "Central claim",
      );
      title.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        body,
        "The visual source remains authoritative.",
      );
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current).toContain("\\newtheorem{claim}{Claim}");
    expect(current).toContain("\\begin{claim}[Central claim]");
    expect(current).toContain("The visual source remains authoritative.");
  });

  it("inserts, edits and deletes a visual figure", async () => {
    await mount("Before");
    const figure = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Figure",
    )!;
    await act(async () => figure.click());
    expect(current).toContain("\\usepackage{graphicx}");
    const path = container.querySelector<HTMLInputElement>(
      "input[aria-label='Figure image path']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        path,
        "images/result.png",
      );
      path.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current).toContain("\\includegraphics[width=0.8\\textwidth]{images/result.png}");
    const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Delete figure",
    )!;
    await act(async () => remove.click());
    expect(current).not.toContain("\\begin{figure}");
  });

  it("inserts a source-backed reference from the writing toolbar", async () => {
    await mount("Target \\label{sec:target}");
    const key = container.querySelector<HTMLInputElement>(
      "input[aria-label='Reference or citation key']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        key,
        "sec:target",
      );
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const insert = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Insert" && !button.disabled,
    )!;
    await act(async () => insert.click());
    expect(current).toContain("\\ref{sec:target}");
  });

  it("rejects a destructive transaction spanning protected source", async () => {
    await mount("Hello\n\n\\custom{keep}");
    const before = current;
    await act(async () => {
      editor().commands.selectAll();
      editor().commands.deleteSelection();
    });
    expect(current).toBe(before);
    expect(container.textContent).toContain("Use Edit LaTeX");
  });

  it("discards obsolete undo history when external source is adopted", async () => {
    const renderEditor = (source: string) => (
      <LatexVisualEditor
        draftKey="synthetic-editor-test"
        fileRevision="external-test"
        source={source}
        disabled={false}
        onEdit={(expected, next) => {
          writes(expected, next);
          return true;
        }}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
      />
    );
    await act(async () => {
      root.render(renderEditor(tex("Hello")));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      editor().commands.insertContent("Old ");
    });
    expect(editor().can().undo()).toBe(true);
    const external = tex("External replacement");
    await act(async () => {
      root.render(renderEditor(external));
    });
    expect(editor().getText()).toBe("External replacement");
    expect(editor().can().undo()).toBe(false);
  });
});
