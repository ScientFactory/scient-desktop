import { act, fakeTimers, render as _fixtureRender, type Screen } from "../../../test/render";
import { waitForTestReceipt } from "../../../test/receipt";
import { useState, type ReactNode } from "react";

import type { Editor } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { expect, it, vi, type TestContext } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { latexPagedKey, pagedPositionAtPoint, pagedLayoutSettled } from "./latexPagedGeometry";
import { measureNatural, naturalTextLines } from "./latexNaturalMeasurement";
import { clearVisualDraft } from "./visualDrafts";
import { waitForLatexVisualTestReadiness } from "./latexVisualTestReadiness";
import template15 from "./fixtures/paging-long-table.tex?raw";
import template26 from "./fixtures/paging-hebrew.tex?raw";
import template28 from "./fixtures/paging-medical-article.tex?raw";
import twoColumnArticle from "./fixtures/paging-two-column-article.tex?raw";
import hebrewMathAndTables from "./fixtures/hebrew-math-and-tables.tex?raw";
import "~/index.css";
import "./scient-latex.css";

let published: string;
let key = "";
async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  clearVisualDraft(key);
}
async function editAndLayout(editor: Editor, context: TestContext, edit: () => void) {
  await act(edit);
  await waitForLatexVisualTestReadiness(editor.view.dom.parentElement!, context, "edit layout");
}
async function mount(_fixture: _Fixture, source: string, name: string) {
  await page.viewport(1250, 950);
  key = `paging-${name}`;
  clearVisualDraft(key);
  published = source;
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText = "width:1000px;height:900px;display:flex;flex-direction:column";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  function Harness() {
    const [value, setValue] = useState(source);
    const owner = useLatexVisualTestOwner(value);
    return (
      <LatexVisualEditor
        draftKey={key}
        fileRevision="r1"
        source={value}
        sourceSnapshot={owner.snapshot}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const outcome = owner.edit(request, request.edit.source === published);
          if (outcome.accepted) {
            published = outcome.snapshot.source;
            setValue(published);
          }
          return outcome;
        }}
      />
    );
  }
  await _fixture.root0.rerender(<Harness />);
  return waitForLatexVisualTestReadiness(_fixture.host, _fixture.context, `pagination ${name}`);
}

