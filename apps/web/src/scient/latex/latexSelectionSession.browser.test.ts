import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { registerLatexSelection } from "./latexSelectionSession";
import "./scient-latex.css";

let workspace: HTMLDivElement;
let surface: HTMLDivElement;
let range: Range;
let registration: ReturnType<typeof registerLatexSelection>;
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

beforeEach(() => {
  workspace = document.createElement("div");
  workspace.className = "scient-latex-visual-workspace";
  const layer = document.createElement("div");
  layer.className = "scient-latex-page-zoom-frame";
  layer.style.cssText = "position:relative;transform:scale(1.37);transform-origin:0 0;width:600px";
  surface = document.createElement("div");
  surface.className = "scient-latex-visual-document";
  surface.contentEditable = "true";
  surface.style.cssText =
    "font:20px/28px monospace;padding:20px;min-height:100px;--scient-latex-selection-background:rgba(20,90,160,.22);--scient-latex-retained-selection-background:rgba(100,110,120,.24)";
  const paragraph = document.createElement("p");
  const text = document.createTextNode("A short selection for ink geometry.");
  paragraph.append(text);
  surface.append(paragraph);
  layer.append(surface);
  workspace.append(layer);
  document.body.append(workspace);
  range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 17);
  surface.focus();
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range.cloneRange());
  registration = registerLatexSelection({
    element: surface,
    command: () => false,
    capture: () => ({
      path: ["Text"],
      scopes: () => [],
      selection: () => [...range.getClientRects()],
      selectionOverlay: true,
      restore: (focus) => {
        if (focus) surface.focus();
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range.cloneRange());
        return true;
      },
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  registration.dispose();
  document.getSelection()?.removeAllRanges();
  workspace.remove();
});

function watchOverlayWrites() {
  const writes: string[] = [];
  const original = CSSStyleDeclaration.prototype.setProperty;
  vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
    this: CSSStyleDeclaration,
    name,
    value,
    priority,
  ) {
    if (this === workspace.querySelector<HTMLElement>(".scient-latex-selection-overlay")?.style)
      writes.push(name);
    return original.call(this, name, value, priority);
  });
  return writes;
}

it("reads colors before overlay writes and keeps ink aligned at fractional zoom", async () => {
  const order: string[] = [];
  const nativeComputed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = nativeComputed(element, pseudo);
    if (element !== surface) return style;
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
    if (this === workspace.querySelector<HTMLElement>(".scient-latex-selection-overlay")?.style)
      order.push(`write:${name}`);
    return original.call(this, name, value, priority);
  });
  await frame();
  const writesAt = order.findIndex((entry) => entry.startsWith("write:"));
  expect(writesAt).toBeGreaterThan(0);
  expect(order.slice(0, writesAt).filter((entry) => entry.startsWith("read:"))).toHaveLength(3);
  expect(order.slice(writesAt).some((entry) => entry.startsWith("read:"))).toBe(false);
  const ink = range.getBoundingClientRect();
  const highlight = workspace
    .querySelector<HTMLElement>(".scient-latex-range-selection")!
    .getBoundingClientRect();
  for (const edge of ["left", "top", "right", "bottom"] as const)
    expect(Math.abs(ink[edge] - highlight[edge])).toBeLessThan(0.1);
  expect(surface.textContent).toBe("A short selection for ink geometry.");
});

it("does not rewrite unchanged overlay variables and responds to a changed color", async () => {
  await frame();
  const writes = watchOverlayWrites();
  registration.refresh();
  await frame();
  expect(writes).toEqual([]);
  surface.style.setProperty("--scient-latex-selection-background", "rgba(70,80,190,.22)");
  registration.refresh();
  await frame();
  expect(writes).toEqual([
    "--scient-latex-selection-background",
    "--scient-latex-cell-selection-background",
  ]);
  expect(
    workspace
      .querySelector<HTMLElement>(".scient-latex-selection-overlay")!
      .style.getPropertyValue("--scient-latex-selection-background"),
  ).toBe("rgba(70,80,190,.22)");
});

it("retains selected ink and muted colors through menu focus, then restores active ink", async () => {
  await frame();
  const ink = range.getBoundingClientRect();
  const menu = document.createElement("button");
  const toolbar = document.createElement("div");
  toolbar.className = "scient-latex-writing-toolbar";
  toolbar.append(menu);
  workspace.append(toolbar);
  menu.focus();
  await frame();
  const held = workspace.querySelector<HTMLElement>(".scient-latex-retained-selection")!;
  expect(held).toBeTruthy();
  expect(Math.abs(held.getBoundingClientRect().left - ink.left)).toBeLessThan(0.1);
  expect(workspace.hasAttribute("data-scient-selection-held")).toBe(true);
  surface.focus();
  registration.refresh();
  await frame();
  expect(workspace.querySelector(".scient-latex-retained-selection")).toBeNull();
  expect(workspace.querySelector(".scient-latex-range-selection")).toBeTruthy();
  expect(workspace.hasAttribute("data-scient-selection-held")).toBe(false);
  expect(surface.textContent).toBe("A short selection for ink geometry.");
});
