import { render as _fixtureRender, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import "../../index.css";

import {
  ScientImageControls,
  type ScientImageAction,
  type ScientImageContextMenuHandler,
  type ScientImageControlsProps,
} from "./ScientImageControls";

async function _setupFixture0(_fixture: _Fixture) {}

function nativeImageUrl(token: string) {
  const url = new URL("/test/fixtures/assets/0001.png", window.location.href);
  url.hash = token;
  return url.href;
}

function holdNativePreviewImages() {
  const hold = (event: Event) => {
    if (
      event.isTrusted &&
      event.target instanceof HTMLImageElement &&
      event.target.closest("[data-preview-image-surface]")
    )
      event.stopImmediatePropagation();
  };
  // The viewer is portalled, outside the inline control's render container.
  document.addEventListener("load", hold, true);
  document.addEventListener("error", hold, true);
  return {
    [Symbol.dispose]() {
      document.removeEventListener("load", hold, true);
      document.removeEventListener("error", hold, true);
    },
  };
}

async function _cleanupFixture1(_fixture: _Fixture) {
  for (const cleanup of _fixture.cleanups.splice(0)) await cleanup();
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

async function fixture(
  _fixture: _Fixture,
  actions: readonly ScientImageAction[],
  showContextMenu: ScientImageContextMenuHandler,
  initial: Partial<ScientImageControlsProps> = {},
) {
  const anchor = document.createElement("span");
  anchor.dataset.scientVisualCard = "true";
  const image = document.createElement("img");
  const caption = document.createElement("textarea");
  const controls = document.createElement("span");
  anchor.append(image, caption, controls);
  document.body.append(_ownDOM(_fixture, anchor));
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: controls, router: false }),
  );
  _fixture.cleanups.push(async () => {
    await act(async () => await root.unmount());
  });
  let overrides = initial;
  const render = async (next: Partial<ScientImageControlsProps> = {}) => {
    overrides = { ...overrides, ...next };
    await act(
      async () =>
        await root.rerender(
          <ScientImageControls
            imageURL={nativeImageUrl("figure.png")}
            alt=""
            displayName="figure.png"
            loaded
            selected
            authoring
            anchor={anchor}
            actions={actions}
            showContextMenu={showContextMenu}
            {...overrides}
          />,
        ),
    );
  };
  await render();
  return { anchor, image, caption, controls, render };
}