it.for(["detached", "hidden", "briefly hidden"] as const)(
  "retires a measurement continuation when its paper becomes %s and resumes when visible",
  async (unavailable, context) => {
    await using _fixture = _createFixture(context);
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));
    const editor = await mount(
      _fixture,
      String.raw`\documentclass{article}
\begin{document}
First paragraph remains owned by the document.

Second paragraph has not been measured when the paper disappears.

Third paragraph must return with the same source after showing the paper.
\end{document}`,
      `measurement-${unavailable}`,
    );
    const view = editor.view;
    const source = published;
    const display = _fixture.host.style.display;
    const restore = () => {
      _fixture.host.style.display = display;
      if (!_fixture.host.isConnected) document.body.append(_fixture.host);
    };
    using _restore = { [Symbol.dispose]: restore };
    const visibleSize = Promise.withResolvers<void>();
    const hiddenSize = Promise.withResolvers<void>();
    let observedHidden = false;
    const sizeObserver = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.contentRect.width > 0)) visibleSize.resolve();
      if (entries.some((entry) => entry.contentRect.width === 0)) {
        observedHidden = true;
        hiddenSize.resolve();
      }
    });
    sizeObserver.observe(view.dom);
    using _sizeObserver = { [Symbol.dispose]: () => sizeObserver.disconnect() };
    await waitForTestReceipt(context.signal, visibleSize.promise);
    await vi.waitFor(() => expect(pagedLayoutSettled(view)).toBe(true));
    const previous = latexPagedKey.getState(editor.state)!;
    {
      using _timers = fakeTimers();
      const continuations = new Map<number, FrameRequestCallback>();
      let nextId = 0;
      using _request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        const id = --nextId;
        continuations.set(id, callback);
        return id;
      });
      using _cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        continuations.delete(id);
      });
      let measuredTime = 0;
      // Each measurement exhausts the cooperative work budget, independent of machine speed.
      using _measurementClock = vi
        .spyOn(performance, "now")
        .mockImplementation(() => (measuredTime += 100));
      const takeContinuation = () => {
        expect(continuations.size).toBe(1);
        const [id, callback] = continuations.entries().next().value!;
        continuations.delete(id);
        return callback;
      };
      view.dom.dispatchEvent(new Event("scient-latex-layout-config"));
      takeContinuation()(0);
      const resume = takeContinuation();
      expect(pagedLayoutSettled(view)).toBe(false);
      expect(latexPagedKey.getState(editor.state)).toBe(previous);
      if (unavailable === "detached") _fixture.host.remove();
      else _fixture.host.style.display = "none";
      expect(editor.isDestroyed).toBe(false);
      expect(view.dom.offsetWidth).toBe(0);
      using geometry = vi.spyOn(view.dom, "getBoundingClientRect");
      resume(0);
      expect(geometry).not.toHaveBeenCalled();
      expect(continuations.size).toBe(1);
      expect(latexPagedKey.getState(editor.state)).toBe(previous);
      expect(pagedLayoutSettled(view)).toBe(false);
      const recovery = takeContinuation();
      if (unavailable === "briefly hidden") {
        restore();
        // The full controlled clock gives the recovered pass an uninterrupted work budget.
        _measurementClock.mockRestore();
        recovery(0);
        expect(pagedLayoutSettled(view)).toBe(true);
      } else {
        // An owned wake-up must park if the paper is still unavailable.
        recovery(0);
      }
      expect(continuations.size).toBe(0);
    }
    if (unavailable !== "briefly hidden") {
      await waitForTestReceipt(context.signal, hiddenSize.promise);
      restore();
    }
    await vi.waitFor(() => {
      expect({ settled: pagedLayoutSettled(view), observedHidden }).toEqual({
        settled: true,
        observedHidden: unavailable !== "briefly hidden",
      });
      const presentation = latexPagedKey.getState(editor.state)!;
      expect(presentation.revision).toBeGreaterThan(previous.revision);
      expect(presentation.plan!.sheets!.length).toBeGreaterThan(0);
      expect(presentation.plan!.sheets!.every((sheet) => Number.isFinite(sheet.top))).toBe(true);
    });
    expect(published).toBe(source);
  },
);

it.for([
  ["15", template15, 2],
  ["26", template26, 4],
  ["28", template28, 3],
] as const)(
  "template %s has the compiled PDF's page count and opens without source or undo changes",
  async ([name, source, pages], context) => {
    await using _fixture = _createFixture(context);
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const editor = await mount(_fixture, source, name);
    // Page counts match the PDF only with the document's own fonts. Template 26
    // sets its Hebrew in Arial, which macOS and Windows ship and Linux runners
    // do not; there a substitute with other metrics gives a different count.
    if (name !== "26" || !/Linux/u.test(navigator.userAgent))
      expect(latexPagedKey.getState(editor.state)?.plan?.pages).toBe(pages);
    expect(published).toBe(source);
    expect(undoDepth(editor.state)).toBe(0);
    expect(_fixture.host.querySelectorAll(".scient-latex-page-sheet")).toHaveLength(
      latexPagedKey.getState(editor.state)!.plan!.pages,
    );
    const screenshotDirectory = import.meta.env.VITE_SCIENT_PAGING_SCREENSHOTS;
    if (screenshotDirectory) {
      await page.viewport(1250, 1700);
      _fixture.host.style.height = "1650px";
      const scroll = _fixture.host.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
      scroll.style.flex = "none";
      scroll.style.height = `${_fixture.host.querySelector(".scient-latex-page-sheet")!.getBoundingClientRect().height + 20}px`;
      const spacer = document.createElement("div");
      spacer.style.height = "700px";
      scroll.append(spacer);
      await vi.waitFor(() =>
        expect(scroll.clientHeight).toBeCloseTo(
          _fixture.host.querySelector(".scient-latex-page-sheet")!.getBoundingClientRect().height +
            20,
          0,
        ),
      );
      for (let number = 1; number <= pages; number++) {
        const sheet = _fixture.host.querySelector<HTMLElement>(
          `.scient-latex-page-sheet[data-page="${number}"]`,
        )!;
        scroll.scrollTop +=
          sheet.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 10;
        await vi.waitFor(() =>
          expect(
            Math.abs(sheet.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 10),
          ).toBeLessThan(2),
        );
        await page.screenshot({
          path: `${screenshotDirectory}/${name}-visual-${number}.png`,
          element: scroll,
        });
      }
      spacer.remove();
    }
  },
);

