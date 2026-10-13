import { useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { latexPageAt, latexPageMarkersKey, setLatexPageMarkers } from "./latexPageMarkers";
import { latexEquationReferencesKey, navigateToFootnote } from "./latexEquationReferences";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { clearVisualDraft } from "./visualDrafts";
import { latexBenchmarkDocument } from "./visualBenchmark/latexBenchmarkDocument";
import "./scient-latex.css";
import { projectLatexVisualDocument } from "./latexVisualDocument";

const source = latexBenchmarkDocument({ pages: 8 });
let container: HTMLDivElement;
let root: Root;
let published: string;
let publications: number;
let key = "";
/** Changes the document's source as Source or another editor would. */
let replaceSource: (next: string) => void = () => {};

beforeEach(async () => {
  await page.viewport(1300, 950);
  container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:1100px;height:900px";
  document.body.append(container);
  root = createRoot(container);
  published = source;
  publications = 0;
});
afterEach(() => {
  root.unmount();
  container.remove();
  clearVisualDraft(key);
});

async function open(draftKey: string, initial = source, loaded = true) {
  key = draftKey;
  published = initial;
  clearVisualDraft(key);
  function Harness() {
    const [value, setValue] = useState(initial);
    const owner = useLatexVisualTestOwner(value);
    useEffect(() => {
      replaceSource = (next) => {
        published = next;
        setValue(next);
      };
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
  root.render(<Harness />);
  const editor = () =>
    (
      container.querySelector(".scient-latex-visual-document") as
        | (HTMLElement & { editor?: Editor })
        | null
    )?.editor;
  await expect.poll(editor, { timeout: 20000 }).toBeTruthy();
  if (!loaded) return editor()!;
  await expect
    .poll(() => editor()!.view.editable && editor()!.view.dom.dataset.latexLoading !== "true", {
      timeout: 20000,
    })
    .toBe(true);
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
async function formulasRendered() {
  await expect
    .poll(
      () =>
        [...container.querySelectorAll(".scient-latex-math-preview")].every((preview) =>
          preview.shadowRoot
            ?.querySelector("[data-math-preview-content]")
            ?.hasAttribute("data-math-preview-ready"),
        ),
      { timeout: 20000 },
    )
    .toBe(true);
}

/** Samples after each paint: layout, resize observers and paint have run. */
function afterPaint(sample: () => void) {
  let running = true;
  const next = () =>
    requestAnimationFrame(() =>
      setTimeout(() => {
        if (!running) return;
        sample();
        next();
      }, 0),
    );
  next();
  return () => {
    running = false;
  };
}

function topOf(editor: Editor, position: number) {
  const element = editor.view.nodeDOM(position);
  return element instanceof HTMLElement ? element.getBoundingClientRect().top : Number.NaN;
}

it("opens without publishing source or creating undo history", async () => {
  const editor = await open("visual-stability-open");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(publications).toBe(0);
  expect(published).toBe(source);
  expect(undoDepth(editor.state)).toBe(0);
  expect(container.querySelector("[aria-busy='true']")).toBeNull();
  // Forward references are numbered from the whole document, not left as keys.
  expect(editor.view.dom.textContent).not.toMatch(/\[eq:bench-\d+\]/u);
  // Progressive loading ends with exactly the parsed document.
  const parsed = editor.schema.nodeFromJSON(projectLatexVisualDocument(source).content);
  expect(editor.state.doc.eq(parsed)).toBe(true);
}, 30000);

it("a structural edit after opening rewrites only its own source", async () => {
  const editor = await open("visual-stability-local-edit");
  let last = 0;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "paragraph") last = offset + node.nodeSize;
  });
  editor.commands.insertContentAt(last, {
    type: "paragraph",
    content: [{ type: "text", text: "Closing remark." }],
  });
  await expect.poll(() => published, { timeout: 5000 }).toContain("Closing remark.");
  expect(changedLength(source, published)).toBeLessThan("Closing remark.".length + 8);
}, 30000);

it("typing, splitting and joining keep content above still without app scrolling", async () => {
  const editor = await open("visual-stability-typing");
  await formulasRendered();
  const scroll = scroller(editor);
  scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * 0.4;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const found = target(editor);
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
  const stopSampling = afterPaint(() => {
    moved = Math.max(
      moved,
      Math.abs(topOf(editor, above) - aboveTop),
      Math.abs(topOf(editor, paragraph) - paragraphTop),
    );
  });
  try {
    await userEvent.keyboard("steady words ");
    await expect.poll(() => published, { timeout: 5000 }).toContain("steady words ");
    expect(changedLength(source, published)).toBe("steady words ".length);
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("New paragraph.");
    for (let index = 0; index < 15; index++) await userEvent.keyboard("{Backspace}");
    await new Promise((resolve) => setTimeout(resolve, 800));
  } finally {
    stopSampling();
    watch.stop();
  }
  expect(moved).toBeLessThan(1);
  expect(watch.writes).toEqual([]);
  await expect.poll(() => published).toContain("steady words ");
  while (undoDepth(editor.state) > 0) editor.commands.undo();
  await expect.poll(() => published, { timeout: 5000 }).toBe(source);
}, 60000);

it("formulas finishing above the reading area do not move it", async () => {
  const editor = await open("visual-stability-rendering");
  const scroll = scroller(editor);
  scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * 0.6;
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
  const box = scroll.getBoundingClientRect();
  const reading = [...editor.view.dom.children].find(
    (element) => element.getBoundingClientRect().bottom > box.top + 1,
  )!;
  const start = reading.getBoundingClientRect().top;
  let moved = 0;
  const stop = afterPaint(() => {
    moved = Math.max(moved, Math.abs(reading.getBoundingClientRect().top - start));
  });
  await formulasRendered();
  await new Promise((resolve) => setTimeout(resolve, 300));
  stop();
  expect(moved).toBeLessThan(1);
}, 40000);

it("PDF page markers follow edits, become stale and disappear with their text", async () => {
  const editor = await open("visual-stability-markers");
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
}, 30000);

it("shows each block's footnotes beneath it and redraws only notes that change", async () => {
  const editor = await open(
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
  await expect.poll(() => bands()[1]?.textContent).toBe("2Changed note.3Third note.");
  expect(bands()[0]).toBe(first);
}, 30000);

it("renumbers equations and their references when an equation moves above another", async () => {
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
  await expect.poll(numbers).toEqual(["(1)", "(2)"]);
  await expect.poll(references).toEqual(["(1)", "(2)"]);
  // The second equation moves above the first in the source; the sentence
  // that refers to both is unchanged.
  replaceSource(document(equation("b", "b=2"), equation("a", "a=1"), sentence));
  const formulas = () => {
    const found: string[] = [];
    editor.state.doc.forEach((node) => {
      if (node.type.name === "latexDisplayMath") found.push(String(node.attrs.tex));
    });
    return found;
  };
  await expect.poll(formulas).toEqual(["b=2", "a=1"]);
  await expect.poll(numbers).toEqual(["(1)", "(2)"]);
  await expect.poll(references).toEqual(["(2)", "(1)"]);
}, 30000);

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const next = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1));
    next(count);
  });

