import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { AllSelection, EditorState, TextSelection } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import { EditorView } from "@tiptap/pm/view";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import type { MathfieldElement } from "mathlive";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { clearVisualDraft } from "./visualDrafts";
import {
  latexViewportContext,
  latexViewportMeasurement,
  presentLatexViewportPages,
  recordLatexViewportMeasurement,
  finishLatexViewportMeasurements,
} from "./latexViewport";
import {
  drawLatexPagePreview,
  measureLatexPagePreview,
  latexPagePreviewStyles,
} from "./latexPagePreview";
import { latexPaginationKey } from "./latexVisualPaginationExtension";
import {
  configureScientMarkdownSearch,
  clearScientMarkdownSearch,
  scientMarkdownSearchState,
} from "../markdownEditor/prosemirror/search";
import "./scient-latex.css";

const key = "browser-viewport-source-preservation";
const paragraphs = Array.from(
  { length: 48 },
  (_, index) =>
    `Paragraph ${index + 1}. ${"Words which wrap across the available width. ".repeat(index === 20 ? 32 : 6)} ` +
    String.raw`Inline formula \(x_{${index + 1}}^2+\frac{1}{y}\).` +
    (index === 47 ? " UniqueLastDestination." : ""),
);
const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
${paragraphs.join("\n\n")}
\end{document}`;
let container: HTMLDivElement;
let root: Root;
let current: string;
beforeEach(async () => {
  clearVisualDraft(key);
  await page.viewport(1300, 900);
  container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:1000px;height:800px";
  document.body.append(container);
  root = createRoot(container);
  current = source;
});
afterEach(() => {
  window.dispatchEvent(new Event("afterprint"));
  root.unmount();
  container.remove();
  clearVisualDraft(key);
});

async function open(input = source) {
  current = input;
  function Harness() {
    const [value, setValue] = useState(current);
    return (
      <LatexVisualEditor
        draftKey={key}
        fileRevision="r1"
        source={value}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(expected, next) => {
          if (expected !== current) return false;
          current = next;
          setValue(next);
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
    .poll(() => container.querySelectorAll("[data-latex-viewport-closed]").length)
    .toBeGreaterThan(20);
  return editor()!;
}

async function prepared(editor: Editor) {
  await expect
    .poll(() => editor.view.dom.dataset.latexViewportPending, { timeout: 30000 })
    .toBe("0");
  await expect
    .poll(() => latexPaginationKey.getState(editor.state)?.pages.length, { timeout: 10000 })
    .toBeGreaterThan(48);
}

it("keeps geometry contexts current when a shared paragraph's ancestors or first-child role change", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      text: { group: "inline" },
      paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
      blockquote: {
        group: "block",
        content: "block+",
        attrs: { indent: { default: 0 } },
        toDOM: () => ["blockquote", 0],
      },
    },
  });
  const paragraph = schema.nodes.paragraph!.create(null, schema.text("Shared content"));
  const quote = schema.nodes.blockquote!.create(null, paragraph);
  const view = new EditorView(container, {
    state: EditorState.create({ schema, doc: schema.nodes.doc!.create(null, quote) }),
  });
  try {
    const first = latexViewportContext(view, paragraph, 1);
    expect(latexViewportContext(view, paragraph, 1)).toBe(first);
    view.updateState(view.state.apply(view.state.tr.setNodeMarkup(0, undefined, { indent: 1 })));
    expect(view.state.doc.nodeAt(1)).toBe(paragraph);
    const indented = latexViewportContext(view, paragraph, 1);
    expect(indented).not.toBe(first);
    const preceding = schema.nodes.paragraph!.create(null, schema.text("Before"));
    view.updateState(view.state.apply(view.state.tr.insert(1, preceding)));
    const position = 1 + preceding.nodeSize;
    expect(view.state.doc.nodeAt(position)).toBe(paragraph);
    expect(latexViewportContext(view, paragraph, position)).not.toBe(indented);
    expect(latexViewportContext(view, preceding, 1)).toBe(indented);
  } finally {
    view.destroy();
  }
});

it("measures progressively admitted offscreen blocks in bounded cohorts", async () => {
  const batches: number[] = [];
  container.addEventListener("scient-latex-viewport-measure", (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    if (Array.isArray(detail)) batches.push(detail.length);
  });
  const editor = await open();
  const model = editor.state.doc;
  await prepared(editor);
  expect(batches.some((size) => size > 4)).toBe(true);
  expect(Math.max(...batches)).toBeLessThanOrEqual(16);
  expect(editor.state.doc).toBe(model);
  expect(current).toBe(source);
  expect(container.querySelector("math-field")).toBeNull();
}, 45000);

it("invalidates distant geometry when a built-in font changes with an empty font shorthand", async () => {
  const editor = await open();
  await prepared(editor);
  await document.fonts.ready;
  const model = editor.state.doc;
  const position = model.content.size - model.lastChild!.nodeSize;
  const node = model.lastChild!;
  const measurement = latexViewportMeasurement(editor.view, node, position);
  const context = latexViewportContext(editor.view, node, position);
  const before = getComputedStyle(editor.view.dom);
  const family = before.fontFamily;
  const size = before.fontSize;
  const lineHeight = before.lineHeight;
  expect(before.font).toBe("");
  expect(measurement).not.toBeNull();
  const paper = container.querySelector<HTMLElement>(".scient-latex-visual-paper")!;
  paper.style.setProperty("--scient-latex-font-family", "monospace");
  const changed = getComputedStyle(editor.view.dom);
  expect(changed.fontFamily).not.toBe(family);
  expect(changed.font).toBe("");
  expect(changed.fontSize).toBe(size);
  expect(changed.lineHeight).toBe(lineHeight);
  editor.view.dom.dispatchEvent(new CustomEvent("scient-latex-math-preview", { bubbles: true }));
  await expect
    .poll(() => latexViewportContext(editor.view, node, position), { timeout: 10000 })
    .not.toBe(context);
  await prepared(editor);
  expect(latexViewportMeasurement(editor.view, node, position)).not.toBe(measurement);
  expect(editor.state.doc).toBe(model);
  expect(current).toBe(source);
}, 45000);

it("preserves untouched offscreen text and the native caret when one paragraph is remeasured", async () => {
  const editor = await open();
  await prepared(editor);
  const doc = editor.state.doc;
  const lastPosition = doc.content.size - doc.lastChild!.nodeSize;
  const last = editor.view.nodeDOM(lastPosition) as HTMLElement;
  expect(last.hasAttribute("data-latex-viewport-closed")).toBe(true);
  const accessible = last.querySelector(".scient-latex-viewport-accessible")!;
  const text = accessible.firstChild;
  editor.commands.setTextSelection(5);
  editor.view.focus();
  const selection = document.getSelection()!;
  const anchorNode = selection.anchorNode;
  const anchorOffset = selection.anchorOffset;
  const measurement = latexViewportMeasurement(editor.view, doc.firstChild!, 0)!;
  expect(measurement).not.toBeNull();
  recordLatexViewportMeasurement(editor.view, doc.firstChild!, 0, {
    ...measurement,
    height: measurement.height + 0.25,
  });
  finishLatexViewportMeasurements(editor.view);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(editor.view.nodeDOM(lastPosition)).toBe(last);
  expect(accessible.firstChild).toBe(text);
  expect(selection.anchorNode).toBe(anchorNode);
  expect(selection.anchorOffset).toBe(anchorOffset);
  expect(editor.state.doc).toBe(doc);
  expect(current).toBe(source);
}, 45000);

it("retains prepared geometry while Visual is hidden and resumes with current typography", async () => {
  const editor = await open();
  await prepared(editor);
  const doc = editor.state.doc;
  const position = doc.content.size - doc.lastChild!.nodeSize;
  const node = doc.lastChild!;
  const context = latexViewportContext(editor.view, node, position);
  const measurement = latexViewportMeasurement(editor.view, node, position);
  expect(measurement).not.toBeNull();
  const hidden = new Promise<void>((resolve) => {
    const observer = new ResizeObserver((entries) => {
      if (
        entries.some((entry) => entry.target === editor.view.dom && entry.contentRect.width === 0)
      ) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(editor.view.dom);
  });
  container.style.display = "none";
  await hidden;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(latexViewportContext(editor.view, node, position)).toBe(context);
  expect(latexViewportMeasurement(editor.view, node, position)).toBe(measurement);
  expect(editor.view.dom.dataset.latexViewportPending).toBe("0");
  const paper = container.querySelector<HTMLElement>(".scient-latex-visual-paper")!;
  paper.style.setProperty("--scient-latex-font-family", "monospace");
  editor.view.dom.dispatchEvent(new CustomEvent("scient-latex-math-preview", { bubbles: true }));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(latexViewportContext(editor.view, node, position)).toBe(context);
  container.style.display = "flex";
  await expect.poll(() => latexViewportContext(editor.view, node, position)).not.toBe(context);
  await prepared(editor);
  expect(latexViewportMeasurement(editor.view, node, position)).not.toBe(measurement);
  expect(editor.state.doc).toBe(doc);
  expect(current).toBe(source);
}, 45000);

it("retains the full model, exact source and native caret while mounting only nearby paragraphs", async () => {
  const editor = await open(),
    original = editor.state.doc;
  expect(original.childCount).toBe(48);
  let formulas = 0;
  original.descendants((node) => {
    if (node.type.name === "latexInlineMath") formulas++;
  });
  expect(formulas).toBe(48);
  await prepared(editor);
  await expect
    .poll(() => container.querySelectorAll(".scient-latex-math-preview").length)
    .toBeLessThan(48);
  expect(
    container.querySelector<HTMLElement>(".scient-latex-visual-scroll")!.clientHeight,
  ).toBeLessThan(800);
  expect(container.querySelector("math-field")).toBeNull();
  expect(current).toBe(source);

  let idleTransactions = 0;
  const idle = () => {
    idleTransactions++;
  };
  editor.on("transaction", idle);
  await new Promise((resolve) => setTimeout(resolve, 500));
  editor.off("transaction", idle);
  expect(idleTransactions).toBeLessThan(12);

  const firstParagraph = editor.view.nodeDOM(0);
  editor.view.dispatch(editor.state.tr.insertText("FIRST ", 1));
  editor.commands.setTextSelection(
    editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize + 6,
  );
  expect(editor.view.nodeDOM(0)).toBe(firstParagraph);
  editor.commands.undo();
  await expect.poll(() => current).toBe(source);
  expect(editor.state.doc.eq(original)).toBe(true);

  const position = original.content.size - original.lastChild!.nodeSize;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position + 6)),
  );
  const paragraph = editor.view.nodeDOM(position) as HTMLElement;
  expect(paragraph.hasAttribute("data-latex-viewport-closed")).toBe(false);
  editor.view.focus();
  const selection = document.getSelection()!;
  expect(editor.view.posAtDOM(selection.anchorNode!, selection.anchorOffset)).toBe(position + 6);
  editor.view.dispatch(editor.state.tr.insertText("ADDED "));
  await expect.poll(() => current).toBe(source.replace("Paragraph 48", "ParagADDED raph 48"));
  editor.commands.undo();
  await expect.poll(() => current).toBe(source);
  expect(editor.state.doc.eq(original)).toBe(true);
  expect(editor.view.dom.querySelectorAll("[data-latex-viewport-closed]").length).toBeGreaterThan(
    20,
  );

  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  const transfer = new DataTransfer();
  editor.view.dom.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
  const copied = transfer.getData("text/plain");
  expect(copied).toContain("Paragraph 1.");
  expect(copied).toContain("UniqueLastDestination.");
  expect(copied.match(/Inline formula/gu)?.length).toBe(48);
  expect(current).toBe(source);
}, 45000);

it("admits an immediately clicked distant equation and keeps the active math editor mounted", async () => {
  const input = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
${Array.from({ length: 36 }, (_, index) => `Paragraph ${index + 1}.\n\n` + String.raw`\[x_{${index + 1}}^2+\frac{1}{y}\]`).join("\n\n")}
\end{document}`;
  const editor = await open(input);
  const doc = editor.state.doc;
  const position = doc.content.size - doc.lastChild!.nodeSize;
  const closed = editor.view.nodeDOM(position) as HTMLElement;
  expect(closed.hasAttribute("data-latex-viewport-closed")).toBe(true);
  const viewport = container.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
  // Dispatch in the same turn as the jump, before the intersection callback can
  // mount the destination. This covers the old opaque-DOM caret race.
  viewport.scrollTop +=
    closed.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 200;
  const box = closed.getBoundingClientRect();
  closed.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      composed: true,
      cancelable: true,
      pointerId: 41,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );
  document.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 41,
      pointerType: "mouse",
      button: 0,
      buttons: 0,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );
  await expect
    .poll(() => container.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  const field = container.querySelector<MathfieldElement>("math-field")!;
  expect(editor.state.doc).toBe(doc);
  expect(current).toBe(input);
  viewport.scrollTop = 0;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(container.querySelector("math-field")).toBe(field);
  expect(field.hasFocus()).toBe(true);
  field.position = field.lastOffset;
  await userEvent.keyboard("+z");
  await expect
    .poll(() => current)
    .toBe(
      input.replace(String.raw`\[x_{36}^2+\frac{1}{y}\]`, String.raw`\[x_{36}^2+\frac{1}{y}+z\]`),
    );
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.poll(() => current).toBe(input);
  expect(editor.state.doc.eq(doc)).toBe(true);
}, 45000);

