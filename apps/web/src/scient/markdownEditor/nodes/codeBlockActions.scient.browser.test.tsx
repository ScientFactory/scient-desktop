import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../../test/render";
import { ScientMarkdownEditorView } from "../prosemirror/view";

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

describe("rich-editor code header fallback copy", () => {
  it.each([true, false])(
    "keeps current source and the real nested-editor selection when copy returns %s",
    async (accepted) => {
      await using resources = new AsyncDisposableStack();
      const screen = resources.use(
        await render(null, {
          // The real editor owns its DOM below this disposable host; it does not read a route.
          router: false,
        }),
      );
      const code = "alpha βeta gamma\n  delta omega";
      const onUserSourceChange = vi.fn();
      const controller = new ScientMarkdownEditorView({
        source: `\`\`\`text\n${code}\n\`\`\`\n`,
        revision: "original",
        mode: "write",
        ariaLabel: "Markdown copy fixture",
        onUserSourceChange,
      });
      resources.defer(() => act(() => controller.destroy()));
      await act(() => controller.mount(screen.container));
      await vi.waitFor(() => expect(screen.container.querySelector(".cm-content")).not.toBeNull());
      const editor = EditorView.findFromDOM(screen.container.querySelector(".cm-editor")!)!;
      await page.elementLocator(editor.contentDOM).click();
      await act(() =>
        editor.dispatch({
          changes: { from: 0, insert: "updated " },
          selection: { anchor: 18, head: 9 },
        }),
      );
      const currentCode = `updated ${code}`;
      const selection = document.getSelection()!;
      await vi.waitFor(() => expect(selection.toString()).toBe(currentCode.slice(9, 18)));
      const endpoints = [
        selection.anchorNode,
        selection.anchorOffset,
        selection.focusNode,
        selection.focusOffset,
      ];
      const sourceChangeCount = onUserSourceChange.mock.calls.length;
      expect(sourceChangeCount).toBeGreaterThan(0);
      expect(controller.view!.state.doc.firstChild!.textContent).toBe(currentCode);
      using _cleanup = { [Symbol.dispose]: () => selection.removeAllRanges() };
      using _clipboard = withoutAsyncClipboard();
      using logged = vi.spyOn(console, "error").mockImplementation(() => {});
      let copied: string | null = null;
      using exec = vi.spyOn(document, "execCommand").mockImplementation(() => {
        const active = document.activeElement as HTMLTextAreaElement;
        copied = active.value.slice(active.selectionStart, active.selectionEnd);
        return accepted;
      });
      // Dispatch only activation so test setup does not discard the native selection on pointer-down.
      await act(() =>
        screen.container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click(),
      );
      expect(copied).toBe(currentCode);
      expect(exec).toHaveBeenCalledExactlyOnceWith("copy");
      expect(document.activeElement).toBe(editor.contentDOM);
      expect(selection.toString()).toBe(currentCode.slice(9, 18));
      expect([
        selection.anchorNode,
        selection.anchorOffset,
        selection.focusNode,
        selection.focusOffset,
      ]).toEqual(endpoints);
      expect([editor.state.selection.main.anchor, editor.state.selection.main.head]).toEqual([
        18, 9,
      ]);
      expect(controller.view!.state.doc.firstChild!.textContent).toBe(currentCode);
      expect(onUserSourceChange).toHaveBeenCalledTimes(sourceChangeCount);
      expect(screen.container.querySelector('[aria-label="Copied"]') !== null).toBe(accepted);
      expect(logged).toHaveBeenCalledTimes(accepted ? 0 : 1);
    },
  );
});
