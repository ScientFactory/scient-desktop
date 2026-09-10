// @vitest-environment happy-dom
import { EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scientMarkdownSchema } from "../prosemirror/schema";
import {
  createScientRawBlockNodeView,
  type ScientMarkdownRawSourceEditorRegistrar,
} from "./rawBlockNodeView";
import {
  createScientNestedCodeEditor,
  type ScientNestedCodeEditorRegistrar,
} from "./codeMirrorCodeEditor";

vi.mock("./codeMirrorCodeEditor", { spy: true });

const createCodeEditor = vi.mocked(createScientNestedCodeEditor);

function fixture(
  sourceKind: string,
  source: string,
  registerSourceEditor?: ScientMarkdownRawSourceEditorRegistrar,
  editable = true,
  registerCodeEditor?: ScientNestedCodeEditorRegistrar,
) {
  const node = scientMarkdownSchema.nodes.raw_block!.create({ source, sourceKind });
  const paragraph = scientMarkdownSchema.nodes.paragraph!.create(
    null,
    scientMarkdownSchema.text("Body"),
  );
  const doc = scientMarkdownSchema.topNodeType.create(null, [node, paragraph]);
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 2),
  });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = state.apply(transaction);
  });
  const view = {
    editable,
    get state() {
      return state;
    },
    dispatch,
    focus: vi.fn(),
  } as unknown as EditorView;
  const nodeView = createScientRawBlockNodeView(
    node,
    view,
    () => 0,
    registerSourceEditor,
    registerCodeEditor,
  );
  document.body.append(nodeView.dom);
  return { dispatch, nodeView, state: () => state };
}

