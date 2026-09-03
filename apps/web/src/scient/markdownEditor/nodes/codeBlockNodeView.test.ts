// @vitest-environment happy-dom
import { EditorState, NodeSelection, type Selection, type Transaction } from "prosemirror-state";
import { DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scientMarkdownSchema } from "../prosemirror/schema";
import { createScientCodeBlockNodeView } from "./codeBlockNodeView";
import { createScientNestedCodeEditor } from "./codeMirrorCodeEditor";
import type {
  ScientMarkdownExternalPresentationRefresh,
  ScientMarkdownExternalPresentationRegistrar,
  ScientMarkdownThemeResolver,
} from "./externalPresentation";

const syntaxMocks = vi.hoisted(() => ({
  codeToHtml: vi.fn(
    (_code: string, options: { readonly theme: string }) =>
      `<span data-code-theme="${options.theme}">code</span>`,
  ),
  getSyntaxHighlighterPromise: vi.fn(),
}));

const mocks = {
  create: vi.mocked(createScientNestedCodeEditor),
  dispatch: vi.fn(),
};
// Manual factory mocks can resolve to actual exports during concurrent dynamic
// imports. Autospy keeps both activation continuations on the same controlled factory.
vi.mock("./codeMirrorCodeEditor", { spy: true });
vi.mock("./ScientEditableRichFence", async () => {
  const { createElement } = await import("react");
  return {
    ScientEditableRichFence: ({
      authoringActions,
    }: {
      readonly authoringActions: { readonly onEditSource: () => void };
    }) =>
      createElement(
        "button",
        { "data-edit-rich-source": true, onClick: authoringActions.onEditSource, type: "button" },
        "Edit source",
      ),
  };
});
vi.mock("~/lib/syntaxHighlighting", () => ({
  getSyntaxHighlighterPromise: syntaxMocks.getSyntaxHighlighterPromise,
}));

