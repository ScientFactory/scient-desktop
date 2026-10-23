import { render as _fixtureRender, type Screen } from "../../../test/render";
import { observeLatexSelectionPresentation } from "./latexSelectionPresentation.testkit";
import { createRef, useState, type ReactNode } from "react";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import type { MathfieldElement } from "mathlive";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "prosemirror-history";
import { insertMatrix } from "../math/input/matrix";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { splitMathRow } from "./mathLiveSelection";
import "./scient-latex.css";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { clearVisualDraft } from "./visualDrafts";

let published = "";

const draftKey = "synthetic-matrix-spacing-qualification";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.host = undefined;
  _fixture.root0 = undefined;
  clearVisualDraft(draftKey);
}

async function mount(_fixture: _Fixture, value: string, display = true) {
  await page.viewport(1400, 900);
  published = value;
  _fixture.host = document.createElement("div");
  _fixture.host.className = "scient-latex-visual-workspace";
  _fixture.host.style.cssText =
    "width:1200px;height:850px;padding:40px;background:white;color:black;";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  _fixture.selectionPresentation = _fixture.stack.use(
    observeLatexSelectionPresentation(_fixture.host),
  );
  await _fixture.root0.rerender(
    <LatexMathField
      ref={_fixture.handle}
      value={value}
      display={display}
      disabled={false}
      onChange={(value) => {
        published = value;
        return { accepted: true, value };
      }}
      onFocus={() => {}}
      onExit={() => {}}
      onExtendOutside={() => false}
      onUndo={() => false}
      onRemoveEmpty={() => {}}
      onShortcut={() => false}
      onShortcutHint={() => {}}
      formatCopiedMath={(value) => value}
      parsePastedMath={(value) => value}
    />,
  );
  await expect.poll(() => _fixture.handle.current).toBeTruthy();
  _fixture.handle.current!.focus();
  await expect.poll(() => _fixture.host?.querySelector("math-field")).toBeTruthy();
  const math = _fixture.host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => math.getValue()).toBeTruthy();
  await userEvent.click(math);
  await _fixture.selectionPresentation!.wait();
  return math;
}

interface Atom {
  type?: string;
  value?: string;
  environmentName?: string;
  rowCount: number;
  colCount: number;
  rowGaps: { dimension: number; unit?: string }[];
  getCell(row: number, column: number): Atom[];
}
function model(math: MathfieldElement) {
  return (
    math as unknown as { _mathfield: { model: { atoms: Atom[]; offsetOf(atom: Atom): number } } }
  )._mathfield.model;
}
function matrix(math: MathfieldElement, environment = "bmatrix") {
  const array = model(math).atoms.find(
    (atom) => atom.type === "array" && atom.environmentName === environment,
  );
  expect(array).toBeTruthy();
  return array!;
}
function cell(math: MathfieldElement, row = 0, column = 0, environment = "bmatrix") {
  math.position = model(math).offsetOf(matrix(math, environment).getCell(row, column).at(-1)!);
}
function spaced(math: MathfieldElement, rows: number, environment = "bmatrix") {
  expect(matrix(math, environment).rowCount).toBe(rows);
  expect(matrix(math, environment).rowGaps.slice(0, rows - 1)).toEqual(
    Array.from({ length: rows - 1 }, () => ({ dimension: 0.12, unit: "em" })),
  );
}

it.each(["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"] as const)(
  "%s retains explicit spacing across native row commands, undo/redo and a source reload",
  async (environment) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const math = await mount(
      _fixture,
      insertMatrix({ from: 0, to: 0 }, environment, 3, 3, true)!.insert,
    );
    spaced(math, 3, environment);
    cell(math, 1, 1, environment);
    expect(math.executeCommand("addRowAfter")).toBe(true);
    spaced(math, 4, environment);
    // The host owns history; record the completed native mutation here to
    // verify MathLive's JSON snapshot preserves gaps on restore. The complete
    // Visual test below exercises the actual document undo/redo path.
    (math as unknown as { _mathfield: { snapshot(): void } })._mathfield.snapshot();
    expect(math.executeCommand("undo")).toBe(true);
    spaced(math, 3, environment);
    expect(math.executeCommand("redo")).toBe(true);
    spaced(math, 4, environment);
    cell(math, 0, 0, environment);
    math.executeCommand("addRowBefore");
    spaced(math, 5, environment);
    cell(math, 2, 0, environment);
    math.executeCommand("removeRow");
    spaced(math, 4, environment);
    cell(math, 0, 0, environment);
    math.executeCommand("addColumnAfter");
    expect(matrix(math, environment).colCount).toBe(4);
    spaced(math, 4, environment);
    math.executeCommand("removeColumn");
    expect(matrix(math, environment).colCount).toBe(3);
    spaced(math, 4, environment);
    await _fixture.selectionPresentation!.wait();
    expect(_fixture.handle.current!.flush()).toBe(true);
    await expect.poll(() => published).toBe(math.getValue("latex-without-placeholders"));
    math.setValue(published);
    spaced(math, 4, environment);
    cell(math, 3, 0, environment);
    math.executeCommand("addRowAfter");
    spaced(math, 5, environment);
  },
);

