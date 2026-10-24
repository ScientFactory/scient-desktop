import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { act, fakeTimers, render } from "../../../test/render";
import { waitForTestReceipt } from "../../../test/receipt";
import { LatexVisualEditor } from "./LatexVisualEditor";
import { latexPagedKey, pagedLayoutProgress, pagedLayoutSettled } from "./latexPagedGeometry";
import {
  rememberLatexReadingPosition,
  rememberedLatexReadingBlock,
  restoreLatexReadingPosition,
} from "./latexReadingPosition";
import {
  createLatexVisualTestOwner,
  readMountedLatexVisualTestEditor,
} from "./latexVisualTestOwner";
import "./scient-latex.css";
import { waitForLatexVisualTestReadiness } from "./latexVisualTestReadiness";

const sentence =
  "זהו משפט סינתטי לבדיקת בחירה בעברית. המילים נשמרות בסדר המקורי והמספר 12345 נשאר קריא. ";
const source = String.raw`% !TEX program = xelatex
\documentclass[twocolumn]{article}
\usepackage{amsmath,amssymb}
\usepackage{hyperref}
\newcommand{\OpaqueSentinel}[1]{\texttt{#1}}
% PR614-PRESERVE-COMMENT: spaces, macros and source bytes are intentional.
\usepackage{fontspec}
\usepackage{polyglossia}
\setmainlanguage{hebrew}
\setotherlanguage{english}
\newfontfamily\hebrewfont[Script=Hebrew]{FreeSerif}
\newfontfamily\englishfont{Latin Modern Roman}
\title{בדיקת מקור סינתטית}
\author{PR614 Fixture}
\date{}
\begin{document}
\maketitle
\tableofcontents
${Array.from(
  { length: 18 },
  (_, index) => String.raw`
% PR614-SOURCE-hebrew-${index + 1}
\section{מקטע ${index + 1}}
${sentence.repeat(10)}
\[E=mc^2,\qquad A=\begin{pmatrix}1&2\\3&4\end{pmatrix}\]
\begin{itemize}\item פריט ראשון\item פריט שני\end{itemize}
${
  index === 1
    ? String.raw`\begin{tabular}{lr} A & 12 \\ B & 34 \end{tabular}
\begin{figure}[ht]\centering\fbox{\rule{0pt}{24pt}\rule{0.6\linewidth}{0pt}}\caption{PR614}\end{figure}
`
    : ""
}${
    index === 4 || index === 10
      ? String.raw`\newpage
% PR614-EXPLICIT-PAGE-BOUNDARY
`
      : ""
  }`,
).join("")}
% PR614-END-SOURCE
\end{document}
`;

function scroller(editor: Editor) {
  return editor.view.dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
}

