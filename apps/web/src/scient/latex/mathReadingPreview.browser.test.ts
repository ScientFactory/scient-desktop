import { afterEach, expect, it } from "vite-plus/test";
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
});

it("styles each formula from the same text without duplicating content or changing its state", () => {
  const first = preview();
  const style = first.root.querySelector("style")!;
  expect(first.root.adoptedStyleSheets).toHaveLength(0);
  expect(style.textContent).not.toMatch(/@font-face/u);
  expect(style.textContent).toContain("::selection");
  first.content.dataset.mathPreviewReady = "";
  for (let index = 0; index < 100; index++) {
    const next = preview();
    expect(next.root.querySelector("style")!.textContent).toBe(style.textContent);
    expect(next.content.textContent).toBe("x");
  }
  expect(installMathReadingPreview(first.host)).toBe(first.root);
  expect(first.root.querySelectorAll("style")).toHaveLength(1);
  expect(first.root.querySelectorAll("[data-math-preview-content]")).toHaveLength(1);
  expect(first.content.hasAttribute("data-math-preview-ready")).toBe(true);
  expect(first.content.textContent).toBe("x");
});

// A shared adopted stylesheet made every later style update cost time in
// proportion to all formulas: 36 ms per update at 4,000 formulas.
it("keeps adding a formula cheap in a document with thousands of them", () => {
  const container = document.createElement("div");
  document.body.append(container);
  try {
    const add = () => {
      const paragraph = document.createElement("p");
      const host = document.createElement("span");
      paragraph.append(host);
      container.append(paragraph);
      installMathReadingPreview(host).querySelector("[data-math-preview-content]")!.textContent =
        "x";
    };
    for (let index = 0; index < 3000; index++) add();
    void container.offsetHeight;
    const started = performance.now();
    for (let update = 0; update < 10; update++) {
      add();
      void container.offsetHeight;
    }
    expect((performance.now() - started) / 10).toBeLessThan(10);
  } finally {
    container.remove();
  }
});
