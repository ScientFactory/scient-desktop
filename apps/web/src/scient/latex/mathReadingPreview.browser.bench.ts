import { expect, it } from "vite-plus/test";

import { installMathReadingPreview } from "./mathReadingPreview";

it("keeps adding a formula cheap in a document with thousands of them", async ({ bench }) => {
  using cleanup = new DisposableStack();
  const container = document.createElement("div");
  cleanup.defer(() => container.remove());
  document.body.append(container);
  const add = () => {
    const paragraph = document.createElement("p");
    const host = document.createElement("span");
    paragraph.append(host);
    container.append(paragraph);
    installMathReadingPreview(host).querySelector("[data-math-preview-content]")!.textContent = "x";
  };
  for (let index = 0; index < 3000; index++) add();
  void container.offsetHeight;
  const result = await bench("add formula and lay out", { async: false }, () => {
    add();
    void container.offsetHeight;
  }).run({ time: 0, iterations: 10, warmup: false });
  const previews = Array.from(container.children, (paragraph) =>
    paragraph.firstElementChild?.shadowRoot?.querySelector("[data-math-preview-content]"),
  );
  expect(previews).toHaveLength(3010);
  expect(previews.every((preview) => preview?.textContent === "x")).toBe(true);
  expect(result.latency.mean).toBeLessThan(10);
});