describe("nested code editor activation", () => {
  beforeEach(() => {
    syntaxMocks.codeToHtml.mockClear();
    syntaxMocks.getSyntaxHighlighterPromise.mockReset();
    syntaxMocks.getSyntaxHighlighterPromise.mockImplementation(async () => ({
      codeToHtml: syntaxMocks.codeToHtml,
    }));
    mocks.create.mockImplementation(() => ({
      focus: vi.fn(),
      focusAt: vi.fn(),
      destroy: vi.fn(),
      replaceExternalCode: vi.fn(),
    }));
  });
  afterEach(() => {
    mocks.create.mockReset();
    mocks.dispatch.mockClear();
    document.body.replaceChildren();
  });
  function fixture(
    resolveTheme?: ScientMarkdownThemeResolver,
    registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar,
    params = "text",
  ) {
    const node = scientMarkdownSchema.nodes.code_block!.create(
      { params },
      scientMarkdownSchema.text("code"),
    );
    const doc = scientMarkdownSchema.topNodeType.create(null, [node]);
    let state = EditorState.create({ doc });
    let nodeView: NodeView | undefined;
    const selectsBlock = (selection: Selection) =>
      selection instanceof NodeSelection && selection.from === 0;
    const view = {
      editable: true,
      focus: vi.fn(),
      get state() {
        return state;
      },
      dispatch: (transaction: Transaction) => {
        mocks.dispatch(transaction);
        const wasSelected = selectsBlock(state.selection);
        state = state.apply(transaction);
        // The real view calls selectNode/deselectNode synchronously while it
        // applies a selection change; the node view relies on that ordering.
        const isSelected = selectsBlock(state.selection);
        if (isSelected && !wasSelected) nodeView?.selectNode?.();
        if (!isSelected && wasSelected) nodeView?.deselectNode?.();
      },
    } as unknown as EditorView;
    nodeView = createScientCodeBlockNodeView(
      node,
      view,
      () => 0,
      resolveTheme,
      registerExternalPresentation,
    );
    document.body.append(nodeView.dom!);
    return { nodeView, state: () => state };
  }
  it("does not activate or steal focus after deselection during the lazy import", async () => {
    const { nodeView } = fixture();
    nodeView.selectNode!();
    nodeView.deselectNode!();
    await vi.dynamicImportSettled();
    expect(mocks.create).not.toHaveBeenCalled();
    nodeView.destroy!();
  });
  it("keeps rendered code visible until the lazy editor is ready, then swaps once", async () => {
    const { nodeView } = fixture();
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
    const { nodeView } = fixture();
    nodeView.selectNode!();
    nodeView.deselectNode!();
    nodeView.selectNode!();
    await vi.dynamicImportSettled();
    expect(mocks.create).toHaveBeenCalledOnce();
    nodeView.destroy!();
    expect(mocks.create.mock.results[0]?.value.destroy).toHaveBeenCalledOnce();
  });
  it("does not create an editor after destruction", async () => {
    const { nodeView } = fixture();
    nodeView.selectNode!();
    nodeView.destroy!();
    await vi.dynamicImportSettled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refreshes syntax appearance through the shared presentation channel", async () => {
    let theme: "light" | "dark" = "light";
    let refresh: ScientMarkdownExternalPresentationRefresh | undefined;
    const unregister = vi.fn();
    const { nodeView } = fixture(
      () => theme,
      (registeredRefresh) => {
        refresh = registeredRefresh;
        return unregister;
      },
    );
    const rendered = (nodeView.dom as HTMLElement).querySelector<HTMLElement>(
      ".scient-markdown-code-render",
    )!;

    await vi.waitFor(() => expect(rendered.querySelector("[data-code-theme]")).not.toBeNull());
    const lightTheme = rendered.querySelector("[data-code-theme]")?.getAttribute("data-code-theme");
    refresh?.("workspace");
    expect(rendered.querySelector("[data-code-theme]")?.getAttribute("data-code-theme")).toBe(
      lightTheme,
    );

    theme = "dark";
    refresh?.("appearance");
    await vi.waitFor(() =>
      expect(rendered.querySelector("[data-code-theme]")?.getAttribute("data-code-theme")).not.toBe(
        lightTheme,
      ),
    );

    nodeView.destroy!();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("defers syntax highlighting while CodeMirror owns the selected code", async () => {
    const { nodeView } = fixture();
    await vi.waitFor(() => expect(syntaxMocks.codeToHtml).toHaveBeenCalledOnce());
    syntaxMocks.codeToHtml.mockClear();
    syntaxMocks.getSyntaxHighlighterPromise.mockClear();

    nodeView.selectNode?.();
    const updatedNode = scientMarkdownSchema.nodes.code_block!.create(
      { params: "text" },
      scientMarkdownSchema.text("latest code"),
    );
    expect(nodeView.update?.(updatedNode, [], DecorationSet.empty)).toBe(true);
    await Promise.resolve();
    expect(syntaxMocks.getSyntaxHighlighterPromise).not.toHaveBeenCalled();
    expect(syntaxMocks.codeToHtml).not.toHaveBeenCalled();

    nodeView.deselectNode?.();
    await vi.waitFor(() =>
      expect(syntaxMocks.codeToHtml).toHaveBeenCalledWith(
        "latest code",
        expect.objectContaining({ lang: "text" }),
      ),
    );
    nodeView.destroy?.();
  });

  it("keeps code readable after activation fails and retries without changing the source", async () => {
    const { nodeView } = fixture();
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
    const { nodeView } = fixture();
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

  it("lets a rich visual own pointer, wheel, and double-click interaction", () => {
    const { nodeView, state } = fixture(undefined, undefined, "plotly");
    const rendered = (nodeView.dom as HTMLElement).querySelector<HTMLElement>(
      ".scient-markdown-code-render",
    )!;
    const originalSelection = state().selection;

    for (const event of [
      new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
      new Event("pointerdown", { bubbles: true, cancelable: true }),
      new MouseEvent("mousemove", { bubbles: true, cancelable: true }),
      new MouseEvent("dblclick", { bubbles: true, button: 0, cancelable: true }),
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 12 }),
    ]) {
      rendered.dispatchEvent(event);
      expect(nodeView.stopEvent?.(event)).toBe(true);
    }

    expect(state().selection.eq(originalSelection)).toBe(true);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    nodeView.destroy!();
  });

  it("opens ordinary code at the exact first-click coordinates", async () => {
    const editor = {
      focus: vi.fn(),
      focusAt: vi.fn(),
      destroy: vi.fn(),
      replaceExternalCode: vi.fn(),
    };
    mocks.create.mockReturnValue(editor);
    const { nodeView, state } = fixture();
    const rendered = (nodeView.dom as HTMLElement).querySelector<HTMLElement>(
      ".scient-markdown-code-render",
    )!;
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 32,
      clientY: 48,
    });

    rendered.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(0);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    await vi.dynamicImportSettled();
    expect(editor.focusAt).toHaveBeenCalledExactlyOnceWith({
      x: 32,
      y: 48,
    });
    expect(editor.focus).not.toHaveBeenCalled();
    nodeView.destroy!();
  });

  it("opens from a header click without steering the caret", async () => {
    const editor = {
      focus: vi.fn(),
      focusAt: vi.fn(),
      destroy: vi.fn(),
      replaceExternalCode: vi.fn(),
    };
    mocks.create.mockReturnValue(editor);
    const { nodeView, state } = fixture();
    const header = (nodeView.dom as HTMLElement).querySelector<HTMLElement>(
      ".scient-markdown-code-header",
    )!;

    header.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true, clientX: 8 }),
    );
    expect(state().selection).toBeInstanceOf(NodeSelection);
    await vi.dynamicImportSettled();
    expect(editor.focus).toHaveBeenCalledOnce();
    expect(editor.focusAt).not.toHaveBeenCalled();

    // The editor is open and focused; a header click must not move its caret.
    header.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true, clientX: 8 }),
    );
    await vi.dynamicImportSettled();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(editor.focusAt).not.toHaveBeenCalled();
    expect(editor.focus).toHaveBeenCalledTimes(2);
    nodeView.destroy!();
  });

  it("retries a failed editor from a click on the still-selected code", async () => {
    const { nodeView } = fixture();
    const dom = nodeView.dom as HTMLElement;
    const rendered = dom.querySelector<HTMLElement>(".scient-markdown-code-render")!;
    mocks.create.mockImplementationOnce(() => {
      throw new Error("Editor initialization failed");
    });
    try {
      nodeView.selectNode!();
      await vi.dynamicImportSettled();
      expect(dom.querySelector<HTMLElement>(".scient-markdown-code-load-error")?.hidden).toBe(
        false,
      );

      rendered.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      );
      // Already the selection: nothing to dispatch, so the click itself must retry.
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await vi.dynamicImportSettled();
      expect(mocks.create).toHaveBeenCalledTimes(2);
      expect(mocks.create.mock.results[1]?.value.focusAt).toHaveBeenCalledExactlyOnceWith({
        x: 20,
        y: 30,
      });
      expect(dom.querySelector<HTMLElement>(".scient-markdown-code-load-error")?.hidden).toBe(true);
      expect(dom.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(false);
    } finally {
      nodeView.destroy!();
    }
  });

  it("opens rich-fence source only through its explicit authoring action", async () => {
    const { nodeView, state } = fixture(undefined, undefined, "mermaid");
    const dom = nodeView.dom as HTMLElement;
    const edit = await vi.waitFor(() => {
      const button = dom.querySelector<HTMLButtonElement>("[data-edit-rich-source]");
      expect(button).not.toBeNull();
      return button!;
    });

    nodeView.selectNode!();
    await vi.dynamicImportSettled();
    expect(mocks.create).not.toHaveBeenCalled();

    edit.click();
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(0);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.dispatch.mock.calls[0]?.[0].getMeta("addToHistory")).toBe(false);

    await vi.dynamicImportSettled();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-render")?.hidden).toBe(false);
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(false);

    edit.click();
    await vi.dynamicImportSettled();
    expect(mocks.create).toHaveBeenCalledOnce();
    nodeView.destroy!();
  });
});
