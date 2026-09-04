// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";

import { createScientNestedCodeEditor, type ScientNestedCodeEditor } from "./codeMirrorCodeEditor";

describe("Scient nested code editor", () => {
  let editor: ScientNestedCodeEditor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.replaceChildren();
    document.documentElement.classList.remove("dark");
  });

  it("keeps one surface while code, language, and document mode change", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onUserCodeChange = vi.fn();
    editor = createScientNestedCodeEditor({
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

    editor.setEditable(true);
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(content.getAttribute("contenteditable")).toBe("true");

    editor.replaceExternalCode("const after: boolean = true;", "typescript");
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(parent.querySelector(".cm-line")?.textContent).toBe("const after: boolean = true;");
    expect(content.getAttribute("aria-label")).toBe("typescript code block");
    expect(onUserCodeChange).not.toHaveBeenCalled();

    const lightClassName = surface.className;
    document.documentElement.classList.add("dark");
    editor.refreshAppearance();
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(surface.className).not.toBe(lightClassName);

    editor.setEditable(false);
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(content.getAttribute("contenteditable")).toBe("false");
  });

  it("keeps Escape owned by the nested editor without changing its surface", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onEscape = vi.fn();
    editor = createScientNestedCodeEditor({
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

  it("changes wrapping without losing the cursor, edits, or undo history", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onUserCodeChange = vi.fn();
    editor = createScientNestedCodeEditor({
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

    editor.setWordWrap(true);
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    editor.setWordWrap(false);
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(view.state.selection).toBe(selection);
    expect(view.state.doc.toString()).toBe("before after");
    expect(onUserCodeChange).not.toHaveBeenCalled();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("before");
    expect(onUserCodeChange).toHaveBeenCalledExactlyOnceWith("before");
  });

  it("keeps a source-specific accessible name when its language changes", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = createScientNestedCodeEditor({
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
    editor.replaceExternalCode('title = "Exact"', "toml");
    expect(content.getAttribute("aria-label")).toBe("HTML source");
  });

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
    const parent = document.createElement("div");
    document.body.append(parent);
    const onUserCodeChange = vi.fn();
    editor = createScientNestedCodeEditor({
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

  it("colors Mermaid across edits and themes without replacing the editor or its undo history", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onUserCodeChange = vi.fn();
    const code = "flowchart LR\n  A[Start] --> B[End]";
    editor = createScientNestedCodeEditor({
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
    await vi.waitFor(() => expect(keywordColor()).toBeTruthy());
    const lightColor = keywordColor();
    expect(onUserCodeChange).not.toHaveBeenCalled();
    view.dispatch({
      changes: { from: code.length, insert: "\n  B --> C" },
      selection: { anchor: code.length + 10 },
    });
    const selection = view.state.selection;
    document.documentElement.classList.add("dark");
    editor.refreshAppearance();
    await vi.waitFor(() => expect(keywordColor()).not.toBe(lightColor));
    expect(parent.querySelector(".cm-editor")).toBe(surface);
    expect(view.state.selection).toBe(selection);
    expect(view.state.doc.toString()).toBe(code + "\n  B --> C");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(code);
    expect(keywordColor()).toBeTruthy();
    editor.replaceExternalCode("plain source", "text");
    await vi.waitFor(() => expect(parent.querySelector(".cm-line span[style]")).toBeNull());
  });

  it.each([
    ["light", "#d5512f", "#18a46c", "#636363"],
    ["dark", "#ff855e", "#60d199", "#636363"],
  ])(
    "highlights HTML tags, attributes, and punctuation in %s mode",
    async (mode, tag, attribute, punctuation) => {
      document.documentElement.classList.toggle("dark", mode === "dark");
      const parent = document.createElement("div");
      document.body.append(parent);
      const onUserCodeChange = vi.fn();
      editor = createScientNestedCodeEditor({
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
        expect(colorOf("div")).toBe(tag);
        expect(colorOf("class")).toBe(attribute);
        expect(colorOf("<")).toBe(punctuation);
      });

      // Editing and a language change retain the same code surface and palette.
      editor.replaceExternalCode("const value = Math.max(1, 2);", "javascript");
      await vi.waitFor(() => {
        expect(colorOf("=")).toBe(punctuation);
        expect(colorOf(".")).toBe(punctuation);
      });
      expect(parent.querySelector(".cm-editor")).toBe(surface);
      expect(onUserCodeChange).not.toHaveBeenCalled();
    },
  );
});
