import { createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
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
import { clearVisualDraft } from "./visualDrafts";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let published = "";
const handle = createRef<LatexMathFieldHandle>();
const draftKey = "synthetic-matrix-spacing-qualification";
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

afterEach(async () => {
  root?.unmount();
  host?.remove();
  host = undefined;
  root = undefined;
  clearVisualDraft(draftKey);
  await frame();
});

async function mount(value: string, display = true) {
  await page.viewport(1400, 900);
  published = value;
  host = document.createElement("div");
  host.className = "scient-latex-visual-workspace";
  host.style.cssText = "width:1200px;height:850px;padding:40px;background:white;color:black;";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <LatexMathField
      ref={handle}
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
  await expect.poll(() => handle.current).toBeTruthy();
  handle.current!.focus();
  await expect.poll(() => host?.querySelector("math-field")).toBeTruthy();
  const math = host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => math.getValue()).toBeTruthy();
  await userEvent.click(math);
  await frame();
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
    const math = await mount(insertMatrix({ from: 0, to: 0 }, environment, 3, 3, true)!.insert);
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
    await frame();
    expect(handle.current!.flush()).toBe(true);
    await expect.poll(() => published).toBe(math.getValue("latex-without-placeholders"));
    math.setValue(published);
    spaced(math, 4, environment);
    cell(math, 3, 0, environment);
    math.executeCommand("addRowAfter");
    spaced(math, 5, environment);
  },
);

it("survives repeated row growth/shrinkage, single-row restoration, row splitting and Shift+Enter", async () => {
  const math = await mount(String.raw`\begin{bmatrix}ab&c\\[0.12em]d&e\\[0.12em]f&g\end{bmatrix}`);
  for (let index = 0; index < 25; index++) {
    cell(math, index % 3);
    expect(handle.current!.command("addRowAfter")).toBe(true);
    spaced(math, 4);
    expect(handle.current!.command("removeRow")).toBe(true);
    spaced(math, 3);
  }
  for (let rows = 3; rows > 1; rows--) {
    cell(math);
    handle.current!.command("removeRow");
    spaced(math, rows - 1);
  }
  const single = math.getValue();
  math.setValue(single);
  cell(math);
  handle.current!.command("addRowAfter");
  spaced(math, 2);
  cell(math);
  expect(splitMathRow(math)).toBeNull();
  spaced(math, 3);
  cell(math);
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  spaced(math, 4);
});

it("does not modify compact, inline, or author-defined matrices on mount or when adding a row", async () => {
  const math = await mount(String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`);
  const original = math.getValue();
  await frame();
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
  const math = await mount(insertMatrix({ from: 0, to: 0 }, "bmatrix", 1, 2, false)!.insert, false);
  cell(math);
  handle.current!.command("addRowAfter");
  expect(math.getValue()).not.toContain("[0.12");
});

it("keeps nested arrays independent and enforces the existing 20-row boundary", async () => {
  const math = await mount(
    String.raw`\begin{bmatrix}\begin{pmatrix}a\\[0.12em]b\end{pmatrix}&c\\[0.12em]d&e\end{bmatrix}`,
  );
  cell(math, 0, 0, "pmatrix");
  handle.current!.command("addRowAfter");
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
  expect(handle.current!.command("addRowAfter")).toBe(false);
  expect(math.getValue()).toBe(full);
  math.readOnly = true;
  expect(handle.current!.command("removeRow")).toBe(false);
  expect(math.getValue()).toBe(full);
});

it("inserts a spaced matrix through the actual Visual menu and persists/reopens editable source", async () => {
  await page.viewport(1400, 900);
  published = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Before.
\end{document}`;
  host = document.createElement("div");
  host.style.cssText = "width:1200px;height:850px;background:white;color:black;";
  document.body.append(host);
  root = createRoot(host);
  let finish: (() => boolean) | null = null;
  function Harness() {
    const [source, setSource] = useState(published);
    return (
      <LatexVisualEditor
        draftKey={draftKey}
        fileRevision="synthetic-r1"
        source={source}
        disabled={false}
        onEditingChange={() => {}}
        registerFinishEditing={(callback) => {
          finish = callback;
        }}
        onOpenSource={() => {}}
        onEdit={(expected, next) => {
          if (expected !== published) return false;
          published = next;
          setSource(next);
          return true;
        }}
      />
    );
  }
  root.render(<Harness />);
  await page.getByText("Before.", { exact: true }).click();
  await page.getByRole("button", { name: "Math", exact: true }).click();
  await page.getByRole("menuitem", { name: "Matrix", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Insert matrix with 3 columns × 3 rows" }).click();
  await expect.poll(() => host?.querySelector("math-field")).toBeTruthy();
  const math = host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => math.getValue()).toBeTruthy();
  spaced(math, 3);
  cell(math);
  math.insert("7");
  await frame();
  await expect.poll(() => finish?.()).toBe(true);
  await expect.poll(() => published).toContain("[0.12 em]");
  expect(published).toContain("7");
  // Separate this structural edit from insertion/typing, as a user pause does.
  const editor = (host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  editor.view.dispatch(closeHistory(editor.state.tr));
  const editing = host.querySelector<MathfieldElement>("math-field")!;
  await userEvent.click(editing);
  cell(editing);
  await frame();
  await expect.poll(() => editing.matches(":focus-within")).toBe(true);
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await expect
    .poll(() => matrix(host!.querySelector<MathfieldElement>("math-field")!).rowCount)
    .toBe(4);
  await frame();
  await expect.poll(() => published.match(/\\\\\[0\.12\s*em\]/gu)?.length).toBe(3);
  await frame();
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect
    .poll(
      () =>
        host
          ?.querySelector<MathfieldElement>("math-field")
          ?.getValue()
          .match(/\\\\\[0\.12\s*em\]/gu)?.length,
    )
    .toBe(2);
  await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  await expect
    .poll(
      () =>
        host
          ?.querySelector<MathfieldElement>("math-field")
          ?.getValue()
          .match(/\\\\\[0\.12\s*em\]/gu)?.length,
    )
    .toBe(3);
  await expect.poll(() => finish?.()).toBe(true);
  const saved = published;
  root.unmount();
  clearVisualDraft(draftKey);
  published = saved;
  root = createRoot(host);
  root.render(<Harness />);
  await expect.poll(() => host?.querySelector(".scient-latex-mathfield")).toBeTruthy();
  await userEvent.click(host.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => host?.querySelector("math-field")).toBeTruthy();
  const reopened = host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => reopened.getValue()).toContain("7");
  spaced(reopened, 4);
  expect(host.querySelector(".scient-latex-raw-block")).toBeNull();
});
