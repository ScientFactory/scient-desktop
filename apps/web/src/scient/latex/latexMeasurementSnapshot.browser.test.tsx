import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vite-plus/test";
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
  createLatexMeasurementSnapshot,
  type LatexMeasurementGeometry,
} from "./latexMeasurementSnapshot";
import { measureLatexDocument } from "./latexVisualPaginationExtension";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import "./scient-latex.css";

let root: Root;
let host: HTMLElement;
let editor: Editor;
const key = "measurement-snapshot-native-source-preservation";
const input = String.raw`\documentclass{article}
\usepackage{amsmath,amsthm}
\newtheorem{theorem}{Theorem}
\begin{document}
\section{Geometry and marks}
Text with \textbf{bold words} and \emph{italic words}. ${"Words which wrap naturally. ".repeat(14)}

Prose before \(x^2+\frac{1}{y}\) and after. ${"More words around inline mathematics. ".repeat(5)}
\begin{theorem}[A nested statement]
The first paragraph flows beside the heading. ${"An assumption on the process. ".repeat(8)}
\[C=\frac{1}{2}\log(1+\frac{a^2}{1+b^2})\]
The paragraph after the result. ${"A conclusion with several words. ".repeat(8)}
\end{theorem}
\begin{tabular}{|l|r|}\hline Item & Value\\\hline First & 1\\Second & 2\\\hline\end{tabular}
\begin{verbatim}
literal code and spaces
  indentation retained
\end{verbatim}
\clearpage
\subsection{After the break}
Last paragraph with \(\hat{x}+y\) and more words.
\end{document}`;

afterEach(() => {
  root?.unmount();
  host?.remove();
  clearVisualDraft(key);
});

