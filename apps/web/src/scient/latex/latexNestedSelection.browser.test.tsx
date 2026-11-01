import { render as _fixtureRender, type Screen } from "../../../test/render";
import { observeLatexSelectionPresentation } from "./latexSelectionPresentation.testkit";

import { createRef } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { MenuSub, MenuSubTrigger, MenuSubPopup } from "~/components/ui/menu";
import { DockMenu, DockCommandItem } from "../writing/dockChrome";
import { runLatexSelectionCommand } from "./latexSelectionSession";
import type { MathfieldElement } from "mathlive";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { mathBracketsTemplate } from "./mathBrackets";
import { mathEditingScopes, mathSelectionPoint, mathCaretRect } from "./mathLiveSelection";
import "./scient-latex.css";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

async function mount(_fixture: _Fixture, value: string, display = false) {
  const Container = display ? "div" : "p";
  await page.viewport(1400, 900);
  _fixture.host = document.createElement("div");
  _fixture.host.className = "scient-latex-visual-workspace";
  _fixture.host.style.cssText =
    "position:relative; width:900px; height:500px; background:white; color:black; padding:40px;";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  _fixture.selectionPresentation = _fixture.stack.use(
    observeLatexSelectionPresentation(_fixture.host),
  );
  await _fixture.root0.rerender(
    <>
      <div className="scient-latex-writing-toolbar">
        <DockMenu label="Selection actions" icon={<span>Selection actions</span>}>
          <DockCommandItem
            onClick={() => {
              const math = _fixture.host!.querySelector<MathfieldElement>("math-field")!;
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
                  const math = _fixture.host!.querySelector<MathfieldElement>("math-field")!;
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
              ref={_fixture.field}
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
  await expect.poll(() => _fixture.host?.querySelector(".scient-latex-mathfield")).toBeTruthy();
  _fixture.field.current!.focus();
  await expect
    .poll(() => _fixture.host?.querySelector("math-field"), { timeout: 10000 })
    .toBeTruthy();
  const math = _fixture.host.querySelector<MathfieldElement>("math-field")!;
  await expect.poll(() => math.getValue()).toBeTruthy();
  await _fixture.selectionPresentation!.wait();
  await userEvent.click(math);
  await expect.poll(() => math.matches(":focus-within")).toBe(true);
  await document.fonts.ready;
  await _fixture.selectionPresentation!.wait();
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\begin{pmatrix}\left(x\right)^2&y\end{pmatrix}`);
  const x = offset(math, "x");
  const exponent = offset(math, "2");
  for (const start of [x, x + 1]) {
    math.selection = { ranges: [[start, exponent]] };
    await _fixture.selectionPresentation!.wait();
    expect(math.getValue(math.selection, "latex-without-placeholders")).toContain("x");
    expect(math.getValue(math.selection, "latex-without-placeholders")).toContain("^2");
  }
  math.selection = { ranges: [[exponent - 1, exponent]] };
  await _fixture.selectionPresentation!.wait();
  expect(math.getValue(math.selection, "latex-without-placeholders")).toBe("2");
  math.selection = { ranges: [[x - 1, x]] };
  await _fixture.selectionPresentation!.wait();
  expect(math.getValue(math.selection, "latex-without-placeholders")).toBe("x");
});

const selectScope = async (_fixture: _Fixture) => {
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
  await _fixture.selectionPresentation!.wait();
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const math = await mount(_fixture, String.raw`\mathbf{h}_{i}`, display);
    for (const position of [
      offset(math, "h") - 1,
      offset(math, "h"),
      offset(math, "i") - 1,
      offset(math, "i"),
      0,
      math.lastOffset,
    ]) {
      math.position = position;
      await _fixture.selectionPresentation!.wait();
      await _fixture.selectionPresentation!.wait();
      const guide = _fixture.host!.querySelector<HTMLElement>(
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    for (const command of [
      String.raw`\mathbf{}`,
      String.raw`\frac{#?}{#?}`,
      String.raw`\sqrt{#?}`,
      String.raw`\hat{#?}`,
      String.raw`\begin{pmatrix}#? & #? \\ #? & #?\end{pmatrix}`,
    ]) {
      const math = await mount(_fixture, "x", display);
      math.position = math.lastOffset;
      _fixture.field.current!.insert(command);
      await document.fonts.ready;
      await _fixture.selectionPresentation!.wait();
      await _fixture.selectionPresentation!.wait();
      expect(math.selectionIsCollapsed, command).toBe(true);
      // Native layout, slot decoration and the shared overlay paint in order.
      // Wait for their final geometry rather than reading a previous render.
      await expect
        .poll(() => {
          const guide = _fixture.host!.querySelector<HTMLElement>(
            ".scient-latex-scope-outline:not([data-guide])",
          );
          const caret = math.shadowRoot!.querySelector<HTMLElement>(".ML__caret,.ML__text-caret");
          if (!guide || !caret) return Infinity;
          const stroke = mathCaretRect(math, caret);
          const bounds = guide.getBoundingClientRect();
          return Math.abs(stroke.left + stroke.width / 2 - (bounds.left + bounds.width / 2));
        })
        .toBeLessThan(1);
      const guide = _fixture.host!.querySelector<HTMLElement>(
        ".scient-latex-scope-outline:not([data-guide])",
      )!;
      expect(guide, command).toBeTruthy();
      const caret = math.shadowRoot!.querySelector<HTMLElement>(".ML__caret,.ML__text-caret")!;
      const stroke = mathCaretRect(math, caret);
      const bounds = guide.getBoundingClientRect();
      expect(
        Math.abs(stroke.left + stroke.width / 2 - (bounds.left + bounds.width / 2)),
        command,
      ).toBeLessThan(1);
      await _fixture.root0!.unmount();
      _fixture.host!.remove();
      _fixture.root0 = undefined;
      _fixture.host = undefined;
    }
  },
);

it("enters a bold wrapper after wrapping existing selected content", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, "h", true);
  math.selection = { ranges: [[0, math.lastOffset]] };
  _fixture.field.current!.insert(String.raw`\mathbf{}`);
  await _fixture.selectionPresentation!.wait();
  expect(math.selectionIsCollapsed).toBe(true);
  expect(math.getValue("latex-without-placeholders")).toBe(String.raw`\mathbf{h}`);
  expect(mathEditingScopes(math)[0]!.label).toBe("Bold");
  await userEvent.keyboard("i");
  await _fixture.selectionPresentation!.wait();
  expect(math.getValue("latex-without-placeholders")).toBe(String.raw`\mathbf{hi}`);
});

