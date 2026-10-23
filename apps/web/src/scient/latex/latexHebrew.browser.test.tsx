import { render as _fixtureRender, type Screen } from "../../../test/render";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { useState, type ReactNode } from "react";

import type { Editor } from "@tiptap/core";
import type { MathfieldElement } from "mathlive";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";
import template from "./fixtures/hebrew-math-and-tables.tex?raw";

let source = "";
const draftKey = "hebrew-babel-review";
async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  clearVisualDraft(draftKey);
}
async function mount(_fixture: _Fixture, input: string) {
  await page.viewport(1300, 900);
  source = input;
  clearVisualDraft(draftKey);
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText = "width:1100px;height:850px";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  function Harness() {
    const [text, setText] = useState(input);
    const owner = useLatexVisualTestOwner(text);
    return (
      <LatexVisualEditor
        sourceSnapshot={owner.snapshot}
        source={text}
        draftKey={draftKey}
        fileRevision="r1"
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const result = owner.edit(request);
          if (result.accepted) {
            source = result.snapshot.source;
            setText(source);
          }
          return result;
        }}
      />
    );
  }
  await _fixture.root0.rerender(<Harness />);
  await expect
    .poll(
      () =>
        _fixture.host.querySelector<HTMLElement & { editor: Editor }>(
          ".scient-latex-visual-document",
        )?.editor,
    )
    .toBeTruthy();
  const editor = _fixture.host.querySelector<HTMLElement & { editor: Editor }>(
    ".scient-latex-visual-document",
  )!.editor;
  await expect
    .poll(() => editor.view.dom.hasAttribute("data-latex-loading"), { timeout: 15000 })
    .toBe(false);
  return editor;
}
const preamble = String.raw`\documentclass{article}
\usepackage{amsmath,fontspec}
\usepackage[english,bidi=basic,layout=lists.tabular]{babel}
\babelprovide[main]{hebrew}
\babelprovide{english}
\babelfont{rm}{Latin Modern Roman}
\babelfont[hebrew]{rm}{Arial}
\begin{document}`;

it("renders every template 26 block with Hebrew direction, labels, figure and code", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const editor = await mount(_fixture, template);
  expect(_fixture.host.querySelector(".scient-latex-visual-paper")?.getAttribute("dir")).toBe(
    "rtl",
  );
  expect(_fixture.host.querySelector(".scient-latex-visual-paper")?.getAttribute("lang")).toBe(
    "he",
  );
  expect(_fixture.host.querySelector(".scient-latex-visual-raw")).toBeNull();
  const figure = _fixture.host.querySelector<HTMLElement>(".scient-latex-framed-figure")!;
  expect(figure).toBeTruthy();
  expect(figure.textContent).toContain("איור 1:");
  expect(figure.textContent).toContain("שלבי בדיקה");
  const code = _fixture.host.querySelector<HTMLTextAreaElement>('[aria-label="Literal text"]');
  expect(code?.value).toContain("return x * x");
  expect(getComputedStyle(code!).direction).toBe("ltr");
  const english = _fixture.host.querySelector<HTMLElement>(
    '[data-latex-direction-mark="latexEnglish"]',
  )!;
  expect(getComputedStyle(english).direction).toBe("ltr");
  expect(getComputedStyle(english).fontFamily).toContain("Latin Modern Roman");
  expect(getComputedStyle(editor.view.dom).fontFamily).toContain("Arial");
  const table = _fixture.host.querySelector<HTMLTableElement>(
    'figure[data-table-kind="stretch"] table',
  )!;
  const description = table.rows[1]!.cells[1]!;
  expect(getComputedStyle(description).textAlign).toBe("justify");
  const quantity = table.rows[1]!.cells[2]!;
  const total = table.rows[3]!.cells[0]!;
  expect(total.colSpan).toBe(2);
  const scale = table.getBoundingClientRect().width / table.offsetWidth;
  for (const cell of [quantity, total]) {
    expect(getComputedStyle(cell).textAlign).toBe("end");
    const field = cell.querySelector<HTMLElement>(".scient-latex-inline-field")!;
    expect(
      Math.abs(
        (field.getBoundingClientRect().left - cell.getBoundingClientRect().left) / scale -
          parseFloat(getComputedStyle(cell).paddingLeft),
      ),
    ).toBeLessThan(2);
  }
  const header = table.rows[0]!.cells[0]!;
  // At ordinary zoom both subpixel rules can snap to one device pixel.
  const initialZoom = table.style.zoom;
  table.style.zoom = "2";
  expect(parseFloat(getComputedStyle(header).borderTopWidth)).toBeGreaterThan(
    parseFloat(getComputedStyle(header).borderBottomWidth),
  );
  expect(parseFloat(getComputedStyle(table.rows[3]!.cells[0]!).borderBottomWidth)).toBeCloseTo(
    parseFloat(getComputedStyle(header).borderTopWidth),
    1,
  );
  table.style.zoom = initialZoom;
  expect(source).toBe(template);
});