it("mounts an offscreen search destination and preserves the page map through eager print rendering", async () => {
  const editor = await open();
  await prepared(editor);
  const doc = editor.state.doc;
  const pages = latexPaginationKey.getState(editor.state)!.pages;
  const lastPosition = doc.content.size - doc.lastChild!.nodeSize;
  expect(
    (editor.view.nodeDOM(lastPosition) as HTMLElement).hasAttribute("data-latex-viewport-closed"),
  ).toBe(true);
  editor.view.dispatch(
    configureScientMarkdownSearch(editor.state.tr, {
      query: "UniqueLastDestination",
      caseSensitive: true,
      wholeWord: true,
    }),
  );
  expect(scientMarkdownSearchState(editor.state).matches).toHaveLength(1);
  expect(
    (editor.view.nodeDOM(lastPosition) as HTMLElement).hasAttribute("data-latex-viewport-closed"),
  ).toBe(false);
  expect(
    editor.view.dom.querySelector('[data-scient-markdown-search-match="active"]')?.textContent,
  ).toBe("UniqueLastDestination");
  editor.view.dispatch(clearScientMarkdownSearch(editor.state.tr));

  window.dispatchEvent(new Event("beforeprint"));
  expect(editor.view.dom.querySelector("[data-latex-viewport-closed]")).toBeNull();
  await expect.poll(() => container.querySelectorAll(".scient-latex-math-preview").length).toBe(48);
  await expect
    .poll(() => latexPaginationKey.getState(editor.state)!.pages, { timeout: 10000 })
    .toEqual(pages);
  expect(editor.state.doc).toBe(doc);
  expect(current).toBe(source);
  window.dispatchEvent(new Event("afterprint"));
  await expect
    .poll(() => editor.view.dom.querySelectorAll("[data-latex-viewport-closed]").length)
    .toBeGreaterThan(20);
  expect(editor.state.doc).toBe(doc);
}, 45000);

