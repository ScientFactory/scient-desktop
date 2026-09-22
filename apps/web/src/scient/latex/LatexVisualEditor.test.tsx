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

  it("renders protected descriptions and tables instead of raw source", async () => {
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
    expect(container.textContent).toContain("Algorithms");
    expect(container.textContent).toContain("Design and prove algorithms.");
    expect(container.textContent).toContain("Research options.");
    expect(container.querySelectorAll(".scient-latex-rich-preview")).toHaveLength(2);
    expect(container.querySelector(".scient-latex-visual-raw")).toBeNull();
    expect(container.textContent).toContain("Editable cells");
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