async function open() {
  clearVisualDraft(key);
  await page.viewport(1400, 900);
  host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;width:1050px;height:820px";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <LatexVisualEditor
      draftKey={key}
      fileRevision="snapshot-r1"
      source={input}
      disabled={false}
      onEditingChange={() => {}}
      onOpenSource={() => {}}
      onEdit={() => {
        throw Error("Measurement must not edit source");
      }}
    />,
  );
  await expect
    .poll(
      () =>
        (host.querySelector(".scient-latex-visual-document") as HTMLElement & { editor?: Editor })
          ?.editor,
    )
    .toBeTruthy();
  editor = (host.querySelector(".scient-latex-visual-document") as HTMLElement & { editor: Editor })
    .editor;
  await expect
    .poll(
      () =>
        [...editor.view.dom.querySelectorAll(".scient-latex-math-preview")].every(
          mathReadingPreviewReady,
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function collect(geometry?: LatexMeasurementGeometry) {
  const measured = measureLatexDocument(
    editor.view,
    new WeakMap(),
    { pageHeight: 1056, pageGap: 28, marginTop: 96, marginBottom: 96 },
    new WeakMap(),
    () => false,
    [],
    [],
    geometry,
  );
  let next = measured.next();
  while (!next.done) next = measured.next();
  return next.value;
}

it("matches live natural geometry with mathematical shadows and preserves the native caret", async () => {
  await open();
  const doc = editor.state.doc;
  editor.commands.setTextSelection(36);
  editor.view.focus();
  const native = document.getSelection()!;
  const selection = { node: native.anchorNode, offset: native.anchorOffset };
  const scope = editor.view.dom.parentElement!;
  scope.dataset.latexMeasuring = "true";
  scope.dataset.latexMeasureVisible = "true";
  let expected: ReturnType<typeof collect>;
  try {
    expected = collect();
  } finally {
    delete scope.dataset.latexMeasuring;
    delete scope.dataset.latexMeasureVisible;
  }
  const snapshot = await createLatexMeasurementSnapshot(editor.view, async () => true);
  expect(snapshot).not.toBeNull();
  try {
    const actual = collect(snapshot!);
    expect(actual.map((unit) => unit.position)).toEqual(expected.map((unit) => unit.position));
    expect(actual.map((unit) => unit.keepWithNext)).toEqual(
      expected.map((unit) => unit.keepWithNext),
    );
    for (const [index, unit] of actual.entries()) {
      expect(Math.abs(unit.top - expected[index]!.top)).toBeLessThan(1);
      expect(Math.abs(unit.bottom - expected[index]!.bottom)).toBeLessThan(1);
    }
    const preview = snapshot!.root.querySelector(".scient-latex-math-preview")!;
    expect(preview.shadowRoot?.querySelector("[data-math-preview-content]")?.textContent).toContain(
      "x",
    );
    expect(scope.hasAttribute("data-latex-measuring")).toBe(false);
    expect(native.anchorNode).toBe(selection.node);
    expect(native.anchorOffset).toBe(selection.offset);
    expect(editor.state.doc).toBe(doc);
    expect(snapshot!.root.closest<HTMLElement>("[data-latex-measurement-snapshot]")!.inert).toBe(
      true,
    );
  } finally {
    snapshot!.destroy();
  }
}, 20000);

it("measures prepared mounted content naturally instead of its paginated offscreen fallback", async () => {
  await open();
  const model = editor.state.doc;
  const paragraph = editor.view.dom.querySelector<HTMLElement>("p")!;
  const display = editor.view.dom.querySelector<HTMLElement>(".scient-latex-visual-display-math")!;
  const wrapper = display.closest<HTMLElement>(".node-latexDisplayMath")!;
  const scale =
    editor.view.dom.getBoundingClientRect().width /
    Number.parseFloat(getComputedStyle(editor.view.dom).width);
  const expectedParagraphHeight = paragraph.getBoundingClientRect().height / scale;
  const expectedDisplayHeight = display.getBoundingClientRect().height / scale;
  editor.view.dom.dataset.latexWindowed = "true";
  for (const node of [paragraph, wrapper]) {
    node.dataset.latexViewport = "mounted";
    node.dataset.latexViewportPrepared = "true";
  }
  // The reading fallback includes page spacing, which must be absent from
  // natural measurement even when Chromium would skip this offscreen subtree.
  paragraph.style.setProperty("--scient-latex-block-height", "1000px");
  display.style.setProperty("--scient-latex-block-height", "500px");
  const snapshot = await createLatexMeasurementSnapshot(editor.view, async () => true);
  expect(snapshot).not.toBeNull();
  try {
    const copiedParagraph = snapshot!.root.querySelector<HTMLElement>("p")!;
    const copiedDisplay = snapshot!.root.querySelector<HTMLElement>(
      ".scient-latex-visual-display-math",
    )!;
    expect(getComputedStyle(copiedParagraph).contentVisibility).toBe("visible");
    expect(getComputedStyle(copiedDisplay).contentVisibility).toBe("visible");
    expect(
      Math.abs(copiedParagraph.getBoundingClientRect().height - expectedParagraphHeight),
    ).toBeLessThan(1);
    expect(
      Math.abs(copiedDisplay.getBoundingClientRect().height - expectedDisplayHeight),
    ).toBeLessThan(1);
    expect(editor.state.doc).toBe(model);
  } finally {
    snapshot!.destroy();
  }
}, 20000);

it("cancels batched construction without attaching a partial snapshot or moving selection", async () => {
  await open();
  const original = editor.view.dom.innerHTML;
  const doc = editor.state.doc;
  const paragraph = editor.view.dom.querySelector("p")!;
  const extra = document.createElement("span");
  extra.contentEditable = "false";
  for (let i = 0; i < 12000; i++) extra.append(document.createElement("span"));
  paragraph.append(extra);
  try {
    let yielded = false;
    const result = await createLatexMeasurementSnapshot(editor.view, async () => {
      yielded = true;
      return false;
    });
    expect(yielded).toBe(true);
    expect(result).toBeNull();
    expect(
      document.querySelectorAll("[data-latex-measurement-snapshot]").length,
    ).toBeLessThanOrEqual(1);
  } finally {
    extra.remove();
  }
  // A rejected snapshot changes no source-owned DOM; only our explicit fixture
  // insertion was removed. Automatic pagination may update its decorations.
  expect(editor.state.doc.textContent).toContain("Geometry and marks");
  expect(editor.state.doc).toBe(doc);
  expect(original).toContain("Geometry and marks");
}, 20000);

it("preserves an active math editor without constructing a second field", async () => {
  await open();
  await userEvent.click(editor.view.dom.querySelector<HTMLElement>("p .scient-latex-mathfield")!);
  await expect
    .poll(() => editor.view.dom.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  const field = editor.view.dom.querySelector<MathfieldElement>("math-field")!;
  const value = field.value;
  const doc = editor.state.doc;
  expect(await createLatexMeasurementSnapshot(editor.view, async () => true)).toBeNull();
  expect(editor.view.dom.querySelectorAll("math-field")).toHaveLength(1);
  expect(editor.view.dom.querySelector("math-field")).toBe(field);
  expect(field.hasFocus()).toBe(true);
  expect(field.value).toBe(value);
  expect(editor.state.doc).toBe(doc);
}, 20000);