it("template 15 repeats furniture at the next printable origin and preserves every editable row", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const editor = await mount(_fixture, template15, "longtable");
  await expect
    .poll(() => _fixture.host.querySelectorAll('[data-paged-repeat="true"]').length)
    .toBeGreaterThan(0);
  expect(_fixture.host.querySelectorAll("tr[data-latex-table-row]")).toHaveLength(41);
  const dimensions = latexPagedKey.getState(editor.state)!.plan!.dimensions;
  const paper = editor.view.dom.getBoundingClientRect();
  const scale = paper.width / editor.view.dom.offsetWidth;
  const head = _fixture.host.querySelector<HTMLElement>(
    '[data-paged-repeat="true"][data-latex-longtable-band="head"]',
  )!;
  expect(
    Math.abs(
      (head.getBoundingClientRect().top - paper.top) / scale -
        dimensions.height -
        dimensions.gap -
        dimensions.top,
    ),
  ).toBeLessThan(2);
  expect(published).toBe(template15);
});
it("mirrors body margins on facing pages while retaining authored paragraph positions", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const source = String.raw`\documentclass[twoside,a5paper]{article}
\usepackage[inner=20mm,outer=30mm,top=18mm,bottom=18mm,bindingoffset=5mm]{geometry}
\begin{document}
First page text.
\newpage
Second page text.
\end{document}`;
  const editor = await mount(_fixture, source, "facing-pages");
  const paragraphs = [...editor.view.dom.querySelectorAll("p")];
  const scale = editor.view.dom.getBoundingClientRect().width / editor.view.dom.offsetWidth;
  expect(
    (paragraphs[1]!.getBoundingClientRect().left - paragraphs[0]!.getBoundingClientRect().left) /
      scale,
  ).toBeCloseTo((5 * 96) / 25.4, 0);
  expect(published).toBe(source);
});

it("a paragraph can cross both columns and pages while every visible text fragment maps to its original position", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const source = String.raw`\documentclass[twocolumn,a5paper]{article}
\usepackage[margin=18mm]{geometry}
\begin{document}
${Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ")}
\end{document}`;
  const editor = await mount(_fixture, source, "long-paragraph");
  const state = latexPagedKey.getState(editor.state)!;
  expect(state.geometry.some((part) => part.column === 1)).toBe(true);
  expect(state.geometry.some((part) => part.page === 1)).toBe(true);
  const scroll = editor.view.dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
  for (const part of state.geometry.filter((part) => part.column === 1).slice(0, 3)) {
    const rect = editor.view.coordsAtPos(part.from + 1);
    scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - 100;
    await vi.waitFor(() => {
      const visible = editor.view.coordsAtPos(part.from + 1);
      const position = pagedPositionAtPoint(
        editor.view,
        visible.left + 1,
        (visible.top + visible.bottom) / 2,
      );
      expect(position).toBeGreaterThanOrEqual(part.from);
      expect(position).toBeLessThan(part.to);
    });
  }
  expect(published).toBe(source);
  const target = state.geometry.find((part) => part.column === 1)!;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target.from + 2)),
  );
  editor.view.focus();
  await userEvent.keyboard("Z");
  await expect.poll(() => published).toContain("Z");
  editor.commands.undo();
  await expect.poll(() => published).toBe(source);
});

