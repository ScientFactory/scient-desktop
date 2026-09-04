// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ScientImageControls,
  type ScientImageAction,
  type ScientImageContextMenuHandler,
  type ScientImageControlsProps,
} from "./ScientImageControls";

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function fixture(
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
  document.body.append(anchor);
  const root = createRoot(controls);
  cleanups.push(async () => {
    await act(() => root.unmount());
  });
  let overrides = initial;
  const render = async (next: Partial<ScientImageControlsProps> = {}) => {
    overrides = { ...overrides, ...next };
    await act(() =>
      root.render(
        <ScientImageControls
          imageURL="https://images.test/figure.png"
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
    const { anchor, controls } = await fixture([], async () => null);
    const toolbar = controls.querySelector<HTMLElement>("[aria-label='Image actions']")!;
    const handle = toolbar.querySelector<HTMLButtonElement>("[data-scient-toolbar-move]")!;
    const more = toolbar.querySelector<HTMLButtonElement>("[aria-label='More image actions']")!;
    // Model CSS translation independently of Happy DOM's missing implementation.
    let translation = "";
    Object.defineProperty(toolbar.style, "translate", {
      get: () => translation,
      set: (value: string) => {
        translation = value;
      },
    });
    const removeProperty = toolbar.style.removeProperty.bind(toolbar.style);
    vi.spyOn(toolbar.style, "removeProperty").mockImplementation((property) => {
      if (property === "translate") translation = "";
      return removeProperty(property);
    });
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 400));
    vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(700, 10, 60, 28));
    expect(handle.hidden).toBe(true);
    await act(() => {
      more.focus();
      more.click();
    });
    await act(() =>
      [...document.querySelectorAll<HTMLElement>("[role='menuitem']")]
        .find((item) => item.textContent === "Move controls")!
        .click(),
    );
    expect(handle.hidden).toBe(false);
    expect(document.activeElement).toBe(handle);
    await act(() =>
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      ),
    );
    expect(toolbar.style.translate).toBe("-10px 0px");
    await act(() =>
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(handle.hidden).toBe(true);
    expect(document.activeElement).toBe(more);
    expect(toolbar.style.translate).toBe("-10px 0px");
    await act(() => more.click());
    await act(() =>
      [...document.querySelectorAll<HTMLElement>("[role='menuitem']")]
        .find((item) => item.textContent === "Reset controls position")!
        .click(),
    );
    expect(toolbar.style.translate).toBe("");
    expect(document.activeElement).toBe(more);
  });

  it("isolates fresh viewer access and retry from inline image refresh", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce("https://signed.test/fresh-1")
      .mockResolvedValueOnce("https://signed.test/fresh-2");
    const inlineRetry = vi.fn();
    const { controls } = await fixture([], async () => null, {
      sourceIdentity: "figure",
      resolveViewerSource: resolve,
      onRetry: inlineRetry,
    });
    await act(() =>
      controls.querySelector<HTMLButtonElement>('button[aria-label="Expand image"]')!.click(),
    );
    const preview = document.querySelector<HTMLImageElement>("[data-preview-image-surface] img")!;
    expect(preview.src).toBe("https://signed.test/fresh-1");
    await act(() => preview.dispatchEvent(new Event("error")));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Unable to display this image",
    );
    await act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
        .find((button) => button.textContent === "Try again")!
        .click(),
    );
    expect(document.querySelector<HTMLImageElement>("[data-preview-image-surface] img")!.src).toBe(
      "https://signed.test/fresh-2",
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(inlineRetry).not.toHaveBeenCalled();
  });

  it("ignores fresh viewer resolution after close or source replacement", async () => {
    let resolve!: (url: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const { controls, render } = await fixture([], async () => null, {
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
    await render({ sourceIdentity: "second", imageURL: "https://images.test/second.png" });
    await act(() => resolve("https://signed.test/stale-first"));
    expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
    expect(document.querySelector('img[src="https://signed.test/stale-first"]')).toBeNull();
    await render({ sourceIdentity: "first", imageURL: "https://images.test/figure.png" });
    expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
  });

  it("keeps late byte-action feedback out of a replacement image", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const { image, controls, render } = await fixture(
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
    const copy = vi.fn();
    const show = vi.fn<ScientImageContextMenuHandler>().mockResolvedValue(null);
    const { image, controls } = await fixture(
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
      let caption!: HTMLTextAreaElement;
      const edit = vi.fn(() => {
        caption.hidden = false;
        caption.focus();
      });
      const result = await fixture(
        [{ id: "edit-caption", label: "Edit caption", closeViewer: true, run: edit }],
        async () => null,
      );
      caption = result.caption;
      caption.value = value;
      caption.hidden = value === "";
      caption.addEventListener("blur", () => {
        caption.hidden = caption.value === "";
      });
      await act(() =>
        result.controls
          .querySelector<HTMLButtonElement>('button[aria-label="More image actions"]')!
          .click(),
      );
      await act(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
          .find((item) => item.textContent === "Edit caption")!
          .click(),
      );
      expect(edit).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(caption);
      expect(caption.hidden).toBe(false);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      const more = result.controls.querySelector<HTMLButtonElement>(
        'button[aria-label="More image actions"]',
      )!;
      await act(() => more.click());
      await act(() =>
        document
          .querySelector('[role="menu"]')!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(document.activeElement).toBe(more);
    },
  );

  it("discards a focus handoff when its image changes during menu closure", async () => {
    const edit = vi.fn();
    const { controls, render } = await fixture(
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
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(getAnimations).toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    await render({ sourceIdentity: "second" });
    await act(() => finish());
    expect(edit).not.toHaveBeenCalled();
  });

  it.each([
    { expanded: false, picker: false },
    { expanded: true, picker: false },
    { expanded: false, picker: true },
    { expanded: true, picker: true },
  ])("runs gesture-sensitive actions in the item click (%j)", async ({ expanded, picker }) => {
    let inClick = false;
    const action = vi.fn(() => {
      expect(inClick).toBe(true);
    });
    const label = picker ? "Replace image" : "Copy image";
    const { controls } = await fixture(
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
    const { controls } = await fixture([], async () => null);
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
    let choose!: (id: string | null) => void;
    const show = vi.fn<ScientImageContextMenuHandler>().mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    const remove = vi.fn();
    const { image, caption } = await fixture(
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
    await cleanups.pop()!();
    await act(() => choose("remove-image"));
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports a rejected byte action instead of reporting copy success", async () => {
    const show = vi.fn<ScientImageContextMenuHandler>().mockResolvedValue("copy-image");
    const { image, controls } = await fixture(
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
    const input = document.createElement("input");
    document.body.append(input);
    const edit = vi.fn(() => {
      input.focus();
    });
    const { controls } = await fixture(
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
    expect(edit).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
  });
});