it("keeps the visible Hebrew two-column source heading across a file-tab remount", async (context) => {
  await page.viewport(1280, 800);
  using resources = new DisposableStack();
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:255px;top:100px;width:1025px;height:700px;display:flex;flex-direction:column";
  document.body.append(container);
  resources.defer(() => container.remove());
  const owner = createLatexVisualTestOwner(source);
  const onEdit = vi.fn(owner.edit);
  const readingKey = "hebrew-two-column-tab-reading";
  function FileTabs() {
    const [file, setFile] = useState("hebrew-two-column.tex");
    return (
      <>
        <div>
          <button type="button" onClick={() => setFile("rich.md")}>
            rich.md
          </button>
          <button type="button" onClick={() => setFile("hebrew-two-column.tex")}>
            hebrew-two-column.tex
          </button>
        </div>
        {file === "rich.md" ? (
          <p>Other document</p>
        ) : (
          <LatexVisualEditor
            draftKey={readingKey}
            editorInstanceKey={readingKey}
            source={source}
            sourceSnapshot={owner.snapshot}
            fileRevision="unchanged-r1"
            disabled={false}
            onEdit={onEdit}
            onEditingChange={() => {}}
            onOpenSource={() => {}}
          />
        )}
      </>
    );
  }
  // The file host has no router behavior; the actual editor and its retained source owner do.
  await using screen = await render(<FileTabs />, { container, router: false });
  const before = await waitForLatexVisualTestReadiness(
    container,
    context,
    "Hebrew tab initial opening",
  );
  expect(latexPagedKey.getState(before.state)!.plan!.pages).toBeGreaterThanOrEqual(5);
  {
    using _clock = fakeTimers();
    const background = vi.fn();
    const interval = setInterval(background, 1000);
    using _background = { [Symbol.dispose]: () => clearInterval(interval) };
    const delivered = Promise.withResolvers<void>();
    const onScroll = () => delivered.resolve();
    const scroll = scroller(before);
    scroll.addEventListener("scroll", onScroll, { once: true });
    try {
      const pageNumber = screen.getByRole("textbox", { name: "Page number", exact: true });
      await pageNumber.fill("5");
      await userEvent.keyboard("{Enter}");
      await waitForTestReceipt(context.signal, delivered.promise);
      // Capture this scroll without draining recurring services that share the clock.
      await act(() => vi.runOnlyPendingTimersAsync());
    } finally {
      scroll.removeEventListener("scroll", onScroll);
    }
    expect(rememberedLatexReadingBlock(readingKey)).toBeGreaterThan(0);
    expect(pagedLayoutSettled(before.view)).toBe(true);
    expect(background).toHaveBeenCalled();
  }
  const box = scroller(before).getBoundingClientRect();
  const headings = Array.from(before.view.dom.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  const heading = headings.find((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= box.top && bounds.bottom < box.bottom;
  });
  expect(heading).toBeDefined();
  const text = heading!.textContent;
  const position = before.view.posAtDOM(heading!, 0);
  const offset = heading!.getBoundingClientRect().top - box.top;
  const doc = before.state.doc.toJSON();

  await screen.getByRole("button", { name: "rich.md", exact: true }).click();
  expect(readMountedLatexVisualTestEditor(container)).toBeNull();
  await screen.getByRole("button", { name: "hebrew-two-column.tex", exact: true }).click();
  const after = await waitForLatexVisualTestReadiness(container, context, "Hebrew tab remount");
  const returned = Array.from(after.view.dom.querySelectorAll("h1,h2,h3,h4,h5,h6")).find(
    (element) => element.textContent === text,
  );
  expect(returned).toBeDefined();
  expect(after).not.toBe(before);
  expect(after.state.doc.toJSON()).toEqual(doc);
  expect(after.view.posAtDOM(returned!, 0)).toBe(position);
  expect(onEdit).not.toHaveBeenCalled();
  expect(owner.snapshot.source).toBe(source);
  expect(
    Math.abs(
      returned!.getBoundingClientRect().top - scroller(after).getBoundingClientRect().top - offset,
    ),
  ).toBeLessThan(2);
});

it("yields opening restoration to explicit reader zoom before pagination settles", async (context) => {
  await page.viewport(1280, 800);
  using resources = new DisposableStack();
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:1025px;height:700px";
  document.body.append(container);
  resources.defer(() => container.remove());
  const zoomSource = String.raw`\documentclass{article}
\begin{document}
${"A source-owned paragraph spans several pages while its reading position is retained. ".repeat(150)}
\end{document}`;
  const owner = createLatexVisualTestOwner(zoomSource);
  const onEdit = vi.fn(owner.edit);
  const key = "opening-zoom-cancellation";
  // The production editor supplies both scroll geometry and the enabled zoom callback.
  await using screen = await render(
    <LatexVisualEditor
      draftKey={key}
      editorInstanceKey={key}
      source={zoomSource}
      sourceSnapshot={owner.snapshot}
      fileRevision="unchanged-r1"
      disabled={false}
      onEdit={onEdit}
      onEditingChange={() => {}}
      onOpenSource={() => {}}
    />,
    { container, router: false },
  );
  const editor = await waitForLatexVisualTestReadiness(
    container,
    context,
    "zoom cancellation initial opening",
  );
  const originalDocument = editor.state.doc.toJSON();
  const scroll = scroller(editor);
  const delivered = Promise.withResolvers<void>();
  const onScroll = () => delivered.resolve();
  scroll.addEventListener("scroll", onScroll, { once: true });
  using _scrollReceipt = {
    [Symbol.dispose]: () => scroll.removeEventListener("scroll", onScroll),
  };
  scroll.scrollTop = 400;
  await waitForTestReceipt(context.signal, delivered.promise);
  rememberLatexReadingPosition(key, editor.view);
  expect(rememberedLatexReadingBlock(key)).toBe(0);
  expect(scroll.scrollTop).toBe(400);
  const stage = scroll.querySelector<HTMLElement>(".scient-latex-page-stage")!;
  const readingPoint = () => {
    const bounds = stage.getBoundingClientRect();
    return (scroll.getBoundingClientRect().top - bounds.top) / (bounds.width / stage.offsetWidth);
  };
  using _clock = fakeTimers();
  const progress = pagedLayoutProgress.get(editor.view)!;
  expect(progress.pending).toBe(false);
  progress.pending = true;
  editor.view.dom.dataset.latexLoading = "true";
  using _opening = {
    [Symbol.dispose]() {
      progress.pending = false;
      delete editor.view.dom.dataset.latexLoading;
    },
  };
  restoreLatexReadingPosition(key, editor.view, 0);
  // Hold the real owner across the early stage-resize receipt, before final pagination.
  editor.view.dom.dispatchEvent(new Event("scient-latex-layout"));
  const scale = stage.getBoundingClientRect().width / stage.offsetWidth;
  const beforeZoom = readingPoint();
  const zoom = screen.getByRole("button", { name: /^Zoom in(?: \(|$)/ });
  await expect.element(zoom).toBeEnabled();
  await zoom.click();
  expect(stage.getBoundingClientRect().width / stage.offsetWidth).toBeGreaterThan(scale);
  expect(Math.abs(readingPoint() - beforeZoom)).toBeLessThan(1);
  const zoomed = readingPoint();
  editor.view.dom.dispatchEvent(new Event("scient-latex-layout"));
  expect(Math.abs(readingPoint() - zoomed)).toBeLessThan(1);
  delete editor.view.dom.dataset.latexLoading;
  progress.pending = false;
  editor.view.dom.dispatchEvent(new Event("scient-latex-layout"));
  await act(() => vi.runOnlyPendingTimersAsync());
  expect(Math.abs(readingPoint() - zoomed)).toBeLessThan(1);
  expect(editor.state.doc.toJSON()).toEqual(originalDocument);
  expect(onEdit).not.toHaveBeenCalled();
  expect(owner.snapshot.source).toBe(zoomSource);
});
