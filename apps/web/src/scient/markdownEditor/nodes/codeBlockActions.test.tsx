// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientMarkdownEditorView } from "../prosemirror/view";

const preference = vi.hoisted(() => ({ wrapped: true, listeners: new Set<() => void>() }));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: preference.wrapped }),
  useClientSettings: () =>
    useSyncExternalStore(
      (listener) => {
        preference.listeners.add(listener);
        return () => preference.listeners.delete(listener);
      },
      () => preference.wrapped,
    ),
}));

describe("editor code actions", () => {
  let controller: ScientMarkdownEditorView | undefined;
  afterEach(async () => {
    await act(() => controller?.destroy());
    controller = undefined;
    document.body.replaceChildren();
    document.documentElement.classList.remove("dark");
    preference.wrapped = true;
    vi.unstubAllGlobals();
  });

  it.each([
    ["```text\nbefore\n```\n", "before"],
    ["---\ntitle: Before\n---\n", "---\ntitle: Before\n---"],
  ])(
    "copies current source and follows wrapping preferences without remounting: %s",
    async (source, code) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const onUserSourceChange = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      controller = new ScientMarkdownEditorView({
        source,
        revision: "r0",
        mode: "write",
        ariaLabel: "Code actions",
        onUserSourceChange,
      });
      await act(() => {
        controller!.mount(host);
      });
      const surface = host.querySelector<HTMLElement>(".cm-editor")!;
      const editor = EditorView.findFromDOM(surface)!;
      expect(editor.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
      await act(() => {
        host.querySelector<HTMLButtonElement>("[aria-label='Disable line wrap']")!.click();
      });
      expect(editor.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
      expect(onUserSourceChange).not.toHaveBeenCalled();
      expect(preference.wrapped).toBe(true);

      // A saved false preference can arrive after mount; it also applies live.
      for (const wrapped of [false, true]) {
        await act(() => {
          preference.wrapped = wrapped;
          preference.listeners.forEach((listener) => listener());
        });
        expect(editor.contentDOM.classList.contains("cm-lineWrapping")).toBe(wrapped);
        expect(host.querySelector(".cm-editor")).toBe(surface);
      }
      await act(() => {
        editor.dispatch({ changes: { from: 0, insert: "updated " } });
      });
      await act(() => {
        host.querySelector<HTMLButtonElement>("[aria-label='Copy code']")!.click();
      });
      expect(writeText).toHaveBeenCalledExactlyOnceWith(`updated ${code}`);
      expect(host.querySelector("[aria-label='Copied']")).not.toBeNull();
      expect(onUserSourceChange).toHaveBeenCalledOnce();
      if (controller!.view!.state.doc.firstChild!.type.name === "code_block") {
        const view = controller!.view!;
        await act(() => {
          view.dispatch(
            view.state.tr.setNodeMarkup(0, undefined, {
              ...view.state.doc.firstChild!.attrs,
              params: 'html title="sample.html"',
            }),
          );
        });
        expect(host.querySelector(".scient-markdown-code-language")?.textContent).toBe(
          "sample.html",
        );
        const icon = host.querySelector<SVGElement>("[data-icon-token='html']")!;
        expect(icon).not.toBeNull();
        const lightColor = icon.style.color;
        const sourceChanges = onUserSourceChange.mock.calls.length;
        await act(() => {
          document.documentElement.classList.add("dark");
          controller!.refreshExternalPresentation("appearance");
        });
        expect(icon.style.color).not.toBe(lightColor);
        expect(onUserSourceChange).toHaveBeenCalledTimes(sourceChanges);
        expect(host.querySelector(".cm-editor")).toBe(surface);
        expect(editor.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
        expect(host.querySelector("[aria-label='Copied']")).not.toBeNull();
      }
      await act(() => {
        controller!.setMode("read");
      });
      expect(host.querySelector("[aria-label='Copied']")).not.toBeNull();
      expect(host.querySelector(".cm-editor")).toBe(surface);
    },
  );
});
