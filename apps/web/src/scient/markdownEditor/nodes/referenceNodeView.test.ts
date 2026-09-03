// @vitest-environment happy-dom

import { EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { scientMarkdownFootnotePresentation } from "../footnotes";
import { scientMarkdownSchema } from "../prosemirror/schema";
import {
  createScientReferenceNodeView,
  type ScientMarkdownFootnoteNodeViewRegistrar,
} from "./referenceNodeView";

function footnoteFixture(input: {
  definition?: boolean;
  editable?: boolean;
  repeated?: boolean;
  viewDefinition?: boolean;
}) {
  const reference = scientMarkdownSchema.nodes.footnote_reference!.create({ label: "multiline" });
  const repeatedReference = scientMarkdownSchema.nodes.footnote_reference!.create({
    label: "multiline",
  });
  const before = scientMarkdownSchema.text("Before ");
  const after = scientMarkdownSchema.text(" after");
  const middle = scientMarkdownSchema.text(" and ");
  const paragraph = scientMarkdownSchema.nodes.paragraph!.create(
    null,
    input.repeated
      ? [before, reference, middle, repeatedReference, after]
      : [before, reference, after],
  );
  const definition = scientMarkdownSchema.nodes.footnote_definition!.create({
    label: "multiline",
    source: "[^multiline]: First line\n    second line",
  });
  const children = input.definition === false ? [paragraph] : [paragraph, definition];
  const doc = scientMarkdownSchema.nodes.doc!.create(null, children);
  const referencePosition = 1 + before.nodeSize;
  const repeatedReferencePosition = referencePosition + reference.nodeSize + middle.nodeSize;
  const definitionPosition = paragraph.nodeSize;
  const node = input.viewDefinition ? definition : reference;
  const position = input.viewDefinition ? definitionPosition : referencePosition;
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
  const destination = document.createElement("aside");
  destination.tabIndex = -1;
  const destinationEditor = document.createElement("textarea");
  destinationEditor.className = "scient-markdown-reference-source";
  destination.append(destinationEditor);
  document.body.append(destination);
  const dispatch = vi.fn((transaction: Transaction) => {
    state = state.apply(transaction);
  });
  const view = {
    editable: input.editable ?? true,
    get state() {
      return state;
    },
    dispatch,
    focus: vi.fn(),
    nodeDOM: vi.fn((requestedPosition: number) =>
      requestedPosition === definitionPosition ? destination : null,
    ),
  } as unknown as EditorView;
  const register: ScientMarkdownFootnoteNodeViewRegistrar = (registration) => {
    registration.refresh(scientMarkdownFootnotePresentation(doc));
    return vi.fn();
  };
  const nodeView = createScientReferenceNodeView(node, view, () => position, register);
  document.body.append(nodeView.dom);
  return {
    destination,
    definitionPosition,
    destinationEditor,
    dispatch,
    nodeView,
    referencePosition,
    repeatedReferencePosition,
    state: () => state,
  };
}

function citationFixture(source = "@synthetic2026") {
  const citation = scientMarkdownSchema.nodes.citation!.create({ source });
  const before = scientMarkdownSchema.text("Before ");
  const after = scientMarkdownSchema.text(" after");
  const paragraph = scientMarkdownSchema.nodes.paragraph!.create(null, [before, citation, after]);
  const doc = scientMarkdownSchema.nodes.doc!.create(null, paragraph);
  const position = 1 + before.nodeSize;
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
  });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = state.apply(transaction);
  });
  const view = {
    editable: true,
    get state() {
      return state;
    },
    dispatch,
    focus: vi.fn(),
  } as unknown as EditorView;
  const nodeView = createScientReferenceNodeView(citation, view, () => position);
  document.body.append(nodeView.dom);
  const editor = nodeView.dom.querySelector<HTMLInputElement>("input")!;
  return { dispatch, editor, nodeView, position, state: () => state };
}