it("retains the displayed document height when mounting already prepared offscreen content", async () => {
  const input = String.raw`\documentclass{article}
\usepackage{amsmath,amsthm}
\newtheorem{theorem}{Theorem}
\begin{document}
${Array.from(
  { length: 36 },
  (_, index) => String.raw`\begin{theorem}
Short paragraph ${index}.
\[x_${index}^2+1\]
Short concluding paragraph.
\end{theorem}`,
).join("\n\n")}
\end{document}`;
  const editor = await open(input);
  await prepared(editor);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const model = editor.state.doc;
  const pages = latexPaginationKey.getState(editor.state)!.pages;
  const before = editor.view.dom.getBoundingClientRect().height;
  window.dispatchEvent(new Event("beforeprint"));
  await expect
    .poll(() => editor.view.dom.querySelectorAll(".scient-latex-math-preview").length)
    .toBe(36);
  await expect
    .poll(
      () =>
        [...editor.view.dom.querySelectorAll(".scient-latex-math-preview")].every(
          (node) =>
            node.hasAttribute("data-math-preview-ready") ||
            node.shadowRoot?.firstElementChild?.hasAttribute("data-math-preview-ready"),
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 700));
  // Read the displayed layout directly. A temporary natural-flow switch can
  // hide incorrect content-visibility fallback sizes in the actual paper.
  expect(Math.abs(editor.view.dom.getBoundingClientRect().height - before)).toBeLessThan(1);
  expect(latexPaginationKey.getState(editor.state)!.pages).toEqual(pages);
  expect(editor.state.doc).toBe(model);
  expect(current).toBe(input);
  window.dispatchEvent(new Event("afterprint"));
  await expect
    .poll(() => editor.view.dom.dataset.latexViewportPending, { timeout: 10000 })
    .toBe("0");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(Math.abs(editor.view.dom.getBoundingClientRect().height - before)).toBeLessThan(1);
  expect(latexPaginationKey.getState(editor.state)!.pages).toEqual(pages);
  expect(editor.state.doc).toBe(model);
  expect(current).toBe(input);
}, 45000);

