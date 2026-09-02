// @vitest-environment happy-dom

import { DOMSerializer, type Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, NodeSelection } from "prosemirror-state";
import { DecorationSet, type EditorView } from "prosemirror-view";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/scient/math/ScientMath", () => ({
  getScientKatexRuntimePromise: () => Promise.reject(new Error("chunk unavailable")),
  ScientDisplayMath: () => null,
  ScientInlineMath: () => null,
}));

import { createScientMathNodeView } from "./mathNodeView";
import { scientMarkdownSchema } from "../prosemirror/schema";

describe("Scient math node view", () => {
  it("settles a rejected runtime load as invalid instead of remaining pending", async () => {
    const node = {
      attrs: { tex: "x^2" },
      type: { name: "display_math" },
    } as unknown as ProseMirrorNode;
    const view = {
      dispatch: vi.fn(),
      focus: vi.fn(),
    } as unknown as EditorView;
    const nodeView = createScientMathNodeView(node, view, () => 0);
    document.body.append(nodeView.dom);

    await vi.waitFor(() => {
      expect(nodeView.dom.getAttribute("data-scient-markdown-math-validity")).toBe("invalid");
    });

    nodeView.destroy?.();
    document.body.replaceChildren();
  });

  it("does not overwrite a focused source field during an external render", () => {
    const type = { name: "display_math" };
    const node = { attrs: { tex: "x^2" }, type } as unknown as ProseMirrorNode;
    const view = { dispatch: vi.fn(), focus: vi.fn() } as unknown as EditorView;
    const nodeView = createScientMathNodeView(node, view, () => 0);
    document.body.append(nodeView.dom);
    const sourceEditor = nodeView.dom.querySelector("textarea");
    expect(sourceEditor).not.toBeNull();
    sourceEditor!.hidden = false;
    sourceEditor!.focus();
    sourceEditor!.value = "composing value";

    expect(
      nodeView.update?.(
        { attrs: { tex: "external value" }, type } as unknown as ProseMirrorNode,
        [],
        DecorationSet.empty,
      ),
    ).toBe(true);
    expect(sourceEditor!.value).toBe("composing value");

    nodeView.destroy?.();
    document.body.replaceChildren();
  });

  it("opens and focuses the source editor from one rendered-equation click", () => {
    const node = scientMarkdownSchema.nodes.display_math!.create({ tex: "E = mc^2" });
    const paragraph = scientMarkdownSchema.nodes.paragraph!.create(
      null,
      scientMarkdownSchema.text("Before"),
    );
    const position = paragraph.nodeSize;
    let state = EditorState.create({
      doc: scientMarkdownSchema.nodes.doc!.create(null, [paragraph, node]),
    });
    const dispatch = vi.fn((transaction) => {
      state = state.apply(transaction);
    });
    const view = {
      get state() {
        return state;
      },
      dispatch,
      editable: true,
      focus: vi.fn(),
    } as unknown as EditorView;
    const nodeView = createScientMathNodeView(node, view, () => position);
    document.body.append(nodeView.dom);
    const render = nodeView.dom.querySelector<HTMLElement>(".scient-markdown-math-render");
    const source = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea");

    expect(render).not.toBeNull();
    expect(source?.hidden).toBe(true);
    expect(Number(source?.rows)).toBe(1);
    render!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));

    expect(dispatch).toHaveBeenCalledOnce();
    expect(state.selection).toBeInstanceOf(NodeSelection);
    expect(state.selection.from).toBe(position);
    expect(source?.hidden).toBe(false);
    expect(document.activeElement).toBe(source);
    expect(source?.selectionStart).toBe(source?.value.length);
    expect(source?.selectionEnd).toBe(source?.value.length);

    nodeView.destroy?.();
    document.body.replaceChildren();
  });

  it("does not steal focus when math is selected without clicking its render", () => {
    const node = {
      attrs: { tex: "x^2" },
      type: { name: "display_math" },
    } as unknown as ProseMirrorNode;
    const view = { dispatch: vi.fn(), editable: true, focus: vi.fn() } as unknown as EditorView;
    const nodeView = createScientMathNodeView(node, view, () => 0);
    document.body.append(nodeView.dom);
    const source = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea");

    nodeView.selectNode?.();

    expect(source?.hidden).toBe(false);
    expect(document.activeElement).not.toBe(source);

    nodeView.destroy?.();
    document.body.replaceChildren();
  });

  it("does not expose the source editor when math is selected in read mode", () => {
    const node = {
      attrs: { tex: "x^2" },
      type: { name: "display_math" },
    } as unknown as ProseMirrorNode;
    const view = { dispatch: vi.fn(), editable: false, focus: vi.fn() } as unknown as EditorView;
    const nodeView = createScientMathNodeView(node, view, () => 0);
    document.body.append(nodeView.dom);
    const source = nodeView.dom.querySelector<HTMLTextAreaElement>("textarea");

    nodeView.selectNode?.();

    expect(source?.hidden).toBe(true);
    expect(document.activeElement).not.toBe(source);

    nodeView.destroy?.();
    document.body.replaceChildren();
  });

  it("uses the display editor for an inline node authored with \\[...\\]", () => {
    const node = {
      attrs: { display: true, tex: "E = mc^2" },
      type: { name: "inline_math" },
    } as unknown as ProseMirrorNode;
    const view = { dispatch: vi.fn(), focus: vi.fn() } as unknown as EditorView;
    const nodeView = createScientMathNodeView(node, view, () => 0);
    document.body.append(nodeView.dom);

    expect(nodeView.dom.tagName).toBe("SPAN");
    expect(nodeView.dom.classList.contains("is-display")).toBe(true);
    expect(nodeView.dom.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Display math source",
    );

    nodeView.destroy?.();
    document.body.replaceChildren();
  });

  it("keeps an authored backslash display delimiter in serialized DOM", () => {
    const math = scientMarkdownSchema.nodes.display_math!.create({
      delimiter: "\\[",
      tex: "E = mc^2",
    });
    const dom = DOMSerializer.fromSchema(scientMarkdownSchema).serializeNode(math);

    expect(dom.textContent).toBe("\\[\nE = mc^2\n\\]");
    expect((dom as HTMLElement).dataset.delimiter).toBe("\\[");
  });
});
