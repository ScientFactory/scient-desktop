import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import type { Editor } from "@tiptap/core";
import type { MathfieldElement } from "mathlive";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { mathEditingScopes } from "./mathLiveSelection";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

let host: HTMLDivElement | undefined;
let root: Root | undefined;
let source = "";
let edits = 0;
const draftKey = "synthetic-nested-selection-qualification";
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
const selectScope = async () => {
  await userEvent.keyboard("{Control>}a{/Control}");
  await frame();
};

afterEach(async () => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  clearVisualDraft(draftKey);
  await frame();
});

async function mount(body: string) {
  await page.viewport(1400, 900);
  source = `\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n${body}\n\\end{document}`;
  clearVisualDraft(draftKey);
  edits = 0;
  host = document.createElement("div");
  host.style.cssText = "width:1200px;height:850px;position:relative;background:white;color:black;";
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    const [text, setText] = useState(source);
    return (
      <LatexVisualEditor
        draftKey={draftKey}
        fileRevision="synthetic-r1"
        source={text}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(expected, next) => {
          if (expected !== source) return false;
          edits++;
          source = next;
          setText(next);
          return true;
        }}
      />
    );
  }
  root.render(<Harness />);
  await expect.poll(() => host!.querySelector(".scient-latex-math-preview")).toBeTruthy();
  await userEvent.click(host.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => host!.querySelector("math-field")).toBeTruthy();
  const math = host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => math.getValue()).toBeTruthy();
  await frame();
  await userEvent.click(math);
  await expect.poll(() => math.matches(":focus-within")).toBe(true);
  await frame();
  return math;
}

function offset(math: MathfieldElement, value: string) {
  type Atom = { value?: string };
  const model = (
    math as unknown as { _mathfield: { model: { atoms: Atom[]; offsetOf(atom: Atom): number } } }
  )._mathfield.model;
  const atom = model.atoms.find((atom) => atom.value === value);
  expect(atom).toBeTruthy();
  return model.offsetOf(atom!);
}

it("the complete Visual editor climbs from bold label to equation and document", async () => {
  const math = await mount(String.raw`Before.

\[\underbrace{1+\cdots+1}_{n\ \textbf{times}}=\]

After.`);
  const original = source;
  math.position = offset(math, "m");
  await frame();
  const scopes = mathEditingScopes(math);
  for (const scope of scopes) {
    await selectScope();
    expect(math.selection.ranges).toEqual([[...scope.range]]);
  }
  await selectScope();
  await expect.poll(() => window.getSelection()?.toString()).toContain("Before.");
  expect(window.getSelection()?.toString()).toContain("After.");
  expect(source).toBe(original);
});

it("real Math menu retains bold selection, Escape restores focus, next Ctrl+A selects label", async () => {
  const math = await mount(String.raw`\[\underbrace{1+\cdots+1}_{n\ \textbf{times}}=\]`);
  const original = source;
  math.position = offset(math, "m");
  await frame();
  const scopes = mathEditingScopes(math);
  await selectScope();
  await page.getByRole("button", { name: "Math", exact: true }).click();
  await frame();
  expect(math.selection.ranges).toEqual([[...scopes[0]!.range]]);
  expect(document.querySelectorAll(".scient-latex-retained-selection")).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  await frame();
  await expect.poll(() => math.matches(":focus-within")).toBe(true);
  await selectScope();
  expect(math.selection.ranges).toEqual([[...scopes[1]!.range]]);
  expect(source).toBe(original);
});

it.each([String.raw`\[\mathbf{h}_{i}=z\]`, String.raw`\(\mathbf{h}_{i}=z\)`])(
  "switching Insert to Math preserves the last caret and range in %s",
  async (body) => {
    const math = await mount(body);
    const original = source;
    const h = offset(math, "h");
    for (const range of [
      [h, h],
      [h - 1, h],
    ] as const) {
      math.selection = { ranges: [[...range]] };
      await frame();
      await page.getByRole("button", { name: "Insert", exact: true }).click();
      await frame();
      expect(math.selection.ranges).toEqual([[...range]]);
      if (range[0] === range[1]) {
        expect(host!.querySelector(".scient-latex-retained-selection")).toBeNull();
        expect(host!.querySelector(".scient-latex-range-selection")).toBeNull();
      }
      await page.getByRole("button", { name: "Math", exact: true }).click();
      await frame();
      expect(math.selection.ranges).toEqual([[...range]]);
      await page.getByRole("menuitem", { name: "Brackets", exact: true }).click();
      await page.getByRole("switch", { name: "Match brackets", exact: true }).click();
      await frame();
      expect(math.selection.ranges).toEqual([[...range]]);
      await userEvent.keyboard("{Escape}");
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => math.matches(":focus-within")).toBe(true);
      expect(math.selection.ranges).toEqual([[...range]]);
    }
    expect(source).toBe(original);
  },
);

