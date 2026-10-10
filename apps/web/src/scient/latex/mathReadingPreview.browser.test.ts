import { afterEach, expect, it, vi } from "vite-plus/test";
import { installMathReadingPreview } from "./mathReadingPreview";

const hosts: HTMLElement[] = [];
function preview() {
  const host = document.createElement("span");
  hosts.push(host);
  document.body.append(host);
  const root = installMathReadingPreview(host);
  const content = root.querySelector<HTMLElement>("[data-math-preview-content]")!;
  content.innerHTML = '<span class="ML__mathlive">x</span>';
  return { host, root, content };
}

afterEach(() => {
  hosts.splice(0).forEach((host) => host.remove());
  vi.unstubAllGlobals();
});

it("shares layout CSS across formulas without duplicating content or changing its state", () => {
  const first = preview();
  const sheet = first.root.adoptedStyleSheets[0]!;
  expect(sheet).toBeDefined();
  expect(first.root.querySelector("style")).toBeNull();
  expect([...sheet.cssRules].some((rule) => rule.cssText.startsWith("@font-face"))).toBe(false);
  first.content.dataset.mathPreviewReady = "";
  for (let index = 0; index < 100; index++) {
    const next = preview();
    expect(next.root.adoptedStyleSheets).toEqual([sheet]);
    expect(next.content.textContent).toBe("x");
  }
  expect(installMathReadingPreview(first.host)).toBe(first.root);
  expect(first.root.querySelectorAll("[data-math-preview-content]")).toHaveLength(1);
  expect(first.content.hasAttribute("data-math-preview-ready")).toBe(true);
  expect(first.content.textContent).toBe("x");
});

it("keeps the same formula styling when constructed stylesheets are unavailable", () => {
  const normal = preview();
  const normalMath = normal.content.firstElementChild!;
  const normalStyle = getComputedStyle(normalMath);
  const expected = { font: normalStyle.fontFamily, display: normalStyle.display };
  vi.stubGlobal("CSSStyleSheet", undefined);
  const fallback = preview();
  expect(fallback.root.adoptedStyleSheets).toHaveLength(0);
  const style = fallback.root.querySelector("style")!;
  expect(style.textContent).not.toMatch(/@font-face/u);
  expect(style.textContent).toContain("::selection");
  const fallbackStyle = getComputedStyle(fallback.content.firstElementChild!);
  expect({ font: fallbackStyle.fontFamily, display: fallbackStyle.display }).toEqual(expected);
  expect(installMathReadingPreview(fallback.host)).toBe(fallback.root);
  expect(fallback.root.querySelectorAll("style")).toHaveLength(1);
});