it.each([true, false])(
  "new empty angle brackets match their type-and-delete layout (display=%s)",
  async (display) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const math = await mount(_fixture, String.raw`\mathbf{h}_{i}=`, display);
    math.position = math.lastOffset;
    _fixture.field.current!.insert(mathBracketsTemplate("angle", "angle", "auto")!);
    await document.fonts.ready;
    await _fixture.selectionPresentation!.wait();
    await _fixture.selectionPresentation!.wait();
    expect(math.selectionIsCollapsed).toBe(true);
    expect(math.getValue()).not.toContain("placeholder");
    const source = math.getValue("latex-without-placeholders");
    const measure = () => [
      math.shadowRoot!.querySelector<HTMLElement>(".ML__open")!.getBoundingClientRect(),
      math.shadowRoot!.querySelector<HTMLElement>(".ML__close")!.getBoundingClientRect(),
      _fixture
        .host!.querySelector<HTMLElement>(".scient-latex-scope-outline:not([data-guide])")!
        .getBoundingClientRect(),
    ];
    const initial = measure();
    await userEvent.keyboard("x{Backspace}");
    await _fixture.selectionPresentation!.wait();
    await _fixture.selectionPresentation!.wait();
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, "x", true);
  math.position = math.lastOffset;
  await userEvent.keyboard(String.raw`\frac`);
  await userEvent.keyboard("{Enter}");
  await _fixture.selectionPresentation!.wait();
  expect(math.selectionIsCollapsed).toBe(true);
  expect(math.getValue("latex-without-placeholders")).toBe(String.raw`x\frac{}{}`);
  await userEvent.keyboard("h");
  await _fixture.selectionPresentation!.wait();
  expect(math.getValue("latex-without-placeholders")).toBe(String.raw`x\frac{h}{}`);
});

it("repeated Select All visits bold, label, underbrace, then equation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  const source = math.getValue();
  math.position = offset(math, "m");
  await _fixture.selectionPresentation!.wait();
  const scopes = mathEditingScopes(math);
  expect(scopes.map((scope) => scope.label)).toEqual(["Bold", "Label", "Underbrace", "Equation"]);
  for (const scope of scopes) {
    await selectScope(_fixture);
    expect(math.selection.ranges).toEqual([[...scope.range]]);
  }
  expect(selected(math)).toContain("=");
  expect(math.getValue()).toBe(source);
});

it("whole underbrace selection is connected and label/text selections stay local", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await _fixture.selectionPresentation!.wait();
  const scopes = mathEditingScopes(math);
  const boxes: DOMRect[] = [];
  for (let i = 0; i < scopes.length; i++) {
    await selectScope(_fixture);
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

it("Select All can climb more than ten nested scopes", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  let source = "x";
  for (let i = 0; i < 6; i++) source = String.raw`\frac{${source}}{y}`;
  const math = await mount(_fixture, source);
  math.position = offset(math, "x");
  await _fixture.selectionPresentation!.wait();
  const scopes = mathEditingScopes(math);
  expect(scopes.length).toBeGreaterThan(10);
  for (const scope of scopes) {
    await selectScope(_fixture);
    expect(math.selection.ranges).toEqual([[...scope.range]]);
  }
});

it("caret movement and typing restart the Select All ladder", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await _fixture.selectionPresentation!.wait();
  await selectScope(_fixture);
  await selectScope(_fixture);
  await userEvent.keyboard("{ArrowLeft}");
  await _fixture.selectionPresentation!.wait();
  const restarted = mathEditingScopes(math)[0]!;
  await selectScope(_fixture);
  expect(math.selection.ranges).toEqual([[...restarted.range]]);
  math.position = offset(math, "m");
  await _fixture.selectionPresentation!.wait();
  await selectScope(_fixture);
  await userEvent.keyboard("new");
  await _fixture.selectionPresentation!.wait();
  const edited = mathEditingScopes(math)[0]!;
  await selectScope(_fixture);
  expect(math.selection.ranges).toEqual([[...edited.range]]);
});