it("template 28 keeps its title full width, restores two columns and renders running furniture as text", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const editor = await mount(_fixture, template28, "article");
  const paper = editor.view.dom.getBoundingClientRect();
  const scale = paper.width / editor.view.dom.offsetWidth;
  const dimensions = latexPagedKey.getState(editor.state)!.plan!.dimensions;
  for (const [text, pageNumber] of [
    ["Methods", 2],
    ["Discussion", 3],
  ] as const) {
    const heading = [
      ..._fixture.host.querySelectorAll<HTMLElement>('[data-layout="macroHeading"]'),
    ].find((element) => element.textContent?.trim() === text)!;
    const expected =
      paper.top +
      ((pageNumber - 1) * (dimensions.height + dimensions.gap) + dimensions.top) * scale;
    const offset = (heading.getBoundingClientRect().top - expected) / scale;
    // The source adds heading skips; both headings must begin in their page's first lines.
    expect(offset).toBeGreaterThanOrEqual(-1);
    expect(offset).toBeLessThan(3 * parseFloat(getComputedStyle(editor.view.dom).lineHeight));
  }
  const tables = [..._fixture.host.querySelectorAll("table")];
  expect(tables).toHaveLength(2);
  expect(parseFloat(getComputedStyle(tables[1]!).fontSize)).toBeCloseTo(
    parseFloat(getComputedStyle(tables[0]!).fontSize),
    2,
  );
  const title = _fixture.host.querySelector<HTMLElement>('[data-layout="fullWidthTitle"]')!;
  const paragraph = _fixture.host.querySelector<HTMLElement>('[data-layout="sourceColumns"] p')!;
  expect(title.getBoundingClientRect().width).toBeGreaterThan(
    paragraph.getBoundingClientRect().width * 1.8,
  );
  expect(_fixture.host.querySelector(".scient-latex-running-header")!.textContent).toContain(
    "Northbridge Journal",
  );
  expect(_fixture.host.querySelector(".scient-latex-running-header")!.textContent).not.toContain(
    "\\scriptsize",
  );
  expect(latexPagedKey.getState(editor.state)?.geometry.some((part) => part.column === 1)).toBe(
    true,
  );
});

it("detached measurements preserve mixed-script paragraph line heights", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const editor = await mount(_fixture, template26, "natural-parity");
  const scale = editor.view.dom.getBoundingClientRect().width / editor.view.dom.offsetWidth;
  let checked = 0;
  for (const element of editor.view.dom.querySelectorAll<HTMLElement>(":scope > p")) {
    if (element.querySelector(".scient-latex-pagination-gap,.scient-paged-line,math-field"))
      continue;
    const height = measureNatural(
      editor.view,
      element,
      (copy) => copy.getBoundingClientRect().height,
    );
    const live = measureNatural(
      editor.view,
      element,
      (copy) => copy.getBoundingClientRect().height / scale,
      true,
    );
    expect(height, element.textContent ?? "paragraph").toBeCloseTo(live, 0);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
});

it("keeps paragraphs in source order around a note moved to the foot of the page", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const editor = await mount(
    _fixture,
    String.raw`\documentclass[10pt]{article}
\usepackage[letterpaper,margin=1in]{geometry}
\begin{document}
\section{Page one}
Alpha begins this paragraph with a note.\footnote{A note set at the foot of page one.}

Beta is the next body paragraph.\footnote{A second note, from another paragraph.}

Gamma follows without a note.
\vfill
A closing line before the page break.
\newpage
\section{Page two}
The second page starts here.
\end{document}
`,
    "note-order",
  );
  const paragraph = (start: string) =>
    [...editor.view.dom.querySelectorAll<HTMLElement>(":scope > p")].find((element) =>
      element.textContent?.startsWith(start),
    )!;
  const inOrder = () => {
    const blocks = ["Alpha", "Beta", "Gamma"].map(paragraph);
    for (let index = 1; index < blocks.length; index++) {
      // Each is painted below the previous one; paging did not pull it up.
      expect(blocks[index]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        blocks[index - 1]!.getBoundingClientRect().bottom - 1,
      );
      expect(parseFloat(blocks[index]!.style.top) || 0).toBeGreaterThanOrEqual(0);
    }
    const notes = [..._fixture.host.querySelectorAll<HTMLElement>(".scient-latex-footnote")];
    expect(notes).toHaveLength(2);
    for (const note of notes)
      expect(note.getBoundingClientRect().top).toBeGreaterThan(
        blocks.at(-1)!.getBoundingClientRect().bottom,
      );
  };
  inOrder();
  // Repaginating after an edit keeps the order.
  let end = 0;
  editor.state.doc.forEach((node, offset) => {
    if (node.textContent.startsWith("Alpha")) end = offset + node.nodeSize - 1;
  });
  await editAndLayout(editor, context, () =>
    editor.view.dispatch(editor.state.tr.insertText(" More words in the first paragraph.", end)),
  );
  inOrder();
});

