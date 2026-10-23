import { act, fakeTimers, render as _fixtureRender, type Screen } from "../../../test/render";
import { waitForTestReceipt } from "../../../test/receipt";
import { useState, type ReactNode } from "react";

import type { Editor as ProseEditor } from "@tiptap/core";
import type { Editor, EditorSelection } from "@pierre/diffs/edit";
import { expect, it, vi, type TestContext } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
vi.mock("~/localEnvironment", () => ({ isLocalEnvironmentDisabled: () => true }));
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/assets/assetUrls")>()),
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { scrollLatexVisualTestEditor, useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { EditableFileEditor, useFileLineReveal } from "~/components/files/FilePreviewPanel";
import { sourceOffset, sourcePosition } from "../math/input/sourceAdapter";
import { latexTextSelectionRects } from "./latexTextSelectionRects";
import { pagedLayoutSettled } from "./latexPagedGeometry";
import { waitForLatexVisualTestReadiness } from "./latexVisualTestReadiness";
import type { MathfieldElement } from "mathlive";
import template26 from "./fixtures/hebrew-math-and-tables.tex?raw";
import template28 from "./fixtures/mock-medical-article.tex?raw";
import "~/index.css";
import "./scient-latex.css";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
}
async function readyToHit(editor: ProseEditor, measure: () => DOMRect) {
  await vi.waitFor(() => {
    expect(pagedLayoutSettled(editor.view)).toBe(true);
    const rect = measure();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    const viewport = editor.view.dom
      .closest(".scient-latex-visual-scroll")!
      .getBoundingClientRect();
    expect(rect.top + rect.height / 2).toBeGreaterThanOrEqual(viewport.top);
    expect(rect.top + rect.height / 2).toBeLessThanOrEqual(viewport.bottom);
  });
}
async function mount(_fixture: _Fixture, input: string, name: string, context: TestContext) {
  await page.viewport(1300, 900);
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText = "width:1250px;height:840px;display:flex";
  _fixture.host.dataset.testid = "split-browser-host";
  _fixture.host.setAttribute("data-latex-split", "true");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  let sourceEditor: Editor<"file", unknown, undefined> | undefined;
  const sourceReady = Promise.withResolvers<void>();
  let current = input;
  const reveals: { from: number; to: number; precise?: boolean }[] = [];
  const sourceSelections = vi.fn<(selection: EditorSelection | null) => void>();
  function Harness() {
    const [source, setSource] = useState(input);
    const owner = useLatexVisualTestOwner(source);
    const [reveal, setReveal] = useState<{
      source: string;
      from: number;
      to: number;
      requestId: number;
    }>();
    const { onPostRender } = useFileLineReveal(
      `${name}.txt`,
      reveal ? source.slice(0, reveal.from).split("\n").length : null,
      reveal?.requestId ?? -1,
      undefined,
      false,
    );
    return (
      <>
        <div className="scient-latex-pane" style={{ width: 500, height: 840, display: "flex" }}>
          <EditableFileEditor
            environmentId={"split-browser" as never}
            cwd="/debug"
            relativePath={`${name}.txt`}
            composerDraftTarget={"draft:split" as never}
            contents={source}
            revision="1"
            resolvedTheme="light"
            revealRequestId={reveal?.requestId ?? -1}
            wordWrap
            retainSelectionOnBlur
            onEditorSelectionChange={sourceSelections}
            sourceSelectionReveal={reveal}
            onPostRender={(container, instance, context) => {
              sourceEditor = (instance as unknown as { editor: typeof sourceEditor }).editor;
              onPostRender(container, instance, context);
              if (sourceEditor?.getFile()) sourceReady.resolve();
            }}
            onContentsChange={(value) => {
              current = value;
              setSource(value);
            }}
            enableFileComments={false}
          />
        </div>
        <div style={{ width: 710, height: 840, display: "flex" }}>
          <LatexVisualEditor
            source={source}
            sourceSnapshot={owner.snapshot}
            draftKey={`split-browser-${name}`}
            fileRevision="1"
            disabled={false}
            onEdit={(request) => {
              const result = owner.edit(request);
              if (result.accepted) {
                current = result.snapshot.source;
                setSource(current);
              }
              return result;
            }}
            onEditingChange={() => {}}
            onOpenSource={() => {}}
            resolveSourceOwner={(source, from, to) => ({
              path: name,
              rootRelativePath: name,
              source,
              baselineSource: source,
              from,
              to,
            })}
            onRevealSource={(owner) => {
              reveals.push(owner);
              setReveal({
                source: owner.source,
                from: owner.from,
                to: owner.to,
                requestId: reveals.length,
              });
            }}
          />
        </div>
      </>
    );
  }
  await _fixture.root0.rerender(<Harness />);
  const visual = await waitForLatexVisualTestReadiness(_fixture.host, context, `split ${name}`);
  await waitForTestReceipt(context.signal, sourceReady.promise);
  return {
    visual,
    source: () => sourceEditor!,
    sourceSelections,
    reveals,
    text: () => current,
  };
}
function wordPosition(root: HTMLElement | ShadowRoot, word: string, scroll = true) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const field =
      node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? node : null;
    if (!field && node.nodeType !== Node.TEXT_NODE) continue;
    const index = (field?.value ?? node.textContent)?.indexOf(word) ?? -1;
    if (index < 0) continue;
    const element = field ?? node.parentElement!;
    if (element.closest("button,[role=button]") || (!field && element.closest("textarea,input")))
      continue;
    if (scroll) element.scrollIntoView({ block: "center" });
    let box: DOMRect | undefined;
    if (field) box = latexTextSelectionRects(field, index, index + word.length)[0];
    else {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + word.length);
      // A wrapped word's union box can be centred over unrelated text.
      box = [...range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0);
    }
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const bounds = element.getBoundingClientRect();
    return {
      element,
      box,
      position: {
        x: box.left + box.width / 2 - bounds.left,
        y: box.top + box.height / 2 - bounds.top,
      },
    };
  }
  throw new Error(`Missing word: ${word}`);
}
async function scrollToWord(editor: ProseEditor, word: string, context: TestContext) {
  const target = wordPosition(editor.view.dom, word, false).element;
  const visible = Promise.withResolvers<void>();
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.target === target && entry.isIntersecting))
        visible.resolve();
    },
    { root: editor.view.dom.closest(".scient-latex-visual-scroll") },
  );
  using _visibility = { [Symbol.dispose]: () => observer.disconnect() };
  observer.observe(target);
  await scrollLatexVisualTestEditor(editor, () => {
    target.scrollIntoView({ block: "center" });
  });
  // A scroll event can precede lazy-block layout and leave readiness briefly stale.
  await waitForTestReceipt(context.signal, visible.promise);
}
it.for([
  ["26", template26, "פסקה"],
  ["26-abstract", template26, "מסמך"],
  ["26-abstract-line-end", template26, "ניסוי"],
  ["26-rtl-line-start", template26, "זו"],
  ["26-rtl-line-end", template26, "לתצוגה"],
  ["26-bold", template26, "מודגש"],
  ["26-italic", template26, "נטוי"],
  ["26-vowels", template26, "שָׁלוֹם"],
  ["26-mixed-english", template26, "Mixed"],
  ["26-nested-list", template26, "הזחה"],
  ["26-heading", template26, "ומשפטים"],
  ["26-table", template26, "ראשונה"],
  ["26-caption", template26, "וחצים"],
  ["26-title", template26, "נוספים"],
  ["26-author", template26, "מחבר"],
  ["26-date", template26, "אוקטובר"],
  ["26-proof", template26, "הוספת"],
  ["26-theorem", template26, "מתקיים"],
  ["26-description", template26, "ונוסחאות"],
  ["26-figure-body", template26, "חיצוני"],
  ["26-footnote", template26, "ובה"],
  ["26-code", template26, "return"],
  ["28", template28, "Early"],
] as const)(
  "template %s: native word selection updates Source without jumping, then survives pane handoff",
  async ([name, source, word], context) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const state = await mount(_fixture, source, name, context);
    if (name === "26-footnote") {
      await page
        .getByRole("button", { name: "Return to footnote 1 marker", exact: true })
        .nth(0)
        .click();
      await page.getByRole("button", { name: "Edit text", exact: true }).click();
      await expect
        .poll(() => _fixture.host.querySelector('[aria-label="Footnote text"]'))
        .toBeTruthy();
    }
    const scroll = _fixture.host.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
    await scrollToWord(state.visual, word, context);
    // Exposing an offscreen block can request another font before hit measurement.
    await document.fonts.ready;
    await readyToHit(state.visual, () => wordPosition(state.visual.view.dom, word, false).box);
    const hit = wordPosition(state.visual.view.dom, word, false);
    state.visual.view.dom.dataset.testid = "active-visual-editor";
    let before = scroll.scrollTop;
    {
      using _clock = fakeTimers();
      const pointer = () => {
        before = scroll.scrollTop;
        _fixture.host.removeEventListener("pointerdown", pointer, true);
      };
      _fixture.host.addEventListener("pointerdown", pointer, true);
      const cell = hit.element.closest<HTMLElement>("[data-table-cell]");
      if (cell) {
        const bounds = hit.element.getBoundingClientRect();
        const cellBounds = cell.getBoundingClientRect();
        await page
          .getByRole("textbox", { name: cell.getAttribute("aria-label")!, exact: true })
          .nth(0)
          .dblClick({
            position: {
              x: bounds.left + hit.position.x - cellBounds.left,
              y: bounds.top + hit.position.y - cellBounds.top,
            },
          });
      } else if (name === "26-code") {
        const field = state.visual.view.dom.querySelector<HTMLElement>(
          '[aria-label="Literal text"]',
        )!;
        const bounds = hit.element.getBoundingClientRect();
        const fieldBounds = field.getBoundingClientRect();
        await page
          .getByRole("textbox", { name: "Literal text", exact: true })
          .nth(0)
          .dblClick({
            position: {
              x: bounds.left + hit.position.x - fieldBounds.left,
              y: bounds.top + hit.position.y - fieldBounds.top,
            },
          });
      } else if (
        hit.element instanceof HTMLTextAreaElement ||
        hit.element instanceof HTMLInputElement
      ) {
        await page
          .getByRole("textbox", { name: hit.element.getAttribute("aria-label")!, exact: true })
          .nth(0)
          .dblClick({ position: hit.position });
      } else if (hit.element.closest("h1,h2,h3,h4,h5,h6")) {
        await page
          .getByRole("heading", { name: new RegExp(word) })
          .nth(0)
          .dblClick({ position: hit.position });
      } else {
        await page
          .getByTestId("active-visual-editor")
          .nth(0)
          .getByText(word, { exact: false })
          .nth(0)
          .dblClick({ position: hit.position });
      }
      // Publish the gesture's queued source reveal without advancing recurring editor services.
      await act(() => vi.runOnlyPendingTimersAsync());
      await vi.waitFor(() => expect(state.reveals).toHaveLength(1));
      const mapped = state.reveals[0]!;
      expect(source.slice(mapped.from, mapped.to).trim()).toBe(word);
      const field = document.activeElement;
      expect(
        field instanceof HTMLTextAreaElement
          ? field.value.slice(field.selectionStart, field.selectionEnd).trim()
          : document.getSelection()?.toString().trim(),
      ).toBe(word);
      expect(Math.abs(scroll.scrollTop - before)).toBeLessThanOrEqual(2);
      await vi.waitFor(() =>
        expect(state.source().getViewState().selections?.[0]?.start).toEqual(
          sourcePosition(source, mapped.from),
        ),
      );
      expect(state.source().getViewState().selections?.[0]?.end).toEqual(
        sourcePosition(source, mapped.to),
      );
      expect(state.visual.view.dom.contains(document.activeElement)).toBe(true);
      await vi.waitFor(() => {
        const sourcePane = _fixture.host.querySelector("diffs-container")!;
        expect(sourcePane.shadowRoot!.querySelector("[data-caret]")).toBeInstanceOf(HTMLElement);
      });
    }
    const selection = state.source().getViewState().selections;
    state.visual.view.dom.dataset.testid = "active-visual-split";
    await page
      .getByTestId("active-visual-split")
      .nth(0)
      .click({ position: { x: 100, y: 100 } });
    expect(state.source().getViewState().selections).toEqual(selection);
    const container = _fixture.host.querySelector("diffs-container")!;
    await expect
      .poll(
        () =>
          getComputedStyle(container.shadowRoot!.querySelector<HTMLElement>("[data-caret]")!)
            .visibility,
      )
      .toBe("visible");
    const sourceHit = wordPosition(container.shadowRoot!, word);
    state.sourceSelections.mockClear();
    await userEvent.dblClick(sourceHit.element, { position: sourceHit.position });
    await vi.waitFor(() => {
      expect(state.sourceSelections).toHaveBeenCalled();
      const selected = state.source().getViewState().selections?.[0];
      expect(selected).toBeDefined();
      if (!selected) throw new Error("The Source owner did not acknowledge its native selection.");
      expect(
        source.slice(sourceOffset(source, selected.start), sourceOffset(source, selected.end)),
      ).toBe(word);
    });
    const manuallySelected = state.source().getViewState().selections;
    await page
      .getByTestId("active-visual-split")
      .nth(0)
      .click({ position: { x: 100, y: 100 } });
    expect(state.source().getViewState().selections).toEqual(manuallySelected);
    expect(state.text()).toBe(source);
  },
);