const equationNumbers = (editor: Editor) =>
  [...editor.view.dom.querySelectorAll(".scient-latex-equation-numbers")].map(
    (band) => band.textContent,
  );

it("numbers the new document when another revision arrives while loading", async () => {
  const editor = await open(
    "visual-stability-revision-while-loading",
    latexBenchmarkDocument({ pages: 60 }),
    false,
  );
  expect(editor.view.dom.dataset.latexLoading).toBe("true");
  replaceSource(String.raw`\documentclass{article}
\begin{document}
\begin{equation}a=1\label{eq:a}\end{equation}

\begin{equation}b=2\label{eq:b}\end{equation}

See \eqref{eq:b} and \eqref{eq:a}.
\end{document}
`);
  await expect.poll(() => editor.view.dom.dataset.latexLoading).toBeUndefined();
  await expect.poll(() => equationNumbers(editor)).toEqual(["(1)", "(2)"]);
  await expect
    .poll(() =>
      [...editor.view.dom.querySelectorAll(".scient-latex-equation-reference")].map(
        (reference) => reference.textContent,
      ),
    )
    .toEqual(["(2)", "(1)"]);
  const labels = latexEquationReferencesKey.getState(editor.state)!.labels;
  expect([...labels.keys()].toSorted()).toEqual(["eq:a", "eq:b"]);
}, 30000);

