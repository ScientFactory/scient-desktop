import { render as _fixtureRender, type Screen, act, fakeTimers } from "../../../test/render";
import { useEffect, useState, type ReactNode } from "react";

import type { Editor } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { latexPageAt, latexPageMarkersKey, setLatexPageMarkers } from "./latexPageMarkers";
import { latexPagedKey, pagedLayoutSettled } from "./latexPagedGeometry";
import { rememberedLatexReadingBlock } from "./latexReadingPosition";
import { latexEquationReferencesKey, navigateToFootnote } from "./latexEquationReferences";
import {
  readMountedLatexVisualTestEditor,
  scrollLatexVisualTestEditor as scrollDelivered,
  useLatexVisualTestOwner,
} from "./latexVisualTestOwner";
import { clearVisualDraft } from "./visualDrafts";
import { latexBenchmarkDocument } from "./visualBenchmark/latexBenchmarkDocument";
import "./scient-latex.css";
import { projectLatexVisualDocument } from "./latexVisualDocument";

const source = latexBenchmarkDocument({ pages: 8 });

let published: string;
let publications = 0;
let key = "";
/** Changes the document's source as Source or another editor would. */

async function _setupFixture0(_fixture: _Fixture) {
  await page.viewport(1300, 950);
  _fixture.container = document.createElement("div");
  _fixture.container.style.cssText = "display:flex;flex-direction:column;width:1100px;height:900px";
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
  published = source;
  publications = 0;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await _fixture.root0.unmount();
  _fixture.container.remove();
  clearVisualDraft(key);
}

async function open(
  _fixture: _Fixture,
  draftKey: string,
  initial = source,
  loaded = true,
  controlledClock = true,
) {
  key = draftKey;
  published = initial;
  clearVisualDraft(key);
  function Harness() {
    const [value, setValue] = useState(initial);
    const owner = useLatexVisualTestOwner(value);
    useEffect(() => {
      _fixture.publishReplaceSource((next) => {
        published = next;
        setValue(next);
      });
    }, []);
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
          if (!outcome.accepted) return outcome;
          publications++;
          published = outcome.snapshot.source;
          setValue(published);
          return outcome;
        }}
      />
    );
  }
  await _fixture.root0.rerender(<Harness />);
  const editor = () => readMountedLatexVisualTestEditor(_fixture.container);
  await vi.waitFor(async () => expect(await editor()).toBeTruthy(), { timeout: 20000 });
  if (controlledClock) _fixture.clock ??= _fixture.stack.use(fakeTimers());
  if (!loaded) return editor()!;
  await vi.waitFor(
    async () =>
      expect(editor()!.view.editable && editor()!.view.dom.dataset.latexLoading !== "true").toBe(
        true,
      ),
    {
      timeout: 20000,
    },
  );
  return editor()!;
}

function scroller(editor: Editor) {
  return editor.view.dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
}

/** Counts programmatic scroll writes that do not come from caret-following. */
function watchScrollWrites(scroll: HTMLElement) {
  const writes: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(scroll, "scrollTop", {
    configurable: true,
    get: () => descriptor.get!.call(scroll),
    set: (value: number) => {
      const stack = new Error().stack ?? "";
      if (!/scrollRectIntoView|scrollToSelection/u.test(stack)) writes.push(stack);
      descriptor.set!.call(scroll, value);
    },
  });
  return {
    writes,
    stop: () => Reflect.deleteProperty(scroll, "scrollTop"),
  };
}

/** A visible prose paragraph in the upper half, and the visible block above it. */
function target(editor: Editor) {
  const view = editor.view;
  const box = scroller(editor).getBoundingClientRect();
  let found: { paragraph: number; above: number; caret: number } | null = null;
  let previous: number | null = null;
  view.state.doc.forEach((node, offset) => {
    if (found) return;
    const element = view.nodeDOM(offset);
    if (!(element instanceof HTMLElement)) return;
    const rect = element.getBoundingClientRect();
    const visible = rect.top >= box.top + 10 && rect.bottom <= box.bottom - 10;
    if (
      previous !== null &&
      node.type.name === "paragraph" &&
      node.textContent.length > 120 &&
      rect.top > box.top + box.height * 0.15 &&
      rect.top < box.top + box.height * 0.75
    ) {
      found = { paragraph: offset, above: previous, caret: offset + 40 };
      return;
    }
    if (visible) previous = offset;
  });
  return found as { paragraph: number; above: number; caret: number } | null;
}

/** Length of the source region that differs between two revisions. */
function changedLength(before: string, after: string) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return Math.max(before.length, after.length) - start - end;
}

/** Every formula preview rendered. Edits are measured apart from rendering. */
async function formulasRendered(_fixture: _Fixture) {
  await vi.waitFor(
    async () => {
      const editor = readMountedLatexVisualTestEditor(_fixture.container);
      expect(editor).not.toBeNull();
      let expected = 0;
      editor!.state.doc.descendants((node) => {
        if (node.type.name === "latexInlineMath" || node.type.name === "latexDisplayMath")
          expected++;
      });
      expect(expected).toBeGreaterThan(0);
      const previews = [...editor!.view.dom.querySelectorAll(".scient-latex-math-preview")];
      expect(previews).toHaveLength(expected);
      expect(
        previews.every((preview) =>
          preview.shadowRoot
            ?.querySelector("[data-math-preview-content]")
            ?.hasAttribute("data-math-preview-ready"),
        ),
      ).toBe(true);
    },
    { timeout: 20000 },
  );
  const editor = readMountedLatexVisualTestEditor(_fixture.container)!;
  await document.fonts.ready;
  await vi.waitFor(async () => expect(pagedLayoutSettled(editor.view)).toBe(true), {
    timeout: 20000,
  });
}

