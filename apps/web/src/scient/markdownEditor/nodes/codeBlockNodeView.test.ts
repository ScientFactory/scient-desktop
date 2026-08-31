// @vitest-environment happy-dom
import type { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scientMarkdownSchema } from "../prosemirror/schema";
import { createScientCodeBlockNodeView } from "./codeBlockNodeView";

const mocks = vi.hoisted(() => ({
  create: vi.fn(() => ({ focus: vi.fn(), destroy: vi.fn(), replaceExternalCode: vi.fn() })),
}));
vi.mock("./codeMirrorCodeEditor", () => ({ createScientNestedCodeEditor: mocks.create }));
vi.mock("~/lib/syntaxHighlighting", () => ({
  getSyntaxHighlighterPromise: async () => ({ codeToHtml: () => "" }),
}));

describe("nested code editor activation", () => {
  afterEach(() => {
    mocks.create.mockClear();
    document.body.replaceChildren();
  });
  function fixture() {
    const node = scientMarkdownSchema.nodes.code_block!.create(
      { params: "text" },
      scientMarkdownSchema.text("code"),
    );
    const view = { editable: true, focus: vi.fn() } as unknown as EditorView;
    const nodeView = createScientCodeBlockNodeView(node, view, () => 0);
    document.body.append(nodeView.dom!);
    return nodeView;
  }
  it("does not activate or steal focus after deselection during the lazy import", async () => {
    const nodeView = fixture();
    nodeView.selectNode!();
    nodeView.deselectNode!();
    await vi.dynamicImportSettled();
    expect(mocks.create).not.toHaveBeenCalled();
    nodeView.destroy!();
  });
  it("keeps rendered code visible until the lazy editor is ready, then swaps once", async () => {
    const nodeView = fixture();
    const dom = nodeView.dom as HTMLElement;
    const rendered = dom.querySelector<HTMLElement>(".scient-markdown-code-render")!;
    const editor = dom.querySelector<HTMLElement>(".scient-markdown-code-editor")!;
    nodeView.selectNode!();
    expect(rendered.hidden).toBe(false);
    expect(rendered.textContent).toBe("code");
    expect(editor.hidden).toBe(true);
    await vi.dynamicImportSettled();
    expect(rendered.hidden).toBe(true);
    expect(editor.hidden).toBe(false);
    nodeView.deselectNode!();
    expect(rendered.hidden).toBe(false);
    expect(editor.hidden).toBe(true);
    nodeView.selectNode!();
    expect(rendered.hidden).toBe(true);
    expect(editor.hidden).toBe(false);
    expect(mocks.create).toHaveBeenCalledOnce();
    nodeView.destroy!();
  });
  it("creates only one editor across overlapping activations", async () => {
    const nodeView = fixture();
    nodeView.selectNode!();
    nodeView.deselectNode!();
    nodeView.selectNode!();
    await vi.dynamicImportSettled();
    expect(mocks.create).toHaveBeenCalledOnce();
    nodeView.destroy!();
    expect(mocks.create.mock.results[0]?.value.destroy).toHaveBeenCalledOnce();
  });
  it("does not create an editor after destruction", async () => {
    const nodeView = fixture();
    nodeView.selectNode!();
    nodeView.destroy!();
    await vi.dynamicImportSettled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
