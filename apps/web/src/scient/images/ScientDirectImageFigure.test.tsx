// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientDirectImageFigure } from "./ScientDirectImageFigure";

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function fixture() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(() => root.unmount());
  });
  const render = async (caption = "Figure caption") =>
    act(() =>
      root.render(
        <ScientDirectImageFigure
          src="https://images.test/figure.png"
          authoredSource="https://images.test/figure.png"
          alt=""
          caption={caption}
          markdownSource={`![](https://images.test/figure.png "${caption}")`}
        />,
      ),
    );
  await render();
  return { host, render };
}

describe("direct file image figures", () => {
  it("keeps the native image stable when a caption changes and expands without imposing CORS", async () => {
    const { host, render } = await fixture();
    const image = host.querySelector<HTMLImageElement>("img")!;
    expect(image.crossOrigin).toBe(null);
    expect(image.alt).toBe("");
    await act(() => image.dispatchEvent(new Event("load")));
    await render("Updated caption");
    expect(host.querySelector("img")).toBe(image);
    expect(host.textContent).toContain("Updated caption");
    await act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Expand image"]')!.click(),
    );
    const preview = document.querySelector<HTMLImageElement>("[data-preview-image-surface] img");
    expect(preview).not.toBeNull();
    expect(preview!.crossOrigin).toBe(null);
  });

  it("retries failed decoding locally without replacing the authored source", async () => {
    const { host } = await fixture();
    const original = host.querySelector<HTMLImageElement>("img")!;
    await act(() => original.dispatchEvent(new Event("error")));
    expect(host.textContent).toContain("Unable to display this image");
    const retry = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Try again",
    )!;
    await act(() => retry.click());
    const replacement = host.querySelector<HTMLImageElement>("img")!;
    expect(replacement).not.toBe(original);
    expect(replacement.src).toBe(original.src);
    expect(host.textContent).toContain("Loading image…");
    await act(() => replacement.dispatchEvent(new Event("load")));
    expect(host.textContent).not.toContain("Loading image…");
    expect(host.querySelector("[data-markdown-copy]")?.getAttribute("data-markdown-copy")).toBe(
      '![](https://images.test/figure.png "Figure caption")',
    );
  });
});