/** Samples the same native geometry at DOM, resize, scroll and layout publications. */
function observeLayout(root: HTMLElement, sample: () => void) {
  let deliveries = 0;
  const seen = new WeakSet<Element>();
  const receive = () => {
    deliveries++;
    sample();
  };
  const resize = new ResizeObserver(receive);
  const watch = () => {
    for (const element of [
      root,
      ...root.querySelectorAll(
        "p,.scient-latex-math-preview,.scient-latex-page-stage,.scient-latex-visual-document",
      ),
    ]) {
      if (seen.has(element)) continue;
      seen.add(element);
      resize.observe(element);
    }
  };
  const mutation = new MutationObserver(() => {
    watch();
    receive();
  });
  mutation.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  watch();
  for (const name of ["scroll", "scient-latex-layout", "scient-latex-selection-scope"])
    root.addEventListener(name, receive, true);
  sample();
  return async () => {
    try {
      await vi.waitFor(() => expect(deliveries).toBeGreaterThan(0));
      sample();
    } finally {
      mutation.disconnect();
      resize.disconnect();
      for (const name of ["scroll", "scient-latex-layout", "scient-latex-selection-scope"])
        root.removeEventListener(name, receive, true);
    }
  };
}

async function settleLayout(editor: Editor) {
  await act(() => vi.runOnlyPendingTimersAsync());
  await vi.waitFor(() => expect(pagedLayoutSettled(editor.view)).toBe(true));
}

async function scrollAndLayout(editor: Editor, change: () => void) {
  await scrollDelivered(editor, change);
  await settleLayout(editor);
}

it("remembers the first visible block when the viewport top is in a real page gap", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const initial = String.raw`\documentclass{article}
\pagestyle{empty}
\begin{document}
First page marker.

\newpage

Second page marker.

\newpage

Third page marker.
\end{document}`;
  const readingKey = "visual-stability-page-gap";
  const editor = await open(_fixture, readingKey, initial);
  await document.fonts.ready;
  await settleLayout(editor);
  const scroll = scroller(editor);
  const sheets = scroll.querySelectorAll<HTMLElement>(".scient-latex-page-sheet");
  expect(sheets).toHaveLength(3);
  const markers = new Map<string, { index: number; element: HTMLElement }>();
  editor.state.doc.forEach((node, position, index) => {
    const element = editor.view.nodeDOM(position);
    if (node.type.name === "paragraph" && element instanceof HTMLElement)
      markers.set(node.textContent, { index, element });
  });
  const first = markers.get("First page marker.")!;
  const second = markers.get("Second page marker.")!;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(second.index).toBeGreaterThan(0);
  const gapStart = sheets[0]!.getBoundingClientRect().bottom;
  const gapEnd = sheets[1]!.getBoundingClientRect().top;
  expect(gapEnd - gapStart).toBeGreaterThan(2);
  const box = scroll.getBoundingClientRect();
  const offset = scroll.scrollTop + (gapStart + gapEnd) / 2 - (box.top + 1);
  expect(offset).toBeGreaterThan(scroll.scrollTop);
  expect(offset).toBeLessThan(scroll.scrollHeight - scroll.clientHeight);
  let receipt: { trusted: boolean; owned: boolean } | undefined;
  const receive = (event: Event) => {
    receipt = { trusted: event.isTrusted, owned: event.target === scroll };
  };
  scroll.addEventListener("scroll", receive, { once: true });
  _fixture.cleanup.defer(() => scroll.removeEventListener("scroll", receive));
  await scrollDelivered(editor, () => {
    scroll.scrollTop = offset;
  });
  expect(receipt).toEqual({ trusted: true, owned: true });
  expect(scroll.scrollTop).toBeCloseTo(offset, 0);
  const paper = editor.view.dom.getBoundingClientRect();
  expect(document.elementFromPoint(paper.left + paper.width / 2, box.top + 1)).toBe(
    editor.view.dom,
  );
  expect(first.element.getBoundingClientRect().bottom).toBeLessThan(box.top + 1);
  const visible = second.element.getBoundingClientRect();
  expect(visible.top).toBeGreaterThan(box.top + 1);
  expect(visible.bottom).toBeLessThan(box.bottom);
  await vi.waitFor(() => expect(rememberedLatexReadingBlock(readingKey)).toBe(second.index));
});

function topOf(editor: Editor, position: number) {
  const element = editor.view.nodeDOM(position);
  return element instanceof HTMLElement ? element.getBoundingClientRect().top : Number.NaN;
}

