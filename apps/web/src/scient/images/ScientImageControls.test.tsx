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
          standalone
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
    expect(items.map((item) => item.textContent)).toEqual(expected);
    await act(() => items.find((item) => item.textContent === "Copy image source")!.click());
    expect(copy).toHaveBeenCalledOnce();
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
