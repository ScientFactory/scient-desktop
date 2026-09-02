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
    definitionPosition,
    destinationEditor,
    dispatch,
    nodeView,
    referencePosition,
    repeatedReferencePosition,
    state: () => state,
  };
}

describe("Scient reference node view", () => {
  afterEach(() => document.body.replaceChildren());

  it("renders a numbered marker and navigates directly to its definition", async () => {
    const { definitionPosition, destinationEditor, nodeView, state } = footnoteFixture({});
    const marker = nodeView.dom.querySelector<HTMLButtonElement>("button")!;

    expect(nodeView.dom.dataset.scientMarkdownReference).toBe("footnote_reference");
    expect(marker.textContent).toBe("1");
    expect(marker.getAttribute("aria-label")).toBe("Go to footnote 1");
    expect(nodeView.dom.querySelector("input, textarea")).toBeNull();

    marker.click();
    await Promise.resolve();
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(definitionPosition);
    expect(document.activeElement).toBe(destinationEditor);

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

  it("shows the definition body and edits only its text while preserving the stable label", () => {
    const { nodeView, state, definitionPosition } = footnoteFixture({ viewDefinition: true });
    const body = nodeView.dom.querySelector<HTMLElement>(".scient-markdown-footnote-body")!;
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(nodeView.dom.querySelector(".scient-markdown-reference-label")?.textContent).toBe("1.");
    expect(body.textContent).toBe("First line\nsecond line");
    expect(editor.hidden).toBe(true);
    nodeView.selectNode?.();
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe("First line\nsecond line");

    editor.value = "Updated\ncontinued";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(state().doc.nodeAt(definitionPosition)?.attrs).toMatchObject({
      label: "multiline",
      source: "[^multiline]: Updated\n    continued",
    });

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
    backlinks[1]?.click();
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(repeatedReferencePosition);

    nodeView.destroy?.();
  });

  it("keeps the existing reveal-on-selection behavior for citations", () => {
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

    expect(editor.hidden).toBe(true);
    nodeView.selectNode?.();
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe("@synthetic2026");
    nodeView.deselectNode?.();
    expect(editor.hidden).toBe(true);

    nodeView.destroy?.();
  });

  it("does not reveal or mutate definition source in read mode", () => {
    const { dispatch, nodeView } = footnoteFixture({ editable: false, viewDefinition: true });
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea")!;

    nodeView.selectNode?.();
    expect(editor.hidden).toBe(true);
    editor.value = "Changed";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(dispatch).not.toHaveBeenCalled();

    nodeView.destroy?.();
  });
});
