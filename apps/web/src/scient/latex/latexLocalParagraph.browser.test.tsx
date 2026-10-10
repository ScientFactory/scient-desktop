import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import type { MathfieldElement } from "mathlive";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { clearVisualDraft } from "./visualDrafts";
import {
  createLatexParagraphTextWalker,
  hasUnchangedParagraphMath,
  measureLatexParagraph,
  measureLatexTextLines,
} from "./latexParagraphMeasurement";
import "./scient-latex.css";
import {
  latexPaginationKey,
  measureLatexDocument,
  setLatexPaginationDimensions,
} from "./latexVisualPaginationExtension";

const key = "browser-local-math-paragraph";
const original = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Prose with \textbf{marked words} and \(\frac{x^2+1}{y+2}\), followed by several words that wrap around the formula. Here is \(\hat{z}+\sum_{k=1}^{n} k\) and more text to test the final lines of this ordinary paragraph without changing its math.
\end{document}`;
let container: HTMLDivElement;
let root: Root;
let current: string;
const nativeResizeObserver = globalThis.ResizeObserver;
beforeEach(async () => {
  clearVisualDraft(key);
  await page.viewport(1300, 900);
  container = document.createElement("div");
  container.style.cssText = "width:1000px;height:900px";
  document.body.append(container);
  root = createRoot(container);
  current = original;
});
afterEach(() => {
  globalThis.ResizeObserver = nativeResizeObserver;
  root.unmount();
  container.remove();
  clearVisualDraft(key);
});

async function open(source = original, expectedPreviews = 2) {
  current = source;
  function Harness() {
    const [source, setSource] = useState(current);
    return (
      <LatexVisualEditor
        draftKey={key}
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
    .poll(
      () =>
        [...container.querySelectorAll(".scient-latex-math-preview")].filter(
          (element) =>
            element.hasAttribute("data-math-preview-ready") ||
            element.shadowRoot
              ?.querySelector("[data-math-preview-content]")
              ?.hasAttribute("data-math-preview-ready"),
        ).length,
      { timeout: 10000 },
    )
    .toBe(expectedPreviews);
  await document.fonts.ready;
  return editor()!;
}

it.each([0.75, 1, 1.37])(
  "mirrors passive formula geometry and source line positions at zoom %s",
  async (zoom) => {
    const editor = await open();
    const paragraph = editor.view.dom.querySelector<HTMLElement>(":scope > p")!;
    const node = editor.state.doc.firstChild!;
    const frame = container.querySelector<HTMLElement>(".scient-latex-page-zoom-frame")!;
    frame.style.transform = `scale(${zoom})`;
    const rect = paragraph.getBoundingClientRect();
    const scale = rect.width / parseFloat(getComputedStyle(paragraph).width);
    const textLines = (
      element: HTMLElement,
      positionAtDOM: (text: globalThis.Node, offset: number) => number,
      scale: number,
    ) => {
      const bounds = element.getBoundingClientRect(),
        walker = createLatexParagraphTextWalker(element),
        lines = [];
      for (let text; (text = walker.nextNode());)
        for (const line of measureLatexTextLines(text, document.createRange()))
          lines.push({
            position: positionAtDOM(text, line.offset),
            top: (line.top - bounds.top) / scale,
            bottom: (line.bottom - bounds.top) / scale,
          });
      return lines;
    };
    const expectedLines = textLines(
      paragraph,
      (text, offset) => editor.view.posAtDOM(text, offset),
      scale,
    );
    const atomPositions: number[] = [];
    node.forEach((child, offset) => {
      if (!child.isText) atomPositions.push(offset + 1);
    });
    const expectedAtoms = atomPositions.map((position) => {
      const box = (editor.view.nodeDOM(position) as HTMLElement).getBoundingClientRect();
      return {
        position,
        left: (box.left - rect.left) / scale,
        top: (box.top - rect.top) / scale,
        width: box.width / scale,
        height: box.height / scale,
      };
    });
    editor.commands.setTextSelection(4);
    editor.view.focus();
    const selection = document.getSelection()!,
      anchor = selection.anchorNode,
      offset = selection.anchorOffset;
    const before = editor.state.doc,
      fields = container.querySelectorAll("math-field").length;
    const measured = measureLatexParagraph(
      editor.view,
      paragraph,
      (copy, positionAtDOM, nodeAtDOM) => {
        const bounds = copy.getBoundingClientRect();
        return {
          height: bounds.height,
          lines: textLines(copy, positionAtDOM, 1),
          atoms: atomPositions.map((position) => {
            const atom = nodeAtDOM(position)!;
            expect(atom).toBeTruthy();
            expect(
              atom
                .querySelector(".scient-latex-math-preview")
                ?.shadowRoot?.querySelector("[data-math-preview-content]")?.textContent,
            ).toBeTruthy();
            const box = atom.getBoundingClientRect();
            return {
              position,
              left: box.left - bounds.left,
              top: box.top - bounds.top,
              width: box.width,
              height: box.height,
            };
          }),
        };
      },
    );
    expect(measured.lines.map((line) => line.position)).toEqual(
      expectedLines.map((line) => line.position),
    );
    for (const [index, line] of measured.lines.entries()) {
      expect(Math.abs(line.top - expectedLines[index]!.top)).toBeLessThan(0.1);
      expect(Math.abs(line.bottom - expectedLines[index]!.bottom)).toBeLessThan(0.1);
    }
    for (const [index, atom] of measured.atoms.entries())
      for (const field of ["left", "top", "width", "height"] as const)
        expect(Math.abs(atom[field] - expectedAtoms[index]![field])).toBeLessThan(0.1);
    expect(Math.abs(measured.height - rect.height / scale)).toBeLessThan(0.1);
    expect(editor.state.doc).toBe(before);
    expect(container.querySelectorAll("math-field").length).toBe(fields);
    expect(selection.anchorNode).toBe(anchor);
    expect(selection.anchorOffset).toBe(offset);
    expect(current).toBe(original);
  },
);

it("retains exact formula identities through prose edit, source publication and undo", async () => {
  const editor = await open(),
    before = editor.state.doc.firstChild!;
  const maths = [...container.querySelectorAll('[data-math-reading-view="true"]')];
  editor.view.dispatch(editor.state.tr.insertText("More ", 1));
  expect(hasUnchangedParagraphMath(before, editor.state.doc.firstChild!)).toBe(true);
  await expect.poll(() => current).toBe(original.replace("Prose with", "More Prose with"));
  expect([...container.querySelectorAll('[data-math-reading-view="true"]')]).toEqual(maths);
  expect(container.querySelector("math-field")).toBeNull();
  editor.commands.undo();
  await expect.poll(() => current).toBe(original);
  expect([...container.querySelectorAll('[data-math-reading-view="true"]')]).toEqual(maths);
  const math = before.content.content.find((node) => !node.isText)!;
  const changed = math.type.create({ ...math.attrs, tex: "a+b" });
  const rewritten = before.copy(
    before.content.replaceChild(before.content.content.indexOf(math), changed),
  );
  expect(hasUnchangedParagraphMath(before, rewritten)).toBe(false);
});

it("retains natural document geometry across measurement batches and scrolling", async () => {
  const paragraphs = Array.from(
    { length: 18 },
    (_, index) =>
      `Paragraph ${index}. ${"Synthetic text with wrapping and marked words. ".repeat(8)}`,
  ).join("\n\n");
  const source = original.replace(
    String.raw`\end{document}`,
    String.raw`\begin{proof}${paragraphs}\end{proof}\end{document}`,
  );
  const editor = await open(source);
  await expect.poll(() => editor.view.dom.dataset.latexWindowed).toBe("true");
  await new Promise((resolve) => setTimeout(resolve, 700));
  const scope = editor.view.dom.parentElement!,
    scroll = container.querySelector<HTMLElement>(".scient-latex-visual-scroll")!,
    before = editor.state.doc;
  const dimensions = { pageHeight: 1056, pageGap: 28, marginTop: 96, marginBottom: 96 };
  const measure = () =>
    measureLatexDocument(editor.view, new WeakMap(), dimensions, new WeakMap(), () => false, []);
  try {
    scope.dataset.latexMeasureVisible = "true";
    scope.dataset.latexMeasuring = "true";
    const baseline = measure();
    let expected = baseline.next();
    while (!expected.done) expected = baseline.next();
    const batched = measure();
    let next = batched.next(),
      steps = 0,
      paints = 0;
    while (!next.done) {
      if (++steps % 4 === 0) {
        delete scope.dataset.latexMeasuring;
        scroll.scrollTop += 37;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        paints++;
        expect(scope.hasAttribute("data-latex-measuring")).toBe(false);
        scope.dataset.latexMeasuring = "true";
        next = batched.next(editor.view.dom.getBoundingClientRect().top);
      } else next = batched.next();
    }
    expect(paints).toBeGreaterThanOrEqual(5);
    expect(next.value).toHaveLength(expected.value.length);
    for (const [index, unit] of next.value.entries()) {
      const reference = expected.value[index]!;
      expect(unit.position).toBe(reference.position);
      expect(unit.keepWithNext).toBe(reference.keepWithNext);
      expect(Math.abs(unit.top - reference.top)).toBeLessThan(0.1);
      expect(Math.abs(unit.bottom - reference.bottom)).toBeLessThan(0.1);
    }
    expect(editor.state.doc).toBe(before);
    expect(current).toBe(source);
    expect(container.querySelector("math-field")).toBeNull();
  } finally {
    delete scope.dataset.latexMeasuring;
    delete scope.dataset.latexMeasureVisible;
  }
});

it("abandons a full measurement interrupted by an edit and retains undo and the new page map", async () => {
  const paragraphs = Array.from(
    { length: 120 },
    (_, index) => `Paragraph ${index}. Synthetic text to measure between user input and paints.`,
  ).join("\n\n");
  const source = original.replace(String.raw`\end{document}`, `${paragraphs}\n\\end{document}`);
  const editor = await open(source);
  await expect.poll(() => editor.view.dom.dataset.latexWindowed).toBe("true");
  await new Promise((resolve) => setTimeout(resolve, 700));
  const before = editor.state.doc,
    scope = editor.view.dom.parentElement!,
    previousPages = latexPaginationKey.getState(editor.state)!.pages,
    dimensions = { pageHeight: 440, pageGap: 28, marginTop: 48, marginBottom: 48 };
  let interrupted = false,
    stalePlanPublished = false;
  const observer = new MutationObserver((records) => {
    const measurementStarted = records.some(
      (record) =>
        (record.target === scope && record.oldValue === "true") ||
        [...record.addedNodes].some(
          (node) =>
            node instanceof HTMLElement && node.hasAttribute("data-latex-measurement-snapshot"),
        ),
    );
    if (interrupted || !measurementStarted) return;
    interrupted = true;
    stalePlanPublished = latexPaginationKey.getState(editor.state)!.pages !== previousPages;
    editor.view.dispatch(editor.state.tr.insertText("Interrupted ", 1));
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-latex-measuring"],
  });
  const map = () => JSON.stringify(latexPaginationKey.getState(editor.state)!.pages);
  try {
    setLatexPaginationDimensions(editor.view, dimensions);
    await expect.poll(() => interrupted).toBe(true);
    expect(stalePlanPublished).toBe(false);
    await expect.poll(() => current).toBe(source.replace("Prose with", "Interrupted Prose with"));
    await expect.poll(() => map()).not.toBe(JSON.stringify(previousPages));
    await new Promise((resolve) => setTimeout(resolve, 800));
    observer.disconnect();
    const settled = map();
    setLatexPaginationDimensions(editor.view, dimensions);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(map()).toBe(settled);
    expect(scope.hasAttribute("data-latex-measuring")).toBe(false);
    expect(scope.hasAttribute("data-latex-measure-visible")).toBe(false);
    await expect
      .poll(() => document.querySelectorAll("[data-latex-measurement-snapshot]").length)
      .toBe(0);
    editor.commands.undo();
    await expect.poll(() => current).toBe(source);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(container.querySelector("math-field")).toBeNull();
  } finally {
    observer.disconnect();
  }
});

it("settles a mixed prose edit without switching the whole canvas into natural measurement", async () => {
  const editor = await open();
  await expect.poll(() => editor.view.dom.dataset.latexWindowed).toBe("true");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const scope = editor.view.dom.parentElement!;
  let globalMeasurements = 0;
  const observer = new MutationObserver((records) => {
    globalMeasurements += records.filter((record) => record.oldValue === "true").length;
  });
  observer.observe(scope, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-latex-measuring"],
  });
  try {
    editor.view.dispatch(editor.state.tr.insertText("Additional prose ", 1));
    await expect
      .poll(() => current)
      .toBe(original.replace("Prose with", "Additional prose Prose with"));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(globalMeasurements).toBe(0);
    expect(container.querySelectorAll('[data-math-reading-view="true"]')).toHaveLength(2);
    expect(container.querySelector("math-field")).toBeNull();
    editor.commands.undo();
    await expect.poll(() => current).toBe(original);
  } finally {
    observer.disconnect();
  }
});

it("retains full measurement while a formula has an interactive editor", async () => {
  const editor = await open();
  await expect.poll(() => editor.view.dom.dataset.latexWindowed).toBe("true");
  await userEvent.click(container.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => container.querySelector("math-field")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const field = container.querySelector("math-field")!;
  const scope = editor.view.dom.parentElement!;
  let globalMeasurements = 0;
  const observer = new MutationObserver((records) => {
    globalMeasurements += records.filter((record) => record.oldValue === "true").length;
  });
  observer.observe(scope, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-latex-measuring"],
  });
  try {
    editor.view.dispatch(editor.state.tr.insertText("Additional prose ", 1));
    await expect
      .poll(() => current)
      .toBe(original.replace("Prose with", "Additional prose Prose with"));
    await expect.poll(() => globalMeasurements).toBeGreaterThan(0);
    expect(container.querySelector("math-field")).toBe(field);
    editor.commands.undo();
    await expect.poll(() => current).toBe(original);
  } finally {
    observer.disconnect();
  }
});

it("finishes a batched full pass with active math instead of restarting on its own resizes", async () => {
  const paragraphs = Array.from(
    { length: 120 },
    (_, index) => `Paragraph ${index}. Synthetic text to measure between user input and paints.`,
  ).join("\n\n");
  const source = original.replace(String.raw`\end{document}`, `${paragraphs}\n\\end{document}`);
  const editor = await open(source);
  await expect.poll(() => editor.view.dom.dataset.latexWindowed).toBe("true");
  await new Promise((resolve) => setTimeout(resolve, 700));
  await userEvent.click(container.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => container.querySelector("math-field")).toBeTruthy();
  const field = container.querySelector<MathfieldElement>("math-field")!;
  let commits = 0;
  const position = field.position;
  const selection = JSON.stringify(field.selection);
  const onTransaction = ({ transaction }: { transaction: Editor["state"]["tr"] }) => {
    if (transaction.getMeta(latexPaginationKey)?.pages) commits++;
  };
  editor.on("transaction", onTransaction);
  try {
    setLatexPaginationDimensions(editor.view, {
      pageHeight: 440,
      pageGap: 28,
      marginTop: 48,
      marginBottom: 48,
    });
    await expect.poll(() => commits, { timeout: 10000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const pages = JSON.stringify(latexPaginationKey.getState(editor.state)!.pages);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(JSON.stringify(latexPaginationKey.getState(editor.state)!.pages)).toBe(pages);
    expect(editor.view.dom.parentElement!.hasAttribute("data-latex-measure-visible")).toBe(false);
    expect(container.querySelector("math-field")).toBe(field);
    expect(field.position).toBe(position);
    expect(JSON.stringify(field.selection)).toBe(selection);
    expect(field.hasFocus()).toBe(true);
    expect(current).toBe(source);
  } finally {
    editor.off("transaction", onTransaction);
  }
});

it("settles display-math and proof margins when full measurement reveals distant content", async () => {
  const blocks = Array.from(
    { length: 12 },
    (_, index) => String.raw`Paragraph ${index}. Text separates the display formulas.
