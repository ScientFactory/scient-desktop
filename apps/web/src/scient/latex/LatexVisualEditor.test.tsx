// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act as reactAct, useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Test the actual ProseMirror transaction/save boundary. MathLive's native
// shadow-DOM keyboard is checked in the running desktop, not simulated here.
vi.mock("./LatexMathField", () => ({
  LatexMathField: ({ value, ref }: { value: string; ref: Ref<unknown> }) => {
    useImperativeHandle(ref, () => ({
      flush: () => true,
      focus: () => {},
      clearSelection: () => {},
    }));
    return <span>{value}</span>;
  },
}));
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { mathSourceCompletions } from "./latexMathCompletion";
import { clearVisualDraft } from "./visualDrafts";
import { clearTypingDraft } from "./visualTyping";
import { scientificStatementsFixture } from "./scientificStatements.fixture";
import { projectLatexVisualDocument } from "./latexVisualDocument";
import { latexFigureSource } from "./figureSource";

// Wait for the editor's paint-delayed conversion and source publication.
const act = async (callback: () => unknown) =>
  reactAct(async () => {
    await callback();
    await new Promise((resolve) => setTimeout(resolve, 320));
  });

describe("writing editor source transactions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let current: string;
  const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  const writes = vi.fn();
  const tex = (body: string) =>
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    writes.mockReset();
    clearVisualDraft("synthetic-editor-test");
    clearTypingDraft("synthetic-editor-test");
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearVisualDraft("synthetic-editor-test");
    clearTypingDraft("synthetic-editor-test");
    if (originalGetAnimations)
      Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  function editor(): Editor {
    return (container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  }
  async function insertMenuItem(name: string) {
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
    );
    const find = () =>
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent?.trim() === name,
      );
    if (!find()) {
      const search = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Search insert options"]',
      )!;
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          name,
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const item = find();
    expect(item).toBeDefined();
    await act(() => item!.click());
    await act(() => {});
  }
  async function setField(
    field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
  ) {
    expect(field).not.toBeNull();
    await act(() => {
      field.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(
        new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
      );
    });
    await act(() => field.blur());
  }
  async function selectOption(label: string, optionLabel: string) {
    const trigger = document.body.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
    expect(trigger).not.toBeNull();
    const details = trigger.closest("details");
    if (details && !details.open) await act(() => details.querySelector("summary")!.click());
    await act(() => trigger.click());
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === optionLabel,
    );
    expect(option, optionLabel).toBeDefined();
    await act(() => option!.click());
  }
  async function selectKind(kind: string) {
    let position = -1;
    editor().state.doc.descendants((node, offset) => {
      if (node.attrs.kind === kind || node.type.name === kind) position = offset;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    await act(() => editor().commands.setNodeSelection(position));
    return position;
  }
  async function mount(body = "Hello", preamble = "") {
    current = tex(body).replace("\\begin{document}", preamble + "\\begin{document}");
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

  it("keeps writing tools in one permanent row and reader controls in the footer", async () => {
    await mount();
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    expect(
      [...toolbar.querySelectorAll("[data-dock-group]")].map((group) =>
        group.getAttribute("data-dock-group"),
      ),
    ).toEqual(["history", "style", "format", "lists", "math", "insert", "document"]);
    expect(toolbar.querySelector('button[aria-label="Style: Text"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Hide formatting tools"]')).toBeNull();
    expect(toolbar.querySelector('input[aria-label="Page number"]')).toBeNull();
    expect(
      container.querySelector('.scient-latex-reader-footer input[aria-label="Page number"]'),
    ).not.toBeNull();
    expect(container.querySelector(".scient-latex-document-tools")).toBeNull();
    const context = container.querySelector(".scient-latex-context-tools")!;
    expect(context.previousElementSibling?.getAttribute("aria-label")).toBe("Fit width");
    expect(context.nextElementSibling?.getAttribute("aria-label")).toMatch(/^Search Document/);
    expect(context.querySelector(".scient-latex-context-tools-slot")).not.toBeNull();
    expect(container.querySelector('[aria-label="Selected object properties"]')).toBeNull();
  });

  it("puts plain-text shortcut help under Document without extra More actions", async () => {
    await mount();
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    expect(toolbar.querySelector('button[aria-label="More actions"]')).toBeNull();
    await act(() =>
      toolbar.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
    );
    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const shortcuts = items.find((item) => item.textContent?.trim() === "Keyboard shortcuts");
    expect(shortcuts).toBeDefined();
    expect(shortcuts!.querySelector("svg")).toBeNull();
    expect(
      items.some((item) =>
        /Open LaTeX source|Next source-only block/u.test(item.textContent ?? ""),
      ),
    ).toBe(false);
    await act(() => shortcuts!.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "Writing shortcuts",
    );
  });
  it("moves lower-priority writing groups into More on narrow panes", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute("role") === "toolbar" ? 230 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-dock-reserved") ? 36 : 70;
    });
    await mount();
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    expect(toolbar.querySelector('[data-dock-group="style"]')).not.toBeNull();
    expect(toolbar.querySelector('[data-dock-group="history"]')).toBeNull();
    await act(() =>
      toolbar.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!.click(),
    );
    const menuItems = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
    ];
    for (const label of [
      "Undo",
      "Redo",
      "Bulleted list",
      "Theorems & proofs",
      "Page layout\u2026",
      "Keyboard shortcuts",
    ])
      expect(
        menuItems.some((item) => item.textContent?.trim() === label),
        label,
      ).toBe(true);
  });

  it.each([false, true])(
    "opens and applies an existing theorem's exact source after insertion=%s",
    async (insertBefore) => {
      const raw =
        "\\begin{theorem}[Energy estimate and decay]\nAssume \\eqref{eq:bc} and $u_0 \\in L^2(\\Omega)$.\n\\[\\|u(t)\\|^2 \\le \\|u_0\\|^2\\]\n\\custom{Keep}\n\\end{theorem}";
      await mount(raw);
      if (insertBefore)
        await act(() =>
          editor().commands.insertContentAt(0, {
            type: "paragraph",
            content: [{ type: "text", text: "Before" }],
          }),
        );
      const block = container.querySelector<HTMLElement>(".scient-latex-visual-raw pre")!;
      expect(block.textContent).toBe(raw);
      await act(() => block.click());
      const source = container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Block LaTeX source']",
      );
      expect(source).not.toBeNull();
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          source,
          raw.replace("Assume", "Suppose"),
        );
        source!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const apply = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Apply LaTeX",
      );
      expect(apply).toBeDefined();
      await act(() => apply!.click());
      expect(current).toContain(raw.replace("Assume", "Suppose"));
      if (insertBefore) expect(current).toContain("Before");
    },
  );

  it("edits prose and nested equations in the supplied theorem/proof/remark document", async () => {
    const marker = "\\begin{document}";
    const body = scientificStatementsFixture
      .slice(
        scientificStatementsFixture.indexOf(marker) + marker.length,
        scientificStatementsFixture.lastIndexOf("\\end{document}"),
      )
      .trim();
    await mount(body);
    expect(container.querySelectorAll(".scient-latex-scientific-structure")).toHaveLength(4);
    expect(container.querySelector(".scient-latex-visual-raw")).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    const before = current;
    let prose = -1;
    editor().state.doc.descendants((node, position) => {
      if (node.isText && node.text?.startsWith("Assume")) prose = position;
    });
    expect(prose).toBeGreaterThan(0);
    await act(() => {
      editor().commands.setTextSelection(prose);
      editor().commands.insertContent("We ");
    });
    expect(current).toBe(before.replace("Assume", "We Assume"));
    let math = -1;
    editor().state.doc.descendants((node, position) => {
      if (node.type.name === "latexDisplayMath" && String(node.attrs.tex).includes("\\sup"))
        math = position;
    });
    await act(() => {
      editor().commands.setNodeSelection(math);
      editor().commands.updateAttributes("latexDisplayMath", {
        tex: String(editor().state.doc.nodeAt(math)!.attrs.tex).replace("\\sup", "\\max"),
      });
    });
    expect(current).toBe(before.replace("Assume", "We Assume").replace("\\sup", "\\max"));
    await act(() => editor().commands.undo());
    expect(current).toBe(before.replace("Assume", "We Assume"));
  });

  it("splits a paragraph inside a theorem while keeping its environment", async () => {
    await mount("\\begin{theorem}[Result]\nFirst second\n\\end{theorem}");
    await act(() => {
      editor().commands.setTextSelection(7);
      editor().commands.splitBlock();
    });
    expect(editor().state.doc.firstChild!.type.name).toBe("latexScientific");
    expect(editor().state.doc.firstChild!.childCount).toBe(2);
    expect(current).toContain("\\begin{theorem}[Result]\nFirst\n\n second\n\\end{theorem}");
  });

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

  it("inserts a source-backed explicit page break", async () => {
    await mount("First page");
    await insertMenuItem("Page break");
    expect(current).toContain("\\newpage");
    expect(
      editor()
        .getJSON()
        .content?.some((node) => node.attrs?.kind === "pagebreak"),
    ).toBe(true);
  });

  it("zooms the fixed paper without changing LaTeX", async () => {
    await mount("Stable page");
    await act(() => container.querySelector<HTMLButtonElement>(".scient-pdf-zoom-label")!.click());
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="Zoom out"]')!.click(),
    );
    expect(
      container
        .querySelector<HTMLElement>(".scient-latex-page-stage")
        ?.style.getPropertyValue("transform"),
    ).toBe("scale(0.95)");
    expect(writes).not.toHaveBeenCalled();
  });

  it("shows editable front matter and marks only starred headings as unnumbered", async () => {
    current = `\\documentclass{article}
\\title{Research Guide}
\\author{Nati}
\\date{2026}
\\begin{document}
\\maketitle

\\section{Introduction}

\\subsection*{Scope}
\\end{document}
`;
    function Harness() {
      const [source, setSource] = useState(current);
      return (
        <LatexVisualEditor
          draftKey="synthetic-front-matter-test"
          fileRevision="r1"
          source={source}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (current !== expected) return false;
            current = next;
            setSource(next);
            return true;
          }}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const title = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Document title']",
    )!;
    expect(title.value).toBe("Research Guide");
    expect(container.querySelector("h1")?.hasAttribute("data-latex-unnumbered")).toBe(false);
    expect(container.querySelector("h2")?.hasAttribute("data-latex-unnumbered")).toBe(true);
    await setField(title, "A Better Guide");
    expect(current).toContain("\\title{A Better Guide}");
    await act(async () => title.focus());
    const removeAuthor = container.querySelector<HTMLInputElement>(
      ".scient-latex-title-author-toggle input",
    )!;
    await act(async () => removeAuthor.click());
    expect(current).toContain("\\author{}");
    expect(container.querySelector("textarea[aria-label='Document author']")).toBeNull();
    await selectOption("Title date", "Date: Hidden");
    expect(current).toContain("\\date{}");
    expect(container.querySelector("textarea[aria-label='Document date']")).toBeNull();
  });

  it("opens formula source without replacing the rendered equation", async () => {
    await mount("Inline $x^2$ here");
    await selectKind("latexInlineMath");
    const equation = container.querySelector(".scient-latex-visual-inline-math") as HTMLElement;
    await act(async () => equation.click());
    const sourceButton = document.body.querySelector<HTMLButtonElement>(
      ".scient-latex-math-bar-source",
    )!;
    await act(async () => sourceButton.click());
    const source = container.querySelector(
      "textarea[aria-label='LaTeX formula code']",
    ) as HTMLTextAreaElement;
    expect(source.value).toBe("x^2");
    expect(container.textContent).toContain("x^2");
    expect(document.body.querySelector("[aria-label='Math tools']")).not.toBeNull();
    expect(document.body.querySelector("[aria-label='Edit formula as LaTeX']")).not.toBeNull();
  });

  it("changes a display wrapper from the compact source popover", async () => {
    await mount("\\[\nx^2\n\\]");
    await selectKind("latexDisplayMath");
    const equation = container.querySelector(".scient-latex-visual-display-math") as HTMLElement;
    await act(async () => equation.click());
    await act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Math tools"] [data-latex-number-toggle]')!
        .click(),
    );
    expect(current).toContain("\\begin{equation}\nx^2\n\\end{equation}");
  });

  it("changes centered math to a standalone inline formula", async () => {
    await mount("\\[\nx^2\n\\]");
    await selectKind("latexDisplayMath");
    const equation = container.querySelector(".scient-latex-visual-display-math") as HTMLElement;
    await act(async () => equation.click());
    await selectOption("Equation placement", "Inline math");
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

  it("edits prose and inserts both kinds of math inside an abstract", async () => {
    await mount("\\begin{abstract}\nAbstract text.\n\\end{abstract}");
    const host = container.querySelector('[aria-label="Abstract"]');
    expect(host?.closest('[contenteditable="false"]')).toBeNull();
    let position = 0;
    editor().state.doc.descendants((node, at) => {
      if (node.type.name === "paragraph") position = at + 1;
    });
    await act(() =>
      editor()
        .chain()
        .setTextSelection(position)
        .insertContent({ type: "latexInlineMath", attrs: { tex: "x", wrapper: "paren" } })
        .run(),
    );
    await act(() =>
      editor().commands.insertContentAt(editor().state.doc.firstChild!.nodeSize - 1, {
        type: "latexDisplayMath",
        attrs: { tex: "a=b", wrapper: "bracket" },
      }),
    );
    expect(current).toContain("\\(x\\)Abstract text.");
    expect(current).toMatch(/\\\[\s*a=b\s*\\\]/u);
    expect(current.match(/\\begin\{abstract\}/g)).toHaveLength(1);
    expect(projectLatexVisualDocument(current).rawBlocks).toBe(0);
  });

  it("routes the Math menu to the caret inside a table cell and shares document undo", async () => {
    await mount("\\begin{tabular}{ll}\nBefore after & Keep\\\\\n\\end{tabular}");
    const field = container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    expect(inner).toBeDefined();
    await act(() => inner.chain().focus().setTextSelection(8).run());
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Math"]')!.click(),
    );
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
    ].find((item) => item.textContent?.trim() === "Inline math");
    expect(option).toBeDefined();
    await act(() => option!.click());
    let position = -1;
    inner.state.doc.descendants((node, at) => {
      if (node.type.name === "latexInlineMath") position = at;
    });
    expect(position).toBeGreaterThan(0);
    await act(() =>
      inner.view.dispatch(
        inner.state.tr.setNodeMarkup(position, undefined, { tex: "q^2", wrapper: "paren" }),
      ),
    );
    expect(current).toContain("Before \\(q^2\\)after & Keep");
    expect(editor().state.doc.childCount).toBe(1);
    expect(projectLatexVisualDocument(current).rawBlocks).toBe(0);
    await act(() => editor().commands.undo());
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
  });

  it("expands a cell's Select All to the whole table and restores a deleted table with undo", async () => {
    await mount("\\begin{tabular}{ll}\nOne & Two\\\\\n\\end{tabular}");
    const field = container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    await act(() => inner.chain().focus().selectAll().run());
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    const table = container.querySelector<HTMLElement>('[data-table-selection="whole"]');
    expect(table).not.toBeNull();
    await act(() =>
      table!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      ),
    );
    expect(current).not.toContain("\\begin{tabular}");
    await act(() => editor().commands.undo());
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
    expect(current).toContain("One & Two");
  });

  it("retains rapid edits in different table cells", async () => {
    await mount("\\begin{tabular}{ll}\nOne & Two\\\\\n\\end{tabular}");
    const fields = [...container.querySelectorAll<HTMLElement>("[data-table-cell]")].map(
      (field) => (field as HTMLElement & { editor: Editor }).editor,
    );
    await act(() => {
      fields[0]!.chain().selectAll().insertContent("First").run();
      fields[1]!.chain().selectAll().insertContent("Second").run();
    });
    expect(current).toContain("First & Second");
  });

  it("clears a rectangular selection of rich cells and restores it without another table", async () => {
    await mount("\\begin{tabular}{ll}\nAlpha & Text $x$\\\\\nKeep & Last\\\\\n\\end{tabular}");
    const field = container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    await act(() => inner.commands.focus("end"));
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const table = container.querySelector<HTMLElement>('[data-table-selection="cells"]');
    expect(table).not.toBeNull();
    await act(() =>
      table!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      ),
    );
    expect(editor().state.doc.firstChild!.attrs.rows).toEqual([
      ["", ""],
      ["Keep", "Last"],
    ]);
    await act(() => editor().commands.undo());
    expect(editor().state.doc.firstChild!.attrs.rows).toEqual([
      ["Alpha", "Text $x$"],
      ["Keep", "Last"],
    ]);
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
    await act(() => inner.commands.focus("end"));
    expect(container.querySelector("[data-table-selection]")).toBeNull();
    expect(inner.state.selection.empty).toBe(true);
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
    const descriptionLabel = container.querySelector<HTMLInputElement>(
      "input[aria-label='Description item 1 label']",
    )!;
    const descriptionBody = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Description item 1 body']",
    )!;
    expect(descriptionLabel.value).toBe("Algorithms");
    expect(descriptionBody.value).toBe("Design and prove algorithms.");
    await setField(descriptionLabel, "Algorithms & proofs");
    await setField(descriptionBody, "Design verified algorithms.");
    expect(current).toContain("\\item[Algorithms \\& proofs] Design verified algorithms.");
    await selectKind("table");
    const caption = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Table caption']",
    )!;
    expect(caption.value).toBe("Research options.");
    await setField(caption, "Research areas & evidence.");
    expect(current).toContain("\\caption{Research areas \\& evidence.}");
    const evidence = container.querySelector<HTMLElement>(
      "[contenteditable][aria-label='Table row 2 column 2']",
    )!;
    const fieldEditor = (evidence as HTMLElement & { editor: Editor }).editor;
    await act(() => fieldEditor.chain().focus().selectAll().insertContent("Verified proofs").run());
    expect(current).toContain("Theory & Verified proofs");
    expect(container.querySelector("[contenteditable][aria-label='Table row 2 column 2']")).toBe(
      evidence,
    );
    const addRow = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Insert row below",
    )!;
    await act(async () => addRow.click());
    expect(current).toContain(" &  \\\\");
    expect(
      container.querySelector("[contenteditable][aria-label='Table row 3 column 1']"),
    ).not.toBeNull();
    const addColumn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Insert column right",
    )!;
    await act(async () => addColumn.click());
    expect(
      container.querySelector("[contenteditable][aria-label='Table row 1 column 3']"),
    ).not.toBeNull();
    await selectOption("Table style", "Full grid");
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
    await insertMenuItem("Table");
    const insert = document.body.querySelector<HTMLElement>(
      "[data-scient-table-size-cell-row='3'][data-scient-table-size-cell-column='4']",
    )!;
    await act(async () => insert.click());
    await act(() => {});
    expect(current).toContain("\\begin{table}[htbp]");
    expect(current).toContain("\\begin{tabular}");
    expect(
      container.querySelector("[contenteditable][aria-label='Table row 3 column 4']"),
    ).not.toBeNull();
  });

  it("inserts and edits theorem-like scientific statements", async () => {
    await mount("Before");
    await insertMenuItem("Claim");
    const position = await selectKind("latexScientific");
    const title = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Scientific statement title']",
    )!;
    await setField(title, "Central claim");
    await act(() => {
      const statement = editor().state.doc.nodeAt(position)!;
      editor().commands.setTextSelection({
        from: position + 2,
        to: position + statement.nodeSize - 2,
      });
      editor().commands.insertContent("The visual source remains authoritative.");
    });
    expect(current).toContain("\\newtheorem{claim}{Claim}");
    expect(current).toContain("\\begin{claim}[Central claim]");
    expect(current).toContain("The visual source remains authoritative.");
  });

  it("inserts, edits and deletes a visual figure", async () => {
    await mount("Before");
    const figure = latexFigureSource({
      documentPath: "main.tex",
      assetPath: "images/image.png",
      source: current,
    });
    await act(() =>
      editor().commands.insertContent(projectLatexVisualDocument(tex(figure)).content.content!),
    );
    expect(current).toContain("\\usepackage{graphicx}");
    await selectKind("figure");
    const path = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Figure image path']",
    )!;
    await setField(path, "images/result.png");
    expect(current).toContain("\\includegraphics[width=0.8\\textwidth]{images/result.png}");
    const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Delete figure",
    )!;
    await act(async () => remove.click());
    expect(current).not.toContain("\\begin{figure}");
  });

  it("inserts a source-backed reference from the writing toolbar", async () => {
    await mount("Target \\label{sec:target}");
    await insertMenuItem("Cross-reference\u2026");
    const key = document.body.querySelector<HTMLInputElement>(
      ".scient-writing-reference-key input",
    )!;
    await setField(key, "sec:target");
    await act(() =>
      key.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await act(() => {});
    expect(current).toContain("\\ref{sec:target}");
  });

  it("provides a compact writing toolbar and collapsed document outline", async () => {
    await mount("\\section{Methods}\nThe method remains editable.");
    expect(container.querySelector("button[aria-label='Insert']")).not.toBeNull();
    expect(container.querySelector("[aria-label='Document navigation']")).toBeNull();
    const outline = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Show Document sidebar']",
    )!;
    await act(() => outline.click());
    await act(() =>
      [...container.querySelectorAll<HTMLButtonElement>(".scient-latex-navigation-tabs button")]
        .find((button) => button.textContent === "Outline")!
        .click(),
    );
    expect(container.querySelector("[aria-label='Document navigation']")?.textContent).toContain(
      "Methods",
    );
  });

  it("moves a paragraph into the title and undoes the complete source change", async () => {
    await mount("Energy estimate\n\nBody stays here");
    const original = current;
    await act(() => editor().commands.setTextSelection(1));
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
    );
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Use paragraph as title…",
    )!;
    await act(() => item.click());
    expect(current).toContain("\\title{Energy estimate}");
    expect(current).toContain("\\maketitle");
    expect(current.match(/Energy estimate/gu)).toHaveLength(1);
    const titled = current;
    await act(() => editor().commands.undo());
    expect(current).toBe(original);
    await act(() => editor().commands.redo());
    expect(current).toBe(titled);
  });
  it("editing a title never silently inserts a printed title block", async () => {
    await mount("Body", "\\title{Existing metadata}\n");
    const original = current;
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
    );
    const titleGroup = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Title & authors",
    )!;
    await act(() => titleGroup.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Edit title",
    )!;
    await act(() => item.click());
    expect(current).toBe(original);
    expect(current).not.toContain("\\maketitle");
  });

  it("rejects a destructive transaction spanning protected source", async () => {
    await mount("Hello\n\n\\custom{keep}");
    const before = current;
    await act(async () => {
      editor().commands.selectAll();
      editor().commands.deleteSelection();
    });
    expect(current).toBe(before);
    expect(container.textContent).toContain("source was left unchanged");
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

  it("keeps the body caret after an external source change so typing cannot replace the title", async () => {
    const titled = (body: string) =>
      `\\documentclass{article}\n\\title{Keep this title}\n\\begin{document}\n\\maketitle\n\n${body}\n\\end{document}\n`;
    const renderEditor = (source: string) => (
      <LatexVisualEditor
        draftKey="synthetic-title-selection-test"
        fileRevision="external-title-test"
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
    await act(async () => root.render(renderEditor(titled("First paragraph"))));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    let bodyPosition = -1;
    editor().state.doc.descendants((node, position) => {
      if (node.isText && node.text?.includes("First paragraph")) bodyPosition = position + 5;
    });
    expect(bodyPosition).toBeGreaterThan(0);
    await act(async () => editor().commands.setTextSelection(bodyPosition));

    const external = titled("Changed paragraph");
    await act(async () => root.render(renderEditor(external)));
    expect(editor().getText()).toContain("Changed paragraph");
    expect(editor().state.selection.empty).toBe(true);
    expect(editor().state.selection.$from.parent.type.name).toBe("paragraph");
    await act(async () => editor().commands.insertContent("X"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(writes).toHaveBeenCalledWith(external, expect.stringContaining("\\maketitle"));
    expect(writes.mock.lastCall?.[1]).toContain("\\title{Keep this title}");
    expect(writes.mock.lastCall?.[1]).toContain("ChangXed paragraph");
  });

  it("edits labelled equation math while retaining numbering and refusing new outer rows", async () => {
    await mount("\\begin{align}\n  x &= y \\label{eq:first} \\\\\n  a &= b \\notag\n\\end{align}");
    const before = current;
    expect(editor().state.doc.firstChild?.type.name).toBe("latexDisplayMath");
    await act(async () => {
      editor().commands.setNodeSelection(0);
      editor().commands.updateAttributes("latexDisplayMath", {
        tex: String(editor().state.doc.firstChild!.attrs.tex).replace("x &=", "z &="),
      });
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(current).toBe(before.replace("x &=", "z &="));
    const saved = current;
    const math = editor().state.doc.firstChild!.attrs.tex;
    await act(async () => {
      editor().commands.updateAttributes("latexDisplayMath", { tex: math + " \\\\ q = r" });
    });
    expect(editor().state.doc.firstChild!.attrs.tex).toBe(math);
    expect(current).toBe(saved);
  });
});
