import { useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import type { Editor } from "@tiptap/core";
import type { MathfieldElement } from "mathlive";
import { NodeSelection } from "@tiptap/pm/state";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { clearVisualDraft } from "./visualDrafts";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import { latexPaginationKey, setLatexPaginationDimensions } from "./latexVisualPaginationExtension";
import "./scient-latex.css";

let host: HTMLDivElement;
let root: Root;
let source: string;
let replace: (source: string) => void;
let setDisabled: (disabled: boolean) => void;
const draftKey = "synthetic-math-reading-node-qualification";
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
const readers = () => [...host.querySelectorAll<HTMLElement>("[data-math-reading-view]")];
const editor = () => (host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
// A full pass either attaches an inert measurement copy or uses the legacy
// outer-paper flags when an interactive custom editor cannot be copied.
const fullMeasurement = (record: MutationRecord) =>
  record.attributeName === "data-latex-measuring" ||
  [...record.addedNodes].some(
    (node) => node instanceof HTMLElement && node.hasAttribute("data-latex-measurement-snapshot"),
  );
const markup = (element: Element) =>
  element
    .querySelector(".scient-latex-math-preview")
    ?.shadowRoot?.querySelector("[data-math-preview-content]")?.textContent;

afterEach(async () => {
  root?.unmount();
  host?.remove();
  clearVisualDraft(draftKey);
  await frame();
});

async function mount(body: string, preamble = "") {
  await page.viewport(1400, 900);
  source = `\\documentclass{article}\n\\usepackage{amsmath}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}`;
  clearVisualDraft(draftKey);
  host = document.createElement("div");
  host.style.cssText = "width:1200px;height:850px;position:relative;background:white;color:black";
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    const [text, setText] = useState(source);
    const [disabled, updateDisabled] = useState(false);
    useLayoutEffect(() => {
      replace = (next) => {
        source = next;
        setText(next);
      };
      setDisabled = updateDisabled;
    }, []);
    return (
      <LatexVisualEditor
        draftKey={draftKey}
        fileRevision="synthetic-r1"
        source={text}
        disabled={disabled}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(expected, next) => {
          if (expected !== source) return false;
          replace(next);
          return true;
        }}
      />
    );
  }
  root.render(<Harness />);
  await expect.poll(() => readers().length).toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        readers().every((element) =>
          mathReadingPreviewReady(element.querySelector(".scient-latex-math-preview")!),
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await document.fonts.ready;
  await frame();
}

it("reads many formulas without live editors and retains document selection", async () => {
  await mount(Array.from({ length: 64 }, (_, i) => `Paragraph ${i}: $x_${i}+y$.`).join("\n\n"));
  const original = source;
  expect(readers()).toHaveLength(64);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  expect(readers().every((element) => markup(element)?.includes("x"))).toBe(true);
  editor().commands.selectAll();
  await frame();
  expect(host.querySelectorAll("[data-document-selected]")).toHaveLength(64);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  expect(source).toBe(original);
});

it("the first click enters only its formula and native typing can be undone", async () => {
  await mount("Before $a+b+c+d+e+f+g+h$ after.\n\n\\[u+v\\]");
  const original = source;
  const field = readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!;
  await userEvent.click(field);
  await expect
    .poll(() => host.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  const math = host.querySelector<MathfieldElement>("math-field")!;
  await frame();
  expect(readers()).toHaveLength(1);
  expect(host.querySelectorAll("math-field")).toHaveLength(1);
  expect(
    [...host.querySelectorAll(".scient-latex-math-preview")].every(
      (preview) => preview.shadowRoot?.querySelector("[data-math-preview-content]")?.textContent,
    ),
  ).toBe(true);
  // A click in the middle must place the caret there rather than at the end.
  expect(math.position).toBeLessThan(math.lastOffset);
  expect(editor().state.selection).toBeInstanceOf(NodeSelection);
  await userEvent.keyboard("q");
  await expect.poll(() => source).toContain("q");
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.poll(() => source).toBe(original);
  expect(math.hasFocus()).toBe(true);
});

it("macro-only changes and numbering refresh passive views without rewriting source", async () => {
  await mount(
    "Before.\n\n\\begin{equation}\\readingmacro+y\\end{equation}\n\n\\begin{equation}z\\end{equation}",
    "\\newcommand{\\readingmacro}{x}",
  );
  expect(readers().map(markup)[0]).toContain("x");
  expect(
    [...host.querySelectorAll("[data-latex-equation-row]")].map((element) => element.textContent),
  ).toEqual(["(1)", "(2)"]);
  const next = source.replace("{\\readingmacro}{x}", "{\\readingmacro}{w}");
  replace(next);
  await expect.poll(() => readers().map(markup)[0]).toContain("w");
  expect(source).toBe(next);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  const current = editor();
  let first = -1;
  current.state.doc.forEach((node, position) => {
    if (first < 0 && node.type.name === "latexDisplayMath") first = position;
  });
  current.view.dispatch(
    current.state.tr.delete(first, first + current.state.doc.nodeAt(first)!.nodeSize),
  );
  await expect
    .poll(() =>
      [...host.querySelectorAll("[data-latex-equation-row]")].map((element) => element.textContent),
    )
    .toEqual(["(1)"]);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
});

it("read-only formulas stay readable and become editable when enabled", async () => {
  await mount("Before $x+y$ after.\n\n\\[z^2\\]");
  const original = source;
  setDisabled(true);
  await expect.poll(() => editor().isEditable).toBe(false);
  await userEvent.click(readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await frame();
  expect(readers()).toHaveLength(2);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  expect(source).toBe(original);
  setDisabled(false);
  await expect.poll(() => editor().isEditable).toBe(true);
  await userEvent.click(readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect
    .poll(() => host.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  expect(source).toBe(original);
});

it("clicking beside a display returns to prose without initializing math", async () => {
  await mount("Before.\n\n\\[x+y\\]\n\nAfter.");
  const original = source;
  const wrapper = readers()[0]!.querySelector<HTMLElement>(".scient-latex-visual-display-math")!;
  const bounds = wrapper.getBoundingClientRect();
  wrapper.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      composed: true,
      button: 0,
      clientX: bounds.right - 2,
      clientY: (bounds.top + bounds.bottom) / 2,
    }),
  );
  await frame();
  expect(editor().state.selection).not.toBeInstanceOf(NodeSelection);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  await userEvent.keyboard("q");
  await expect.poll(() => source).toContain("qAfter.");
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.poll(() => source).toBe(original);
});

it("pagination keeps its temporary measurement switches outside the editable DOM", async () => {
  await mount("Before $x+y$.\n\n\\newpage\n\nAfter $z^2$.");
  const current = editor();
  const document = current.view.dom;
  const parent = document.parentElement!;
  const observed: MutationRecord[] = [];
  const observer = new MutationObserver((records) => observed.push(...records));
  observer.observe(document.ownerDocument.body, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  try {
    // Start the pass after installing the observer; initial pagination can
    // already have completed while mount() waited for formula previews.
    setLatexPaginationDimensions(
      current.view,
      latexPaginationKey.getState(current.state)!.dimensions,
    );
    await expect.poll(() => document.dataset.latexWindowed).toBe("true");
    await expect.poll(() => observed.some(fullMeasurement)).toBe(true);
    expect(
      observed.filter(
        (record) =>
          record.target === document &&
          /data-latex-(?:column-)?measuring/u.test(record.attributeName ?? ""),
      ),
    ).toHaveLength(0);
    expect(parent.hasAttribute("data-latex-measuring")).toBe(false);
    expect(parent.hasAttribute("data-latex-column-measuring")).toBe(false);
    expect(host.querySelectorAll(".scient-latex-pagination-gap").length).toBeGreaterThan(0);
    expect(readers()).toHaveLength(2);
  } finally {
    observer.disconnect();
  }
});

it("equation tags return to the single-row CSS position after an external row change", async () => {
  const aligned = String.raw`\begin{align}x&=y\\z&=w\end{align}`;
  await mount(`Before.\n\n${aligned}`);
  await expect.poll(() => host.querySelectorAll("[data-latex-equation-row]").length).toBe(2);
  await userEvent.click(readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect
    .poll(() => host.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  await expect
    .poll(() => host.querySelector<HTMLElement>("[data-latex-equation-row]")?.style.top)
    .not.toBe("");
  const next = source.replace(aligned, String.raw`\begin{equation}u=v\end{equation}`);
  replace(next);
  await expect.poll(() => host.querySelectorAll("[data-latex-equation-row]").length).toBe(1);
  await expect
    .poll(() => host.querySelector<HTMLElement>("[data-latex-equation-row]")?.style.top)
    .toBe("");
  const row = host.querySelector<HTMLElement>("[data-latex-equation-row]")!;
  const formula = row.closest<HTMLElement>(".scient-latex-visual-display-math")!;
  const labelBounds = row.getBoundingClientRect();
  const formulaBounds = formula.getBoundingClientRect();
  expect(
    Math.abs(
      labelBounds.top + labelBounds.height / 2 - formulaBounds.top - formulaBounds.height / 2,
    ),
  ).toBeLessThan(1);
  expect(source).toBe(next);
});

it.each(["plain", "mixed fonts"])(
  "local %s wrapping retains the full-layout page map, source and undo",
  async (format) => {
    const prose = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const formatted =
      format === "plain"
        ? prose
        : prose
            .replace("word100 word101", String.raw`\textbf{word100 word101}`)
            .replace("word200 word201", String.raw`\textit{word200 word201}`);
    await mount(`Before $x+y$.\n\n${formatted}\n\nAfter $z^2$.`);
    const current = editor();
    await expect.poll(() => current.view.dom.dataset.latexWindowed).toBe("true");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const dimensions = { pageHeight: 320, pageGap: 28, marginTop: 36, marginBottom: 36 };
    setLatexPaginationDimensions(current.view, dimensions);
    const map = () => JSON.stringify(latexPaginationKey.getState(current.state)?.pages);
    await expect
      .poll(() => latexPaginationKey.getState(current.state)?.pages.at(-1)?.page)
      .toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const original = source;
    const originalMap = map();
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    try {
      // Use an explicit position within the long paragraph so the browser viewport
      // does not choose the surrounding formula when clicking across page gaps.
      let position = 0;
      current.state.doc.forEach((node, offset) => {
        if (node.type.name === "paragraph" && node.textContent === prose) position = offset + 1;
      });
      current.commands.focus(position + prose.length);
      current.commands.insertContent(" additional wrapping words ".repeat(12));
      await expect.poll(() => source.length).toBeGreaterThan(original.length);
      await expect.poll(map).not.toBe(originalMap);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const localMap = map();
      expect(changes.filter(fullMeasurement)).toHaveLength(0);
      changes.length = 0;
      // An unchanged dimension request deliberately invalidates all natural-flow
      // caches, providing an independent full-DOM layout for the same document.
      setLatexPaginationDimensions(current.view, dimensions);
      await expect.poll(() => changes.some(fullMeasurement)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(map()).toBe(localMap);
      expect(readers()).toHaveLength(2);
      expect(host.querySelectorAll("math-field")).toHaveLength(0);
      current.commands.undo();
      await expect.poll(() => source, { timeout: 5000 }).toBe(original);
      await expect.poll(map).toBe(originalMap);
    } finally {
      observer.disconnect();
    }
  },
);

it("native prose typing retains local layout beside a title and paginated statements", async () => {
  const prose = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  await mount(
    `\\maketitle\n\nOrdinary prose to edit.\n\n\\begin{theorem}${prose} $x+y$\\end{theorem}\n\n\\begin{theorem}${prose} $z^2$\\end{theorem}`,
    "\\title{Synthetic title}\\author{Synthetic author}\\newtheorem{theorem}{Theorem}",
  );
  const current = editor();
  const dimensions = { pageHeight: 320, pageGap: 28, marginTop: 36, marginBottom: 36 };
  setLatexPaginationDimensions(current.view, dimensions);
  await expect.poll(() => current.view.dom.dataset.latexWindowed).toBe("true");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const map = () => JSON.stringify(latexPaginationKey.getState(current.state)?.pages);
  const original = source;
  const originalMap = map();
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => changes.push(...records));
  observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  try {
    let position = 0;
    current.state.doc.forEach((node, offset) => {
      if (node.type.name === "paragraph" && node.textContent === "Ordinary prose to edit.")
        position = offset + 1 + node.content.size;
    });
    current.commands.focus(position);
    await userEvent.keyboard(" Additional prose.");
    await expect.poll(() => source).toContain(" Additional prose.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const localMap = map();
    expect(changes.filter(fullMeasurement)).toHaveLength(0);
    changes.length = 0;
    setLatexPaginationDimensions(current.view, dimensions);
    await expect.poll(() => changes.some(fullMeasurement)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(map()).toBe(localMap);
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.poll(() => source, { timeout: 5000 }).toBe(original);
    await expect.poll(map).toBe(originalMap);
    // Later genuine object resizes and preview events must still invalidate the
    // snapshot. This prevents the initial-observation optimization hiding them.
    const title = current.view.nodeDOM(0) as HTMLElement;
    changes.length = 0;
    try {
      title.style.minHeight = `${title.offsetHeight + 40}px`;
      await expect.poll(() => changes.some(fullMeasurement)).toBe(true);
    } finally {
      title.style.removeProperty("min-height");
    }
    await expect.poll(map).toBe(originalMap);
    changes.length = 0;
    readers()[0]!.dispatchEvent(new Event("scient-latex-math-preview", { bubbles: true }));
    await expect.poll(() => changes.some(fullMeasurement)).toBe(true);
    expect(source).toBe(original);
  } finally {
    observer.disconnect();
  }
});

it("structural paragraph edits retain full layout and editable math", async () => {
  await mount("Before.\n\n$x+y$\n\nAfter.");
  const current = editor();
  await expect.poll(() => current.view.dom.dataset.latexWindowed).toBe("true");
  await new Promise((resolve) => setTimeout(resolve, 700));
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => changes.push(...records));
  observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  try {
    current.commands.setTextSelection(4);
    current.commands.splitBlock();
    await expect.poll(() => changes.some(fullMeasurement)).toBe(true);
    await expect.poll(() => source).toContain("Bef\n\nore");
    await userEvent.click(readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await expect
      .poll(() => host.querySelector<MathfieldElement>("math-field")?.hasFocus())
      .toBe(true);
  } finally {
    observer.disconnect();
  }
});
