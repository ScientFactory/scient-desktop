// @vitest-environment happy-dom
import type { EditorView } from "prosemirror-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scientMarkdownSchema } from "../prosemirror/schema";
import { createScientCodeBlockNodeView } from "./codeBlockNodeView";
import { createScientNestedCodeEditor } from "./codeMirrorCodeEditor";

const mocks = {
  create: vi.mocked(createScientNestedCodeEditor),
  dispatch: vi.fn(),
};
// Manual factory mocks can resolve to actual exports during concurrent dynamic
// imports. Autospy keeps both activation continuations on the same controlled factory.
vi.mock("./codeMirrorCodeEditor", { spy: true });
vi.mock("~/lib/syntaxHighlighting", () => ({
  getSyntaxHighlighterPromise: async () => ({ codeToHtml: () => "code" }),
}));

describe("nested code editor activation", () => {
  beforeEach(() => {
    mocks.create.mockImplementation(() => ({
      focus: vi.fn(),
      destroy: vi.fn(),
      replaceExternalCode: vi.fn(),
    }));
  });
  afterEach(() => {
    mocks.create.mockReset();
    mocks.dispatch.mockClear();
    document.body.replaceChildren();
  });
  function fixture() {
    const node = scientMarkdownSchema.nodes.code_block!.create(
      { params: "text" },
      scientMarkdownSchema.text("code"),
    );
    const view = {
      editable: true,
      focus: vi.fn(),
      dispatch: mocks.dispatch,
    } as unknown as EditorView;
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

  it("keeps code readable after activation fails and retries without changing the source", async () => {
    const nodeView = fixture();
    const dom = nodeView.dom as HTMLElement;
    const rendered = dom.querySelector<HTMLElement>(".scient-markdown-code-render")!;
    const editor = dom.querySelector<HTMLElement>(".scient-markdown-code-editor")!;
    mocks.create.mockImplementationOnce(() => {
      editor.append(document.createElement("span"));
      throw new Error("Editor initialization failed");
    });
    try {
      nodeView.selectNode!();
      await vi.dynamicImportSettled();
      const notice = dom.querySelector<HTMLElement>(".scient-markdown-code-load-error")!;
      expect(notice?.hidden).toBe(false);
      expect(notice.textContent).toContain("Markdown source");
      expect(rendered.hidden).toBe(false);
      expect(rendered.textContent).toBe("code");
      expect(editor.hidden).toBe(true);
      expect(editor.childElementCount).toBe(0);
      expect(mocks.dispatch).not.toHaveBeenCalled();

      const retry = notice.querySelector<HTMLButtonElement>("button")!;
      retry.click();
      await vi.dynamicImportSettled();
      expect(mocks.create).toHaveBeenCalledTimes(2);
      expect(mocks.create.mock.results[1]?.value.focus).toHaveBeenCalledOnce();
      expect(notice.hidden).toBe(true);
      expect(rendered.hidden).toBe(true);
      expect(editor.hidden).toBe(false);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    } finally {
      nodeView.destroy!();
    }
  });

  it("clears a failed overlapping attempt when another activation succeeds", async () => {
    const nodeView = fixture();
    const dom = nodeView.dom as HTMLElement;
    mocks.create.mockImplementationOnce(() => {
      throw new Error("First activation failed");
    });
    try {
      nodeView.selectNode!();
      nodeView.selectNode!();
      await vi.dynamicImportSettled();
      expect(mocks.create).toHaveBeenCalledTimes(2);
      expect(mocks.create.mock.results[1]?.value.focus).toHaveBeenCalledOnce();
      expect(dom.querySelector<HTMLElement>(".scient-markdown-code-load-error")?.hidden).toBe(true);
      expect(dom.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(false);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    } finally {
      nodeView.destroy!();
    }
  });
});