it("renders a distant thumbnail page without changing the reading position or retaining its editors", async () => {
  const editor = await open();
  await prepared(editor);
  const doc = editor.state.doc,
    placements = latexPaginationKey.getState(editor.state)!.pages;
  const lastPosition = doc.content.size - doc.lastChild!.nodeSize;
  const lastPage = Math.max(...placements.map((placement) => placement.page)) + 1;
  const viewport = container.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
  const top = viewport.scrollTop;
  await expect
    .poll(() => presentLatexViewportPages(editor.view, new Set([lastPage]), placements))
    .toBe(true);
  expect(
    (editor.view.nodeDOM(lastPosition) as HTMLElement).hasAttribute("data-latex-viewport-closed"),
  ).toBe(false);
  const stage = container.querySelector<HTMLElement>(".scient-latex-page-stage")!;
  const measured = measureLatexPagePreview(stage)!;
  const preview = document.createElement("div"),
    shadow = preview.attachShadow({ mode: "open" });
  document.body.append(preview);
  try {
    shadow.adoptedStyleSheets = [latexPagePreviewStyles(document)];
    drawLatexPagePreview(shadow, measured, lastPage, 816, 1056, 28);
    expect(shadow.textContent).toContain("UniqueLastDestination");
    expect(shadow.querySelector("[data-math-preview-content]")?.textContent).toContain("x");
    expect(shadow.querySelector("[data-latex-viewport-closed]")).toBeNull();
    expect(viewport.scrollTop).toBe(top);
    expect(container.querySelector("math-field")).toBeNull();
    expect(editor.state.doc).toBe(doc);
    expect(current).toBe(source);
  } finally {
    preview.remove();
    presentLatexViewportPages(editor.view, new Set(), []);
  }
  await expect
    .poll(() =>
      (editor.view.nodeDOM(lastPosition) as HTMLElement).hasAttribute("data-latex-viewport-closed"),
    )
    .toBe(true);
}, 45000);

