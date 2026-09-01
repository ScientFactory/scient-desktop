// @vitest-environment happy-dom

import type { Node as ProseMirrorNode } from "prosemirror-model";
import { DecorationSet, type EditorView } from "prosemirror-view";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/scient/math/ScientMath", () => ({
  getScientKatexRuntimePromise: () => Promise.reject(new Error("chunk unavailable")),
  ScientDisplayMath: () => null,
  ScientInlineMath: () => null,
}));

import { createScientMathNodeView } from "./mathNodeView";

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
});
