import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { ClipboardApiUnavailableError, writeTextToClipboard } from "./useCopyToClipboard";

function withoutAsyncClipboard() {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  return {
    [Symbol.dispose]() {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    },
  };
}

describe("clipboard fallback selection", () => {
  it.each(["input", "textarea"] as const)(
    "restores a backward %s selection without scrolling",
    async (kind) => {
      await using screen = await render(
        <div style={{ height: 100, overflow: "auto" }}>
          {kind === "input" ? (
            <input aria-label="Draft" defaultValue="keep this selected text" />
          ) : (
            <textarea aria-label="Draft" defaultValue="keep this selected text" />
          )}
          <div style={{ height: 1000 }} />
        </div>,
        // Plain DOM controls have no route dependencies.
        { router: false },
      );
      using _clipboard = withoutAsyncClipboard();
      await screen.getByRole("textbox", { name: "Draft" }).click();
      const input = screen.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(kind)!;
      input.setSelectionRange(5, 18, "backward");
      const scroll = screen.container.firstElementChild as HTMLElement;
      scroll.scrollTop = 400;
      const beforeScroll = scroll.scrollTop;
      expect(beforeScroll).toBeGreaterThan(0);
      using focus = vi.spyOn(input, "focus");
      let copied: string | null = null;
      using _exec = vi.spyOn(document, "execCommand").mockImplementation(() => {
        const active = document.activeElement as HTMLTextAreaElement;
        copied = active.value.slice(active.selectionStart, active.selectionEnd);
        return true;
      });
      await expect(writeTextToClipboard("  copied\tbytes\n")).resolves.toBe(true);
      expect(copied).toBe("  copied\tbytes\n");
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
        5,
        18,
        "backward",
      ]);
      expect(scroll.scrollTop).toBe(beforeScroll);
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(screen.container.querySelectorAll("textarea")).toHaveLength(
        kind === "textarea" ? 1 : 0,
      );
    },
  );

  it.each(["refused", "threw"] as const)(
    "restores native document endpoints when copy is %s",
    async (failure) => {
      await using screen = await render(
        <p>
          <span>first words</span>
          <span>last words</span>
        </p>,
        { router: false },
      );
      using _clipboard = withoutAsyncClipboard();
      const first = screen.container.querySelectorAll("span")[0]!.firstChild!;
      const last = screen.container.querySelectorAll("span")[1]!.firstChild!;
      const selection = document.getSelection()!;
      selection.setBaseAndExtent(last, 4, first, 2);
      using _cleanup = { [Symbol.dispose]: () => selection.removeAllRanges() };
      const selected = selection.toString();
      expect(selected).toBe("rst wordslast");
      using _exec = vi.spyOn(document, "execCommand").mockImplementation(() => {
        if (failure === "threw") throw new Error("Copy refused");
        return false;
      });
      await expect(writeTextToClipboard("new source")).rejects.toBeInstanceOf(
        ClipboardApiUnavailableError,
      );
      expect(selection.toString()).toBe(selected);
      expect([
        selection.anchorNode,
        selection.anchorOffset,
        selection.focusNode,
        selection.focusOffset,
      ]).toEqual([last, 4, first, 2]);
      expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull();
    },
  );

  it("does not refocus or restore ranges into nodes removed by a copy handler", async () => {
    await using screen = await render(
      <div>
        <input aria-label="Draft" defaultValue="selected draft" />
        <p>selected document</p>
      </div>,
      { router: false },
    );
    using _clipboard = withoutAsyncClipboard();
    await screen.getByRole("textbox", { name: "Draft" }).click();
    const input = screen.container.querySelector("input")!;
    input.setSelectionRange(1, 6, "backward");
    const text = screen.container.querySelector("p")!.firstChild!;
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(text, 8, text, 1);
    using _cleanup = { [Symbol.dispose]: () => selection.removeAllRanges() };
    using focus = vi.spyOn(input, "focus");
    using range = vi.spyOn(input, "setSelectionRange");
    using documentRange = vi.spyOn(selection, "setBaseAndExtent");
    using _exec = vi.spyOn(document, "execCommand").mockImplementation(() => {
      screen.container.remove();
      return true;
    });
    await expect(writeTextToClipboard("still copied")).resolves.toBe(true);
    expect(input.isConnected).toBe(false);
    expect(text.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(range).not.toHaveBeenCalled();
    expect(documentRange).not.toHaveBeenCalled();
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull();
  });

  it("copies with a focused input that does not support text selection", async () => {
    await using screen = await render(
      <input type="number" aria-label="Count" defaultValue="12" />,
      { router: false },
    );
    using _clipboard = withoutAsyncClipboard();
    await screen.getByRole("spinbutton", { name: "Count" }).click();
    const input = screen.container.querySelector("input")!;
    using _exec = vi.spyOn(document, "execCommand").mockReturnValue(true);
    await expect(writeTextToClipboard("12")).resolves.toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("12");
  });
});
