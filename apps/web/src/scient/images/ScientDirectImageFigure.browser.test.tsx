import "../../index.css";
import { flushSync } from "react-dom";
import { render as _fixtureRender, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { ScientDirectImageFigure } from "./ScientDirectImageFigure";

const imageUrl = new URL("/test/fixtures/assets/0001.png", location.origin).href;
async function _setupFixture0(_fixture: _Fixture) {}
async function _cleanupFixture1(_fixture: _Fixture) {
  for (const cleanup of _fixture.cleanups.splice(0)) await cleanup();
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

async function fixture(_fixture: _Fixture, deferDecode = false) {
  const host = document.createElement("div");
  // Keep the lazy image undecoded until the injected failure is retried.
  if (deferDecode) host.style.display = "none";
  document.body.append(_ownDOM(_fixture, host));
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  _fixture.cleanups.push(async () => {
    await act(async () => await root.unmount());
  });
  const render = async (caption = "Figure caption") =>
    await act(
      async () =>
        await root.rerender(
          <ScientDirectImageFigure
            src={deferDecode ? `${imageUrl}?retry-fixture` : imageUrl}
            authoredSource={imageUrl}
            alt=""
            caption={caption}
            markdownSource={`![](${imageUrl} "${caption}")`}
          />,
        ),
    );
  await render();
  return { host, render };
}

describe("direct file image figures", () => {
  it("keeps the native image stable when a caption changes and expands without imposing CORS", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render } = await fixture(_fixture);
    const image = host.querySelector<HTMLImageElement>("img")!;
    expect(image.crossOrigin).toBe(null);
    expect(image.alt).toBe("");
    await image.decode();
    await expect.poll(() => host.textContent).not.toContain("Loading image…");
    await render("Updated caption");
    expect(host.querySelector("img")).toBe(image);
    expect(host.textContent).toContain("Updated caption");
    await act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Expand image"]')!.click(),
    );
    const preview = await vi.waitFor(() => {
      const preview = document.querySelector<HTMLImageElement>("[data-preview-image-surface] img");
      expect(preview).not.toBeNull();
      return preview;
    });
    expect(preview).not.toBeNull();
    expect(preview!.crossOrigin).toBe(null);
  });

  it("retries failed decoding locally without replacing the authored source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host } = await fixture(_fixture, true);
    const original = host.querySelector<HTMLImageElement>("img")!;
    expect(original.complete).toBe(false);
    await act(() => original.dispatchEvent(new Event("error")));
    expect(host.textContent).toContain("Unable to display this image");
    const retry = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Try again",
    )!;
    const replacement = await act(() => {
      flushSync(() => retry.click());
      const replacement = host.querySelector<HTMLImageElement>("img")!;
      expect(replacement).not.toBe(original);
      expect(replacement.src).toBe(original.src);
      expect(host.textContent).toContain("Loading image…");
      host.style.display = "";
      return replacement;
    });
    await replacement.decode();
    await expect.poll(() => host.textContent).not.toContain("Loading image…");
    expect(host.querySelector("[data-markdown-copy]")?.getAttribute("data-markdown-copy")).toBe(
      `![](${imageUrl} "Figure caption")`,
    );
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    cleanups: [] as Array<() => Promise<void>>,
    _ownedDOM: [] as Node[],

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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
