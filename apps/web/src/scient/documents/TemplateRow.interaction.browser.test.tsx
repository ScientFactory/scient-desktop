import "../../index.css";
import { page, userEvent } from "vitest/browser";
import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { TemplateRow } from "./TemplateRow";
import { templatePicture } from "./templatePreviews";

describe("template preview interaction", () => {
  const choose = vi.fn();
  async function _setupFixture0(_fixture: _Fixture) {
    const previousViewport = { width: innerWidth, height: innerHeight };
    _fixture.stack.defer(() => page.viewport(previousViewport.width, previousViewport.height));
    await page.viewport(640, 900);
    choose.mockReset();
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  const render = async (_fixture: _Fixture) => {
    await act(
      async () =>
        await _fixture.root0.rerender(
          <TemplateRow
            templates={["blank", "article", "thesis", "problem-set", "letter"].map((id) => ({
              id,
              name: id,
              own: false,
              picture: templatePicture(id, null),
            }))}
            selected="blank"
            defaultTemplate="blank"
            onSelect={choose}
            onSetDefault={vi.fn()}
            onEdit={vi.fn()}
            onNewTemplate={vi.fn()}
            strip={{}}
          />,
        ),
    );
  };
  const namedButton = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
      (button) => button.getAttribute("aria-label") === name || button.textContent === name,
    )!;
  const hoverPreview = async (name: string) => {
    using _clock = _fixtureFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await userEvent.hover(namedButton(name));
    await act(() => vi.advanceTimersByTimeAsync(180));
  };

  it("opens promptly, loads only the thumbnail on hover, and keeps selection on the name", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    using _clock = _fixtureFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(() => namedButton("article").focus());
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(document.querySelector('[aria-label="Expand article preview"]')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(30));
    const preview = namedButton("Expand article preview");
    expect(preview).toBeDefined();
    const picture = templatePicture("article", null)!;
    if (picture.kind === "image")
      expect(preview.parentElement?.querySelector("img")?.getAttribute("src")).toBe(picture.src);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(() => namedButton("article").click());
    expect(choose).toHaveBeenCalledExactlyOnceWith("article");
  });

  it("expands without selecting, shows the full page, zooms, and closes with Escape", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await hoverPreview("article");
    await act(() => namedButton("Expand article preview").click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(choose).not.toHaveBeenCalled();
    const picture = templatePicture("article", null)!;
    if (picture.kind === "image")
      expect(dialog.querySelector("img")?.getAttribute("src")).toBe(picture.expandedSrc);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "article",
    );
    const initialWidth = dialog.querySelector("img")!.style.width;
    const viewport = dialog.querySelector<HTMLElement>('[role="region"]')!;
    expect(innerWidth).toBe(640);
    expect(viewport.clientWidth).toBeGreaterThan(8);
    expect(initialWidth).toBe(`${viewport.clientWidth - 8}px`);
    await dialog.querySelector("img")!.decode();
    await act(() => namedButton("Zoom in").click());
    expect(dialog.textContent).toContain("125%");
    expect(dialog.querySelector("img")!.style.width).not.toBe(initialWidth);
    await act(() => namedButton("Fit page width").click());
    expect(dialog.querySelector("img")!.style.width).toBe(initialWidth);
    await act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(namedButton("article"));
    expect(choose).not.toHaveBeenCalled();
  });

  it("keeps the expanded preview alive after More closes, then returns focus to More", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(() => namedButton("More").click());
    await hoverPreview("letter");
    const expand = namedButton("Expand letter preview");
    await act(() =>
      expand.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }),
      ),
    );
    await act(() =>
      expand.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    expect(expand.isConnected).toBe(true);
    await act(() => namedButton("Expand letter preview").click());
    await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("letter");
    expect(choose).not.toHaveBeenCalled();
    await act(() => namedButton("Close").click());
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(namedButton("More"));
  });

  it("expands a personal template as the same sanitized read-only page", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const picture = templatePicture(
      null,
      '<div data-page-width="816" data-page-height="1056"><p onclick="run()" contenteditable="true">My template</p><button>Captured control</button></div>',
    );
    await act(
      async () =>
        await _fixture.root0.rerender(
          <TemplateRow
            templates={[{ id: "mine", name: "Mine", own: true, picture }]}
            selected="mine"
            defaultTemplate="mine"
            onSelect={choose}
            onSetDefault={vi.fn()}
            onEdit={vi.fn()}
            onNewTemplate={vi.fn()}
            strip={{}}
          />,
        ),
    );
    await hoverPreview("Mine");
    const expand = namedButton("Expand Mine preview");
    expect(expand.querySelector("button")).toBeNull();
    expect(expand.parentElement?.querySelector("[inert] button")).not.toBeNull();
    await act(() => expand.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("My template");
    expect(dialog.querySelector("[inert] p")?.getAttribute("onclick")).toBeNull();
    expect(dialog.querySelector("[contenteditable]")).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
