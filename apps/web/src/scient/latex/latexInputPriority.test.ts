// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  afterLatexInputQuiet,
  LatexInputPriority,
  latexInputQuietDelay,
} from "./latexInputPriority";

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  vi.useRealTimers();
});
const mount = () => {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, LatexInputPriority],
    content: "<p>Writing</p>",
  });
  return editor.view.dom;
};

describe("editing priority over speculative rendering", () => {
  it("waits for nested input to become quiet and allows cancelled work to stay cancelled", async () => {
    vi.useFakeTimers();
    const root = mount(),
      nested = document.createElement("span");
    root.append(nested);
    nested.dispatchEvent(new Event("beforeinput", { bubbles: true }));
    const work = vi.fn(),
      cancelled = vi.fn();
    afterLatexInputQuiet(work, root);
    afterLatexInputQuiet(cancelled, root)();
    await vi.advanceTimersByTimeAsync(100);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(work).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });
  it("keeps composition and dragging ahead of background work until they end", async () => {
    vi.useFakeTimers();
    const root = mount(),
      work = vi.fn();
    root.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    afterLatexInputQuiet(work, root);
    await vi.advanceTimersByTimeAsync(1000);
    expect(work).not.toHaveBeenCalled();
    root.dispatchEvent(new Event("compositionend", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(work).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("pointerup"));
    await vi.advanceTimersByTimeAsync(300);
    expect(work).toHaveBeenCalledOnce();
    editor!.destroy();
    editor = undefined;
    expect(latexInputQuietDelay()).toBe(0);
  });
});
