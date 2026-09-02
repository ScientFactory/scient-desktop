// @vitest-environment happy-dom
import { EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { scientMarkdownSchema } from "../prosemirror/schema";
import {
  createScientRawBlockNodeView,
  type ScientMarkdownRawSourceEditorRegistrar,
} from "./rawBlockNodeView";

function fixture(
  sourceKind: string,
  source: string,
  registerSourceEditor?: ScientMarkdownRawSourceEditorRegistrar,
  editable = true,
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
  const nodeView = createScientRawBlockNodeView(node, view, () => 0, registerSourceEditor);
  document.body.append(nodeView.dom);
  return { dispatch, nodeView, state: () => state };
}

describe("raw Markdown source islands", () => {
  afterEach(() => document.body.replaceChildren());

  it.each([
    ["yaml", "---\ntitle: Native Markdown acceptance\n---"],
    ["html", "<!-- Keep this exact comment. -->"],
  ])("keeps one persistent %s source field while selection changes", (sourceKind, source) => {
    const { nodeView } = fixture(sourceKind, source);
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>(
      ".scient-markdown-source-island-editor",
    )!;

    expect(nodeView.dom.querySelector(".scient-markdown-source-island-preview")).toBeNull();
    expect(nodeView.dom.querySelectorAll("textarea")).toHaveLength(1);
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe(source);
    expect(editor.dir).toBe("ltr");
    expect(editor.getAttribute("aria-label")).toBe(
      sourceKind === "html" ? "HTML source" : "YAML source",
    );
    expect(nodeView.dom.dataset.scientMarkdownSourceKind).toBe(sourceKind);

    nodeView.selectNode?.();
    expect(nodeView.dom.querySelector("textarea")).toBe(editor);
    expect(editor.hidden).toBe(false);

    nodeView.deselectNode?.();
    expect(nodeView.dom.querySelector("textarea")).toBe(editor);
    expect(editor.hidden).toBe(false);

    nodeView.destroy?.();
  });

  it("selects the atom and edits its exact source in the same field", () => {
    const source = "---\ntitle: Before\n---";
    const { dispatch, nodeView, state } = fixture("yaml", source);
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(0);
    expect(dispatch).toHaveBeenCalledOnce();

    editor.value = "---\ntitle: After\n---";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(state().doc.firstChild?.attrs.source).toBe("---\ntitle: After\n---");
    expect(nodeView.dom.querySelector("textarea")).toBe(editor);
    expect(dispatch).toHaveBeenCalledTimes(2);

    nodeView.destroy?.();
  });

  it("waits for IME composition to finish before projecting source", () => {
    const { dispatch, nodeView, state } = fixture("yaml", "---\ntitle: Before\n---");
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "---\ntitle: שלום\n---";

    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "ם",
        inputType: "insertText",
        isComposing: true,
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(state().doc.firstChild?.attrs.source).toBe("---\ntitle: Before\n---");

    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: "ם", inputType: "insertText" }),
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(state().doc.firstChild?.attrs.source).toBe("---\ntitle: שלום\n---");

    nodeView.destroy?.();
  });

  it("does not project input while the persistent field is read-only", () => {
    const { dispatch, nodeView, state } = fixture("html", "<!-- Before -->");
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.readOnly = true;
    editor.value = "<!-- After -->";

    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(state().doc.firstChild?.attrs.source).toBe("<!-- Before -->");

    nodeView.destroy?.();
  });

  it("registers one source field for mode changes and unregisters it on destroy", () => {
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const { nodeView } = fixture("html", "<!-- exact -->", register);
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(register).toHaveBeenCalledExactlyOnceWith(editor);
    nodeView.destroy?.();
    expect(unregister).toHaveBeenCalledOnce();
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