describe("raw Markdown source islands", () => {
  beforeEach(() => {
    createCodeEditor.mockReset();
    createCodeEditor.mockImplementation((input) => {
      const content = document.createElement("div");
      content.className = "cm-content";
      content.setAttribute("aria-label", input.ariaLabel ?? "Source");
      input.parent.append(content);
      return {
        destroy: vi.fn(),
        focus: vi.fn(),
        refreshAppearance: vi.fn(),
        replaceExternalCode: vi.fn(),
        setEditable: vi.fn(),
        setWordWrap: vi.fn(),
      };
    });
  });

  afterEach(() => {
    createCodeEditor.mockReset();
    document.body.replaceChildren();
  });

  it.each([
    ["yaml", "---\ntitle: Native Markdown acceptance\n---"],
    ["html", "<!-- Keep this exact comment. -->"],
  ])("keeps one persistent %s source editor while selection changes", (sourceKind, source) => {
    const { nodeView } = fixture(sourceKind, source);
    const editor = nodeView.dom.querySelector<HTMLElement>(
      ".scient-markdown-source-island-code-editor",
    )!;

    expect(nodeView.dom.querySelector(".scient-markdown-source-island-preview")).toBeNull();
    expect(nodeView.dom.querySelector("textarea")).toBeNull();
    expect(createCodeEditor).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ariaLabel: sourceKind === "html" ? "HTML source" : "YAML source",
        code: source,
        editable: true,
        language: sourceKind,
      }),
    );
    expect(editor.hidden).toBe(false);
    expect(editor.dataset.scientMarkdownAtomEditor).toBe("true");
    expect(editor.tabIndex).toBe(-1);
    expect(nodeView.dom.dir).toBe("ltr");
    expect(editor.querySelector(".cm-content")?.getAttribute("aria-label")).toBe(
      sourceKind === "html" ? "HTML source" : "YAML source",
    );
    expect(nodeView.dom.dataset.scientMarkdownSourceKind).toBe(sourceKind);

    nodeView.selectNode?.();
    expect(nodeView.dom.querySelector(".scient-markdown-source-island-code-editor")).toBe(editor);
    expect(editor.hidden).toBe(false);

    nodeView.deselectNode?.();
    expect(nodeView.dom.querySelector(".scient-markdown-source-island-code-editor")).toBe(editor);
    expect(editor.hidden).toBe(false);
    expect(createCodeEditor).toHaveBeenCalledOnce();

    editor.focus();
    expect(createCodeEditor.mock.results[0]!.value.focus).toHaveBeenCalledOnce();

    nodeView.destroy?.();
  });

  it("selects the atom and edits its exact source in the same nested editor", () => {
    const source = "---\ntitle: Before\n---";
    const { dispatch, nodeView, state } = fixture("yaml", source);
    const editor = nodeView.dom.querySelector<HTMLElement>(
      ".scient-markdown-source-island-code-editor .cm-content",
    )!;

    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(0);
    expect(dispatch).toHaveBeenCalledOnce();

    createCodeEditor.mock.calls[0]![0].onUserCodeChange("---\ntitle: After\n---", []);
    expect(state().doc.firstChild?.attrs.source).toBe("---\ntitle: After\n---");
    expect(
      nodeView.dom.querySelector(".scient-markdown-source-island-code-editor .cm-content"),
    ).toBe(editor);
    expect(dispatch).toHaveBeenCalledTimes(2);

    nodeView.destroy?.();
  });

  it("projects one nested-editor change and ignores the same source afterward", () => {
    const { dispatch, nodeView, state } = fixture("yaml", "---\ntitle: Before\n---");
    const changeSource = createCodeEditor.mock.calls[0]![0].onUserCodeChange;

    changeSource("---\ntitle: שלום\n---", []);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(state().doc.firstChild?.attrs.source).toBe("---\ntitle: שלום\n---");
    changeSource("---\ntitle: שלום\n---", []);
    expect(dispatch).toHaveBeenCalledOnce();

    nodeView.destroy?.();
  });

  it("does not project nested-editor input from a read-only view", () => {
    const { dispatch, nodeView, state } = fixture("html", "<!-- Before -->", undefined, false);
    expect(createCodeEditor.mock.calls[0]![0].editable).toBe(false);
    createCodeEditor.mock.calls[0]![0].onUserCodeChange("<!-- After -->", []);
    expect(dispatch).not.toHaveBeenCalled();
    expect(state().doc.firstChild?.attrs.source).toBe("<!-- Before -->");

    nodeView.destroy?.();
  });

  it("registers one nested editor for mode and appearance changes", () => {
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const { nodeView } = fixture("html", "<!-- exact -->", undefined, true, register);
    const editor = createCodeEditor.mock.results[0]!.value;

    expect(register).toHaveBeenCalledExactlyOnceWith(editor);
    nodeView.destroy?.();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("falls back to one exact-source textarea if the nested editor cannot mount", () => {
    createCodeEditor.mockImplementationOnce(() => {
      throw new Error("CodeMirror unavailable");
    });
    const { dispatch, nodeView, state } = fixture("html", "<!-- Before -->");
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(editor.value).toBe("<!-- Before -->");
    expect(editor.getAttribute("aria-label")).toBe("HTML source");
    editor.value = "<!-- After -->";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(state().doc.firstChild?.attrs.source).toBe("<!-- After -->");
    expect(dispatch).toHaveBeenCalledOnce();

    nodeView.destroy?.();
  });

  it("directly edits a compact reference definition in its only source field", () => {
    const source = '[shared]: https://example.com/shared "Shared reference title"';
    const { dispatch, nodeView, state } = fixture("definition", source);
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(nodeView.dom.querySelector("button")).toBeNull();
    expect(nodeView.dom.querySelector(".scient-markdown-source-island-kind")?.textContent).toBe(
      "Reference",
    );
    expect(editor.hidden).toBe(false);
    expect(Number(editor.rows)).toBe(1);
    expect(editor.tabIndex).toBe(0);
    expect(editor.getAttribute("aria-label")).toBe("Reference definition");
    expect(editor.value).toBe(source);
    expect(state().doc.firstChild?.attrs.source).toBe(source);

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, button: 0 });
    editor.dispatchEvent(mouseDown);
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(0);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(state().doc.firstChild?.attrs.source).toBe(source);

    editor.value = "[shared]: ./updated.md";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(state().doc.firstChild?.attrs.source).toBe("[shared]: ./updated.md");

    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(state().selection).not.toBeInstanceOf(NodeSelection);
    expect(editor.hidden).toBe(false);
    expect(editor.tabIndex).toBe(0);

    nodeView.destroy?.();
  });

  it("keeps the direct definition field visible when its node selection leaves", () => {
    const { nodeView } = fixture("definition", "[shared]: ./target.md");
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(editor.hidden).toBe(false);
    nodeView.deselectNode?.();
    expect(editor.hidden).toBe(false);

    nodeView.destroy?.();
  });

  it("does not project direct reference input from a read-only view", () => {
    const source = "[shared]: ./target.md";
    const { dispatch, nodeView, state } = fixture("definition", source, undefined, false);
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(editor.readOnly).toBe(true);
    editor.value = "[shared]: ./changed.md";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(state().doc.firstChild?.attrs.source).toBe(source);

    nodeView.destroy?.();
  });
});
