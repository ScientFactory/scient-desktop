import { stubGlobal as _fixtureStubGlobal, act } from "../../../../test/render";
import { EditorView } from "@codemirror/view";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { setI18nLanguage, startI18n } from "~/i18n/runtime";
import { ScientMarkdownEditorView } from "../prosemirror/view";

const preference = vi.hoisted(() => ({ wrapped: true, listeners: new Set<() => void>() }));
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
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
  async function _cleanupFixture0(_fixture: _Fixture) {
    await act(() => _fixture.controller?.destroy());
    _fixture.controller = undefined;
    _clearOwnedDOM(_fixture);
    document.documentElement.classList.remove("dark");
    preference.wrapped = true;
    vi.unstubAllGlobals();
  }

  it("switches the language of code actions without remounting the editor", async () => {
    await using fixture = _createFixture();
    fixture.cleanup.defer(() => act(() => setI18nLanguage("en")));
    fixture.cleanup.defer(() => _cleanupFixture0(fixture));
    using _languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"]);
    startI18n();
    await setI18nLanguage("en");

    const host = document.createElement("div");
    document.body.append(_ownDOM(fixture, host));
    fixture.controller = new ScientMarkdownEditorView({
      source: "```text\nexample\n```\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Code actions",
      onUserSourceChange: vi.fn(),
    });
    await act(() => fixture.controller!.mount(host));
    const copyButton = host.querySelector("[aria-label='Copy code']");
    expect(copyButton).not.toBeNull();

    await act(() => setI18nLanguage());
    expect(host.querySelector("[aria-label='Code kopieren']")).toBe(copyButton);
  });

  it.each([
    // The editor text ends in a newline; the fence's closing newline is not copied.
    ["```text\nbefore\n\n```\n", "before"],
    ["---\ntitle: Before\n---\n", "---\ntitle: Before\n---"],
  ])(
    "copies current source and follows wrapping preferences without remounting: %s",
    async (source, code) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const writeText = vi.fn().mockResolvedValue(undefined);
      _fixture.stack.use(_fixtureStubGlobal("navigator", { clipboard: { writeText } }));
      const onUserSourceChange = vi.fn();
      const host = document.createElement("div");
      document.body.append(_ownDOM(_fixture, host));
      _fixture.controller = new ScientMarkdownEditorView({
        source,
        revision: "r0",
        mode: "write",
        ariaLabel: "Code actions",
        onUserSourceChange,
      });
      await act(() => {
        _fixture.controller!.mount(host);
      });
      const surface = host.querySelector<HTMLElement>(".cm-editor")!;
      const editor = EditorView.findFromDOM(surface)!;
      expect(editor.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
      // regression: cff39eeba2 fix(chat): Stop shows what arrived; code blocks and thread-read rows match upstream
      const wrapToggle = host.querySelector<HTMLButtonElement>("[aria-label='Disable line wrap']")!;
      expect(wrapToggle.getAttribute("aria-pressed")).toBe("true");
      expect(wrapToggle.dataset.variant).toBe("secondary");
      // regression: 010d58e874 fix(chat): Stop reaches answers that left the screen; thoughts read quietly when expanded
      const copyButton = host.querySelector<HTMLButtonElement>("[aria-label='Copy code']")!;
      expect(copyButton.dataset.variant).toBe("ghost-muted");
      expect(copyButton.querySelector("svg.lucide")).not.toBeNull();
      await act(() => {
        wrapToggle.click();
      });
      expect(editor.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
      const unwrapped = host.querySelector<HTMLButtonElement>("[aria-label='Wrap lines']")!;
      expect(unwrapped.getAttribute("aria-pressed")).toBe("false");
      expect(unwrapped.dataset.variant).toBe("ghost-muted");
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
      if (_fixture.controller!.view!.state.doc.firstChild!.type.name === "code_block") {
        const view = _fixture.controller!.view!;
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
          _fixture.controller!.refreshExternalPresentation("appearance");
        });
        expect(icon.style.color).not.toBe(lightColor);
        expect(onUserSourceChange).toHaveBeenCalledTimes(sourceChanges);
        expect(host.querySelector(".cm-editor")).toBe(surface);
        expect(editor.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
        expect(host.querySelector("[aria-label='Copied']")).not.toBeNull();
      }
      await act(() => {
        _fixture.controller!.setMode("read");
      });
      expect(host.querySelector("[aria-label='Copied']")).not.toBeNull();
      expect(host.querySelector(".cm-editor")).toBe(surface);
    },
  );
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    controller: undefined! as ScientMarkdownEditorView | undefined,
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
