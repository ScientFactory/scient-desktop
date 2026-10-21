import { act } from "../../../../test/render";

import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { EditorView } from "prosemirror-view";

import { describe, expect, it, vi } from "vite-plus/test";

import { ScientImageControls } from "~/scient/images/ScientImageControls";
import { scientMarkdownParser, scientMarkdownSchema } from "../prosemirror/schema";
import {
  createScientImageNodeView,
  type ScientMarkdownImageNodeViewOptions,
  type ScientMarkdownImageNodeViewRegistration,
} from "./imageNodeView";

vi.mock("~/scient/images/ScientImageControls", { spy: true });

function controlsFor(anchor: HTMLElement) {
  const props = vi
    .mocked(ScientImageControls)
    .mock.calls.findLast(([props]) => props.anchor === anchor)?.[0];
  if (!props) throw new Error("Missing image controls");
  return props;
}

async function _cleanupFixture0(_fixture: _Fixture) {
  await act(() => {
    _fixture.mounted.splice(0).forEach((view) => view.destroy());
  });
  vi.mocked(ScientImageControls).mockClear();
  _clearOwnedDOM(_fixture);
}

async function fixture(
  _fixture: _Fixture,
  input: {
    source?: string;
    resolve?: (source: string) => string | null | Promise<string | null>;
    options?: ScientMarkdownImageNodeViewOptions;
  } = {},
) {
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  const registrations = new Set<ScientMarkdownImageNodeViewRegistration>();
  const changed = vi.fn();
  let view: EditorView;
  await act(() => {
    view = new EditorView(host, {
      state: EditorState.create({
        schema: scientMarkdownSchema,
        doc: scientMarkdownParser.parse(input.source ?? '![Alt](image.png "Caption")'),
        plugins: [history()],
      }),
      nodeViews: {
        image: (node, editorView, getPos) =>
          createScientImageNodeView(
            node,
            editorView,
            getPos,
            input.resolve ?? ((source) => nativeImageUrl(source)),
            undefined,
            {
              ...input.options,
              registerImage: (registration) => {
                registrations.add(registration);
                return () => registrations.delete(registration);
              },
            },
          ),
      },
      dispatchTransaction: (transaction) => {
        if (transaction.docChanged) changed(transaction);
        view.updateState(view.state.apply(transaction));
        registrations.forEach((entry) => entry.refreshContext());
      },
    });
  });
  _fixture.mounted.push(view!);
  const registration = [...registrations][0]!;
  const image = registration.element.querySelector<HTMLImageElement>("img")!;
  const caption = registration.element.querySelector<HTMLTextAreaElement>("textarea")!;
  const action = (id: string) =>
    controlsFor(registration.element).actions.find((item) => item.id === id)!;
  const pickFile = async () => {
    await act(() => action("replace-image").run());
    const picker = registration.element.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File(["image"], "new.png", { type: "image/png" })],
    });
    await act(() => picker.dispatchEvent(new Event("change", { bubbles: true })));
  };
  return { view: view!, image, caption, registration, changed, action, pickFile };
}

async function enterCaption(caption: HTMLTextAreaElement, value: string, inputType = "insertText") {
  await act(() => {
    caption.focus();
    caption.value = value;
    caption.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  });
}

function nativeImageUrl(source: string) {
  const url = new URL("/test/fixtures/assets/0001.png", window.location.href);
  url.hash = source;
  return url.href;
}

function decodeState(image: HTMLImageElement, width: number, complete = true) {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    complete: { configurable: true, value: complete },
  });
}

