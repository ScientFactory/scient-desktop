import { fakeTimers as _fixtureFakeTimers } from "../../../test/render";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vite-plus/test";
import { afterInputQuiet, InputPriority, inputQuietDelay } from "../writing/inputPriority";

async function _cleanupFixture0(_fixture: _Fixture) {
  _fixture.editor?.destroy();
  _fixture.editor = undefined;
  vi.useRealTimers();
}
const mount = (_fixture: _Fixture) => {
  _fixture.editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, InputPriority],
    content: "<p>Writing</p>",
  });
  return _fixture.editor.view.dom;
};

describe("editing priority over speculative rendering", () => {
  it("holds renderer-wide work during input in another editor and releases it on destroy", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));
    _fixture.stack.use(_fixtureFakeTimers());
    const visualRoot = mount(_fixture);
    const composer = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit, InputPriority],
      content: "<p>Chat</p>",
    });
    _fixture.cleanup.defer(() => {
      if (!composer.isDestroyed) composer.destroy();
    });
    const work = vi.fn();
    composer.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(inputQuietDelay(visualRoot)).toBe(0);
    afterInputQuiet(work);
    await vi.advanceTimersByTimeAsync(1000);
    expect(work).not.toHaveBeenCalled();
    composer.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(work).toHaveBeenCalledOnce();
    composer.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const afterDestroy = vi.fn();
    afterInputQuiet(afterDestroy);
    composer.destroy();
    await vi.advanceTimersByTimeAsync(200);
    expect(afterDestroy).toHaveBeenCalledOnce();
  });

  it("waits for nested input to become quiet and allows cancelled work to stay cancelled", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    _fixture.stack.use(_fixtureFakeTimers());
    const root = mount(_fixture);
    const nested = document.createElement("span");
    root.append(nested);
    nested.dispatchEvent(new Event("beforeinput", { bubbles: true }));
    const work = vi.fn();
    const cancelled = vi.fn();
    afterInputQuiet(work, root);
    afterInputQuiet(cancelled, root)();
    await vi.advanceTimersByTimeAsync(100);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(work).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });
  it("keeps composition and dragging ahead of background work until they end", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    _fixture.stack.use(_fixtureFakeTimers());
    const root = mount(_fixture);
    const work = vi.fn();
    root.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    afterInputQuiet(work, root);
    await vi.advanceTimersByTimeAsync(1000);
    expect(work).not.toHaveBeenCalled();
    root.dispatchEvent(new Event("compositionend", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(work).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("pointerup"));
    await vi.advanceTimersByTimeAsync(300);
    expect(work).toHaveBeenCalledOnce();
    _fixture.editor!.destroy();
    _fixture.editor = undefined;
    expect(inputQuietDelay()).toBe(0);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    editor: undefined! as Editor | undefined,
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
