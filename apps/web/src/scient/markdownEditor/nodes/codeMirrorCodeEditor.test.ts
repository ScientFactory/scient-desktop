// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
});