describe("Scient reference node view", () => {
  afterEach(() => document.body.replaceChildren());

  it("navigates a numbered marker without selecting or opening its definition", () => {
    const { destination, dispatch, nodeView, state } = footnoteFixture({});
    const marker = nodeView.dom.querySelector<HTMLButtonElement>("button")!;

    expect(nodeView.dom.dataset.scientMarkdownReference).toBe("footnote_reference");
    expect(marker.textContent).toBe("1");
    expect(marker.getAttribute("aria-label")).toBe("Go to footnote 1");
    expect(nodeView.dom.querySelector("input, textarea")).toBeNull();

    marker.click();
    expect(state().selection).toBeInstanceOf(TextSelection);
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(destination);

    nodeView.destroy?.();
  });

  it("renders a quiet non-dead state when the definition is missing", () => {
    const { dispatch, nodeView } = footnoteFixture({ definition: false });
    const marker = nodeView.dom.querySelector<HTMLButtonElement>("button")!;

    expect(marker.textContent).toBe("1");
    expect(marker.getAttribute("aria-label")).toBe("Footnote 1 has no definition");
    expect(marker.hasAttribute("aria-describedby")).toBe(false);
    expect(nodeView.dom.classList.contains("is-missing")).toBe(true);
    marker.click();
    expect(dispatch).not.toHaveBeenCalled();

    nodeView.destroy?.();
  });

  it("directly edits the visible definition body while preserving the stable label", () => {
    const { nodeView, state, definitionPosition } = footnoteFixture({ viewDefinition: true });
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(nodeView.dom.querySelector(".scient-markdown-reference-label")?.textContent).toBe("1.");
    expect(nodeView.dom.querySelector(".scient-markdown-footnote-body")).toBe(editor);
    expect(nodeView.dom.querySelectorAll(".scient-markdown-footnote-body")).toHaveLength(1);
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe("First line\nsecond line");
    expect(editor.tabIndex).toBe(0);
    nodeView.selectNode?.();
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe("First line\nsecond line");

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, button: 0 });
    editor.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(definitionPosition);
    expect(document.activeElement).toBe(editor);

    editor.value = "Updated\ncontinued";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(state().doc.nodeAt(definitionPosition)?.attrs).toMatchObject({
      label: "multiline",
      source: "[^multiline]: Updated\n    continued",
    });
    nodeView.deselectNode?.();
    expect(editor.hidden).toBe(false);

    nodeView.destroy?.();
  });

  it("gives repeated references individual return backlinks", () => {
    const { nodeView, repeatedReferencePosition, state } = footnoteFixture({
      repeated: true,
      viewDefinition: true,
    });
    const backlinks = nodeView.dom.querySelectorAll<HTMLButtonElement>(
      ".scient-markdown-footnote-backlink",
    );

    expect(backlinks).toHaveLength(2);
    expect(backlinks[1]?.getAttribute("aria-label")).toBe("Return to footnote 1 reference 2");
    const tooltip = backlinks[1]?.querySelector<HTMLElement>(
      ".scient-markdown-footnote-backlink-tooltip",
    );
    expect(tooltip?.textContent).toBe("Back to text");
    expect(tooltip?.getAttribute("aria-hidden")).toBe("true");
    backlinks[1]?.click();
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(repeatedReferencePosition);

    nodeView.destroy?.();
  });

  it("keeps one citation field directly editable without a reveal transition", () => {
    const citation = scientMarkdownSchema.nodes.citation!.create({ source: "@synthetic2026" });
    const paragraph = scientMarkdownSchema.nodes.paragraph!.create(null, citation);
    const doc = scientMarkdownSchema.nodes.doc!.create(null, paragraph);
    const view = {
      editable: true,
      state: EditorState.create({ doc }),
      dispatch: vi.fn(),
    } as unknown as EditorView;
    const nodeView = createScientReferenceNodeView(citation, view, () => 1);
    document.body.append(nodeView.dom);
    const editor = nodeView.dom.querySelector<HTMLInputElement>("input")!;

    expect(nodeView.dom.querySelectorAll("input")).toHaveLength(1);
    expect(nodeView.dom.querySelector(".scient-markdown-reference-label")?.textContent).toBe(
      "[@synthetic2026]",
    );
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe("@synthetic2026");
    expect(editor.dataset.scientMarkdownAtomEditor).toBe("true");
    nodeView.selectNode?.();
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe("@synthetic2026");
    nodeView.deselectNode?.();
    expect(editor.hidden).toBe(false);

    editor.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
    );
    expect(editor).toBe(document.activeElement);

    nodeView.destroy?.();
  });

  it("commits citation IME text once when composition ends", () => {
    const { dispatch, editor, nodeView, position, state } = citationFixture();
    editor.value = "@מקור";

    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "ר",
        inputType: "insertText",
        isComposing: true,
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();

    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "ר" }));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(state().doc.nodeAt(position)?.attrs.source).toBe("@מקור");

    // Browsers may emit a final ordinary input after compositionend. It must
    // not create a duplicate transaction, history item, or save request.
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(dispatch).toHaveBeenCalledOnce();

    nodeView.destroy?.();
  });

  it("keeps physical arrow continuity for an RTL citation in LTR prose", () => {
    const { editor, nodeView, position, state } = citationFixture("@מקור");
    nodeView.dom.style.direction = "ltr";
    editor.style.direction = "rtl";

    editor.setSelectionRange(editor.value.length, editor.value.length);
    const left = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
    });
    editor.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(true);
    expect(state().selection.head).toBe(position);

    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    editor.setSelectionRange(0, 0);
    const right = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    editor.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    expect(state().selection.head).toBe(position + 1);

    nodeView.destroy?.();
  });

  it("keeps physical arrow continuity for an LTR citation in RTL prose", () => {
    const { editor, nodeView, position, state } = citationFixture("@smith2020");
    nodeView.dom.style.direction = "rtl";
    editor.style.direction = "ltr";

    editor.setSelectionRange(0, 0);
    const left = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
    });
    editor.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(true);
    expect(state().selection.head).toBe(position + 1);

    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    editor.setSelectionRange(editor.value.length, editor.value.length);
    const right = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    editor.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    expect(state().selection.head).toBe(position);

    nodeView.destroy?.();
  });

  it("uses the browser-resolved citation direction for mixed-script text", () => {
    const { editor, nodeView, position, state } = citationFixture("@aאבגדה");
    nodeView.dom.style.direction = "ltr";
    editor.style.direction = "ltr";

    editor.setSelectionRange(0, 0);
    const left = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
    });
    editor.dispatchEvent(left);

    expect(left.defaultPrevented).toBe(true);
    expect(state().selection.head).toBe(position);

    nodeView.destroy?.();
  });

  it("deletes an empty inline citation with Backspace", () => {
    const { editor, nodeView, state } = citationFixture("");
    editor.setSelectionRange(0, 0);
    const backspace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Backspace",
    });

    editor.dispatchEvent(backspace);

    expect(backspace.defaultPrevented).toBe(true);
    expect(state().doc.textContent).toBe("Before  after");
    let hasCitation = false;
    state().doc.descendants((node) => {
      if (node.type.name === "citation") hasCitation = true;
    });
    expect(hasCitation).toBe(false);
    nodeView.destroy?.();
  });

  it("keeps definition text visible but does not mutate it in read mode", () => {
    const { dispatch, nodeView } = footnoteFixture({ editable: false, viewDefinition: true });
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(editor.hidden).toBe(false);
    expect(editor.readOnly).toBe(true);
    expect(editor.tabIndex).toBe(-1);
    nodeView.selectNode?.();
    expect(editor.hidden).toBe(false);
    editor.value = "Changed";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(dispatch).not.toHaveBeenCalled();

    nodeView.destroy?.();
  });
});