it("numbers equations before the reading position when a document reopens there", async () => {
  let editor = await open("visual-stability-reopen");
  await formulasRendered();
  const expected = equationNumbers(editor);
  expect(expected.length).toBeGreaterThan(10);
  const scroll = scroller(editor);
  scroll.scrollTop = scroll.scrollHeight * 0.7;
  await frames(3);
  root.render(<></>);
  await frames(2);
  editor = await open("visual-stability-reopen");
  // It opened at the remembered block and loaded the blocks before it.
  expect(scroller(editor).scrollTop).toBeGreaterThan(0);
  await expect.poll(() => equationNumbers(editor), { timeout: 20000 }).toEqual(expected);
}, 60000);

it("keeps a page marker with its block when content is inserted right before it", async () => {
  const editor = await open("visual-stability-marker-boundary");
  const paragraphs: number[] = [];
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "paragraph") paragraphs.push(offset);
  });
  const anchored = paragraphs[6]!;
  const text = editor.state.doc.nodeAt(anchored)!.textContent;
  setLatexPageMarkers(editor.view, {
    key: "build-boundary",
    pageCount: 1,
    anchors: [{ page: 1, position: anchored }],
  });
  const paragraph = editor.schema.nodes.paragraph!.create(null, editor.schema.text("Inserted."));
  editor.view.dispatch(editor.state.tr.insert(anchored, paragraph));
  const [anchor] = latexPageMarkersKey.getState(editor.state)!.anchors;
  expect(anchor).toBeDefined();
  expect(editor.state.doc.nodeAt(anchor!.position)?.textContent).toBe(text);
  expect(editor.view.dom.querySelectorAll(".scient-latex-page-marker")).toHaveLength(1);
}, 30000);

it("keeps the line at the top still when text above it grows its own paragraph", async () => {
  const editor = await open("visual-stability-line-anchor");
  await formulasRendered();
  const scroll = scroller(editor);
  // A paragraph several lines tall, its second line at the top of the reading area.
  let paragraph = -1;
  editor.state.doc.forEach((node, offset) => {
    if (paragraph < 0 && node.type.name === "paragraph" && node.textContent.length > 400)
      paragraph = offset;
  });
  expect(paragraph).toBeGreaterThan(0);
  const element = editor.view.nodeDOM(paragraph) as HTMLElement;
  element.scrollIntoView({ block: "start" });
  scroll.scrollTop += 40;
  await frames(3);
  const box = scroll.getBoundingClientRect();
  const position = editor.view.posAtCoords({
    left: box.left + box.width / 2,
    top: box.top + 1,
  })!.pos;
  const before = editor.view.coordsAtPos(position).top;
  const inserted = "More words before the reading line. ".repeat(6);
  editor.view.dispatch(editor.state.tr.insertText(inserted, paragraph + 1));
  await frames(3);
  expect(Math.abs(editor.view.coordsAtPos(position + inserted.length).top - before)).toBeLessThan(
    1,
  );
}, 30000);

it("returns to where a document that opens at once was read", async () => {
  const long = String.raw`\documentclass{article}
\begin{document}
${"A single long paragraph that is read part of the way down. ".repeat(110)}
\end{document}
`;
  let editor = await open("visual-stability-short-reopen", long);
  expect(editor.view.dom.dataset.latexLoading).toBeUndefined();
  scroller(editor).scrollTop = 300;
  await frames(3);
  root.render(<></>);
  await frames(2);
  editor = await open("visual-stability-short-reopen", long);
  await frames(3);
  expect(Math.abs(scroller(editor).scrollTop - 300)).toBeLessThan(2);
}, 30000);

it("renumbers a reference in an unchanged title when labels change places", async () => {
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
  const editor = await open("visual-stability-swapped-labels", document("a", "b"));
  const reference = () =>
    editor.view.dom.querySelector('[data-latex-prose-text="[eq:b]"]')?.textContent;
  await expect.poll(reference).toBe("(2)");
  replaceSource(document("b", "a"));
  await expect.poll(reference).toBe("(1)");
}, 30000);

