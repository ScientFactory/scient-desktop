import { createRoot, type Root } from "react-dom/client";
import { createRef } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { MenuSub, MenuSubTrigger, MenuSubPopup } from "~/components/ui/menu";
import { DockMenu, DockCommandItem } from "../writing/dockChrome";
import { runLatexSelectionCommand } from "./latexSelectionSession";
import type { MathfieldElement } from "mathlive";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { mathBracketsTemplate } from "./mathBrackets";
import { mathEditingScopes, mathSelectionPoint, mathCaretRect } from "./mathLiveSelection";
import "./scient-latex.css";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const field = createRef<LatexMathFieldHandle>();
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

afterEach(async () => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  await frame();
});

async function mount(value: string, display = false) {
  const Container = display ? "div" : "p";
  await page.viewport(1400, 900);
  host = document.createElement("div");
  host.className = "scient-latex-visual-workspace";
  host.style.cssText =
    "position:relative; width:900px; height:500px; background:white; color:black; padding:40px;";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <>
      <div className="scient-latex-writing-toolbar">
        <DockMenu label="Selection actions" icon={<span>Selection actions</span>}>
          <DockCommandItem
            onClick={() => {
              const math = host!.querySelector<MathfieldElement>("math-field")!;
              runLatexSelectionCommand(math, "selectionScopeExpand");
            }}
          >
            Select parent
          </DockCommandItem>
          <MenuSub>
            <MenuSubTrigger>Nested actions</MenuSubTrigger>
            <MenuSubPopup>
              <DockCommandItem
                onClick={() => {
                  const math = host!.querySelector<MathfieldElement>("math-field")!;
                  runLatexSelectionCommand(math, "selectionScopeExpand");
                }}
              >
                Expand in submenu
              </DockCommandItem>
            </MenuSubPopup>
          </MenuSub>
        </DockMenu>
      </div>
      <div className="scient-latex-visual-scroll">
        <div className="scient-latex-visual-document" data-latex-windowed="true">
          <Container className={display ? "scient-latex-visual-display-math" : undefined}>
            <LatexMathField
              ref={field}
              value={value}
              disabled={false}
              display={display}
              onChange={(value) => ({ accepted: true, value })}
              onFocus={() => {}}
              onExit={() => {}}
              onExtendOutside={() => false}
              onUndo={() => false}
              onRemoveEmpty={() => {}}
              onShortcut={() => false}
              onShortcutHint={() => {}}
              formatCopiedMath={(value) => value}
              parsePastedMath={(value) => value}
            />
          </Container>
        </div>
      </div>
    </>,
  );
  await expect.poll(() => host?.querySelector(".scient-latex-mathfield")).toBeTruthy();
  field.current!.focus();
  await expect.poll(() => host?.querySelector("math-field"), { timeout: 10000 }).toBeTruthy();
  const math = host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => math.getValue()).toBeTruthy();
  await frame();
  await userEvent.click(math);
  await expect.poll(() => math.matches(":focus-within")).toBe(true);
  await document.fonts.ready;
  await frame();
  return math;
}

interface Atom {
  type?: string;
  command?: string;
  value?: string;
  parentBranch?: unknown;
  parent?: Atom;
  style?: unknown;
}
function model(math: MathfieldElement) {
  return (
    math as unknown as {
      _mathfield: { model: { atoms: Atom[]; offsetOf: (atom: Atom) => number } };
    }
  )._mathfield.model;
}
function offset(math: MathfieldElement, value: string) {
  const current = model(math);
  const atom = current.atoms.find((atom) => atom.value === value);
  expect(atom).toBeTruthy();
  return current.offsetOf(atom!);
}