it("moves from section controls into Math and preserves both edits", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const initial = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
New heading

Body text.
\end{document}`;
  const editor = await open(_fixture, "visual-section-to-math", initial, true, false);
  editor.commands.setTextSelection(2);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("menuitem", { name: "Paragraph style", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^Section(?:\s|$)/u }).click();
  await vi.waitFor(async () => expect(published).toContain("\\section{New heading}"));
  let body = 0;
  editor.state.doc.forEach((node, position) => {
    if (node.type.name === "paragraph" && node.textContent === "Body text.")
      body = position + node.nodeSize - 1;
  });
  expect(body).toBeGreaterThan(0);
  editor.commands.setTextSelection(body);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("menuitem", { name: "Paragraph style", exact: true }).click();
  await page.getByRole("button", { name: "Math", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Inline math", exact: true }).click();
  await vi.waitFor(async () => expect(_fixture.container.querySelector("math-field")).toBeTruthy());
  await userEvent.keyboard("x+1");
  // About 220 ms locally; slow CI runners take several times longer.
  await vi.waitFor(async () => expect(published).toContain("x+1"), {
    timeout: 5000,
  });
  expect(published).toContain("\\section{New heading}");
  expect(published).toContain("Body text.");
});

it("opens without publishing source or creating undo history", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-open");
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(publications).toBe(0);
  expect(published).toBe(source);
  expect(undoDepth(editor.state)).toBe(0);
  expect(_fixture.container.querySelector("[aria-busy='true']")).toBeNull();
  // Forward references are numbered from the whole document, not left as keys.
  expect(editor.view.dom.textContent).not.toMatch(/\[eq:bench-\d+\]/u);
  // Progressive loading ends with exactly the parsed document.
  const parsed = editor.schema.nodeFromJSON(projectLatexVisualDocument(source).content);
  expect(editor.state.doc.eq(parsed)).toBe(true);
});

it("a structural edit after opening rewrites only its own source", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-local-edit");
  let last = 0;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "paragraph") last = offset + node.nodeSize;
  });
  editor.commands.insertContentAt(last, {
    type: "paragraph",
    content: [{ type: "text", text: "Closing remark." }],
  });
  await vi.waitFor(async () => expect(published).toContain("Closing remark."), {
    timeout: 5000,
  });
  expect(changedLength(source, published)).toBeLessThan("Closing remark.".length + 8);
});

it("typing, splitting and joining keep content above still without app scrolling", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-typing");
  await document.fonts.ready;
  await formulasRendered(_fixture);
  const scroll = scroller(editor);
  // Page gaps and paragraphs crossing pages can fill the middle of one scroll
  // position; step past them to a long paragraph with a block visible above it.
  let found: ReturnType<typeof target> = null;
  for (const fraction of [0.4, 0.43, 0.46, 0.49, 0.52]) {
    await scrollAndLayout(editor, () => {
      scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * fraction;
    });
    found = target(editor);
    if (found) break;
  }
  expect(found).not.toBeNull();
  const { above, paragraph, caret } = found!;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(caret))),
  );
  editor.view.focus();
  const aboveTop = topOf(editor, above);
  const paragraphTop = topOf(editor, paragraph);
  const watch = watchScrollWrites(scroll);
  let moved = 0;
  const stopSampling = observeLayout(_fixture.container, () => {
    moved = Math.max(
      moved,
      Math.abs(topOf(editor, above) - aboveTop),
      Math.abs(topOf(editor, paragraph) - paragraphTop),
    );
  });
  try {
    await userEvent.keyboard("steady words ");
    await vi.waitFor(async () => expect(published).toContain("steady words "), {
      timeout: 5000,
    });
    expect(changedLength(source, published)).toBe("steady words ".length);
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("New paragraph.");
    for (let index = 0; index < 15; index++) await userEvent.keyboard("{Backspace}");
    await act(() => vi.advanceTimersByTimeAsync(800));
  } finally {
    await stopSampling();
    watch.stop();
  }
  expect(moved).toBeLessThan(1);
  expect(watch.writes).toEqual([]);
  await vi.waitFor(async () => expect(published).toContain("steady words "));
  while (undoDepth(editor.state) > 0) editor.commands.undo();
  await vi.waitFor(async () => expect(published).toBe(source), { timeout: 5000 });
});

it("splitting and joining preserve a paragraph's planned negative flow offset", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-negative-offset");
  await document.fonts.ready;
  await formulasRendered(_fixture);
  const paragraphs: number[] = [];
  editor.state.doc.forEach((node, position) => {
    const element = editor.view.nodeDOM(position);
    if (
      node.type.name !== "paragraph" ||
      node.textContent.length <= 120 ||
      !(element instanceof HTMLElement)
    )
      return;
    const offset = Number.parseFloat(element.style.getPropertyValue("--scient-paged-flow-offset"));
    if (offset < -1) paragraphs.push(position);
  });
  expect(paragraphs.length).toBeGreaterThan(0);
  const paragraph = paragraphs[0]!;
  const scroll = scroller(editor);
  await scrollAndLayout(editor, () => {
    scroll.scrollTop += topOf(editor, paragraph) - scroll.getBoundingClientRect().top - 200;
  });
  const element = editor.view.nodeDOM(paragraph);
  expect(element).toBeInstanceOf(HTMLElement);
  const offset = Number.parseFloat(
    (element as HTMLElement).style.getPropertyValue("--scient-paged-flow-offset"),
  );
  expect(offset).toBeLessThan(-1);
  const node = editor.state.doc.nodeAt(paragraph)!;
  let caret = 0;
  node.forEach((child, at) => {
    if (!caret && child.isText && child.textContent.length > 40) caret = paragraph + 1 + at + 20;
  });
  expect(caret).toBeGreaterThan(paragraph);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(caret))),
  );
  editor.view.focus();
  const initialTop = topOf(editor, paragraph);
  const watch = watchScrollWrites(scroll);
  let moved = 0;
  const stopSampling = observeLayout(_fixture.container, () => {
    moved = Math.max(moved, Math.abs(topOf(editor, paragraph) - initialTop));
  });
  try {
    await userEvent.keyboard("steady words ");
    await vi.waitFor(async () => expect(published).toContain("steady words "), { timeout: 5000 });
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("New paragraph.");
    for (let index = 0; index < 15; index++) await userEvent.keyboard("{Backspace}");
    await act(() => vi.advanceTimersByTimeAsync(800));
  } finally {
    await stopSampling();
    watch.stop();
  }
  expect(moved).toBeLessThan(1);
  expect(watch.writes).toEqual([]);
  while (undoDepth(editor.state) > 0) editor.commands.undo();
  await vi.waitFor(async () => expect(published).toBe(source), { timeout: 5000 });
});

it("planned negative offsets map only to retained paragraphs", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-offset-mapping");
  await document.fonts.ready;
  await formulasRendered(_fixture);
  const presentation = latexPagedKey.getState(editor.state)!;
  const decoration = presentation.decorations.find().find((candidate) => {
    const node = editor.state.doc.nodeAt(candidate.from);
    return (
      typeof candidate.spec.latexFlowOffset === "number" &&
      node?.type.name === "paragraph" &&
      node.firstChild?.isText &&
      node.firstChild.textContent.length > 40
    );
  });
  expect(decoration).toBeDefined();
  const paragraph = decoration!.from;
  const node = editor.state.doc.nodeAt(paragraph)!;
  const caret = paragraph + 21;
  const plugin = editor.state.plugins.find((candidate) => candidate.spec.key === latexPagedKey)!;
  const empty = EditorState.create({ doc: editor.state.doc, plugins: [plugin] });
  const initial = empty.apply(empty.tr.setMeta(latexPagedKey, presentation));
  const offsets = (state: EditorState) =>
    latexPagedKey
      .getState(state)!
      .decorations.find(paragraph, paragraph, (spec) => typeof spec.latexFlowOffset === "number")
      .filter((candidate) => candidate.from === paragraph)
      .map((candidate) => Number(candidate.spec.latexFlowOffset));
  const expected = [Number(decoration!.spec.latexFlowOffset)];
  expect(offsets(initial.apply(initial.tr.insertText("words ", caret)))).toEqual(expected);
  const split = initial.apply(initial.tr.split(caret));
  expect(offsets(split)).toEqual(expected);
  const joined = split.apply(split.tr.join(paragraph + split.doc.nodeAt(paragraph)!.nodeSize));
  expect(offsets(joined)).toEqual(expected);
  const replaced = initial.apply(
    initial.tr.replaceWith(
      paragraph,
      paragraph + node.nodeSize,
      node.type.create(null, editor.schema.text("Replacement paragraph.")),
    ),
  );
  expect(offsets(replaced)).toEqual([]);
});

it("formulas finishing above the reading area do not move it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-rendering");
  await document.fonts.ready;
  const scroll = scroller(editor);
  await scrollDelivered(editor, () => {
    scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * 0.6;
  });
  await settleLayout(editor);
  const box = scroll.getBoundingClientRect();
  const reading = [...editor.view.dom.children].find(
    (element) => element.getBoundingClientRect().bottom > box.top + 1,
  )!;
  const start = reading.getBoundingClientRect().top;
  let moved = 0;
  const stop = observeLayout(_fixture.container, () => {
    moved = Math.max(moved, Math.abs(reading.getBoundingClientRect().top - start));
  });
  await formulasRendered(_fixture);
  await act(() => vi.advanceTimersByTimeAsync(300));
  await stop();
  expect(moved).toBeLessThan(1);
});

it("PDF page markers follow edits, become stale and disappear with their text", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-markers");
  const paragraphs: number[] = [];
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "paragraph") paragraphs.push(offset);
  });
  const [first, second, third] = [paragraphs[2]!, paragraphs[10]!, paragraphs[20]!];
  setLatexPageMarkers(editor.view, {
    key: "build-1",
    pageCount: 3,
    anchors: [
      { page: 1, position: first },
      { page: 2, position: second },
      { page: 3, position: third },
    ],
  });
  expect(editor.view.dom.querySelectorAll(".scient-latex-page-marker")).toHaveLength(3);
  const height = editor.view.dom.getBoundingClientRect().height;
  expect(latexPageAt(editor.state, second + 1)).toBe(2);
  expect(latexPageMarkersKey.getState(editor.state)?.stale).toBe(false);
  // Markers take no space.
  setLatexPageMarkers(editor.view, null);
  expect(Math.abs(editor.view.dom.getBoundingClientRect().height - height)).toBeLessThan(1);
  setLatexPageMarkers(editor.view, {
    key: "build-1",
    pageCount: 3,
    anchors: [
      { page: 1, position: first },
      { page: 2, position: second },
      { page: 3, position: third },
    ],
  });
  editor.view.dispatch(editor.state.tr.insertText("Inserted. ", first + 1));
  const state = latexPageMarkersKey.getState(editor.state)!;
  expect(state.stale).toBe(true);
  expect(editor.view.dom.dataset.latexPagesStale).toBe("true");
  expect(state.anchors.map((anchor) => anchor.page)).toEqual([1, 2, 3]);
  expect(editor.state.doc.nodeAt(state.anchors[1]!.position)?.type.name).toBe("paragraph");
  const page2 = state.anchors[1]!.position;
  const node = editor.state.doc.nodeAt(page2)!;
  editor.view.dispatch(editor.state.tr.delete(page2, page2 + node.nodeSize));
  expect(latexPageMarkersKey.getState(editor.state)!.anchors.map((anchor) => anchor.page)).toEqual([
    1, 3,
  ]);
  expect(editor.view.dom.querySelectorAll(".scient-latex-page-marker")).toHaveLength(2);
});

it("shows each block's footnotes beneath it and redraws only notes that change", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(
    _fixture,
    "visual-stability-footnotes",
    String.raw`\documentclass{article}
\begin{document}
A noted paragraph\footnote{The \emph{first} note.} with more text.

A paragraph without notes.

Another paragraph\footnote{Second note.} ends here\footnote{Third note.}.
\end{document}
`,
  );
  const bands = () => [
    ...editor.view.dom.querySelectorAll<HTMLElement>(":scope > .scient-latex-footnotes"),
  ];
  const markers: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "latexInlineCommand" && node.attrs.name === "footnote")
      markers.push(position);
  });
  expect(markers).toHaveLength(3);
  const [first, second] = bands();
  expect(bands()).toHaveLength(2);
  expect(first!.previousElementSibling!.textContent).toContain("A noted paragraph");
  expect(first!.textContent).toBe("1The first note.");
  expect(first!.querySelector("em")?.textContent).toBe("first");
  expect(second!.previousElementSibling!.textContent).toContain("Another paragraph");
  expect([...second!.children].map((row) => row.textContent)).toEqual([
    "2Second note.",
    "3Third note.",
  ]);

  // Typing anywhere, including in a noted paragraph, keeps the bands.
  let plain = 0;
  editor.state.doc.forEach((node, offset) => {
    if (node.textContent.startsWith("A paragraph without")) plain = offset;
  });
  editor.view.dispatch(editor.state.tr.insertText("Typed ", plain + 1));
  editor.view.dispatch(editor.state.tr.insertText("Typed ", 1));
  expect(bands()).toEqual([first, second]);

  // A marker leads to its note, and the note back to its marker. Both
  // insertions above came before the second paragraph's markers.
  const shifted = markers.map((position, index) => position + (index === 0 ? 6 : 12));
  expect(navigateToFootnote(editor.view, shifted[2]!)).toBe(true);
  expect(second!.children[1]!.hasAttribute("data-reference-highlight")).toBe(true);
  (second!.children[0] as HTMLElement).click();
  expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  expect(editor.state.selection.from).toBe(shifted[1]);

  // Changing a note redraws only its own band.
  const marker = editor.state.selection.from;
  const node = editor.state.doc.nodeAt(marker)!;
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(marker, undefined, {
      ...node.attrs,
      argument: "Changed note.",
      raw: String.raw`\footnote{Changed note.}`,
    }),
  );
  await vi.waitFor(async () => expect(bands()[1]?.textContent).toBe("2Changed note.3Third note."));
  expect(bands()[0]).toBe(first);
});

it("renumbers equations and their references when an equation moves above another", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const sentence = String.raw`See \eqref{eq:a} and \eqref{eq:b}.`;
  const equation = (name: string, body: string) =>
    String.raw`\begin{equation}${body}\label{eq:${name}}\end{equation}`;
  const document = (...blocks: string[]) =>
    String.raw`\documentclass{article}
\begin{document}
${blocks.join("\n\n")}
\end{document}
`;
  const editor = await open(
    _fixture,
    "visual-stability-renumber",
    document(equation("a", "a=1"), sentence, equation("b", "b=2")),
  );
  const numbers = () =>
    [...editor.view.dom.querySelectorAll(".scient-latex-equation-numbers")].map(
      (band) => band.textContent,
    );
  const references = () =>
    [...editor.view.dom.querySelectorAll(".scient-latex-equation-reference")].map(
      (reference) => reference.textContent,
    );
  await vi.waitFor(async () => expect(await numbers()).toEqual(["(1)", "(2)"]));
  await vi.waitFor(async () => expect(await references()).toEqual(["(1)", "(2)"]));
  // The second equation moves above the first in the source; the sentence
  // that refers to both is unchanged.
  await act(() =>
    _fixture.replaceSource(document(equation("b", "b=2"), equation("a", "a=1"), sentence)),
  );
  const formulas = () => {
    const found: string[] = [];
    editor.state.doc.forEach((node) => {
      if (node.type.name === "latexDisplayMath") found.push(String(node.attrs.tex));
    });
    return found;
  };
  await vi.waitFor(async () => expect(await formulas()).toEqual(["b=2", "a=1"]));
  await vi.waitFor(async () => expect(await numbers()).toEqual(["(1)", "(2)"]));
  await vi.waitFor(async () => expect(await references()).toEqual(["(2)", "(1)"]));
});

const equationNumbers = (editor: Editor) =>
  [...editor.view.dom.querySelectorAll(".scient-latex-equation-numbers")].map(
    (band) => band.textContent,
  );

it("numbers the new document when another revision arrives while loading", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(
    _fixture,
    "visual-stability-revision-while-loading",
    latexBenchmarkDocument({ pages: 60 }),
    false,
  );
  expect(editor.view.dom.dataset.latexLoading).toBe("true");
  await act(() =>
    _fixture.replaceSource(String.raw`\documentclass{article}
\begin{document}
\begin{equation}a=1\label{eq:a}\end{equation}

\begin{equation}b=2\label{eq:b}\end{equation}

See \eqref{eq:b} and \eqref{eq:a}.
\end{document}
`),
  );
  await vi.waitFor(async () => expect(editor.view.dom.dataset.latexLoading).toBeUndefined());
  await vi.waitFor(async () => expect(equationNumbers(editor)).toEqual(["(1)", "(2)"]));
  await vi.waitFor(async () =>
    expect(
      [...editor.view.dom.querySelectorAll(".scient-latex-equation-reference")].map(
        (reference) => reference.textContent,
      ),
    ).toEqual(["(2)", "(1)"]),
  );
  const labels = latexEquationReferencesKey.getState(editor.state)!.labels;
  expect([...labels.keys()].toSorted()).toEqual(["eq:a", "eq:b"]);
});

it("numbers equations before the reading position when a document reopens there", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  let editor = await open(_fixture, "visual-stability-reopen");
  await formulasRendered(_fixture);
  const expected = equationNumbers(editor);
  expect(expected.length).toBeGreaterThan(10);
  const scroll = scroller(editor);
  await scrollAndLayout(editor, () => {
    scroll.scrollTop = scroll.scrollHeight * 0.7;
  });
  await vi.waitFor(() =>
    expect(rememberedLatexReadingBlock("visual-stability-reopen")).toBeGreaterThan(0),
  );
  await _fixture.root0.rerender(<></>);
  editor = await open(_fixture, "visual-stability-reopen");
  await settleLayout(editor);
  // It opened at the remembered block and loaded the blocks before it.
  expect(scroller(editor).scrollTop).toBeGreaterThan(0);
  await vi.waitFor(async () => expect(equationNumbers(editor)).toEqual(expected), {
    timeout: 20000,
  });
});

it("keeps the line at the top still when text above it grows its own paragraph", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-line-anchor");
  await formulasRendered(_fixture);
  const scroll = scroller(editor);
  // A paragraph several lines tall, its second line at the top of the reading area.
  let paragraph = -1;
  editor.state.doc.forEach((node, offset) => {
    if (paragraph < 0 && node.type.name === "paragraph" && node.textContent.length > 400)
      paragraph = offset;
  });
  expect(paragraph).toBeGreaterThan(0);
  const element = editor.view.nodeDOM(paragraph) as HTMLElement;
  await scrollAndLayout(editor, () => {
    element.scrollIntoView({ block: "start" });
    scroll.scrollTop += 40;
  });
  const box = scroll.getBoundingClientRect();
  const position = editor.view.posAtCoords({
    left: box.left + box.width / 2,
    top: box.top + 1,
  })!.pos;
  const before = editor.view.coordsAtPos(position).top;
  const inserted = "More words before the reading line. ".repeat(6);
  editor.view.dispatch(editor.state.tr.insertText(inserted, paragraph + 1));
  await settleLayout(editor);
  expect(Math.abs(editor.view.coordsAtPos(position + inserted.length).top - before)).toBeLessThan(
    1,
  );
});

it("returns to where a document that opens at once was read", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const long = String.raw`\documentclass{article}
\begin{document}
${"A single long paragraph that is read part of the way down. ".repeat(110)}
\end{document}
`;
  let editor = await open(_fixture, "visual-stability-short-reopen", long);
  expect(editor.view.dom.dataset.latexLoading).toBeUndefined();
  // A reader scrolls the laid-out document: its font and pages are in place.
  await document.fonts.ready;
  await vi.waitFor(async () => expect(pagedLayoutSettled(editor.view)).toBe(true), {
    timeout: 20000,
  });
  await scrollAndLayout(editor, () => {
    scroller(editor).scrollTop = 300;
  });
  await _fixture.root0.rerender(<></>);
  editor = await open(_fixture, "visual-stability-short-reopen", long);
  // Where reading resumes once the pages are laid out; a busy runner can still
  // be placing them three frames after opening.
  await vi.waitFor(async () => expect(pagedLayoutSettled(editor.view)).toBe(true), {
    timeout: 20000,
  });
  await settleLayout(editor);
  expect(Math.abs(scroller(editor).scrollTop - 300)).toBeLessThan(2);
});

it("keeps a scroll made before the reading line is taken again, corrects drift, and ignores clamping", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture, "visual-stability-scroll-then-layout");
  await formulasRendered(_fixture);
  const scroll = scroller(editor);
  // Content above everything grows, and pages settle, right after a scroll:
  // in the same task (a restored position, the caret followed) or from the
  // scroll event, before the next frame takes the new reading line.
  const spacers: HTMLElement[] = [];
  const growAndSettle = () => {
    const spacer = document.createElement("div");
    spacer.style.height = "80px";
    editor.view.dom.before(spacer);
    spacers.push(spacer);
    editor.view.dom.dispatchEvent(new CustomEvent("scient-latex-layout"));
  };
  // Blocks shown for the first time can still settle their heights.
  const settled = () => settleLayout(editor);
  for (const during of ["task", "scroll event"]) {
    await scrollAndLayout(editor, () => {
      scroll.scrollTop = 400;
    });
    // Where the text is once scrolled, the growth above corrected away.
    const expected = editor.view.dom.getBoundingClientRect().top - 1200;
    if (during === "scroll event") scroll.addEventListener("scroll", growAndSettle, { once: true });
    await scrollAndLayout(editor, () => {
      scroll.scrollTop += 1200;
      if (during === "task") growAndSettle();
    });
    expect(Math.abs(editor.view.dom.getBoundingClientRect().top - expected), during).toBeLessThan(
      2,
    );
  }
  // At the end, content shrinking above clamps the scroll range once the
  // paper's frame follows it: the text read stays where it is rather than
  // counting the clamp as a reading move.
  const frame = editor.view.dom.closest<HTMLElement>(".scient-latex-page-zoom-frame")!;
  const stage = frame.querySelector<HTMLElement>(".scient-latex-page-stage")!;
  await vi.waitFor(() =>
    expect(frame.getBoundingClientRect().height).toBeCloseTo(
      stage.getBoundingClientRect().height,
      0,
    ),
  );
  await scrollAndLayout(editor, () => {
    scroll.scrollTop = scroll.scrollHeight;
  });
  // Revealing the final blocks changes the range; establish the clamp baseline in that range.
  await scrollAndLayout(editor, () => {
    scroll.scrollTop = scroll.scrollHeight;
  });
  await vi.waitFor(() =>
    expect(scroll.scrollTop).toBeCloseTo(scroll.scrollHeight - scroll.clientHeight, 0),
  );
  const box = scroll.getBoundingClientRect();
  const line = editor.view.posAtCoords({
    left: box.left + box.width / 2,
    top: box.top + box.height / 3,
  })!.pos;
  const end = editor.view.coordsAtPos(line).top;
  // Pages set with other fonts (Linux CI) can end on a blank stretch of the
  // last page: with no text in view there is no reading line to keep.
  if (end < box.top || end > box.bottom) return;
  for (const spacer of spacers) spacer.remove();
  // The frame follows the paper and pages settle, as the stage observer does
  // at its resize delivery (which a busy runner can defer or skip here).
  frame.style.height = `${stage.getBoundingClientRect().height}px`;
  editor.view.dom.dispatchEvent(new CustomEvent("scient-latex-layout"));
  await settled();
  expect(Math.abs(editor.view.coordsAtPos(line).top - end)).toBeLessThan(2);
});

it("renumbers a reference in an unchanged title when labels change places", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const document = (first: string, second: string) => String.raw`\documentclass{article}
\usepackage{amsthm}
\newtheorem{theorem}{Theorem}
\begin{document}
\begin{equation}a=1\label{eq:${first}}\end{equation}

\begin{equation}b=2\label{eq:${second}}\end{equation}

\begin{theorem}[After \eqref{eq:b}]
A statement.
\end{theorem}
\end{document}
`;
  const editor = await open(_fixture, "visual-stability-swapped-labels", document("a", "b"));
  const reference = () =>
    editor.view.dom.querySelector('[data-latex-prose-text="[eq:b]"]')?.textContent;
  await vi.waitFor(async () => expect(await reference()).toBe("(2)"));
  await act(() => _fixture.replaceSource(document("b", "a")));
  await vi.waitFor(async () => expect(await reference()).toBe("(1)"));
});

it("moves a footnote band with its note when the paragraph is split after it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(
    _fixture,
    "visual-stability-footnote-split",
    String.raw`\documentclass{article}
\begin{document}
A noted paragraph\footnote{The note.} with more text after the note.
\end{document}
`,
  );
  let marker = -1;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "latexInlineCommand" && node.attrs.name === "footnote")
      marker = position;
  });
  const blocks = editor.state.doc.childCount;
  editor.view.dispatch(editor.state.tr.split(marker + 1));
  expect(editor.state.doc.childCount).toBe(blocks + 1);
  const band = () => editor.view.dom.querySelector(":scope > .scient-latex-footnotes");
  await vi.waitFor(async () =>
    expect(band()?.previousElementSibling?.textContent ?? "").toContain("A noted paragraph"),
  );
  expect(navigateToFootnote(editor.view, marker)).toBe(true);
});

it("keeps a footnote band with its note when text after the note is replaced by paragraphs", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(
    _fixture,
    "visual-stability-footnote-replace",
    String.raw`\documentclass{article}
\begin{document}
A noted paragraph\footnote{The note.} with more text.

The following paragraph.
\end{document}
`,
  );
  let marker = -1;
  let following = -1;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "latexInlineCommand" && node.attrs.name === "footnote")
      marker = position;
  });
  editor.state.doc.forEach((node, offset) => {
    if (node.textContent.startsWith("The following")) following = offset;
  });
  const paragraph = (text: string) =>
    editor.schema.nodes.paragraph!.create(null, editor.schema.text(text));
  const blocks = editor.state.doc.childCount;
  editor.view.dispatch(
    editor.state.tr.replace(
      marker + 1,
      following + 1,
      new Slice(Fragment.from([paragraph("Pasted one."), paragraph("Pasted two")]), 1, 1),
    ),
  );
  expect(editor.state.doc.childCount).toBe(blocks);
  const band = () => editor.view.dom.querySelector(":scope > .scient-latex-footnotes");
  await vi.waitFor(async () =>
    expect(band()?.previousElementSibling?.textContent ?? "").toContain("A noted paragraph"),
  );
  expect(navigateToFootnote(editor.view, marker)).toBe(true);
});

it("draws the band again when a noted paragraph is replaced by one with the same note", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(
    _fixture,
    "visual-stability-footnote-same-note",
    String.raw`\documentclass{article}
\begin{document}
A noted paragraph\footnote{The note.} with more text.

The following paragraph.
\end{document}
`,
  );
  let noted = -1;
  editor.state.doc.forEach((node, offset) => {
    if (noted < 0 && node.textContent.startsWith("A noted")) noted = offset;
  });
  const copy = editor.state.doc.nodeAt(noted)!;
  editor.view.dispatch(
    editor.state.tr.replaceWith(noted, noted + copy.nodeSize, copy.copy(copy.content)),
  );
  const band = () => editor.view.dom.querySelector(":scope > .scient-latex-footnotes");
  await vi.waitFor(async () => expect(band()?.textContent ?? "").toBe("1The note."));
});

it("keeps a run-in heading beside its paragraph when a page marker sits between them", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(
    _fixture,
    "visual-stability-run-in-marker",
    String.raw`\documentclass{article}
\begin{document}
\paragraph{Run-in}
${"Text that follows the run-in heading on the same line. ".repeat(8)}
\end{document}
`,
  );
  let paragraph = -1;
  editor.state.doc.forEach((node, offset) => {
    if (node.textContent.startsWith("Text that follows")) paragraph = offset;
  });
  const heading = editor.view.dom.querySelector<HTMLElement>("h4, h5")!;
  await vi.waitFor(async () => expect(editor.view.dom.closest("[data-paged]")).toBeTruthy());
  const floated = getComputedStyle(heading).float;
  setLatexPageMarkers(editor.view, {
    key: "build-run-in",
    pageCount: 2,
    anchors: [
      { page: 1, position: 0 },
      { page: 2, position: paragraph },
    ],
  });
  expect(editor.view.dom.querySelector(".scient-latex-page-marker")).toBeTruthy();
  expect(getComputedStyle(heading).float).toBe(floated);
  expect(floated).toBe("left");
  expect(
    Math.abs(editor.view.coordsAtPos(paragraph + 1).top - heading.getBoundingClientRect().top),
  ).toBeLessThan(3);
});

it.each([String.raw`\columnbreak`, String.raw`\columnbreak[4]`])(
  "breaks the column after the line an inline %s ends, and again after typing",
  async (command) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const words = (prefix: string) =>
      Array.from({ length: 40 }, (_, index) => `${prefix}${index}`).join(" ");
    const editor = await open(
      _fixture,
      `visual-stability-column-break-${command.length}`,
      String.raw`\documentclass{article}
\usepackage{multicol}
\begin{document}
\begin{multicols}{2}
${words("first")} ${command} ${words("later")}

Closing paragraph.
\end{multicols}
\end{document}
`,
    );
    const content = () =>
      editor.view.dom.querySelector<HTMLElement>(
        '.scient-latex-page-layout[data-layout="columns"] > .scient-latex-page-layout-body > [data-node-view-content-react]',
      )!;
    const marker = () =>
      editor.view.dom.querySelector<HTMLElement>(".scient-latex-inline-column-break")!;
    /** Whether the word's first character is in the second column. */
    const inSecondColumn = (word: string) => {
      const walker = document.createTreeWalker(content(), NodeFilter.SHOW_TEXT);
      let text: Node | null;
      while ((text = walker.nextNode())) {
        const at = text.textContent!.indexOf(word);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + 1);
        const bounds = content().getBoundingClientRect();
        return range.getBoundingClientRect().left > bounds.left + bounds.width / 2;
      }
      throw new Error(`${word} not found`);
    };
    await vi.waitFor(async () =>
      expect(editor.view.dom.querySelectorAll(".scient-latex-column-break-gap").length).toBe(1),
    );
    // The command's own line stays in the first column; everything after it moves.
    expect(
      marker().getBoundingClientRect().left <
        content().getBoundingClientRect().left + content().getBoundingClientRect().width / 2,
    ).toBe(true);
    await vi.waitFor(async () => expect(inSecondColumn("later39")).toBe(true));
    expect(inSecondColumn("first0")).toBe(false);
    // Typing before the command rewraps its paragraph; the break follows the new line.
    let start = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text!.startsWith("first0")) start = position;
    });
    editor.chain().setTextSelection(start).insertContent("inserted words ".repeat(8)).run();
    await vi.waitFor(async () => expect(published).toContain("inserted words"), {
      timeout: 5000,
    });
    await vi.waitFor(async () =>
      expect(editor.view.dom.querySelectorAll(".scient-latex-column-break-gap").length).toBe(1),
    );
    await vi.waitFor(async () => expect(inSecondColumn("later39")).toBe(true));
    expect(inSecondColumn("first0")).toBe(false);
    expect(published).toContain(command);
  },
);

it("keeps an open footnote editor above the next line set against a short display", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const note = "A note long enough to wrap over several lines in its editor. ".repeat(4);
  const editor = await open(
    _fixture,
    "visual-stability-raised-footnote",
    String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Short\footnote{${note}}.
\[a=b\]
Next.
\[c=d\]
Later.
\[e=f\]
After.
\end{document}
`,
  );
  await vi.waitFor(async () =>
    expect(editor.view.dom.querySelectorAll("[data-short-display]").length).toBeGreaterThan(1),
  );
  await page
    .getByRole("button", { name: "Return to footnote 1 marker", exact: true })
    .nth(0)
    .click();
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const field = await vi
    .waitFor(async () =>
      expect(
        editor.view.dom.querySelector<HTMLElement>('[aria-label="Footnote text"]'),
      ).toBeTruthy(),
    )
    .then(() => editor.view.dom.querySelector<HTMLElement>('[aria-label="Footnote text"]')!);
  await settleLayout(editor);
  // Every point of the open editor belongs to it, including where it reaches
  // over the lines and displays below its own paragraph.
  await vi.waitFor(() => {
    const box = field.getBoundingClientRect();
    for (const fraction of [0.25, 0.5, 0.75, 0.95]) {
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height * fraction,
      );
      expect(hit && field.contains(hit), `at ${fraction}`).toBe(true);
    }
  });
});