describe("shared image controls", () => {
  it("moves controls through More, supports keyboard movement, and restores their position", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { anchor, controls } = await fixture(_fixture, [], async () => null);
    const toolbar = controls.querySelector<HTMLElement>("[aria-label='Image actions']")!;
    const handle = toolbar.querySelector<HTMLButtonElement>("[data-scient-toolbar-move]")!;
    const more = toolbar.querySelector<HTMLButtonElement>("[aria-label='More image actions']")!;
    anchor.style.cssText = "display: block; position: relative; width: 800px; height: 400px";
    toolbar.closest<HTMLElement>("[data-scient-image-controls]")!.style.cssText =
      "position: absolute; inset: 0";
    toolbar.style.cssText = "position: absolute; left: 700px; top: 10px; width: 60px; height: 28px";
    expect(anchor.getBoundingClientRect().width).toBe(800);
    expect(anchor.getBoundingClientRect().height).toBe(400);
    expect(handle.hidden).toBe(true);
    await userEvent.click(more);
    await userEvent.click(
      [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
        (item) => item.textContent === "Move controls",
      )!,
    );
    expect(handle.hidden).toBe(false);
    await expect.poll(() => document.activeElement).toBe(handle);
    await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
    await userEvent.keyboard("{ArrowLeft}");
    expect(toolbar.style.translate).toBe("-10px");
    await userEvent.keyboard("{Enter}");
    expect(handle.hidden).toBe(true);
    await expect.poll(() => document.activeElement).toBe(more);
    expect(toolbar.style.translate).toBe("-10px");
    await userEvent.click(more);
    await userEvent.click(
      [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
        (item) => item.textContent === "Reset controls position",
      )!,
    );
    expect(toolbar.style.translate).toBe("");
    await expect.poll(() => document.activeElement).toBe(more);
  });

  it("isolates fresh viewer access and retry from inline image refresh", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    using delivery = holdNativePreviewImages();
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(nativeImageUrl("fresh-1"))
      .mockResolvedValueOnce(nativeImageUrl("fresh-2"));
    const inlineRetry = vi.fn();
    const { controls } = await fixture(_fixture, [], async () => null, {
      sourceIdentity: "figure",
      resolveViewerSource: resolve,
      onRetry: inlineRetry,
    });
    await act(() =>
      controls.querySelector<HTMLButtonElement>('button[aria-label="Expand image"]')!.click(),
    );
    const preview = document.querySelector<HTMLImageElement>("[data-preview-image-surface] img")!;
    expect(preview.src).toBe(nativeImageUrl("fresh-1"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Loading figure…");
    await act(() => preview.dispatchEvent(new Event("error")));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Unable to display this image",
    );
    await act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
        .find((button) => button.textContent === "Try again")!
        .click(),
    );
    const retried = document.querySelector<HTMLImageElement>("[data-preview-image-surface] img")!;
    expect(retried.src).toBe(nativeImageUrl("fresh-2"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Loading figure…");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(inlineRetry).not.toHaveBeenCalled();
    await act(async () => {
      await retried.decode();
      expect(retried.naturalWidth).toBe(16);
      delivery[Symbol.dispose]();
      retried.dispatchEvent(new Event("load"));
    });
    const displayed = document.querySelector<HTMLImageElement>("[data-preview-image-surface] img")!;
    expect(displayed.src).toBe(nativeImageUrl("fresh-2"));
    expect(displayed.hasAttribute("aria-hidden")).toBe(false);
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Loading figure…");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
      "Unable to display this image",
    );
  });

  it("ignores fresh viewer resolution after close or source replacement", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let resolve!: (url: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const { controls, render } = await fixture(_fixture, [], async () => null, {
      sourceIdentity: "first",
      resolveViewerSource: () => pending,
    });
    await act(() =>
      controls.querySelector<HTMLButtonElement>('button[aria-label="Expand image"]')!.click(),
    );
    await act(() =>
      document
        .querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!
        .click(),
    );
    await render({ sourceIdentity: "second", imageURL: nativeImageUrl("second.png") });
    await act(() => resolve(nativeImageUrl("stale-first")));
    expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
    expect(document.querySelector(`img[src="${nativeImageUrl("stale-first")}"]`)).toBeNull();
    await render({ sourceIdentity: "first", imageURL: nativeImageUrl("figure.png") });
    expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
  });

  it("keeps late byte-action feedback out of a replacement image", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const { image, controls, render } = await fixture(
      _fixture,
      [{ id: "copy-image", label: "Copy image", run: () => pending }],
      async () => "copy-image",
      { sourceIdentity: "first" },
    );
    await act(() =>
      image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    await render({ sourceIdentity: "second" });
    await act(() => reject(new Error("Old image copy failed")));
    expect(controls.textContent).not.toContain("Old image copy failed");
  });
  it("uses one action list for More and image context menu", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const copy = vi.fn();
    const show = vi.fn<ScientImageContextMenuHandler>().mockResolvedValue(null);
    const { image, controls } = await fixture(
      _fixture,
      [{ id: "copy-source", label: "Copy image source", run: copy }],
      show,
    );
    await act(() =>
      image.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 24,
        }),
      ),
    );
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0]?.[1]).toEqual({ x: 12, y: 24 });
    const expected = show.mock.calls[0]?.[0].map((item) => item.label);
    const more = controls.querySelector<HTMLButtonElement>(
      'button[aria-label="More image actions"]',
    );
    expect(more).not.toBeNull();
    await act(() => more!.click());
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual([
      ...expected!.filter((label) => label !== "Expand image"),
      "Move controls",
      "Reset controls position",
    ]);
    await act(() => items.find((item) => item.textContent === "Copy image source")!.click());
    expect(copy).toHaveBeenCalledOnce();
  });

  it.each(["", "An existing caption"])(
    "keeps the caption focused after the actual More menu closes (%j)",
    async (value) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      let caption!: HTMLTextAreaElement;
      const edit = vi.fn(() => {
        caption.hidden = false;
        caption.focus();
      });
      const result = await fixture(
        _fixture,
        [{ id: "edit-caption", label: "Edit caption", closeViewer: true, run: edit }],
        async () => null,
      );
      caption = result.caption;
      caption.value = value;
      caption.hidden = value === "";
      caption.addEventListener("blur", () => {
        caption.hidden = caption.value === "";
      });
      await userEvent.click(
        result.controls.querySelector<HTMLButtonElement>(
          'button[aria-label="More image actions"]',
        )!,
      );
      await userEvent.click(
        Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
          (item) => item.textContent === "Edit caption",
        )!,
      );
      await vi.waitFor(() => expect(edit).toHaveBeenCalledOnce());
      await expect.poll(() => document.activeElement).toBe(caption);
      expect(caption.hidden).toBe(false);
      await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
      const more = result.controls.querySelector<HTMLButtonElement>(
        'button[aria-label="More image actions"]',
      )!;
      await userEvent.click(more);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => document.activeElement).toBe(more);
    },
  );

  it("discards a focus handoff when its image changes during menu closure", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const edit = vi.fn();
    const { controls, render } = await fixture(
      _fixture,
      [{ id: "edit-caption", label: "Add caption", closeViewer: true, run: edit }],
      async () => null,
      { sourceIdentity: "first" },
    );
    await act(() =>
      controls.querySelector<HTMLButtonElement>('button[aria-label="More image actions"]')!.click(),
    );
    let finish!: () => void;
    const animation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const popup = document.querySelector('[role="menu"]')!;
    const getAnimations = vi.fn(() => [{ finished: animation }]);
    Object.defineProperty(popup, "getAnimations", { value: getAnimations });
    await act(() =>
      Array.from(popup.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === "Add caption")!
        .click(),
    );
    await vi.waitFor(() => expect(getAnimations).toHaveBeenCalled());
    expect(edit).not.toHaveBeenCalled();
    await render({ sourceIdentity: "second" });
    await act(() => finish());
    expect(edit).not.toHaveBeenCalled();
  });

  it.each([
    // Inline, every action runs in the click whatever its kind; only the viewer branches.
    { expanded: false, picker: false },
    { expanded: true, picker: false },
    { expanded: true, picker: true },
  ])("runs gesture-sensitive actions in the item click (%j)", async ({ expanded, picker }) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let inClick = false;
    const action = vi.fn(() => {
      expect(inClick).toBe(true);
    });
    const label = picker ? "Replace image" : "Copy image";
    const { controls } = await fixture(
      _fixture,
      [
        {
          id: picker ? "replace-image" : "copy-image",
          label,
          closeViewer: picker,
          requiresUserActivation: picker,
          run: action,
        },
      ],
      async () => null,
    );
    if (expanded)
      await act(() =>
        controls.querySelector<HTMLButtonElement>('button[aria-label="Expand image"]')!.click(),
      );
    const surface = expanded ? document.querySelector('[role="dialog"]')! : controls;
    await act(() =>
      surface.querySelector<HTMLButtonElement>('button[aria-label="More image actions"]')!.click(),
    );
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (entry) => entry.textContent === label,
    )!;
    await act(() => {
      inClick = true;
      item.click();
      expect(action).toHaveBeenCalledOnce();
      inClick = false;
    });
    if (expanded)
      expect(document.querySelector('[role="dialog"][data-open]') !== null).toBe(!picker);
  });

  it("expands directly beside More and keeps expansion out of both menus", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { controls } = await fixture(_fixture, [], async () => null);
    await act(() =>
      controls.querySelector<HTMLButtonElement>('button[aria-label="More image actions"]')!.click(),
    );
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent === "Expand image",
      ),
    ).toBe(false);
    await act(() =>
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await act(() =>
      controls.querySelector<HTMLButtonElement>('button[aria-label="Expand image"]')!.click(),
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await act(() =>
      dialog!.querySelector<HTMLButtonElement>('button[aria-label="More image actions"]')!.click(),
    );
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent === "Expand image",
      ),
    ).toBe(false);
  });

  it("preserves native caption context menus and ignores actions after unmount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let choose!: (id: string | null) => void;
    const show = vi.fn<ScientImageContextMenuHandler>().mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    const remove = vi.fn();
    const { image, caption } = await fixture(
      _fixture,
      [{ id: "remove-image", label: "Remove from document", run: remove }],
      show,
    );
    const nativeContext = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    caption.dispatchEvent(nativeContext);
    expect(nativeContext.defaultPrevented).toBe(false);
    expect(show).not.toHaveBeenCalled();
    await act(() =>
      image.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(show).toHaveBeenCalledOnce();
    await _fixture.cleanups.pop()!();
    await act(() => choose("remove-image"));
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports a rejected byte action instead of reporting copy success", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const show = vi.fn<ScientImageContextMenuHandler>().mockResolvedValue("copy-image");
    const { image, controls } = await fixture(
      _fixture,
      [
        {
          id: "copy-image",
          label: "Copy image",
          run: async () => {
            throw new Error("Image host denied access");
          },
        },
      ],
      show,
    );
    await act(() =>
      image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    expect(controls.textContent).toContain("Image host denied access");
    expect(controls.textContent).not.toContain("Copied");
  });

  it("closes the viewer before an authoring action transfers focus", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const input = document.createElement("input");
    document.body.append(_ownDOM(_fixture, input));
    const edit = vi.fn(() => {
      input.focus();
    });
    const { controls } = await fixture(
      _fixture,
      [{ id: "edit-image", label: "Edit details", closeViewer: true, run: edit }],
      async () => null,
    );
    await act(() =>
      controls.querySelector<HTMLButtonElement>('button[aria-label="Expand image"]')!.click(),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await act(() =>
      dialog!.querySelector<HTMLButtonElement>('button[aria-label="More image actions"]')!.click(),
    );
    await act(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === "Edit details")!
        .click(),
    );
    await vi.waitFor(() => expect(edit).toHaveBeenCalledOnce());
    await expect.poll(() => document.activeElement).toBe(input);
    expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
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