it("renders and edits Hebrew math text while preserving its authored command", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const editor = await mount(
    _fixture,
    preamble +
      "\nשלום לפני הנוסחה.\n\n" +
      String.raw`\[\underbrace{1+1}_{\text{\texthebrew{מספר האיברים הוא}}\ n}=n+\texttt{code}.\]` +
      "\n\\end{document}",
  );
  const preview = () =>
    [..._fixture.host.querySelectorAll(".scient-latex-math-preview")]
      .map((e) => e.shadowRoot?.querySelector<HTMLElement>('[data-scient-format="texthebrew"]'))
      .find(Boolean);
  await expect.poll(preview, { timeout: 15000 }).toBeTruthy();
  expect(preview()!.textContent).toContain("מספר האיברים הוא");
  expect(preview()!.textContent).not.toContain("\\text");
  expect(getComputedStyle(preview()!).direction).toBe("rtl");
  expect(
    getComputedStyle((preview()!.getRootNode() as ShadowRoot).querySelector(".ML__tt")!).fontFamily,
  ).toContain("KaTeX_Typewriter");
  await userEvent.click(_fixture.host.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => _fixture.host.querySelector("math-field")).toBeTruthy();
  const math = _fixture.host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => math.getValue("latex-without-placeholders")).toContain("\\texthebrew{");
  expect(math.getValue("latex-without-placeholders")).not.toContain("htmlData");
  math.position = math.lastOffset;
  await userEvent.click(math);
  math.position = math.lastOffset;
  const original = source;
  await userEvent.keyboard("+2");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => source).not.toBe(original);
  expect(source).toContain("\\texthebrew{");
  expect(source).not.toContain("htmlData");
  editor.commands.undo();
  await expect.poll(() => source).toBe(original);
});

it("copies and pastes mixed prose in logical order, undoes it and reopens preserved source", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const original =
    preamble +
    String.raw`שלום \textenglish{English 123} עולם.

סוף.` +
    "\n\\end{document}";
  const editor = await mount(_fixture, original);
  const first = editor.state.doc.firstChild!;
  editor.commands.setTextSelection({ from: 1, to: first.nodeSize - 1 });
  const transfer = new DataTransfer();
  editor.view.dom.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
  expect(transfer.getData("text/plain")).toContain("שלום");
  expect(transfer.getData("text/plain").indexOf("English 123")).toBeGreaterThan(
    transfer.getData("text/plain").indexOf("שלום"),
  );
  editor.commands.focus();
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.view.dom.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
  await expect.poll(() => source).not.toBe(original);
  expect(source.match(/\\textenglish\{English 123\}/gu)?.length).toBe(2);
  editor.commands.undo();
  await expect.poll(() => source).toBe(original);
  await _fixture.root0.unmount();
  _fixture.host.remove();
  const reopened = await mount(_fixture, source);
  expect(reopened.state.doc.textContent).toContain("שלום English 123 עולם.");
  expect(_fixture.host.querySelector('[data-latex-direction-mark="latexEnglish"]')).toBeTruthy();
});

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