it("moves a footnote band with its note when the paragraph is split after it", async () => {
  const editor = await open(
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
  await expect
    .poll(() => band()?.previousElementSibling?.textContent ?? "")
    .toContain("A noted paragraph");
  expect(navigateToFootnote(editor.view, marker)).toBe(true);
}, 30000);

it("removes a page marker with the equation it begins at", async () => {
  const editor = await open("visual-stability-marker-equation");
  let equation = -1;
  editor.state.doc.forEach((node, offset) => {
    if (equation < 0 && offset > 0 && node.type.name === "latexDisplayMath") equation = offset;
  });
  expect(equation).toBeGreaterThan(0);
  setLatexPageMarkers(editor.view, {
    key: "build-equation",
    pageCount: 2,
    anchors: [
      { page: 1, position: 0 },
      { page: 2, position: equation },
    ],
  });
  const size = editor.state.doc.nodeAt(equation)!.nodeSize;
  editor.view.dispatch(editor.state.tr.delete(equation, equation + size));
  expect(editor.state.doc.nodeAt(equation)?.type.name).not.toBe("latexDisplayMath");
  expect(latexPageMarkersKey.getState(editor.state)!.anchors.map((anchor) => anchor.page)).toEqual([
    1,
  ]);
}, 30000);

it("removes a page marker when its block is replaced, but keeps it when the block is retyped", async () => {
  const editor = await open("visual-stability-marker-replace");
  const paragraphs: number[] = [];
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "paragraph") paragraphs.push(offset);
  });
  const [kept, replaced] = [paragraphs[4]!, paragraphs[8]!];
  setLatexPageMarkers(editor.view, {
    key: "build-replace",
    pageCount: 2,
    anchors: [
      { page: 1, position: kept },
      { page: 2, position: replaced },
    ],
  });
  const heading = editor.schema.nodes.heading!;
  editor.view.dispatch(editor.state.tr.setBlockType(kept + 1, kept + 1, heading, { level: 2 }));
  const size = editor.state.doc.nodeAt(
    latexPageMarkersKey.getState(editor.state)!.anchors[1]!.position,
  )!.nodeSize;
  const at = latexPageMarkersKey.getState(editor.state)!.anchors[1]!.position;
  const other = editor.schema.nodes.paragraph!.create(null, editor.schema.text("Replacement."));
  editor.view.dispatch(editor.state.tr.replaceWith(at, at + size, other));
  expect(editor.state.doc.nodeAt(at)?.textContent).toBe("Replacement.");
  expect(latexPageMarkersKey.getState(editor.state)!.anchors.map((anchor) => anchor.page)).toEqual([
    1,
  ]);
}, 30000);

it("keeps a footnote band with its note when text after the note is replaced by paragraphs", async () => {
  const editor = await open(
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
  await expect
    .poll(() => band()?.previousElementSibling?.textContent ?? "")
    .toContain("A noted paragraph");
  expect(navigateToFootnote(editor.view, marker)).toBe(true);
}, 30000);

it("draws the band again when a noted paragraph is replaced by one with the same note", async () => {
  const editor = await open(
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
  await expect.poll(() => band()?.textContent ?? "").toBe("1The note.");
}, 30000);

it("removes a page marker when its equation is replaced by another", async () => {
  const editor = await open("visual-stability-marker-equation-replace");
  let equation = -1;
  editor.state.doc.forEach((node, offset) => {
    if (equation < 0 && offset > 0 && node.type.name === "latexDisplayMath") equation = offset;
  });
  setLatexPageMarkers(editor.view, {
    key: "build-equation-replace",
    pageCount: 2,
    anchors: [
      { page: 1, position: 0 },
      { page: 2, position: equation },
    ],
  });
  const old = editor.state.doc.nodeAt(equation)!;
  const other = old.type.create({ ...old.attrs, tex: "z=0", sourceId: null });
  editor.view.dispatch(editor.state.tr.replaceWith(equation, equation + old.nodeSize, other));
  expect(editor.state.doc.nodeAt(equation)?.attrs.tex).toBe("z=0");
  expect(latexPageMarkersKey.getState(editor.state)!.anchors.map((anchor) => anchor.page)).toEqual([
    1,
  ]);
}, 30000);

it("keeps a run-in heading beside its paragraph when a page marker sits between them", async () => {
  const editor = await open(
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
  const floated = getComputedStyle(heading).float;
  setLatexPageMarkers(editor.view, {
    key: "build-run-in",
    pageCount: 2,
    anchors: [
      { page: 1, position: 0 },
      { page: 2, position: paragraph },
    ],
  });
  expect(heading.nextElementSibling?.classList.contains("scient-latex-page-marker")).toBe(true);
  expect(getComputedStyle(heading).float).toBe(floated);
  expect(floated).toBe("left");
}, 30000);