it("breaks a word across lines or columns only once, at a hyphen", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const editor = await mount(_fixture, twoColumnArticle, "column-words");
  // Words inserted at the start slide the column cut through the text until a
  // hyphenated word lands on it; every layout on the way keeps words whole.
  let cut = false;
  for (let step = 0; step < 16 && !cut; step++) {
    expectWholeWords(editor);
    cut = cutsInsideWord(editor);
    if (!cut) await insertAtArticleStart(editor, context, "word ");
  }
  expect(cut).toBe(true);
  expectWholeWords(editor);
  expect(editor.view.dom.querySelectorAll(".scient-paged-hyphen").length).toBeGreaterThan(0);
});

/** Whether a column or page cut falls between two letters of one word. */
function cutsInsideWord(editor: Editor) {
  const { doc } = editor.state;
  const geometry = latexPagedKey.getState(editor.state)!.geometry;
  return geometry.some((part, index) => {
    const previous = geometry[index - 1];
    if (!previous || (previous.page === part.page && previous.column === part.column)) return false;
    const $at = doc.resolve(part.from);
    return (
      /\p{L}$/u.test($at.nodeBefore?.isText ? $at.nodeBefore.text! : "") &&
      /^\p{L}/u.test($at.nodeAfter?.isText ? $at.nodeAfter.text! : "")
    );
  });
}

/** Every word's letters advance on one line, breaking at most once onto the
 * next line or into the next column. */
function expectWholeWords(editor: Editor) {
  // A letter's own glyph box: the first letter after a hyphenation break also
  // reports the hyphen left on the previous line.
  const glyph = (node: Text, offset: number) => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    return [...range.getClientRects()].findLast((box) => box.width > 0);
  };
  let words = 0;
  for (const element of editor.view.dom.querySelectorAll<HTMLElement>(":scope p")) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const letters: { character: string; box: DOMRect | undefined }[] = [];
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null)
      for (let offset = 0; offset < node.data.length; offset++)
        letters.push({ character: node.data[offset]!, box: glyph(node, offset) });
    let start = -1;
    for (let index = 0; index <= letters.length; index++) {
      const letter = index < letters.length && /\p{L}/u.test(letters[index]!.character);
      if (letter && start < 0) start = index;
      if (letter || start < 0) continue;
      const word = letters.slice(start, index);
      const text = word.map((item) => item.character).join("");
      let breaks = 0;
      for (let at = 1; at < word.length; at++) {
        const previous = word[at - 1]!.box;
        const current = word[at]!.box;
        if (!previous || !current) continue;
        if (Math.abs(current.top - previous.top) < 2) {
          expect(current.left, text).toBeGreaterThan(previous.left - 1);
          continue;
        }
        breaks++;
        expect(current.top > previous.top || current.left > previous.right, text).toBe(true);
      }
      expect(breaks, text).toBeLessThanOrEqual(1);
      words++;
      start = -1;
    }
  }
  expect(words).toBeGreaterThan(300);
}

/** Inserts at the start of the article's first paragraph, the same one each time. */
async function insertAtArticleStart(editor: Editor, context: TestContext, text: string) {
  let at = -1;
  editor.state.doc.descendants((node, position) => {
    if (at < 0 && node.type.name === "paragraph" && node.textContent.includes("Alpha begins"))
      at = position + 1;
    return at < 0;
  });
  expect(at).toBeGreaterThan(0);
  await editAndLayout(editor, context, () =>
    editor.view.dispatch(editor.state.tr.insertText(text, at)),
  );
}

