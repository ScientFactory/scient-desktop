import { act } from "../../../../test/render";

import { Fragment, Slice } from "prosemirror-model";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScientMarkdownEditorView } from "./view";

async function _setupFixture0(_fixture: _Fixture) {
  await undefined;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(() => _fixture.editors.splice(0).forEach((editor) => editor.destroy()));
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

async function fixture(_fixture: _Fixture, source: string, side: "before" | "after" = "after") {
  const onUserSourceChange = vi.fn();
  const editor = new ScientMarkdownEditorView({
    source,
    revision: "r0",
    mode: "write",
    ariaLabel: "Image boundaries",
    onUserSourceChange,
  });
  _fixture.editors.push(editor);
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  await act(() => {
    editor.mount(host);
  });
  const view = editor.view!;
  let imagePosition = 0;
  view.state.doc.descendants((node, position) => {
    if (node.type.name === "image") imagePosition = position;
  });
  await act(() =>
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, imagePosition + (side === "after" ? 1 : 0)),
      ),
    ),
  );
  return { editor, view, onUserSourceChange };
}

describe("standalone image editing boundaries", () => {
  it.each(["Backspace", "Delete"])(
    "selects the adjacent figure instead of merging paragraphs with %s",
    async (key) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const figure = '![Plot](plot.png "Caption")';
      const source = key === "Backspace" ? `${figure}\n\nText\n` : `Text\n\n${figure}\n`;
      const { editor, view, onUserSourceChange } = await fixture(_fixture, source);
      const at = key === "Backspace" ? view.state.doc.firstChild!.nodeSize + 1 : 5;
      await act(() => {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
        view.dom.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
      expect(view.state.selection).toBeInstanceOf(NodeSelection);
      expect(editor.session.session.draftSource).toBe(source);
      expect(onUserSourceChange).not.toHaveBeenCalled();
      await act(() =>
        view.dom.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
        ),
      );
      expect(view.dom.querySelector("[data-scient-markdown-image]")).toBeNull();
      await act(() => editor.execute("undo"));
      expect(editor.session.session.draftSource).toBe(source);
    },
  );

  it.each([
    ['![Plot](plot.png "Caption")\n', '![Plot](plot.png "Caption")\n\nHello\n'],
    ['- ![Plot](plot.png "Caption")\n', '- ![Plot](plot.png "Caption")\n\n  Hello\n'],
    ['> ![Plot](plot.png "Caption")\n', '> ![Plot](plot.png "Caption")\n>\n> Hello\n'],
    [
      '![Plot][fig]\n\n[fig]: plot.png "Caption"\n',
      '![Plot][fig]\n\nHello\n\n[fig]: plot.png "Caption"\n',
    ],
  ])(
    "keeps text below a figure and restores exact source on undo: %s",
    async (source, expected) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const { editor, view, onUserSourceChange } = await fixture(_fixture, source);
      expect(onUserSourceChange).not.toHaveBeenCalled();
      await act(() => view.dispatch(view.state.tr.insertText("Hello")));
      expect(editor.session.session.draftSource).toBe(expected);
      expect(view.dom.querySelector("[data-standalone='true']")).not.toBeNull();
      expect(
        view.dom.querySelector<HTMLTextAreaElement>("[aria-label='Image caption']")?.hidden,
      ).toBe(false);
      expect(onUserSourceChange).toHaveBeenCalledOnce();
      await act(() => editor.execute("undo"));
      expect(editor.session.session.draftSource).toBe(source);
      await act(() => editor.execute("redo"));
      expect(editor.session.session.draftSource).toBe(expected);
    },
  );

  it.each(["before", "after"] as const)(
    "routes native text input %s the image into its own paragraph",
    async (side) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const source = '![Plot](plot.png "Caption")\n';
      const { editor, view } = await fixture(_fixture, source, side);
      const at = view.state.selection.from;
      await act(() =>
        view.someProp("handleTextInput", (handler) =>
          handler(view, at, at, "Text", () => view.state.tr.insertText("Text")),
        ),
      );
      expect(editor.session.session.draftSource).toBe(
        side === "after" ? `${source}\nText\n` : `Text\n\n${source}`,
      );
      expect(view.state.selection.$from.parent.textContent).toBe("Text");
      await act(() => editor.execute("undo"));
      expect(editor.session.session.draftSource).toBe(source);
    },
  );

  it("pastes beside a figure without absorbing the image or losing its caption", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const source = '![Plot](plot.png "Caption")\n';
    const { editor, view } = await fixture(_fixture, source);
    await act(() =>
      view.someProp("handlePaste", (handler) =>
        handler(
          view,
          new ClipboardEvent("paste"),
          new Slice(Fragment.from(view.state.schema.text("Pasted")), 0, 0),
        ),
      ),
    );
    expect(editor.session.session.draftSource).toBe(`${source}\nPasted\n`);
    await act(() => editor.execute("undo"));
    expect(editor.session.session.draftSource).toBe(source);
  });

  it("prepares an empty paragraph for composition and undoes the composed insertion together", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const source = '![Plot](plot.png "Caption")\n';
    const { editor, view } = await fixture(_fixture, source);
    await act(() =>
      view.dom.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "כ",
        }),
      ),
    );
    expect(view.state.selection.$from.parent.content.size).toBe(0);
    await act(() => view.dispatch(view.state.tr.insertText("כיתוב").setMeta("composition", 1)));
    expect(editor.session.session.draftSource).toBe(`${source}\nכיתוב\n`);
    await act(() => editor.execute("undo"));
    expect(editor.session.session.draftSource).toBe(source);
  });

  it.each([false, true])("keeps Enter (shift=%s) outside the image paragraph", async (shiftKey) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { view } = await fixture(_fixture, "![Plot](plot.png)\n");
    await act(() =>
      view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true }),
      ),
    );
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).firstChild?.type.name).toBe("image");
    expect(view.state.selection.$from.parent.content.size).toBe(0);
  });

  it("preserves ordinary inline image editing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { editor, view } = await fixture(_fixture, "Before ![Plot](plot.png) after\n");
    await act(() => view.dispatch(view.state.tr.insertText("more")));
    expect(editor.session.session.draftSource).toBe("Before ![Plot](plot.png)more after\n");
  });

  it.each(["![Plot](plot.png)accidental text\n", "Before ![Plot](plot.png) after\n"])(
    "restores Add caption on an already mixed paragraph: %s",
    async (source) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const { editor, view } = await fixture(_fixture, source);
      const surroundingText = view.state.doc.textContent;
      await act(() =>
        view.dom.querySelector<HTMLButtonElement>("[aria-label='More image actions']")!.click(),
      );
      const addCaption = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
        (item) => item.textContent === "Add caption",
      );
      expect(addCaption).toBeDefined();
      await act(() => addCaption!.click());
      const caption = await vi.waitFor(() => {
        const caption = view.dom.querySelector<HTMLTextAreaElement>(
          "[aria-label='Image caption']",
        )!;
        expect(document.activeElement).toBe(caption);
        return caption;
      });
      expect(caption.hidden).toBe(false);
      expect(view.dom.querySelector("[data-standalone='true']")).not.toBeNull();
      expect(view.state.doc.textContent).toBe(surroundingText);
      await act(() => {
        caption.value = "A caption";
        caption.dispatchEvent(new InputEvent("input", { bubbles: true }));
        caption.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        view.dispatch(view.state.tr.insertText("Below"));
      });
      expect(view.dom.querySelector("[data-standalone='true']")).not.toBeNull();
      expect(editor.session.session.draftSource).toContain('![Plot](plot.png "A caption")');
      expect(view.state.selection.$from.parent.textContent).toBe("Below");
    },
  );
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    editors: [] as ScientMarkdownEditorView[],
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