it("survives repeated row growth/shrinkage, single-row restoration, row splitting and Shift+Enter", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(
    _fixture,
    String.raw`\begin{bmatrix}ab&c\\[0.12em]d&e\\[0.12em]f&g\end{bmatrix}`,
  );
  for (let index = 0; index < 25; index++) {
    cell(math, index % 3);
    expect(_fixture.handle.current!.command("addRowAfter")).toBe(true);
    spaced(math, 4);
    expect(_fixture.handle.current!.command("removeRow")).toBe(true);
    spaced(math, 3);
  }
  for (let rows = 3; rows > 1; rows--) {
    cell(math);
    _fixture.handle.current!.command("removeRow");
    spaced(math, rows - 1);
  }
  const single = math.getValue();
  math.setValue(single);
  cell(math);
  _fixture.handle.current!.command("addRowAfter");
  spaced(math, 2);
  cell(math);
  expect(splitMathRow(math)).toBeNull();
  spaced(math, 3);
  cell(math);
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  spaced(math, 4);
});

it("does not modify compact, inline, or author-defined matrices on mount or when adding a row", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`);
  const original = math.getValue();
  await _fixture.selectionPresentation!.wait();
  expect(math.getValue()).toBe(original);
  cell(math);
  math.executeCommand("addRowAfter");
  expect(math.getValue()).not.toContain("[0.12");
  for (const gap of ["2pt", "0em", "-0.12em", "0.3em"]) {
    math.setValue(`\\begin{bmatrix}a&b\\\\[${gap}]c&d\\end{bmatrix}`);
    const before = matrix(math).rowGaps.map((gap) => ({ ...gap }));
    cell(math);
    math.executeCommand("addRowAfter");
    expect(matrix(math).rowGaps).toEqual(before);
  }
  for (const environment of ["smallmatrix", "cases", "aligned"]) {
    math.setValue(`\\begin{${environment}}a&b\\\\c&d\\end{${environment}}`);
    cell(math, 0, 0, environment);
    math.executeCommand("addRowAfter");
    expect(math.getValue()).not.toContain("[0.12");
  }
});

it("keeps newly inserted inline matrices compact, including their first added row", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(
    _fixture,
    insertMatrix({ from: 0, to: 0 }, "bmatrix", 1, 2, false)!.insert,
    false,
  );
  cell(math);
  _fixture.handle.current!.command("addRowAfter");
  expect(math.getValue()).not.toContain("[0.12");
});

it("keeps nested arrays independent and enforces the existing 20-row boundary", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(
    _fixture,
    String.raw`\begin{bmatrix}\begin{pmatrix}a\\[0.12em]b\end{pmatrix}&c\\[0.12em]d&e\end{bmatrix}`,
  );
  cell(math, 0, 0, "pmatrix");
  _fixture.handle.current!.command("addRowAfter");
  spaced(math, 3, "pmatrix");
  expect(matrix(math).rowCount).toBe(2);
  expect(matrix(math).rowGaps).toEqual([{ dimension: 0.12, unit: "em" }]);
  // MathLive's existing parser caps ordinary arrays at ten columns. Test the
  // supported live shape here; the source generator separately covers 20×20.
  math.setValue(insertMatrix({ from: 0, to: 0 }, "bmatrix", 20, 10, true)!.insert);
  expect(matrix(math).rowCount).toBe(20);
  expect(matrix(math).colCount).toBe(10);
  cell(math);
  const full = math.getValue();
  expect(_fixture.handle.current!.command("addRowAfter")).toBe(false);
  expect(math.getValue()).toBe(full);
  math.readOnly = true;
  expect(_fixture.handle.current!.command("removeRow")).toBe(false);
  expect(math.getValue()).toBe(full);
});

it("inserts a spaced matrix through the actual Visual menu and persists/reopens editable source", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await page.viewport(1400, 900);
  published = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Before.
\end{document}`;
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText = "width:1200px;height:850px;background:white;color:black;";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  let finish: (() => boolean) | null = null;
  function Harness() {
    const [source, setSource] = useState(published);
    const owner = useLatexVisualTestOwner(source);
    return (
      <LatexVisualEditor
        draftKey={draftKey}
        fileRevision="synthetic-r1"
        source={source}
        sourceSnapshot={owner.snapshot}
        disabled={false}
        onEditingChange={() => {}}
        registerFinishEditing={(callback) => {
          finish = callback;
        }}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const outcome = owner.edit(request, request.edit.source === published);
          if (!outcome.accepted) return outcome;
          published = outcome.snapshot.source;
          setSource(published);
          return outcome;
        }}
      />
    );
  }
  _fixture.selectionPresentation = _fixture.stack.use(
    observeLatexSelectionPresentation(_fixture.host),
  );
  await _fixture.root0.rerender(<Harness />);
  await page.getByText("Before.", { exact: true }).click();
  await page.getByRole("button", { name: "Math", exact: true }).click();
  await page.getByRole("menuitem", { name: "Matrix", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Insert matrix with 3 columns × 3 rows" }).click();
  await expect.poll(() => _fixture.host?.querySelector("math-field")).toBeTruthy();
  const math = _fixture.host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => math.getValue()).toBeTruthy();
  // Edit the field once its editor is admitted and focused: until then it is a
  // hidden staged copy, and a slower runner reaches this line before that.
  await expect.poll(() => math.hasFocus()).toBe(true);
  spaced(math, 3);
  cell(math);
  math.insert("7");
  await _fixture.selectionPresentation!.wait();
  await expect.poll(() => finish?.()).toBe(true);
  // Slow CI runners have exceeded the 1 s default here; no edit is lost.
  await expect.poll(() => published, { timeout: 5000 }).toContain("[0.12 em]");
  expect(published).toContain("7");
  // Separate this structural edit from insertion/typing, as a user pause does.
  const editor = (_fixture.host.querySelector(".tiptap") as HTMLElement & { editor: Editor })
    .editor;
  editor.view.dispatch(closeHistory(editor.state.tr));
  const editing = _fixture.host.querySelector<MathfieldElement>("math-field")!;
  await userEvent.click(editing);
  cell(editing);
  await _fixture.selectionPresentation!.wait();
  await expect.poll(() => editing.matches(":focus-within")).toBe(true);
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await expect
    .poll(() => matrix(_fixture.host!.querySelector<MathfieldElement>("math-field")!).rowCount)
    .toBe(4);
  await _fixture.selectionPresentation!.wait();
  await expect.poll(() => published.match(/\\\\\[0\.12\s*em\]/gu)?.length).toBe(3);
  await _fixture.selectionPresentation!.wait();
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect
    .poll(
      () =>
        _fixture.host
          ?.querySelector<MathfieldElement>("math-field")
          ?.getValue()
          .match(/\\\\\[0\.12\s*em\]/gu)?.length,
    )
    .toBe(2);
  await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  await expect
    .poll(
      () =>
        _fixture.host
          ?.querySelector<MathfieldElement>("math-field")
          ?.getValue()
          .match(/\\\\\[0\.12\s*em\]/gu)?.length,
    )
    .toBe(3);
  await expect.poll(() => finish?.()).toBe(true);
  const saved = published;
  await _fixture.root0.unmount();
  clearVisualDraft(draftKey);
  published = saved;
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  _fixture.selectionPresentation = _fixture.stack.use(
    observeLatexSelectionPresentation(_fixture.host),
  );
  await _fixture.root0.rerender(<Harness />);
  await expect.poll(() => _fixture.host?.querySelector(".scient-latex-mathfield")).toBeTruthy();
  await userEvent.click(_fixture.host.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => _fixture.host?.querySelector("math-field")).toBeTruthy();
  const reopened = _fixture.host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => reopened.getValue()).toContain("7");
  spaced(reopened, 4);
  expect(_fixture.host.querySelector(".scient-latex-raw-block")).toBeNull();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const handle = createRef<LatexMathFieldHandle>();
  return {
    handle,
    host: undefined! as HTMLDivElement | undefined,
    stack,
    selectionPresentation: undefined as
      | ReturnType<typeof observeLatexSelectionPresentation>
      | undefined,
    cleanup,
    root0: undefined! as Screen | undefined,
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
