import { expect, it, vi } from "vite-plus/test";
import { registerLatexSelection } from "./latexSelectionSession";
import "./scient-latex.css";

const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.workspace = document.createElement("div");
  _fixture.workspace.className = "scient-latex-visual-workspace";
  const layer = document.createElement("div");
  layer.className = "scient-latex-page-zoom-frame";
  layer.style.cssText = "position:relative;transform:scale(1.37);transform-origin:0 0;width:600px";
  _fixture.surface = document.createElement("div");
  _fixture.surface.className = "scient-latex-visual-document";
  _fixture.surface.contentEditable = "true";
  _fixture.surface.style.cssText =
    "font:20px/28px monospace;padding:20px;min-height:100px;--scient-latex-selection-background:rgba(20,90,160,.22);--scient-latex-retained-selection-background:rgba(100,110,120,.24)";
  const paragraph = document.createElement("p");
  const text = document.createTextNode("A short selection for ink geometry.");
  paragraph.append(text);
  _fixture.surface.append(paragraph);
  layer.append(_fixture.surface);
  _fixture.workspace.append(layer);
  document.body.append(_fixture.workspace);
  _fixture.range = document.createRange();
  _fixture.range.setStart(text, 2);
  _fixture.range.setEnd(text, 17);
  _fixture.surface.focus();
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(_fixture.range.cloneRange());
  _fixture.registration = registerLatexSelection({
    element: _fixture.surface,
    command: () => false,
    capture: () => ({
      path: ["Text"],
      scopes: () => [],
      selection: () => [..._fixture.range.getClientRects()],
      caret: () => [..._fixture.range.getClientRects()],
      selectionOverlay: true,
      restore: (focus) => {
        if (focus) _fixture.surface.focus();
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(_fixture.range.cloneRange());
        return true;
      },
    }),
  });
}

async function _cleanupFixture1(_fixture: _Fixture) {
  vi.restoreAllMocks();
  _fixture.registration.dispose();
  document.getSelection()?.removeAllRanges();
  _fixture.workspace.remove();
  for (const root of _fixture.splitRoots.splice(0)) root.remove();
}

function watchOverlayWrites(_fixture: _Fixture) {
  const writes: string[] = [];
  const original = CSSStyleDeclaration.prototype.setProperty;
  vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
    this: CSSStyleDeclaration,
    name,
    value,
    priority,
  ) {
    if (
      this ===
      _fixture.workspace.querySelector<HTMLElement>(".scient-latex-selection-overlay")?.style
    )
      writes.push(name);
    return original.call(this, name, value, priority);
  });
  return writes;
}

it("reads colors before overlay writes and keeps ink aligned at fractional zoom", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const order: string[] = [];
  const nativeComputed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = nativeComputed(element, pseudo);
    if (element !== _fixture.surface) return style;
    return new Proxy(style, {
      get(target, key) {
        if (key === "getPropertyValue")
          return (name: string) => {
            order.push(`read:${name}`);
            return target.getPropertyValue(name);
          };
        return Reflect.get(target, key, target);
      },
    });
  });
  const original = CSSStyleDeclaration.prototype.setProperty;
  vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
    this: CSSStyleDeclaration,
    name,
    value,
    priority,
  ) {
    if (
      this ===
      _fixture.workspace.querySelector<HTMLElement>(".scient-latex-selection-overlay")?.style
    )
      order.push(`write:${name}`);
    return original.call(this, name, value, priority);
  });
  await frame();
  const writesAt = order.findIndex((entry) => entry.startsWith("write:"));
  expect(writesAt).toBeGreaterThan(0);
  expect(order.slice(0, writesAt).filter((entry) => entry.startsWith("read:"))).toHaveLength(3);
  expect(order.slice(writesAt).some((entry) => entry.startsWith("read:"))).toBe(false);
  const ink = _fixture.range.getBoundingClientRect();
  const highlight = _fixture.workspace
    .querySelector<HTMLElement>(".scient-latex-range-selection")!
    .getBoundingClientRect();
  for (const edge of ["left", "top", "right", "bottom"] as const)
    expect(Math.abs(ink[edge] - highlight[edge])).toBeLessThan(0.1);
  expect(_fixture.surface.textContent).toBe("A short selection for ink geometry.");
});

it("does not rewrite unchanged overlay variables and responds to a changed color", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await frame();
  const writes = watchOverlayWrites(_fixture);
  _fixture.registration.refresh();
  await frame();
  expect(writes).toEqual([]);
  _fixture.surface.style.setProperty("--scient-latex-selection-background", "rgba(70,80,190,.22)");
  _fixture.registration.refresh();
  await frame();
  expect(writes).toEqual([
    "--scient-latex-selection-background",
    "--scient-latex-cell-selection-background",
  ]);
  expect(
    _fixture.workspace
      .querySelector<HTMLElement>(".scient-latex-selection-overlay")!
      .style.getPropertyValue("--scient-latex-selection-background"),
  ).toBe("rgba(70,80,190,.22)");
});

it("retains selected ink and muted colors through menu focus, then restores active ink", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await frame();
  const ink = _fixture.range.getBoundingClientRect();
  const menu = document.createElement("button");
  const toolbar = document.createElement("div");
  toolbar.className = "scient-latex-writing-toolbar";
  toolbar.append(menu);
  _fixture.workspace.append(toolbar);
  menu.focus();
  await frame();
  const held = _fixture.workspace.querySelector<HTMLElement>(".scient-latex-retained-selection")!;
  expect(held).toBeTruthy();
  expect(Math.abs(held.getBoundingClientRect().left - ink.left)).toBeLessThan(0.1);
  expect(_fixture.workspace.hasAttribute("data-scient-selection-held")).toBe(true);
  _fixture.surface.focus();
  _fixture.registration.refresh();
  await frame();
  expect(_fixture.workspace.querySelector(".scient-latex-retained-selection")).toBeNull();
  expect(_fixture.workspace.querySelector(".scient-latex-range-selection")).toBeTruthy();
  expect(_fixture.workspace.hasAttribute("data-scient-selection-held")).toBe(false);
  expect(_fixture.surface.textContent).toBe("A short selection for ink geometry.");
});

it("retains Visual ink when Source takes focus in Split", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const split = document.createElement("div");
  split.dataset.latexSplit = "true";
  _fixture.workspace.before(split);
  split.append(_fixture.workspace);
  _fixture.splitRoots.push(split);
  const source = document.createElement("textarea");
  source.className = "scient-latex-pane";
  split.append(source);
  // DOM reparenting moves live Range boundaries; the model range stays on its ink.
  const text = _fixture.surface.querySelector("p")!.firstChild!;
  _fixture.range.setStart(text, 2);
  _fixture.range.setEnd(text, 17);
  _fixture.surface.focus();
  _fixture.registration.refresh();
  await frame();
  source.focus();
  await frame();
  expect(_fixture.workspace.querySelector(".scient-latex-retained-selection")).toBeTruthy();
  expect(document.activeElement).toBe(source);
  _fixture.surface.focus();
  _fixture.registration.refresh();
  await frame();
  expect(_fixture.workspace.querySelector(".scient-latex-range-selection")).toBeTruthy();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    range: undefined! as Range,
    registration: undefined! as ReturnType<typeof registerLatexSelection>,

    workspace: undefined! as HTMLDivElement,
    surface: undefined! as HTMLDivElement,
    splitRoots: [] as HTMLElement[],
    stack,
    cleanup,
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
