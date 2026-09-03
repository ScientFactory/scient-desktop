// @vitest-environment happy-dom

import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { EditorView } from "prosemirror-view";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScientImageControlsProps } from "~/scient/images/ScientImageControls";
import { scientMarkdownParser, scientMarkdownSchema } from "../prosemirror/schema";
import {
  createScientImageNodeView,
  type ScientMarkdownImageNodeViewOptions,
  type ScientMarkdownImageNodeViewRegistration,
} from "./imageNodeView";

const controls = vi.hoisted(() => new Map<HTMLElement, ScientImageControlsProps>());
vi.mock("~/scient/images/ScientImageControls", () => ({
  SCIENT_IMAGE_CAPTION_CLASS_NAME: "shared-caption",
  ScientImageControls: (props: ScientImageControlsProps) => {
    if (props.anchor) controls.set(props.anchor, props);
    return null;
  },
}));

const mounted: EditorView[] = [];
afterEach(async () => {
  await act(() => {
    mounted.splice(0).forEach((view) => view.destroy());
  });
  controls.clear();
  document.body.replaceChildren();
});

async function fixture(
  input: {
    source?: string;
    resolve?: (source: string) => string | null | Promise<string | null>;
    options?: ScientMarkdownImageNodeViewOptions;
  } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
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
            input.resolve ?? ((source) => `https://assets.test/${source}`),
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
  mounted.push(view!);
  const registration = [...registrations][0]!;
  const image = registration.element.querySelector<HTMLImageElement>("img")!;
  const caption = registration.element.querySelector<HTMLTextAreaElement>("textarea")!;
  const action = (id: string) =>
    controls.get(registration.element)!.actions.find((item) => item.id === id)!;
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

function decodeState(image: HTMLImageElement, width: number, complete = true) {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    complete: { configurable: true, value: complete },
  });
}

describe("Markdown image NodeView", () => {
  it("does not publish a no-op details Apply for intentionally empty alt", async () => {
    const { view, registration, changed, image } = await fixture({ source: "![](image.png)" });
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
    const { view, caption, registration, changed } = await fixture();
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
    const { view, caption, changed } = await fixture();
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
    const { view, caption, action, changed, registration } = await fixture({
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
    const { registration, caption } = await fixture({ source });
    expect(registration.element.dataset.standalone).toBe(String(standalone));
    expect(caption.hidden).toBe(true);
    expect(controls.get(registration.element)?.standalone).toBe(standalone);
  });

  it("separates URL resolution, actual decoding, retry, and stale resolution", async () => {
    let finishOld!: (value: string) => void;
    const resolve = vi.fn((source: string) =>
      source === "image.png"
        ? new Promise<string>((resolveOld) => {
            finishOld = resolveOld;
          })
        : Promise.resolve("https://assets.test/new.png"),
    );
    const { view, image, registration, changed } = await fixture({ resolve });
    expect(registration.element.dataset.imageState).toBe("resolving");
    await act(() => view.dispatch(view.state.tr.setNodeAttribute(1, "src", "new.png")));
    expect(registration.element.dataset.imageState).toBe("loading");
    expect(image.hidden).toBe(true);
    await act(() => finishOld("https://assets.test/old.png"));
    expect(image.src).toBe("https://assets.test/new.png");
    decodeState(image, 0, false);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(registration.element.dataset.imageState).toBe("loading");
    decodeState(image, 0);
    await act(() => image.dispatchEvent(new Event("error")));
    expect(registration.element.dataset.imageState).toBe("failed");
    await act(() => controls.get(registration.element)!.onRetry?.());
    decodeState(image, 100);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(image.hidden).toBe(false);
    expect(registration.element.dataset.imageState).toBe("loaded");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("resolves expanded viewing independently without changing the inline image or document", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce("https://assets.test/inline-token")
      .mockResolvedValueOnce("https://assets.test/fresh-viewer-token");
    const { image, registration, changed } = await fixture({ resolve });
    const result = await controls.get(registration.element)!.resolveViewerSource!();
    expect(result).toBe("https://assets.test/fresh-viewer-token");
    expect(image.src).toBe("https://assets.test/inline-token");
    expect(resolve.mock.calls.map(([source]) => source)).toEqual(["image.png", "image.png"]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps the old image while replacement uploads and follows movement before completing", async () => {
    let complete!: (image: { src: string; alt: string }) => void;
    const uploadImage = vi.fn(
      () =>
        new Promise<{ src: string; alt: string }>((resolve) => {
          complete = resolve;
        }),
    );
    const { view, pickFile, changed } = await fixture({ options: { uploadImage } });
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
      let complete!: (image: { src: string; alt: string }) => void;
      const onImageError = vi.fn();
      const { view, pickFile, registration } = await fixture({
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
    const completions: Array<(image: { src: string; alt: string }) => void> = [];
    const { view, pickFile, action } = await fixture({
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