it.each([String.raw`\[\mathbf{h}_{i}=\]`, String.raw`\(\mathbf{h}_{i}=\)`])(
  "bracket menu choices retain the caret, and Insert leaves it inside empty brackets in %s",
  async (body) => {
    const math = await mount(body);
    math.position = math.lastOffset;
    const before = math.position;
    await frame();
    await page.getByRole("button", { name: "Math", exact: true }).click();
    await page.getByRole("menuitem", { name: "Brackets", exact: true }).click();
    await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Left bracket"]')!);
    await page.getByRole("option", { name: "⟨", exact: true }).click();
    await frame();
    expect(math.selection.ranges).toEqual([[before, before]]);
    expect(host!.querySelector(".scient-latex-retained-selection")).toBeNull();
    await page.getByRole("menuitem", { name: "Insert", exact: true }).click();
    await expect.poll(() => math.matches(":focus-within")).toBe(true);
    await frame();
    expect(math.selectionIsCollapsed).toBe(true);
    expect(host!.querySelector(".scient-latex-range-selection")).toBeNull();
    expect(host!.querySelector(".scient-latex-retained-selection")).toBeNull();
    await userEvent.keyboard("x");
    await frame();
    expect(math.getValue("latex-without-placeholders")).toMatch(
      /\\left\\langle\s*x\s*\\right\\rangle/u,
    );
  },
);

it.each([String.raw`\[\mathbf{h}_{i}\]`, String.raw`\(\mathbf{h}_{i}\)`])(
  "the complete Visual editor leaves every guide corner unclipped in %s",
  async (body) => {
    const math = await mount(body);
    const original = source;
    await document.fonts.ready;
    for (const position of [offset(math, "h"), offset(math, "i"), 0, math.lastOffset]) {
      math.position = position;
      await frame();
      await frame();
      const guide = host!.querySelector<HTMLElement>(
        ".scient-latex-scope-outline:not([data-guide])",
      );
      expect(guide).toBeTruthy();
      const bounds = guide!.getBoundingClientRect();
      for (let ancestor = guide!.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        if (
          ["auto", "hidden", "clip", "scroll"].includes(style.overflowY) ||
          /\b(paint|content|strict)\b/u.test(style.contain) ||
          style.contentVisibility === "auto"
        ) {
          const label = `${ancestor.tagName}.${ancestor.className} (${style.contain})`;
          expect(bounds.top, label).toBeGreaterThanOrEqual(box.top - 1);
          expect(bounds.bottom, label).toBeLessThanOrEqual(box.bottom + 1);
        }
      }
    }
    await page.getByRole("button", { name: "Math", exact: true }).click();
    await frame();
    expect(host!.querySelector(".scient-latex-scope-outline:not([data-guide])")).toBeTruthy();
    const block = math.closest<HTMLElement>("p,.scient-latex-visual-display-math")!;
    expect(getComputedStyle(block).contain).toBe("none");
    expect(getComputedStyle(block).contentVisibility).toBe("visible");
    await userEvent.keyboard("{Escape}");
    expect(source).toBe(original);
  },
);

it("real Visual editor expands bracket/exponent boundaries and paints the complete underbrace", async () => {
  const math = await mount(
    String.raw`\[\begin{pmatrix}\left(x\right)^2&\underbrace{1+\cdots+1}_{n\ \textbf{times}}\end{pmatrix}=\]`,
  );
  const original = source;
  const inputs: string[] = [];
  const transactions: unknown[] = [];
  const editor = (host!.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) transactions.push(transaction.steps.map((step) => step.toJSON()));
  });
  math.addEventListener("input", (e) =>
    inputs.push(`${(e as InputEvent).inputType}: ${math.getValue()}`),
  );
  math.selection = { ranges: [[offset(math, "x"), offset(math, "2")]] };
  await frame();
  expect(math.getValue(math.selection, "latex-without-placeholders")).toContain("x");
  expect(math.getValue(math.selection, "latex-without-placeholders")).toContain("^2");
  math.position = offset(math, "m");
  await frame();
  await selectScope();
  await selectScope();
  await selectScope();
  expect(math.getValue(math.selection, "latex-without-placeholders")).toContain("underbrace");
  expect(
    document.querySelectorAll(".scient-latex-range-selection,.scient-latex-cell-selection"),
  ).toHaveLength(1);
  expect({ edits, inputs, transactions }).toEqual({ edits: 0, inputs: [], transactions: [] });
  expect(source).toBe(original);
});

it("Ctrl+A continues from a formula through its containing table cell, table and document", async () => {
  const math = await mount(String.raw`Before.

\begin{tabular}{ll}
$\underbrace{1+\cdots+1}_{n\ \textbf{times}}$ & Other\\
\end{tabular}

After.`);
  const original = source;
  math.position = offset(math, "m");
  await frame();
  for (const scope of mathEditingScopes(math)) {
    await selectScope();
    expect(math.selection.ranges).toEqual([[...scope.range]]);
  }
  // The inline prose editor also contributes its enclosing text flow.
  for (let step = 0; step < 4 && !host!.querySelector("[data-cell-selection]"); step++)
    await selectScope();
  expect(host!.querySelectorAll("[data-cell-selection]")).toHaveLength(1);
  await selectScope();
  expect(host!.querySelectorAll("[data-cell-selection]")).toHaveLength(2);
  await selectScope();
  expect(window.getSelection()?.toString()).toContain("Before.");
  expect(window.getSelection()?.toString()).toContain("After.");
  expect(source).toBe(original);
});