it("raises a line holding a formula being edited above later lines set against short displays", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(
    _fixture,
    "visual-stability-raised-formula",
    String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Short $x^2$.
\[a=b\]
Next.
\[c=d\]
After.
\end{document}
`,
  );
  const lines = () =>
    [...editor.view.dom.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLParagraphElement && getComputedStyle(child).position === "relative",
    );
  await vi.waitFor(async () => expect(lines().length).toBe(2));
  const [first, next] = lines();
  expect(getComputedStyle(first!).zIndex).toBe("1");
  await userEvent.click(first!.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await vi.waitFor(async () =>
    expect(first!.querySelector("math-field")?.matches(":focus-within")).toBe(true),
  );
  // Its formula's editing surfaces must not be painted over by the next raised line.
  expect(getComputedStyle(first!).zIndex).toBe("2");
  expect(getComputedStyle(next!).zIndex).toBe("1");
});

it("keeps a list uncontained while a footnote inside it is being edited", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const filler = Array.from({ length: 30 }, (_, index) => `Filler paragraph ${index}.`).join(
    "\n\n",
  );
  const editor = await open(
    _fixture,
    "visual-stability-nested-footnote",
    String.raw`\documentclass{article}
\begin{document}
${filler}

\begin{itemize}
\item First item.
\item Last item\footnote{A note long enough to wrap over several lines in its editor, so that it reaches past the bottom of the list it belongs to and would be clipped by containment.}.
\end{itemize}

After the list.
\end{document}
`,
  );
  const list = () =>
    [...editor.view.dom.children].find((child) => child.querySelector("li")) as HTMLElement;
  expect(getComputedStyle(list()).contentVisibility).toBe("auto");
  await page
    .getByRole("button", { name: "Return to footnote 1 marker", exact: true })
    .nth(0)
    .click();
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  await vi.waitFor(async () =>
    expect(editor.view.dom.querySelector('[aria-label="Footnote text"]')).toBeTruthy(),
  );
  expect(list().querySelector("[data-footnote-editor]")).toBeTruthy();
  expect(getComputedStyle(list()).contentVisibility).toBe("visible");
});

it("shows a two-column document in printable-width columns", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const paragraph = (name: string) =>
    `${name} ${Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ")}`;
  const editor = await open(
    _fixture,
    "visual-stability-twocolumn",
    String.raw`\documentclass[twocolumn]{article}
\begin{document}
${paragraph("Opening")}

${paragraph("Following")}
\end{document}
`,
  );
  const paragraphs = [
    ...editor.view.dom.querySelectorAll<HTMLElement>(
      '.scient-latex-content-layout[data-layout="sourceColumns"] p',
    ),
  ];
  expect(paragraphs).toHaveLength(2);
  const [first, second] = paragraphs.map((element) => element.getBoundingClientRect());
  const body = editor.view.dom.getBoundingClientRect();
  const style = getComputedStyle(editor.view.dom);
  const scale = body.width / editor.view.dom.offsetWidth;
  const textWidth =
    body.width -
    (Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)) * scale;
  // Existing paragraphs keep one model while filling printable columns.
  expect(first!.width).toBeGreaterThan(textWidth * 0.4);
  expect(first!.width).toBeLessThan(textWidth * 0.51);
  expect(Math.abs(second!.left - first!.left)).toBeLessThan(1);
  expect(second!.top).toBeGreaterThanOrEqual(first!.bottom - 1);
});

