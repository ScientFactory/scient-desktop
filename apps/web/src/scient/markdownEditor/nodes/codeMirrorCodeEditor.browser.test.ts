import { describe, expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";

import { createScientNestedCodeEditor, type ScientNestedCodeEditor } from "./codeMirrorCodeEditor";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { waitForTestReceipt } from "../../../../test/receipt";

describe("Scient nested code editor", () => {
  async function _cleanupFixture0(_fixture: _Fixture) {
    _fixture.editor?.destroy();
    _fixture.editor = null;
    _clearOwnedDOM(_fixture);
    document.documentElement.classList.remove("dark");
  }

  it("keeps one surface while code, language, and document mode change", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const parent = document.createElement("div");
    document.body.append(_ownDOM(_fixture, parent));
    const onUserCodeChange = vi.fn();
    _fixture.editor = createScientNestedCodeEditor({
      parent,
      code: "const before = true;",
      editable: false,
      language: "javascript",
      onEscape: vi.fn(),
      onUserCodeChange,
    });
    const surface = parent.querySelector<HTMLElement>(".cm-editor")!;
    const content = parent.querySelector<HTMLElement>(".cm-content")!;

    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(content.getAttribute("aria-label")).toBe("javascript code block");

    _fixture.editor.setEditable(true);
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(content.getAttribute("contenteditable")).toBe("true");

    _fixture.editor.replaceExternalCode("const after: boolean = true;", "typescript");
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(parent.querySelector(".cm-line")?.textContent).toBe("const after: boolean = true;");
    expect(content.getAttribute("aria-label")).toBe("typescript code block");
    expect(onUserCodeChange).not.toHaveBeenCalled();

    const lightClassName = surface.className;
    document.documentElement.classList.add("dark");
    _fixture.editor.refreshAppearance();
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(surface.className).not.toBe(lightClassName);

    _fixture.editor.setEditable(false);
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(content.getAttribute("contenteditable")).toBe("false");
  });

  it("keeps Escape owned by the nested editor without changing its surface", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const parent = document.createElement("div");
    document.body.append(_ownDOM(_fixture, parent));
    const onEscape = vi.fn();
    _fixture.editor = createScientNestedCodeEditor({
      parent,
      code: "value",
      editable: true,
      language: "text",
      onEscape,
      onUserCodeChange: vi.fn(),
    });
    const surface = parent.querySelector<HTMLElement>(".cm-editor")!;
    const content = parent.querySelector<HTMLElement>(".cm-content")!;
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });

    content.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onEscape).toHaveBeenCalledOnce();
    expect(parent.querySelector(".cm-editor")).toBe(surface);
  });

  it("changes wrapping without losing the cursor, edits, or undo history", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const parent = document.createElement("div");
    document.body.append(_ownDOM(_fixture, parent));
    const onUserCodeChange = vi.fn();
    _fixture.editor = createScientNestedCodeEditor({
      parent,
      code: "before",
      editable: true,
      language: "text",
      wordWrap: false,
      onEscape: vi.fn(),
      onUserCodeChange,
    });
    const surface = parent.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(surface)!;
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    view.dispatch({ changes: { from: 6, insert: " after" }, selection: { anchor: 12 } });
    const selection = view.state.selection;
    onUserCodeChange.mockClear();

    _fixture.editor.setWordWrap(true);
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    _fixture.editor.setWordWrap(false);
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(view.state.selection).toBe(selection);
    expect(view.state.doc.toString()).toBe("before after");
    expect(onUserCodeChange).not.toHaveBeenCalled();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("before");
    expect(onUserCodeChange).toHaveBeenCalledExactlyOnceWith("before", [
      { from: 6, to: 12, insert: "" },
    ]);
  });

  it("keeps a source-specific accessible name when its language changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const parent = document.createElement("div");
    document.body.append(_ownDOM(_fixture, parent));
    _fixture.editor = createScientNestedCodeEditor({
      ariaLabel: "HTML source",
      parent,
      code: "<!-- exact -->",
      editable: true,
      language: "html",
      onEscape: vi.fn(),
      onUserCodeChange: vi.fn(),
    });
    const content = parent.querySelector<HTMLElement>(".cm-content")!;

    expect(content.getAttribute("aria-label")).toBe("HTML source");
    _fixture.editor.replaceExternalCode('title = "Exact"', "toml");
    expect(content.getAttribute("aria-label")).toBe("HTML source");
  });

  // regression: c66c948db0 chore(upstream): merge t3 through 81dea7821d
  it.each([
    "plotly",
    "plotly.js",
    "plotly-json",
    "plotlyjs",
    "vega",
    "vega-lite",
    "vegalite",
    "vl",
  ])("highlights %s source as JSON without changing its source language", async (language) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const parent = document.createElement("div");
    document.body.append(_ownDOM(_fixture, parent));
    const onUserCodeChange = vi.fn();
    _fixture.editor = createScientNestedCodeEditor({
      parent,
      code: '{"data": [1, true, "label"]}',
      editable: true,
      language,
      onEscape: vi.fn(),
      onUserCodeChange,
    });
    await vi.waitFor(() => {
      const tokens = [...parent.querySelectorAll(".cm-line span")];
      expect(tokens.some((token) => token.textContent === '"data"')).toBe(true);
      expect(new Set(tokens.map((token) => getComputedStyle(token).color)).size).toBeGreaterThan(2);
    });
    expect(parent.querySelector(".cm-content")?.getAttribute("aria-label")).toBe(
      `${language} code block`,
    );
    expect(onUserCodeChange).not.toHaveBeenCalled();
  });

  it("colors Mermaid across edits and themes without replacing the editor or its undo history", async (context) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const parent = document.createElement("div");
    document.body.append(_ownDOM(_fixture, parent));
    const onUserCodeChange = vi.fn();
    const code = "flowchart LR\n  A[Start] --> B[End]";
    _fixture.editor = createScientNestedCodeEditor({
      parent,
      code,
      editable: true,
      language: "mermaid",
      onEscape: vi.fn(),
      onUserCodeChange,
    });
    const surface = parent.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(surface)!;
    const keywordColor = () =>
      [...parent.querySelectorAll<HTMLElement>(".cm-line span")].find(
        (span) => span.textContent === "flowchart",
      )?.style.color;
    // Module and grammar readiness precede CodeMirror's decoration publication.
    await waitForTestReceipt(context.signal, import("./mermaidCodeHighlighting"));
    {
      const painted = Promise.withResolvers<void>();
      const observeColor = () => {
        if (keywordColor()) painted.resolve();
      };
      const observer = new MutationObserver(observeColor);
      using _paint = { [Symbol.dispose]: () => observer.disconnect() };
      observer.observe(parent, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style"],
      });
      observeColor();
      await waitForTestReceipt(context.signal, getSyntaxHighlighterPromise("mermaid"));
      await waitForTestReceipt(context.signal, painted.promise);
    }
    expect(keywordColor()).toBeTruthy();
    const lightColor = keywordColor();
    expect(onUserCodeChange).not.toHaveBeenCalled();
    view.dispatch({
      changes: { from: code.length, insert: "\n  B --> C" },
      selection: { anchor: code.length + 10 },
    });
    const selection = view.state.selection;
    document.documentElement.classList.add("dark");
    _fixture.editor.refreshAppearance();
    await vi.waitFor(() => expect(keywordColor()).not.toBe(lightColor));
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(view.state.selection).toBe(selection);
    expect(view.state.doc.toString()).toBe(code + "\n  B --> C");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(code);
    expect(keywordColor()).toBeTruthy();
    _fixture.editor.replaceExternalCode("plain source", "text");
    await vi.waitFor(() => expect(parent.querySelector(".cm-line span[style]")).toBeNull());
  });

  // regression: 9e5513e5c3 fix(web): align shared math and code presentation
  it.each([
    ["light", "#d5512f", "#18a46c", "#636363"],
    ["dark", "#ff855e", "#60d199", "#636363"],
  ])(
    "highlights HTML tags, attributes, and punctuation in %s mode",
    async (mode, tag, attribute, punctuation) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      document.documentElement.classList.toggle("dark", mode === "dark");
      const parent = document.createElement("div");
      document.body.append(_ownDOM(_fixture, parent));
      const onUserCodeChange = vi.fn();
      _fixture.editor = createScientNestedCodeEditor({
        parent,
        code: '<div class="note">Hello &amp; welcome</div>',
        editable: true,
        language: "html",
        onEscape: vi.fn(),
        onUserCodeChange,
      });
      const surface = parent.querySelector<HTMLElement>(".cm-editor")!;
      const colorOf = (text: string) => {
        const token = [...parent.querySelectorAll(".cm-line span")].find(
          (span) => span.textContent === text,
        );
        return token ? getComputedStyle(token).color : null;
      };
      await vi.waitFor(() => {
        expect(colorOf("div")).toBe(nativeColor(tag!));
        expect(colorOf("class")).toBe(nativeColor(attribute!));
        expect(colorOf("<")).toBe(nativeColor(punctuation!));
      });

      // Editing and a language change retain the same code surface and palette.
      _fixture.editor.replaceExternalCode("const value = Math.max(1, 2);", "javascript");
      await vi.waitFor(() => {
        expect(colorOf("=")).toBe(nativeColor(punctuation!));
        expect(colorOf(".")).toBe(nativeColor(punctuation!));
      });
      expect(parent.querySelector(".cm-editor")).toBe(surface);
      expect(onUserCodeChange).not.toHaveBeenCalled();
    },
  );
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    editor: null as ScientNestedCodeEditor | null,
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

function nativeColor(value: string) {
  const style = document.createElement("span").style;
  style.color = value;
  return style.color;
}
