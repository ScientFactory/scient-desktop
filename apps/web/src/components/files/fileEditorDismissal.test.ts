// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { installFileEditorDismissal } from "./fileEditorDismissal";

describe("file editor dismissal", () => {
  const dispose: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of dispose.splice(0)) cleanup();
  });

  function setup(initiallyAttached = true) {
    const root = document.createElement("div");
    const file = document.createElement("diffs-container");
    const content = document.createElement("div");
    content.tabIndex = 0;
    content.setAttribute("data-content", "");
    file.attachShadow({ mode: "open" }).append(content);
    root.append(file);
    document.body.append(root);
    let attached = initiallyAttached;
    const editor = {
      getFile: vi.fn(() => (attached ? { contents: "A" } : undefined)),
      setSelections: vi.fn(() => {
        if (!attached) throw new Error("Text document is not initialized");
      }),
    };
    const onDismiss = vi.fn();
    const isBlocked = vi.fn(() => false);
    const removeListeners = installFileEditorDismissal({ root, editor, onDismiss, isBlocked });
    dispose.push(removeListeners, () => root.remove());
    return {
      root,
      content,
      editor,
      onDismiss,
      isBlocked,
      removeListeners,
      detach: () => {
        attached = false;
      },
    };
  }

  function clickOutside() {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  }

  it("clears an attached editor selection and blurs on outside pointerdown", () => {
    const { content, editor, onDismiss } = setup();
    const blur = vi.spyOn(content, "blur");
    content.focus();
    clickOutside();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(editor.setSelections).toHaveBeenCalledWith([]);
    expect(blur).toHaveBeenCalledOnce();
  });

  it("does not mutate selections before an editor has attached", () => {
    const { editor, onDismiss } = setup(false);
    clickOutside();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(editor.setSelections).not.toHaveBeenCalled();
  });

  it("checks attachment after the dismissal callback, which can detach the editor", () => {
    const { editor, onDismiss, detach } = setup();
    onDismiss.mockImplementation(detach);
    clickOutside();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(editor.setSelections).not.toHaveBeenCalled();
  });

  it("preserves blocked, inside-click and cleanup behavior", () => {
    const { root, editor, onDismiss, isBlocked, removeListeners } = setup();
    root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    isBlocked.mockReturnValue(true);
    clickOutside();
    isBlocked.mockReturnValue(false);
    removeListeners();
    clickOutside();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(editor.setSelections).not.toHaveBeenCalled();
  });

  it("dismisses a focused editor on Escape without affecting unrelated keys", () => {
    const { content, editor, onDismiss } = setup();
    content.focus();
    content.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true }),
    );
    expect(onDismiss).not.toHaveBeenCalled();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    content.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(editor.setSelections).toHaveBeenCalledWith([]);
  });
});