it("renders a block marked for measuring, however specific the containment rule is", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(
    _fixture,
    "visual-stability-measure-marker",
    String.raw`\documentclass{article}
\begin{document}
\paragraph{Run-in} Text after a run-in heading.

An ordinary paragraph.
\end{document}
`,
  );
  const paragraph = [...editor.view.dom.children].find((child) =>
    child.textContent?.startsWith("An ordinary"),
  ) as HTMLElement;
  await vi.waitFor(async () => expect(editor.view.dom.closest("[data-paged]")).toBeTruthy());
  expect(getComputedStyle(paragraph).contentVisibility).toBe("auto");
  // The idle pass renders each block once so its real height is remembered.
  paragraph.setAttribute("data-latex-measure", "");
  expect(getComputedStyle(paragraph).contentVisibility).toBe("visible");
  paragraph.removeAttribute("data-latex-measure");
});

it("undoes splitting and joining a paragraph that continues after a display", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const initial = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Starting from the initial condition, iterate
\begin{equation}
x_{m+1}=a x_m+b,\qquad m\geq0.
\label{eq:iterate}
\end{equation}
The matrices $X_m$ are prediction-error covariances
conditioned on increasing finite output histories.
They converge to
$X_\infty$, and the limit is used below.
\end{document}
`;
  const editor = await open(_fixture, "visual-stability-split-after-display", initial);
  let caret = -1;
  editor.state.doc.descendants((node, position) => {
    if (caret < 0 && node.isText && node.text!.startsWith(" are prediction"))
      caret = position + " are".length;
    return caret < 0;
  });
  expect(caret).toBeGreaterThan(0);
  editor.commands.setTextSelection(caret);
  editor.view.focus();
  // Real keys, so typing is held and converted as it is in use.
  const press = async (key: string) => {
    await userEvent.keyboard(key);
    await act(() => vi.advanceTimersByTimeAsync(60));
  };
  await press("{Enter}");
  for (const character of "A new paragraph.") await press(character);
  for (let index = 0; index < 17; index++) await press("{Backspace}");
  await press("{Enter}");
  await press("{Backspace}");
  await act(() => vi.advanceTimersByTimeAsync(1500));
  const edited = published;
  expect(edited).not.toBe(initial);
  // However the keys were grouped, every recorded undo step applies.
  const events = undoDepth(editor.state);
  expect(events).toBeGreaterThan(0);
  for (let event = events; event > 0; event--) {
    const before = editor.state.doc;
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc).not.toBe(before);
    expect(undoDepth(editor.state)).toBe(event - 1);
  }
  await vi.waitFor(async () => expect(published).toBe(initial));
  for (let event = 0; event < events; event++) expect(editor.commands.redo()).toBe(true);
  await vi.waitFor(async () => expect(published).toBe(edited));
});

function _createFixture() {
  let _published_replaceSource = (() => {}) as (next: string) => void;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get replaceSource() {
      return _published_replaceSource;
    },
    publishReplaceSource(next: typeof _published_replaceSource) {
      _published_replaceSource = next;
      return next;
    },

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    clock: undefined as Disposable | undefined,
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
