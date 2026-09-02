// @vitest-environment happy-dom
import { EditorState, NodeSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scientMarkdownSchema } from "../prosemirror/schema";
import { createScientCodeBlockNodeView } from "./codeBlockNodeView";
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
  getSyntaxHighlighterPromise: async () => ({
    codeToHtml: (_code: string, options: { readonly theme: string }) =>
      `<span data-code-theme="${options.theme}">code</span>`,
  }),
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
    const view = {
      editable: true,
      focus: vi.fn(),
      get state() {
        return state;
      },
      dispatch: (transaction: Transaction) => {
        mocks.dispatch(transaction);
        state = state.apply(transaction);
      },
    } as unknown as EditorView;
    const nodeView = createScientCodeBlockNodeView(
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

  it("retains primary-click source activation for an ordinary code block", () => {
    const { nodeView, state } = fixture();
    const rendered = (nodeView.dom as HTMLElement).querySelector<HTMLElement>(
      ".scient-markdown-code-render",
    )!;
    const event = new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true });

    rendered.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(0);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    nodeView.destroy!();
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
