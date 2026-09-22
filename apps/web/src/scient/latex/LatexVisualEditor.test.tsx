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