it("keeps nested statement spacing and page placements identical when equation views close", async () => {
  const input = String.raw`\documentclass{article}
\usepackage{amsmath,amsthm}
\newtheorem{theorem}{Theorem}
\begin{document}
${Array.from(
  { length: 28 },
  (_, index) => String.raw`\begin{theorem}
Statement ${index + 1}. ${"A condition on the Gaussian system. ".repeat(4)}
\[C_{${index}}=\frac{1}{2}\log(1+\frac{a^2}{1+b^2})\]
${"The concluding paragraph follows the displayed result. ".repeat(5)}
\end{theorem}`,
).join("\n\n")}
\end{document}`;
  const editor = await open(input);
  await prepared(editor);
  const doc = editor.state.doc;
  const measure = () => {
    const scope = editor.view.dom.parentElement!;
    scope.dataset.latexMeasuring = "true";
    scope.dataset.latexMeasureVisible = "true";
    try {
      const origin = editor.view.dom.getBoundingClientRect().top;
      const scale =
        editor.view.dom.getBoundingClientRect().width /
        Number.parseFloat(getComputedStyle(editor.view.dom).width);
      const geometry: { position: number; height: number; top: number }[] = [];
      doc.forEach((_node, position) => {
        const box = (editor.view.nodeDOM(position) as HTMLElement).getBoundingClientRect();
        geometry.push({ position, height: box.height / scale, top: (box.top - origin) / scale });
      });
      return geometry;
    } finally {
      delete scope.dataset.latexMeasuring;
      delete scope.dataset.latexMeasureVisible;
    }
  };
  const closed = measure();
  const placements = latexPaginationKey.getState(editor.state)!.pages;
  window.dispatchEvent(new Event("beforeprint"));
  await expect
    .poll(() =>
      [...editor.view.dom.querySelectorAll(".scient-latex-math-preview")].every(
        (element) =>
          element.hasAttribute("data-math-preview-ready") ||
          element.shadowRoot?.firstElementChild?.hasAttribute("data-math-preview-ready"),
      ),
    )
    .toBe(true);
  const eager = measure();
  for (const [index, item] of eager.entries()) {
    expect(Math.abs(item.height - closed[index]!.height)).toBeLessThan(0.2);
    expect(Math.abs(item.top - closed[index]!.top)).toBeLessThan(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(latexPaginationKey.getState(editor.state)!.pages).toEqual(placements);
  expect(editor.state.doc).toBe(doc);
  expect(current).toBe(input);
}, 45000);