describe("Markdown image NodeView", () => {
  it.each(["Caption", ""])(
    "focuses the caption from one image click without publishing an edit: %s",
    async (title) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const { view, image, caption, registration, changed } = await fixture(_fixture, {
        source: title ? `![Alt](image.png "${title}")` : "![Alt](image.png)",
      });
      const before = view.state.doc;
      const clickImage = () =>
        image.dispatchEvent(
          new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
        );
      await act(clickImage);
      expect(document.activeElement).toBe(caption);
      expect(caption.hidden).toBe(false);
      expect(caption.selectionStart).toBe(title.length);
      expect(caption.selectionEnd).toBe(title.length);
      expect(view.state.selection).toBeInstanceOf(NodeSelection);
      expect(view.state.doc).toBe(before);
      expect(changed).not.toHaveBeenCalled();

      // Clicking the image again does not reset an existing caption caret.
      caption.setSelectionRange(0, 0);
      await act(clickImage);
      expect(caption.selectionStart).toBe(0);
      await act(() =>
        caption.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(document.activeElement).toBe(view.dom);
      expect(view.state.selection).toBeInstanceOf(TextSelection);
      expect(caption.hidden).toBe(title.length === 0);
      expect(registration.element.classList.contains("is-selected")).toBe(false);
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it("selects the image when its caption receives keyboard focus without replacing the field", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, caption, registration, changed } = await fixture(_fixture);
    await act(() => caption.focus());
    expect(document.activeElement).toBe(caption);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(registration.element.querySelector("textarea")).toBe(caption);
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([
    "Before ![Alt](image.png) after",
    "[![Alt](image.png)](https://example.test)",
    '![Alt][figure]\n\n[figure]: image.png "Shared caption"',
  ])(
    "keeps image clicks from changing inline, linked, or shared-reference content: %s",
    async (source) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const { view, image, caption, changed } = await fixture(_fixture, { source });
      const before = view.state.doc;
      await act(() =>
        image.dispatchEvent(
          new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
        ),
      );
      expect(document.activeElement).not.toBe(caption);
      expect(view.state.doc).toBe(before);
      expect(changed).not.toHaveBeenCalled();
      expect(document.querySelector("[data-slot='popover-popup']")).toBeNull();
    },
  );

  it("keeps read-only image clicks out of caption editing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, image, caption, registration, changed } = await fixture(_fixture);
    await act(() => {
      view.setProps({ editable: () => false });
      registration.setEditable(false);
      image.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).not.toBe(caption);
    expect(caption.readOnly).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not publish a no-op details Apply for intentionally empty alt", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, registration, changed, image } = await fixture(_fixture, {
      source: "![](image.png)",
    });
    const before = view.state.doc;
    await act(() => registration.editDetails());
    const form = document.querySelector<HTMLFormElement>("[data-slot='popover-popup'] form")!;
    expect(form).not.toBeNull();
    await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(changed).not.toHaveBeenCalled();
    expect(view.state.doc).toBe(before);
    expect(image.alt).toBe("");
  });

  it("keeps native caption focus and node selection during sequential text edits and empty exit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, caption, registration, changed } = await fixture(_fixture);
    await act(() =>
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1))),
    );
    const original = caption;
    for (const value of ["N", "Ne", "New"]) await enterCaption(caption, value);
    expect(caption).toBe(original);
    expect(document.activeElement).toBe(caption);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.state.doc.nodeAt(1)?.attrs.title).toBe("New");
    expect(changed).toHaveBeenCalledTimes(3);
    await enterCaption(caption, "", "deleteContentBackward");
    expect(caption.hidden).toBe(false);
    const emptyBackspace = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    caption.dispatchEvent(emptyBackspace);
    expect(emptyBackspace.defaultPrevented).toBe(false);
    expect(view.state.doc.nodeAt(1)?.type.name).toBe("image");
    await act(() =>
      caption.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(caption.hidden).toBe(true);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(registration.element.querySelector("textarea")).toBe(original);
  });

  it("publishes a completed composition once and keeps native Undo unclaimed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, caption, changed } = await fixture(_fixture);
    await act(() => {
      caption.focus();
      caption.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      caption.value = "תמונה";
      caption.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    });
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    caption.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await act(() => {
      caption.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      caption.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    expect(view.state.doc.nodeAt(1)?.attrs.title).toBe("תמונה");
    expect(changed).toHaveBeenCalledTimes(1);
    const nativeUndo = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    caption.dispatchEvent(nativeUndo);
    expect(nativeUndo.defaultPrevented).toBe(false);
    await enterCaption(caption, "Caption", "historyUndo");
    expect(view.state.doc.nodeAt(1)?.attrs.title).toBe("Caption");
    await act(() => undo(view.state, view.dispatch));
    expect(view.state.doc.nodeAt(1)?.attrs.title).toBe("תמונה");
  });

  it("does not create an empty caption until actual input and cancels stale authoring actions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, caption, action, changed, registration } = await fixture(_fixture, {
      source: "![Alt](image.png)",
    });
    const staleEdit = action("edit-caption");
    await act(() => staleEdit.run());
    expect(caption.hidden).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await act(() => registration.invalidateEditing());
    expect(caption.hidden).toBe(true);
    await act(() => staleEdit.run());
    expect(caption.hidden).toBe(true);
    expect(view.state.doc.nodeAt(1)?.attrs.title).toBeNull();
    await act(() => {
      view.setProps({ editable: () => false });
      registration.setEditable(false);
    });
    await enterCaption(caption, "must not save");
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([
    ["![Alt](image.png)", true],
    ["Before ![Alt](image.png) after", false],
    ["[![Alt](image.png)](https://example.test)", false],
    ["- ![Alt](image.png)", true],
    ["| Image |\n| --- |\n| ![Alt](image.png) |", false],
  ])("keeps the authored inline context: %s", async (source, standalone) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { registration, caption } = await fixture(_fixture, { source });
    expect(registration.element.dataset.standalone).toBe(String(standalone));
    expect(caption.hidden).toBe(true);
  });

  it("separates URL resolution, actual decoding, retry, and stale resolution", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    let finishOld!: (value: string) => void;
    let newRequests = 0;
    const resolve = vi.fn((source: string) =>
      source === "image.png"
        ? new Promise<string>((resolveOld) => {
            finishOld = resolveOld;
          })
        : Promise.resolve(
            ++newRequests === 1 ? nativeImageUrl("new.png") : nativeImageUrl("retry.png"),
          ),
    );
    const { view, image, registration, changed } = await fixture(_fixture, { resolve });
    expect(registration.element.dataset.imageState).toBe("resolving");
    using decodeProperties = {
      [Symbol.dispose]() {
        Reflect.deleteProperty(image, "naturalWidth");
        Reflect.deleteProperty(image, "complete");
      },
    };
    const holdNativeDelivery = (event: Event) => {
      if (event.isTrusted && event.target === image) event.stopImmediatePropagation();
    };
    registration.element.addEventListener("load", holdNativeDelivery, true);
    registration.element.addEventListener("error", holdNativeDelivery, true);
    using delivery = {
      [Symbol.dispose]() {
        registration.element.removeEventListener("load", holdNativeDelivery, true);
        registration.element.removeEventListener("error", holdNativeDelivery, true);
      },
    };
    // Resolution also checks complete synchronously, before any load listener runs.
    decodeState(image, 0, false);
    await act(() => view.dispatch(view.state.tr.setNodeAttribute(1, "src", "new.png")));
    expect(registration.element.dataset.imageState).toBe("loading");
    expect(image.hidden).toBe(true);
    await act(() => finishOld(nativeImageUrl("old.png")));
    expect(image.src).toBe(nativeImageUrl("new.png"));
    await act(() => image.dispatchEvent(new Event("load")));
    expect(registration.element.dataset.imageState).toBe("loading");
    decodeState(image, 0);
    await act(() => image.dispatchEvent(new Event("error")));
    expect(registration.element.dataset.imageState).toBe("failed");
    decodeProperties[Symbol.dispose]();
    delivery[Symbol.dispose]();
    await act(() => controlsFor(registration.element).onRetry?.());
    await image.decode();
    expect(image.naturalWidth).toBe(16);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(image.hidden).toBe(false);
    expect(registration.element.dataset.imageState).toBe("loaded");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("resolves expanded viewing independently without changing the inline image or document", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const resolve = vi
      .fn()
      .mockResolvedValueOnce(nativeImageUrl("inline-token"))
      .mockResolvedValueOnce(nativeImageUrl("fresh-viewer-token"));
    const { image, registration, changed } = await fixture(_fixture, { resolve });
    const result = await controlsFor(registration.element).resolveViewerSource!();
    expect(result).toBe(nativeImageUrl("fresh-viewer-token"));
    expect(image.src).toBe(nativeImageUrl("inline-token"));
    expect(resolve.mock.calls.map(([source]) => source)).toEqual(["image.png", "image.png"]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps the old image while replacement uploads and follows movement before completing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    let complete!: (image: { src: string; alt: string }) => void;
    const uploadImage = vi.fn(
      () =>
        new Promise<{ src: string; alt: string }>((resolve) => {
          complete = resolve;
        }),
    );
    const { view, pickFile, changed } = await fixture(_fixture, { options: { uploadImage } });
    await pickFile();
    expect(view.state.doc.nodeAt(1)?.attrs.src).toBe("image.png");
    expect(changed).not.toHaveBeenCalled();
    await act(() => view.dispatch(view.state.tr.insertText("Before ", 1)));
    await act(() => complete({ src: "uploaded.png", alt: "new file" }));
    expect(view.state.doc.nodeAt(8)?.attrs.src).toBe("uploaded.png");
    expect(view.state.doc.nodeAt(8)?.attrs.alt).toBe("Alt");
    expect(view.state.doc.nodeAt(8)?.attrs.title).toBe("Caption");
  });

  it.each(["changed", "deleted", "readonly", "invalidated"] as const)(
    "cancels a replacement whose target was %s",
    async (reason) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      let complete!: (image: { src: string; alt: string }) => void;
      const onImageError = vi.fn();
      const { view, pickFile, registration } = await fixture(_fixture, {
        options: {
          uploadImage: () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
          onImageError,
        },
      });
      await pickFile();
      await act(() => {
        if (reason === "changed")
          view.dispatch(view.state.tr.setNodeAttribute(1, "alt", "new target"));
        if (reason === "deleted") view.dispatch(view.state.tr.delete(1, 2));
        if (reason === "readonly") {
          view.setProps({ editable: () => false });
          registration.setEditable(false);
        }
        if (reason === "invalidated") registration.invalidateEditing();
      });
      const before = view.state.doc;
      await act(() => complete({ src: "must-not-apply.png", alt: "new" }));
      expect(view.state.doc).toBe(before);
      expect(onImageError).toHaveBeenCalledOnce();
    },
  );

  it("does not let an obsolete upload clear the busy state of a newer replacement", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const completions: Array<(image: { src: string; alt: string }) => void> = [];
    const { view, pickFile, action } = await fixture(_fixture, {
      options: {
        uploadImage: () => new Promise((resolve) => completions.push(resolve)),
        onImageError: vi.fn(),
      },
    });
    await pickFile();
    await act(() => view.dispatch(view.state.tr.setNodeAttribute(1, "alt", "Changed")));
    expect(action("replace-image").disabled).toBe(false);
    await pickFile();
    await act(() => completions[0]!({ src: "old-upload.png", alt: "old" }));
    expect(action("replace-image").disabled).toBe(true);
    expect(view.state.doc.nodeAt(1)?.attrs.src).toBe("image.png");
    await act(() => completions[1]!({ src: "new-upload.png", alt: "new" }));
    expect(view.state.doc.nodeAt(1)?.attrs.src).toBe("new-upload.png");
    expect(action("replace-image").disabled).toBe(false);
  });
});

function _createFixture() {
  vi.mocked(ScientImageControls).mockClear();
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    mounted: [] as EditorView[],
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