it("includes the bracket base when selection crosses into its exponent", async () => {
  const math = await mount(String.raw`\begin{pmatrix}\left(x\right)^2&y\end{pmatrix}`);
  const x = offset(math, "x"),
    exponent = offset(math, "2");
  for (const start of [x, x + 1]) {
    math.selection = { ranges: [[start, exponent]] };
    await frame();
    expect(math.getValue(math.selection, "latex-without-placeholders")).toContain("x");
    expect(math.getValue(math.selection, "latex-without-placeholders")).toContain("^2");
  }
  math.selection = { ranges: [[exponent - 1, exponent]] };
  await frame();
  expect(math.getValue(math.selection, "latex-without-placeholders")).toBe("2");
  math.selection = { ranges: [[x - 1, x]] };
  await frame();
  expect(math.getValue(math.selection, "latex-without-placeholders")).toBe("x");
});

it("Ctrl+A starts with bold text inside the underbrace label", async () => {
  const math = await mount(String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await frame();

  await userEvent.keyboard("{Control>}a{/Control}");
  await frame();

  expect(math.getValue(math.selection.ranges[0]!, "latex-without-placeholders")).toContain("times");
  expect(math.getValue(math.selection.ranges[0]!, "latex-without-placeholders")).not.toContain(
    "underbrace",
  );
});

const selectScope = async () => {
  await userEvent.keyboard("{Control>}a{/Control}");
  await frame();
};
const selected = (math: MathfieldElement) =>
  math.getValue(math.selection, "latex-without-placeholders");
const selectionBoxes = () => [
  ...document.querySelectorAll<HTMLElement>(
    ".scient-latex-range-selection,.scient-latex-cell-selection",
  ),
];

it.each([true, false])(
  "keeps all math guide corners visible inside bold, subscript and equation slots (display=%s)",
  async (display) => {
    const math = await mount(String.raw`\mathbf{h}_{i}`, display);
    for (const position of [
      offset(math, "h") - 1,
      offset(math, "h"),
      offset(math, "i") - 1,
      offset(math, "i"),
      0,
      math.lastOffset,
    ]) {
      math.position = position;
      await frame();
      await frame();
      const guide = host!.querySelector<HTMLElement>(
        ".scient-latex-scope-outline:not([data-guide])",
      );
      expect(guide, `guide at ${position}`).toBeTruthy();
      const bounds = guide!.getBoundingClientRect();
      const caret = math.shadowRoot!.querySelector<HTMLElement>(".ML__caret,.ML__text-caret")!;
      const stroke = mathCaretRect(math, caret);
      expect(stroke.left).toBeGreaterThanOrEqual(bounds.left);
      expect(stroke.right).toBeLessThanOrEqual(bounds.right);
      expect(stroke.top).toBeGreaterThanOrEqual(bounds.top);
      expect(stroke.bottom).toBeLessThanOrEqual(bounds.bottom);
      for (let ancestor = guide!.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        if (
          ["auto", "hidden", "clip", "scroll"].includes(style.overflowY) ||
          /\b(paint|content|strict)\b/u.test(style.contain) ||
          style.contentVisibility === "auto"
        ) {
          expect(bounds.top, `${ancestor.className}: top at ${position}`).toBeGreaterThanOrEqual(
            box.top - 1,
          );
          expect(bounds.bottom, `${ancestor.className}: bottom at ${position}`).toBeLessThanOrEqual(
            box.bottom + 1,
          );
        }
      }
    }
  },
);

it.each([true, false])(
  "places a collapsed caret in newly inserted nested argument slots (display=%s)",
  async (display) => {
    for (const command of [
      String.raw`\mathbf{}`,
      String.raw`\frac{#?}{#?}`,
      String.raw`\sqrt{#?}`,
      String.raw`\hat{#?}`,
      String.raw`\begin{pmatrix}#? & #? \\ #? & #?\end{pmatrix}`,
    ]) {
      const math = await mount("x", display);
      math.position = math.lastOffset;
      field.current!.insert(command);
      await document.fonts.ready;
      await frame();
      await frame();
      expect(math.selectionIsCollapsed, command).toBe(true);
      // Native layout, slot decoration and the shared overlay paint in order.
      // Wait for their final geometry rather than reading a previous render.
      await expect
        .poll(() => {
          const guide = host!.querySelector<HTMLElement>(
            ".scient-latex-scope-outline:not([data-guide])",
          );
          const caret = math.shadowRoot!.querySelector<HTMLElement>(".ML__caret,.ML__text-caret");
          if (!guide || !caret) return Infinity;
          const stroke = mathCaretRect(math, caret),
            bounds = guide.getBoundingClientRect();
          return Math.abs(stroke.left + stroke.width / 2 - (bounds.left + bounds.width / 2));
        })
        .toBeLessThan(1);
      const guide = host!.querySelector<HTMLElement>(
        ".scient-latex-scope-outline:not([data-guide])",
      )!;
      expect(guide, command).toBeTruthy();
      const caret = math.shadowRoot!.querySelector<HTMLElement>(".ML__caret,.ML__text-caret")!;
      const stroke = mathCaretRect(math, caret),
        bounds = guide.getBoundingClientRect();
      expect(
        Math.abs(stroke.left + stroke.width / 2 - (bounds.left + bounds.width / 2)),
        command,
      ).toBeLessThan(1);
      root!.unmount();
      host!.remove();
      root = undefined;
      host = undefined;
      await frame();
    }
  },
);

it("enters a bold wrapper after wrapping existing selected content", async () => {
  const math = await mount("h", true);
  math.selection = { ranges: [[0, math.lastOffset]] };
  field.current!.insert(String.raw`\mathbf{}`);
  await frame();
  expect(math.selectionIsCollapsed).toBe(true);
  expect(math.getValue("latex-without-placeholders")).toBe(String.raw`\mathbf{h}`);
  expect(mathEditingScopes(math)[0]!.label).toBe("Bold");
  await userEvent.keyboard("i");
  await frame();
  expect(math.getValue("latex-without-placeholders")).toBe(String.raw`\mathbf{hi}`);
});

it.each([true, false])(
  "new empty angle brackets match their type-and-delete layout (display=%s)",
  async (display) => {
    const math = await mount(String.raw`\mathbf{h}_{i}=`, display);
    math.position = math.lastOffset;
    field.current!.insert(mathBracketsTemplate("angle", "angle", "auto")!);
    await document.fonts.ready;
    await frame();
    await frame();
    expect(math.selectionIsCollapsed).toBe(true);
    expect(math.getValue()).not.toContain("placeholder");
    const source = math.getValue("latex-without-placeholders");
    const measure = () => [
      math.shadowRoot!.querySelector<HTMLElement>(".ML__open")!.getBoundingClientRect(),
      math.shadowRoot!.querySelector<HTMLElement>(".ML__close")!.getBoundingClientRect(),
      host!
        .querySelector<HTMLElement>(".scient-latex-scope-outline:not([data-guide])")!
        .getBoundingClientRect(),
    ];
    const initial = measure();
    await userEvent.keyboard("x{Backspace}");
    await frame();
    await frame();
    expect(math.getValue("latex-without-placeholders")).toBe(source);
    for (const [index, rect] of measure().entries()) {
      expect(rect.width).toBeCloseTo(initial[index]!.width, 0);
      expect(rect.height).toBeCloseTo(initial[index]!.height, 0);
      expect(rect.left).toBeCloseTo(initial[index]!.left, 0);
      expect(rect.top).toBeCloseTo(initial[index]!.top, 0);
    }
  },
);

it("command completion enters the empty nested argument with an insertion caret", async () => {
  const math = await mount("x", true);
  math.position = math.lastOffset;
  await userEvent.keyboard(String.raw`\frac`);
  await userEvent.keyboard("{Enter}");
  await frame();
  expect(math.selectionIsCollapsed).toBe(true);
  expect(math.getValue("latex-without-placeholders")).toBe(String.raw`x\frac{}{}`);
  await userEvent.keyboard("h");
  await frame();
  expect(math.getValue("latex-without-placeholders")).toBe(String.raw`x\frac{h}{}`);
});

it("repeated Ctrl+A visits bold, label, underbrace, then equation", async () => {
  const math = await mount(String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  const source = math.getValue();
  math.position = offset(math, "m");
  await frame();
  const scopes = mathEditingScopes(math);
  expect(scopes.map((scope) => scope.label)).toEqual(["Bold", "Label", "Underbrace", "Equation"]);
  for (const scope of scopes) {
    await selectScope();
    expect(math.selection.ranges).toEqual([[...scope.range]]);
  }
  expect(selected(math)).toContain("=");
  expect(math.getValue()).toBe(source);
});

it("whole underbrace selection is connected and label/text selections stay local", async () => {
  const math = await mount(String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await frame();
  const scopes = mathEditingScopes(math);
  const boxes: DOMRect[] = [];
  for (let i = 0; i < scopes.length; i++) {
    await selectScope();
    expect(selectionBoxes()).toHaveLength(1);
    boxes.push(selectionBoxes()[0]!.getBoundingClientRect());
    expect(
      [...math.shadowRoot!.querySelectorAll(".ML__selection")].every(
        (node) => getComputedStyle(node).display === "none",
      ),
    ).toBe(true);
  }
  expect(boxes[0]!.width).toBeLessThan(boxes[1]!.width);
  expect(boxes[1]!.height).toBeLessThan(boxes[2]!.height);
  expect(boxes[2]!.left).toBeLessThanOrEqual(boxes[1]!.left);
  expect(boxes[2]!.bottom).toBeGreaterThanOrEqual(boxes[1]!.bottom);
  expect(boxes[3]!.width).toBeGreaterThan(boxes[2]!.width);
});

it("Ctrl+A can climb more than ten nested scopes", async () => {
  let source = "x";
  for (let i = 0; i < 6; i++) source = String.raw`\frac{${source}}{y}`;
  const math = await mount(source);
  math.position = offset(math, "x");
  await frame();
  const scopes = mathEditingScopes(math);
  expect(scopes.length).toBeGreaterThan(10);
  for (const scope of scopes) {
    await selectScope();
    expect(math.selection.ranges).toEqual([[...scope.range]]);
  }
});

it("caret movement and typing restart the Ctrl+A ladder", async () => {
  const math = await mount(String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await frame();
  await selectScope();
  await selectScope();
  await userEvent.keyboard("{ArrowLeft}");
  await frame();
  const restarted = mathEditingScopes(math)[0]!;
  await selectScope();
  expect(math.selection.ranges).toEqual([[...restarted.range]]);
  math.position = offset(math, "m");
  await frame();
  await selectScope();
  await userEvent.keyboard("new");
  await frame();
  const edited = mathEditingScopes(math)[0]!;
  await selectScope();
  expect(math.selection.ranges).toEqual([[...edited.range]]);
});

it("menu and submenu keep the selection and Ctrl+A ladder", async () => {
  const math = await mount(String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await frame();
  const scopes = mathEditingScopes(math);
  await selectScope();
  const before = selected(math);
  await page.getByRole("button", { name: "Selection actions" }).click();
  await frame();
  expect(selected(math)).toBe(before);
  expect(document.querySelectorAll(".scient-latex-retained-selection")).toHaveLength(1);
  await page.getByRole("menuitem", { name: "Nested actions" }).click();
  await frame();
  expect(selected(math)).toBe(before);
  await page.getByRole("menuitem", { name: "Expand in submenu" }).click();
  await frame();
  expect(math.selection.ranges).toEqual([[...scopes[1]!.range]]);
  await expect.poll(() => math.matches(":focus-within")).toBe(true);
  await selectScope();
  expect(math.selection.ranges).toEqual([[...scopes[2]!.range]]);
});

it("Ctrl+A selects an empty matrix cell before its matrix", async () => {
  const math = await mount(String.raw`\begin{pmatrix}x&\end{pmatrix}`);
  const empty = model(math).atoms.find(
    (atom) =>
      atom.type === "first" && Array.isArray(atom.parentBranch) && atom.parentBranch[1] === 1,
  )!;
  math.position = model(math).offsetOf(empty);
  await frame();
  const scopes = mathEditingScopes(math);
  expect(scopes[0]!.label).toBe("Cell (1, 2)");
  await selectScope();
  expect(math.selection.ranges).toEqual([[...scopes[0]!.range]]);
  expect(selectionBoxes()).toHaveLength(1);
  await selectScope();
  expect(math.selection.ranges).toEqual([[...scopes[1]!.range]]);
});

it("pointer dragging across closing bracket and exponent selects the complete base", async () => {
  const math = await mount(String.raw`\begin{pmatrix}\left(x\right)^2&y\end{pmatrix}`);
  const x = offset(math, "x"),
    exponent = offset(math, "2");
  const base = math.getElementInfo(x + 1)!.bounds!;
  const script = math.getElementInfo(exponent)!.bounds!;
  const field = math.getBoundingClientRect();
  const bracketPoint = {
    x: base.right - field.left - 1,
    y: base.top + base.height / 2 - field.top,
  };
  const scriptPoint = {
    x: script.right - field.left,
    y: script.top + script.height / 2 - field.top,
  };
  expect([x, x + 1]).toContain(
    mathSelectionPoint(math, base.right - 1, base.top + base.height / 2).offset,
  );
  for (const reverse of [false, true]) {
    await userEvent.dragAndDrop(math, math, {
      sourcePosition: reverse ? scriptPoint : bracketPoint,
      targetPosition: reverse ? bracketPoint : scriptPoint,
    });
    await frame();
    expect(selected(math)).toContain("x");
    expect(selected(math)).toContain("^2");
    expect(selected(math)).not.toContain("y");
  }
});

it("Escape from a menu restores focus without restarting the Ctrl+A ladder", async () => {
  const math = await mount(String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await frame();
  const scopes = mathEditingScopes(math);
  await selectScope();
  const before = selected(math);
  await page.getByRole("button", { name: "Selection actions" }).click();
  await frame();
  await userEvent.keyboard("{Escape}");
  await frame();
  expect(selected(math)).toBe(before);
  await expect.poll(() => math.matches(":focus-within")).toBe(true);
  await selectScope();
  expect(math.selection.ranges).toEqual([[...scopes[1]!.range]]);
});

it("Ctrl+A preserves distinct bracket, script and cell scopes even when their ranges match", async () => {
  const math = await mount(String.raw`\begin{pmatrix}\left(x\right)^2&y\end{pmatrix}`);
  math.position = offset(math, "x");
  await frame();
  const scopes = mathEditingScopes(math);
  expect(scopes.map((scope) => scope.label)).toEqual([
    "Body",
    "Brackets",
    "Scripts",
    "Cell (1, 1)",
    "Matrix",
    "Equation",
  ]);
  for (const scope of scopes) {
    await selectScope();
    expect(math.selection.ranges).toEqual([[...scope.range]]);
  }
});

it("clicking back inside a nested scope restarts Ctrl+A", async () => {
  const math = await mount(String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await frame();
  await selectScope();
  await selectScope();
  await selectScope();
  const m = math.getElementInfo(offset(math, "m"))!.bounds!;
  const field = math.getBoundingClientRect();
  await userEvent.click(math, {
    position: { x: m.left + m.width / 2 - field.left, y: m.top + m.height / 2 - field.top },
  });
  await frame();
  const inner = mathEditingScopes(math)[0]!;
  expect(inner.label).toBe("Bold");
  await selectScope();
  expect(math.selection.ranges).toEqual([[...inner.range]]);
});
