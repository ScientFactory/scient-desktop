import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { clearVisualDraft } from "./visualDrafts";
import { latexPaginationKey } from "./latexVisualPaginationExtension";
import { presentLatexViewportPages, latexViewportReadingRetention } from "./latexViewport";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import "./scient-latex.css";
const draftKey = "large-scrolling-regression";
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  root?.unmount();
  container?.remove();
  clearVisualDraft(draftKey);
});
it("prepares a large document, bounds retained views and keeps rapid jumps/reversals stable", async () => {
  await page.viewport(1300, 900);
  const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
${Array.from(
  { length: 304 },
  (_, i) =>
    `Paragraph ${i}. ${"Scientific prose which wraps across the paper and remains source backed. ".repeat(5)} ` +
    String.raw`Inline \(x_{${i}}^2+1\).

\[y_{${i}}=\frac{x^2+1}{2}\]`,
).join("\n\n")}
\end{document}`;
  let current = source;
  container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:1000px;height:800px";
  document.body.append(container);
  function Harness() {
    const [value, setValue] = useState(source);
    const owner = useLatexVisualTestOwner(value);
    return (
      <LatexVisualEditor
        draftKey={draftKey}
        fileRevision="r1"
        source={value}
        sourceSnapshot={owner.snapshot}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const outcome = owner.edit(request, request.edit.source === current);
          if (outcome.accepted) {
            current = outcome.snapshot.source;
            setValue(current);
          }
          return outcome;
        }}
      />
    );
  }
  root = createRoot(container);
  root.render(<Harness />);
  const findEditor = () =>
    (container!.querySelector(".scient-latex-visual-document") as HTMLElement & { editor?: Editor })
      ?.editor;
  await expect.poll(findEditor).toBeTruthy();
  const editor = findEditor()!;
  const dom = editor.view.dom;
  const scroll = dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
  const status = () => container!.querySelector<HTMLElement>(".scient-latex-viewport-status");
  await expect.poll(() => status()?.textContent).toBe("Preparing first page…");
  const frame = container!.querySelector<HTMLElement>(".scient-latex-page-zoom-frame")!;
  expect(getComputedStyle(frame).visibility).toBe("hidden");
  expect(getComputedStyle(frame).opacity).toBe("0");
  const openingContent = container!.querySelector<HTMLElement>("[data-opening-content]")!;
  expect(openingContent.inert).toBe(true);
  expect(getComputedStyle(openingContent).opacity).toBe("0");
  expect(status()?.hidden).toBe(true);
  expect(container!.querySelector(".scient-latex-document-preparation")?.textContent).toBe(
    "Preparing document…",
  );
  await expect.poll(() => dom.dataset.latexOpening, { timeout: 15000 }).toBe("false");
  await expect.poll(() => openingContent.inert).toBe(false);
  expect(getComputedStyle(frame).visibility).toBe("visible");
  expect(scroll.scrollTop).toBe(0);
  // The first page is useful before background preparation finishes.
  expect(Number(dom.dataset.latexViewportPending)).toBeGreaterThan(0);
  expect(status()?.hidden).toBe(true);
  const initialPages = latexPaginationKey.getState(editor.state)!;
  presentLatexViewportPages(editor.view, new Set([initialPages.pageCount]), initialPages.pages);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(status()?.hidden).toBe(true);
  presentLatexViewportPages(editor.view, new Set(), initialPages.pages);
  // Move while distant pages are still cold, after the opening viewport is ready.
  scroll.scrollTop = 6500;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const viewportTop = scroll.getBoundingClientRect().top;
  const visibleBlock = [...dom.querySelectorAll<HTMLElement>("[data-latex-viewport]")].find(
    (element) => {
      const box = element.getBoundingClientRect();
      return box.top >= viewportTop + 20 && box.top < viewportTop + 350;
    },
  )!;
  expect(visibleBlock).toBeTruthy();
  let blockPosition = -1;
  editor.state.doc.descendants((node, position) => {
    if (editor.view.nodeDOM(position) === visibleBlock) blockPosition = position;
    return !node.isAtom;
  });
  expect(blockPosition).toBeGreaterThanOrEqual(0);
  const blockNode = editor.state.doc.nodeAt(blockPosition)!;
  const blockTop = visibleBlock.getBoundingClientRect().top - viewportTop;
  await expect.poll(() => dom.dataset.latexViewportPending, { timeout: 30000 }).toBe("0");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(editor.state.doc.nodeAt(blockPosition)).toBe(blockNode);
  const preparedBlock = editor.view.nodeDOM(blockPosition) as HTMLElement;
  expect(
    Math.abs(
      preparedBlock.getBoundingClientRect().top - scroll.getBoundingClientRect().top - blockTop,
    ),
    JSON.stringify({
      viewportTop,
      viewportNow: scroll.getBoundingClientRect().top,
      before: blockTop,
      after: preparedBlock.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
      blockPosition,
    }),
  ).toBeLessThan(1);
  scroll.scrollTop = 0;

  await expect
    .poll(() => latexPaginationKey.getState(editor.state)?.pageCount, { timeout: 10000 })
    .toBeGreaterThan(20);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pageInput = container!.querySelector<HTMLInputElement>('input[aria-label="Page number"]')!;
  expect(pageInput).toBeTruthy();
  await userEvent.fill(pageInput, "8");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => scroll.scrollTop).toBeGreaterThan(4000);
  const destination = scroll.scrollTop;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(Math.abs(scroll.scrollTop - destination)).toBeLessThan(1);
  await userEvent.fill(pageInput, "1");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => scroll.scrollTop).toBeLessThan(50);
  const model = editor.state.doc;
  const height = scroll.scrollHeight;
  const pages = latexPaginationKey.getState(editor.state)!.pages;
  let maximumRetainedBytes = 0;
  let maximumDrift = 0;
  for (let round = 0; round < 4; round++) {
    for (const fraction of [0.15, 0.8, 0.35, 0]) {
      scroll.scrollTop = (height - scroll.clientHeight) * fraction;
      for (let frame = 0; frame < 8; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        maximumDrift = Math.max(maximumDrift, Math.abs(scroll.scrollHeight - height));
        maximumRetainedBytes = Math.max(
          maximumRetainedBytes,
          latexViewportReadingRetention(editor.view)!.bytes,
        );
      }
    }
  }
  await expect
    .poll(
      () => [...dom.querySelectorAll(".scient-latex-math-preview")].every(mathReadingPreviewReady),
      { timeout: 10000 },
    )
    .toBe(true);
  expect(maximumDrift).toBeLessThan(1);
  expect(maximumRetainedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(dom.querySelectorAll('[data-latex-viewport="mounted"]').length).toBeGreaterThan(200);
  expect(document.querySelector("[data-latex-measurement-snapshot]")).toBeNull();
  expect(latexPaginationKey.getState(editor.state)!.pages).toBe(pages);
  expect(editor.state.doc).toBe(model);
  expect(current).toBe(source);
  expect(status()?.hidden).toBe(true);
  expect(container.querySelector("math-field")).toBeNull();
}, 60000);
