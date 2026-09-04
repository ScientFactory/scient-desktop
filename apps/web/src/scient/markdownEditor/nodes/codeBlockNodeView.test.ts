// @vitest-environment happy-dom
import { EditorState, NodeSelection, type Selection, type Transaction } from "prosemirror-state";
import { DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scientMarkdownSchema } from "../prosemirror/schema";
import {
  createScientCodeBlockNodeView,
  type ScientMarkdownCodeEditorRegistrar,
} from "./codeBlockNodeView";
import { createScientNestedCodeEditor } from "./codeMirrorCodeEditor";
import type {
  ScientMarkdownExternalPresentationRefresh,
  ScientMarkdownExternalPresentationRegistrar,
  ScientMarkdownThemeResolver,
} from "./externalPresentation";

const mocks = {
  create: vi.mocked(createScientNestedCodeEditor),
  dispatch: vi.fn(),
};

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

describe("persistent nested code editor", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockImplementation((input) => {
      const content = document.createElement("div");
      content.className = "cm-content";
      input.parent.append(content);
      return {
        destroy: vi.fn(),
        focus: vi.fn(),
        refreshAppearance: vi.fn(),
        replaceExternalCode: vi.fn(),
        setEditable: vi.fn(),
      };
    });
  });

  afterEach(() => {
    mocks.create.mockReset();
    mocks.dispatch.mockClear();
    document.body.replaceChildren();
  });

  function fixture(
    input: {
      readonly editable?: boolean;
      readonly params?: string;
      readonly registerCodeEditor?: ScientMarkdownCodeEditorRegistrar;
      readonly registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar;
      readonly resolveTheme?: ScientMarkdownThemeResolver;
    } = {},
  ) {
    const node = scientMarkdownSchema.nodes.code_block!.create(
      { params: input.params ?? "text" },
      scientMarkdownSchema.text("code"),
    );
    const doc = scientMarkdownSchema.topNodeType.create(null, [node]);
    let state = EditorState.create({ doc });
    let nodeView: NodeView | undefined;
    const selectsBlock = (selection: Selection) =>
      selection instanceof NodeSelection && selection.from === 0;
    const view = {
      editable: input.editable ?? true,
      focus: vi.fn(),
      get state() {
        return state;
      },
      dispatch: (transaction: Transaction) => {
        mocks.dispatch(transaction);
        const wasSelected = selectsBlock(state.selection);
        state = state.apply(transaction);
        const isSelected = selectsBlock(state.selection);
        if (isSelected && !wasSelected) nodeView?.selectNode?.();
        if (!isSelected && wasSelected) nodeView?.deselectNode?.();
      },
    } as unknown as EditorView;
    nodeView = createScientCodeBlockNodeView(
      node,
      view,
      () => 0,
      input.resolveTheme,
      input.registerExternalPresentation,
      undefined,
      input.registerCodeEditor,
    );
    document.body.append(nodeView.dom!);
    return { nodeView, state: () => state, view };
  }

  it("uses the same ordinary-code surface before, during, and after selection", () => {
    const { nodeView } = fixture();
    const dom = nodeView.dom as HTMLElement;
    const rendered = dom.querySelector<HTMLElement>(".scient-markdown-code-render")!;
    const editorHost = dom.querySelector<HTMLElement>(".scient-markdown-code-editor")!;
    const editorContent = editorHost.querySelector(".cm-content");

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(dom.dir).toBe("ltr");
    expect(rendered.hidden).toBe(true);
    expect(editorHost.hidden).toBe(false);
    expect(editorContent).not.toBeNull();

    nodeView.selectNode?.();
    nodeView.deselectNode?.();
    nodeView.selectNode?.();

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(rendered.hidden).toBe(true);
    expect(editorHost.hidden).toBe(false);
    expect(editorHost.querySelector(".cm-content")).toBe(editorContent);
    nodeView.destroy?.();
  });

  it("registers one persistent editor for mode ownership and unregisters it on destroy", () => {
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const { nodeView } = fixture({ registerCodeEditor: register });
    const editor = mocks.create.mock.results[0]!.value;

    expect(register).toHaveBeenCalledExactlyOnceWith(editor);
    nodeView.destroy?.();
    expect(unregister).toHaveBeenCalledOnce();
    expect(editor.destroy).toHaveBeenCalledOnce();
  });

  it("updates code and language without replacing the persistent editor", () => {
    const { nodeView } = fixture({ params: "javascript" });
    const editor = mocks.create.mock.results[0]!.value;
    const editorHost = (nodeView.dom as HTMLElement).querySelector<HTMLElement>(
      ".scient-markdown-code-editor",
    )!;
    const editorContent = editorHost.querySelector(".cm-content");
    const updatedNode = scientMarkdownSchema.nodes.code_block!.create(
      { params: "typescript strict" },
      scientMarkdownSchema.text("const ready: boolean = true;"),
    );

    expect(nodeView.update?.(updatedNode, [], DecorationSet.empty)).toBe(true);

    expect(editor.replaceExternalCode).toHaveBeenLastCalledWith(
      "const ready: boolean = true;",
      "typescript",
    );
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(editorHost.querySelector(".cm-content")).toBe(editorContent);
    nodeView.destroy?.();
  });

  it("keeps plain code readable after initialization fails and retries in place", () => {
    const editor = {
      destroy: vi.fn(),
      focus: vi.fn(),
      refreshAppearance: vi.fn(),
      replaceExternalCode: vi.fn(),
      setEditable: vi.fn(),
    };
    mocks.create.mockImplementationOnce(() => {
      throw new Error("Editor initialization failed");
    });
    mocks.create.mockImplementationOnce((input) => {
      const content = document.createElement("div");
      content.className = "cm-content";
      input.parent.append(content);
      return editor;
    });
    const { nodeView } = fixture();
    const dom = nodeView.dom as HTMLElement;
    const rendered = dom.querySelector<HTMLElement>(".scient-markdown-code-render")!;
    const editorHost = dom.querySelector<HTMLElement>(".scient-markdown-code-editor")!;
    const notice = dom.querySelector<HTMLElement>(".scient-markdown-code-load-error")!;

    expect(notice.hidden).toBe(false);
    expect(rendered.hidden).toBe(false);
    expect(rendered.textContent).toBe("code");
    expect(editorHost.hidden).toBe(true);

    notice.querySelector<HTMLButtonElement>("button")!.click();

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(notice.hidden).toBe(true);
    expect(rendered.hidden).toBe(true);
    expect(editorHost.hidden).toBe(false);
    expect(editor.focus).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    nodeView.destroy?.();
  });

  it("refreshes only a rich visual through the shared appearance channel", async () => {
    let theme: "light" | "dark" = "light";
    let refresh: ScientMarkdownExternalPresentationRefresh | undefined;
    const resolveTheme = vi.fn(() => theme);
    const unregister = vi.fn();
    const { nodeView } = fixture({
      params: "plotly",
      resolveTheme,
      registerExternalPresentation: (registeredRefresh) => {
        refresh = registeredRefresh;
        return unregister;
      },
    });

    await vi.waitFor(() =>
      expect((nodeView.dom as HTMLElement).querySelector("[data-edit-rich-source]")).not.toBeNull(),
    );
    expect(resolveTheme).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();

    refresh?.("workspace");
    expect(resolveTheme).toHaveBeenCalledOnce();
    theme = "dark";
    refresh?.("appearance");
    expect(resolveTheme).toHaveBeenCalledTimes(2);

    nodeView.destroy?.();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("lets a rich visual own pointer, wheel, and double-click interaction", () => {
    const { nodeView, state } = fixture({ params: "plotly" });
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
    nodeView.destroy?.();
  });

  it("lets CodeMirror place the first-click caret without a swap or scroll request", () => {
    const { nodeView, state } = fixture();
    const dom = nodeView.dom as HTMLElement;
    const editorHost = dom.querySelector<HTMLElement>(".scient-markdown-code-editor")!;
    const editorContent = editorHost.querySelector<HTMLElement>(".cm-content")!;
    const editor = mocks.create.mock.results[0]!.value;
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 32,
      clientY: 48,
    });

    editorContent.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(0);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(editor.focus).not.toHaveBeenCalled();
    expect(editorHost.hidden).toBe(false);
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-render")?.hidden).toBe(true);
    nodeView.destroy?.();
  });

  it("focuses the existing editor from the header without replacing it", () => {
    const { nodeView, state } = fixture();
    const dom = nodeView.dom as HTMLElement;
    const header = dom.querySelector<HTMLElement>(".scient-markdown-code-header")!;
    const editorHost = dom.querySelector<HTMLElement>(".scient-markdown-code-editor")!;
    const editorContent = editorHost.querySelector(".cm-content");
    const editor = mocks.create.mock.results[0]!.value;

    header.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
    );
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(editor.focus).toHaveBeenCalledOnce();

    header.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
    );
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(editor.focus).toHaveBeenCalledTimes(2);
    expect(editorHost.querySelector(".cm-content")).toBe(editorContent);
    expect(mocks.create).toHaveBeenCalledOnce();
    nodeView.destroy?.();
  });

  it("keeps ordinary code visible but non-activating in read mode", () => {
    const { nodeView } = fixture({ editable: false });
    const dom = nodeView.dom as HTMLElement;
    const header = dom.querySelector<HTMLElement>(".scient-markdown-code-header")!;
    const editorHost = dom.querySelector<HTMLElement>(".scient-markdown-code-editor")!;
    const editor = mocks.create.mock.results[0]!.value;

    header.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
    );

    expect(editorHost.hidden).toBe(false);
    expect(editor.focus).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    nodeView.destroy?.();
  });

  it("recovers a failed ordinary editor as read-only without selecting or focusing it", () => {
    const editor = {
      destroy: vi.fn(),
      focus: vi.fn(),
      refreshAppearance: vi.fn(),
      replaceExternalCode: vi.fn(),
      setEditable: vi.fn(),
    };
    mocks.create.mockImplementationOnce(() => {
      throw new Error("Editor initialization failed");
    });
    mocks.create.mockImplementationOnce((input) => {
      input.parent.append(document.createElement("div"));
      return editor;
    });
    const { nodeView } = fixture({ editable: false });
    const dom = nodeView.dom as HTMLElement;
    const notice = dom.querySelector<HTMLElement>(".scient-markdown-code-load-error")!;

    notice.querySelector<HTMLButtonElement>("button")!.click();

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(notice.hidden).toBe(true);
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-render")?.hidden).toBe(true);
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(false);
    expect(editor.focus).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    nodeView.destroy?.();
  });

  it("opens chart source only through its explicit authoring action", async () => {
    const { nodeView, state } = fixture({ params: "plotly" });
    const dom = nodeView.dom as HTMLElement;
    const edit = await vi.waitFor(() => {
      const button = dom.querySelector<HTMLButtonElement>("[data-edit-rich-source]");
      expect(button).not.toBeNull();
      return button!;
    });

    nodeView.selectNode?.();
    expect(mocks.create).not.toHaveBeenCalled();

    edit.click();
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(0);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-render")?.hidden).toBe(false);
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(false);

    const editorContent = dom.querySelector(".scient-markdown-code-editor .cm-content");
    nodeView.deselectNode?.();
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-render")?.hidden).toBe(false);
    expect(dom.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(true);

    nodeView.selectNode?.();
    edit.click();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(dom.querySelector(".scient-markdown-code-editor .cm-content")).toBe(editorContent);
    nodeView.destroy?.();
  });
});