it("menu and submenu keep the selection and Select All ladder", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await _fixture.selectionPresentation!.wait();
  const scopes = mathEditingScopes(math);
  await selectScope(_fixture);
  const before = selected(math);
  await page.getByRole("button", { name: "Selection actions" }).click();
  await _fixture.selectionPresentation!.wait();
  expect(selected(math)).toBe(before);
  expect(document.querySelectorAll(".scient-latex-retained-selection")).toHaveLength(1);
  await page.getByRole("menuitem", { name: "Nested actions" }).click();
  await _fixture.selectionPresentation!.wait();
  expect(selected(math)).toBe(before);
  await page.getByRole("menuitem", { name: "Expand in submenu" }).click();
  await _fixture.selectionPresentation!.wait();
  expect(math.selection.ranges).toEqual([[...scopes[1]!.range]]);
  await expect.poll(() => math.matches(":focus-within")).toBe(true);
  await selectScope(_fixture);
  expect(math.selection.ranges).toEqual([[...scopes[2]!.range]]);
});

it("Select All selects an empty matrix cell before its matrix", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\begin{pmatrix}x&\end{pmatrix}`);
  const empty = model(math).atoms.find(
    (atom) =>
      atom.type === "first" && Array.isArray(atom.parentBranch) && atom.parentBranch[1] === 1,
  )!;
  math.position = model(math).offsetOf(empty);
  await _fixture.selectionPresentation!.wait();
  const scopes = mathEditingScopes(math);
  expect(scopes[0]!.label).toBe("Cell (1, 2)");
  await selectScope(_fixture);
  expect(math.selection.ranges).toEqual([[...scopes[0]!.range]]);
  expect(selectionBoxes()).toHaveLength(1);
  await selectScope(_fixture);
  expect(math.selection.ranges).toEqual([[...scopes[1]!.range]]);
});

it("pointer dragging across closing bracket and exponent selects the complete base", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\begin{pmatrix}\left(x\right)^2&y\end{pmatrix}`);
  const x = offset(math, "x");
  const exponent = offset(math, "2");
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
    await _fixture.selectionPresentation!.wait();
    expect(selected(math)).toContain("x");
    expect(selected(math)).toContain("^2");
    expect(selected(math)).not.toContain("y");
  }
});

it("Escape from a menu restores focus without restarting the Select All ladder", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await _fixture.selectionPresentation!.wait();
  const scopes = mathEditingScopes(math);
  await selectScope(_fixture);
  const before = selected(math);
  await page.getByRole("button", { name: "Selection actions" }).click();
  await _fixture.selectionPresentation!.wait();
  await userEvent.keyboard("{Escape}");
  await _fixture.selectionPresentation!.wait();
  expect(selected(math)).toBe(before);
  await expect.poll(() => math.matches(":focus-within")).toBe(true);
  await selectScope(_fixture);
  expect(math.selection.ranges).toEqual([[...scopes[1]!.range]]);
});

it("Select All preserves distinct bracket, script and cell scopes even when their ranges match", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\begin{pmatrix}\left(x\right)^2&y\end{pmatrix}`);
  math.position = offset(math, "x");
  await _fixture.selectionPresentation!.wait();
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
    await selectScope(_fixture);
    expect(math.selection.ranges).toEqual([[...scope.range]]);
  }
});

it("clicking back inside a nested scope restarts Select All", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const math = await mount(_fixture, String.raw`\underbrace{1+\cdots+1}_{n\ \textbf{times}}=`);
  math.position = offset(math, "m");
  await _fixture.selectionPresentation!.wait();
  await selectScope(_fixture);
  await selectScope(_fixture);
  await selectScope(_fixture);
  const m = math.getElementInfo(offset(math, "m"))!.bounds!;
  const field = math.getBoundingClientRect();
  await userEvent.click(math, {
    position: { x: m.left + m.width / 2 - field.left, y: m.top + m.height / 2 - field.top },
  });
  await _fixture.selectionPresentation!.wait();
  const inner = mathEditingScopes(math)[0]!;
  expect(inner.label).toBe("Bold");
  await selectScope(_fixture);
  expect(math.selection.ranges).toEqual([[...inner.range]]);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const field = createRef<LatexMathFieldHandle>();
  return {
    field,
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