it("finds the first letter of a line that follows a hyphenation break", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const block = document.createElement("div");
  block.lang = "en";
  block.style.cssText = "width:120px;font:16px serif;hyphens:auto;text-align:justify";
  block.textContent = "Make differences from the compiled output easy to understand differences.";
  document.body.append(block);
  try {
    await waitForTestReceipt(context.signal, document.fonts.ready);
    const text = block.firstChild as Text;
    const range = document.createRange();
    const top = (offset: number) => {
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      return [...range.getClientRects()].findLast((box) => box.width > 0)!.top;
    };
    const lines = naturalTextLines(text, document.createRange());
    expect(lines.length).toBeGreaterThan(3);
    // The specimen hyphenates at least one word at this width.
    expect(lines.some(({ offset }) => /\p{L}/u.test(text.data[offset - 1] ?? ""))).toBe(true);
    for (const line of lines) {
      expect(top(line.offset), text.data.slice(line.offset)).toBeCloseTo(line.top, 0);
      if (line.offset > 0 && /\S/u.test(text.data[line.offset - 1]!))
        expect(top(line.offset - 1)).toBeLessThan(line.top - 0.5);
    }
  } finally {
    block.remove();
  }
});

it("sets a two-column article's title across both columns, above the body", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const editor = await mount(_fixture, twoColumnArticle, "column-title");
  const heading = [...editor.view.dom.querySelectorAll<HTMLElement>("*")].find((element) =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value === "Layout fidelity specimen"
      : element.textContent === "Layout fidelity specimen" && !element.children.length,
  )!;
  expect(heading).toBeTruthy();
  const titleBox = heading.getBoundingClientRect();
  const body = [
    ...editor.view.dom.querySelectorAll<HTMLElement>('[data-layout="sourceColumns"] p'),
  ];
  expect(body.length).toBeGreaterThan(1);
  expect(heading.closest('[data-layout="sourceColumns"]')).toBeNull();
  // Centred on the page's text width, not on the first column.
  const left = Math.min(...body.map((paragraph) => paragraph.getBoundingClientRect().left));
  const right = Math.max(...body.map((paragraph) => paragraph.getBoundingClientRect().right));
  expect(Math.abs((titleBox.left + titleBox.right) / 2 - (left + right) / 2)).toBeLessThan(4);
  // Both columns begin below the title, as \maketitle sets it in twocolumn mode.
  for (const paragraph of body)
    expect(paragraph.getBoundingClientRect().top).toBeGreaterThanOrEqual(titleBox.bottom - 1);
  expect(published).toBe(twoColumnArticle);
});

it("draws no hyphen at line ends that stay in their column", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const han = "中文段落的每一行都在字与字之间换行".repeat(12);
  const words = "Hyphenation of considerably extraordinary vocabulary continues naturally. ".repeat(
    12,
  );
  const editor = await mount(
    _fixture,
    String.raw`\documentclass{article}
\begin{document}
${han}

${words}
\end{document}
`,
    "no-invented-hyphen",
  );
  expect(latexPagedKey.getState(editor.state)?.plan?.pages).toBe(1);
  expect(editor.view.dom.querySelectorAll(".scient-paged-hyphen")).toHaveLength(0);
});

it("lays out an edit next to a drawn hyphen as a fresh opening of the result does", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  let editor = await mount(_fixture, twoColumnArticle, "hyphen-edit");
  for (let step = 0; step < 16 && !cutsInsideWord(editor); step++)
    await insertAtArticleStart(editor, context, "word ");
  const hyphen = editor.view.dom.querySelector(".scient-paged-hyphen");
  expect(hyphen).toBeTruthy();
  const at = editor.view.posAtDOM(hyphen!, 0);
  const paragraph = editor.state.doc.resolve(at).start();
  await editAndLayout(editor, context, () =>
    editor.view.dispatch(editor.state.tr.insertText("Inserted words shift the wrap. ", paragraph)),
  );
  await expect.poll(() => published).toContain("Inserted words shift the wrap.");
  const layout = (current: Editor) =>
    latexPagedKey
      .getState(current.state)!
      .geometry.map(({ page, column, from, to }) => `${page}:${column}:${from}-${to}`);
  const hyphens = (current: Editor) =>
    [...current.view.dom.querySelectorAll(".scient-paged-hyphen")].map((element) =>
      current.view.posAtDOM(element, 0),
    );
  const edited = { layout: layout(editor), hyphens: hyphens(editor) };
  const source = published;
  await _fixture.root0.unmount();
  _fixture.host.remove();
  editor = await mount(_fixture, source, "hyphen-edit-fresh");
  expect(layout(editor)).toEqual(edited.layout);
  expect(hyphens(editor)).toEqual(edited.hyphens);
});