it("a Source interaction cancels a queued Visual reveal before it can replace Source selection", async (context) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const state = await mount(_fixture, template26, "cancel-source", context);
  await scrollLatexVisualTestEditor(state.visual, () => {
    wordPosition(state.visual.view.dom, "פסקה");
  });
  await readyToHit(state.visual, () => wordPosition(state.visual.view.dom, "פסקה", false).box);
  const hit = wordPosition(state.visual.view.dom, "פסקה", false);
  const bounds = hit.element.getBoundingClientRect();
  const before = state.source().getViewState().selections;
  using _clock = fakeTimers();
  await act(() => {
    hit.element.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        clientX: bounds.left + hit.position.x,
        clientY: bounds.top + hit.position.y,
      }),
    );
    _fixture.host.dispatchEvent(new CustomEvent("scient-latex-source-interaction"));
  });
  await act(() => vi.advanceTimersByTimeAsync(32));
  expect(state.reveals).toHaveLength(0);
  expect(state.source().getViewState().selections).toEqual(before);
});

it.for([
  ["matrix", "pmatrix", "4", "4"],
  ["cases", "cases", "0", "x\\geq0,"],
  ["aligned", "x-y", "−", null],
] as const)(
  "template 26: clicking inside %s reveals its authored cell",
  async ([name, match, word, expected], context) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const state = await mount(_fixture, template26, `26-math-${name}`, context);
    let mathNode: HTMLElement | null = null;
    state.visual.state.doc.descendants((node, at) => {
      if (
        !mathNode &&
        node.type.name === "latexDisplayMath" &&
        String(node.attrs.tex).includes(match)
      )
        mathNode = state.visual.view.nodeDOM(at) as HTMLElement;
    });
    expect(mathNode).toBeTruthy();
    const shell = mathNode as unknown as HTMLElement;
    await scrollLatexVisualTestEditor(state.visual, () => {
      shell.scrollIntoView({ block: "center" });
    });
    await readyToHit(state.visual, () => shell.getBoundingClientRect());
    shell.dataset.testid = "active-math-shell";
    await page.getByTestId("active-math-shell").nth(0).click();
    const field = () =>
      [...state.visual.view.dom.querySelectorAll<MathfieldElement>("math-field")].find((field) =>
        field.value.replace(/\s+/gu, "").includes(match),
      )!;
    await expect.poll(() => field()?.shadowRoot?.querySelector(".ML__latex")).toBeTruthy();
    await scrollLatexVisualTestEditor(state.visual, () => {
      field().scrollIntoView({ block: "center" });
    });
    await readyToHit(state.visual, () => field().getBoundingClientRect());
    const glyph = () => {
      const math = field();
      for (let at = 1; at <= math.lastOffset; at++) {
        const info = math.getElementInfo(at);
        if (info?.latex === word.replace("−", "-") && info.bounds && info.bounds.width > 0)
          return info.bounds;
      }
      return null;
    };
    await expect.poll(glyph).toBeTruthy();
    const bounds = glyph()!;
    const rootBounds = field().getBoundingClientRect();
    field().dataset.testid = "active-math-field";
    await page
      .getByTestId("active-math-field")
      .nth(0)
      .dblClick({
        position: {
          x: bounds.left + bounds.width / 2 - rootBounds.left,
          y: bounds.top + bounds.height / 2 - rootBounds.top,
        },
      });
    await expect.poll(() => state.reveals.length).toBe(1);
    const range = state.reveals[0]!;
    const selected = template26.slice(range.from, range.to).trim();
    if (expected) expect(selected).toBe(expected);
    else {
      const start = template26.indexOf("(x-y)^2");
      expect(range.from).toBeGreaterThanOrEqual(start);
      expect(range.to).toBeLessThanOrEqual(template26.indexOf("\\end{align}", start));
      expect(selected).toContain("-");
    }
    await expect
      .poll(() => state.source().getViewState().selections?.[0]?.start)
      .toEqual(sourcePosition(template26, range.from));
    expect(state.text()).toBe(template26);
  },
);

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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