\[\frac{x_${index}^2+1}{y+2}\]
\begin{proof}
Nested text with a display formula and margins.
\[\sum_{k=1}^{n} k=\frac{n(n+1)}{2}\]
\end{proof}`,
  ).join("\n\n");
  const source = original.replace(String.raw`\end{document}`, `${blocks}\n\\end{document}`);
  const editor = await open(source, 26);
  await expect.poll(() => editor.view.dom.dataset.latexWindowed).toBe("true");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const scope = editor.view.dom.parentElement!;
  let starts = 0;
  const observer = new MutationObserver((records) => {
    starts += records.filter((record) => record.oldValue === null).length;
  });
  observer.observe(scope, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-latex-measure-visible"],
  });
  try {
    const displays = [
      ...editor.view.dom.querySelectorAll<HTMLElement>(":scope > .node-latexDisplayMath"),
    ];
    expect(displays).toHaveLength(12);
    scope.dataset.latexMeasureVisible = "true";
    const visibleHeights = displays.map((display) => display.getBoundingClientRect().height);
    delete scope.dataset.latexMeasureVisible;
    displays.forEach((display, index) => {
      expect(
        Math.abs(display.getBoundingClientRect().height - visibleHeights[index]!),
      ).toBeLessThan(0.1);
    });
    await userEvent.click(container.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await expect.poll(() => container.querySelector("math-field")).toBeTruthy();
    setLatexPaginationDimensions(editor.view, {
      pageHeight: 550,
      pageGap: 28,
      marginTop: 48,
      marginBottom: 48,
    });
    await expect.poll(() => starts, { timeout: 10000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const first = starts;
    const pages = JSON.stringify(latexPaginationKey.getState(editor.state)!.pages);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(starts).toBe(first);
    expect(JSON.stringify(latexPaginationKey.getState(editor.state)!.pages)).toBe(pages);
    expect(scope.hasAttribute("data-latex-measure-visible")).toBe(false);
    expect(current).toBe(source);
    expect(container.querySelectorAll("math-field")).toHaveLength(1);
  } finally {
    delete scope.dataset.latexMeasureVisible;
    observer.disconnect();
  }
});

it("ignores resize rounding but measures accumulated height changes", async () => {
  const notices: { target: Element; height: number }[] = [];
  globalThis.ResizeObserver = class extends nativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        for (const entry of entries)
          notices.push({ target: entry.target, height: entry.contentRect.height });
        callback(entries, observer);
      });
    }
  };
  const source = original.replace(
    String.raw`\end{document}`,
    String.raw`\[\frac{x^2+1}{y+2}\]\end{document}`,
  );
  const editor = await open(source, 3);
  await expect.poll(() => editor.view.dom.dataset.latexWindowed).toBe("true");
  await userEvent.click(container.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => container.querySelector("math-field")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const scope = editor.view.dom.parentElement!;
  const display = editor.view.dom.querySelector<HTMLElement>(":scope > .node-latexDisplayMath")!;
  const height = Number.parseFloat(getComputedStyle(display).height);
  expect(Number.isFinite(height)).toBe(true);
  const stylesheet = document.createElement("style");
  container.id = "resize-rounding-fixture";
  document.head.append(stylesheet);
  let starts = 0;
  const observer = new MutationObserver((records) => {
    starts += records.filter((record) => record.oldValue === null).length;
  });
  observer.observe(scope, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-latex-measure-visible"],
  });
  const changeHeight = (amount: number) => {
    stylesheet.textContent = `#resize-rounding-fixture .scient-latex-visual-document > .node-latexDisplayMath { height: ${height + amount}px; }`;
  };
  try {
    changeHeight(0.0625);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(Number.parseFloat(getComputedStyle(display).height)).toBeCloseTo(height + 0.0625, 3);
    expect(starts).toBe(0);
    changeHeight(0.125);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(starts).toBe(0);
    // A native reading size may already differ from natural flow by a layout
    // subpixel. Each further step is below tolerance, but their sum must cause
    // a pass instead of moving the comparison baseline on every notification.
    for (let step = 3; step <= 8 && starts === 0; step++) {
      changeHeight(step * 0.0625);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(notices.filter((notice) => notice.target === display).length).toBeGreaterThan(2);
    expect(starts).toBeGreaterThan(0);
    expect(current).toBe(source);
    expect(container.querySelectorAll("math-field")).toHaveLength(1);
  } finally {
    observer.disconnect();
    stylesheet.remove();
  }
});