it("drops a drawn hyphen when the letter before it becomes a hyphen, as a fresh opening does", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  let editor = await mount(_fixture, twoColumnArticle, "hyphen-replaced");
  for (let step = 0; step < 16 && !cutsInsideWord(editor); step++)
    await insertAtArticleStart(editor, context, "word ");
  const hyphen = editor.view.dom.querySelector(".scient-paged-hyphen");
  expect(hyphen).toBeTruthy();
  const at = editor.view.posAtDOM(hyphen!, 0);
  await editAndLayout(editor, context, () =>
    editor.view.dispatch(editor.state.tr.insertText("-", at, at + 1)),
  );
  await expect.poll(() => published).toContain("-");
  const hyphens = (current: Editor) =>
    [...current.view.dom.querySelectorAll(".scient-paged-hyphen")].map((element) =>
      current.view.posAtDOM(element, 0),
    );
  const edited = hyphens(editor);
  const source = published;
  await _fixture.root0.unmount();
  _fixture.host.remove();
  editor = await mount(_fixture, source, "hyphen-replaced-fresh");
  expect(hyphens(editor)).toEqual(edited);
});

it("draws no hyphen where Han text continues in the next column", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const han =
    "\u4e2d\u6587\u6bb5\u843d\u7684\u6bcf\u4e00\u884c\u90fd\u5728\u5b57\u4e0e\u5b57\u4e4b\u95f4\u6362\u884c";
  const editor = await mount(
    _fixture,
    String.raw`\documentclass[twocolumn]{article}
\begin{document}
${han.repeat(240)}
\end{document}
`,
    "han-columns",
  );
  // One continuous paragraph forces a cut between Han characters regardless of
  // fallback font metrics; short paragraphs can all end at column boundaries.
  expect(cutsInsideWord(editor)).toBe(true);
  expect(editor.view.dom.querySelectorAll(".scient-paged-hyphen")).toHaveLength(0);
});

it("lays out once around a gap cursor between blocks", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));
  const editor = await mount(_fixture, hebrewMathAndTables, "gap-cursor");
  // A gap cursor sits between two adjacent blocks that hold no text cursor.
  let gap: number | null = null;
  let previous: { isTextblock: boolean } | null = null;
  editor.state.doc.forEach((node, offset) => {
    if (gap === null && previous && !previous.isTextblock && !node.isTextblock) gap = offset;
    previous = node;
  });
  expect(gap).not.toBeNull();
  await act(() =>
    editor.view.dispatch(
      editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(gap!))),
    ),
  );
  const cursor = editor.view.dom.querySelector<HTMLElement>(".ProseMirror-gapcursor");
  expect(cursor).toBeInstanceOf(HTMLElement);
  cursor!.scrollIntoView({ block: "center" });
  await waitForLatexVisualTestReadiness(_fixture.host, context, "gap cursor layout");
  // Each pass redraws the cursor's widget; its first paint must not request the next pass.
  // The defect is a loop the browser paces one rendering step at a time, with no state to
  // wait on: only watching real frames shows it (4 extra passes in 10 frames before the fix).
  let passes = 0;
  const pass = () => passes++;
  editor.view.dom.addEventListener("scient-latex-layout", pass);
  _fixture.cleanup.defer(() => editor.view.dom.removeEventListener("scient-latex-layout", pass));
  for (let frame = 0; frame < 10; frame++)
    await waitForTestReceipt(
      context.signal,
      // oxlint-disable-next-line t3code/no-frame-waits-in-browser-tests -- observes a native-frame loop; see above.
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  expect(passes).toBe(0);
});

function _createFixture(context: TestContext) {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    context,
    host: undefined! as HTMLElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
