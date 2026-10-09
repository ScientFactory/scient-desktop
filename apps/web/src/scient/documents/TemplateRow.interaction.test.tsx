// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TemplateRow } from "./TemplateRow";
import { templatePicture } from "./templatePreviews";

describe("template preview interaction", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const choose = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    localStorage.clear();
    choose.mockReset();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const render = async () => {
    await act(() =>
      root.render(
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
  const hoverByFocus = async (name: string) => {
    await act(() => namedButton(name).focus());
    await act(() => vi.advanceTimersByTimeAsync(180));
  };

  it("opens promptly, loads only the thumbnail on hover, and keeps selection on the name", async () => {
    await render();
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
    await render();
    await hoverByFocus("article");
    await act(() => namedButton("Expand article preview").click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(choose).not.toHaveBeenCalled();
    const picture = templatePicture("article", null)!;
    if (picture.kind === "image")
      expect(dialog.querySelector("img")?.getAttribute("src")).toBe(picture.expandedSrc);
    expect(dialog.textContent).toContain("First page");
    const initialWidth = dialog.querySelector("img")!.style.width;
    expect(initialWidth).toBe("608px");
    await act(() => namedButton("Zoom in").click());
    expect(dialog.textContent).toContain("125%");
    expect(dialog.querySelector("img")!.style.width).not.toBe(initialWidth);
    await act(() => namedButton("Fit page width").click());
    expect(dialog.querySelector("img")!.style.width).toBe(initialWidth);
    await act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(namedButton("article"));
    expect(choose).not.toHaveBeenCalled();
  });

  it("keeps the expanded preview alive after More closes, then returns focus to More", async () => {
    await render();
    await act(() => namedButton("More").click());
    await hoverByFocus("letter");
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
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("letter");
    expect(choose).not.toHaveBeenCalled();
    await act(() => namedButton("Close").click());
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(namedButton("More"));
  });

  it("expands a personal template as the same sanitized read-only page", async () => {
    const picture = templatePicture(
      null,
      '<div data-page-width="816" data-page-height="1056"><p onclick="run()" contenteditable="true">My template</p><button>Captured control</button></div>',
    );
    await act(() =>
      root.render(
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
    await hoverByFocus("Mine");
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
