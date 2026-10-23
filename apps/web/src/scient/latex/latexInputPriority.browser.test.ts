import { fakeTimers as _fixtureFakeTimers } from "../../../test/render";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  afterLatexInputQuiet,
  LatexInputPriority,
  latexInputQuietDelay,
} from "./latexInputPriority";

async function _cleanupFixture0(_fixture: _Fixture) {
  _fixture.editor?.destroy();
  _fixture.editor = undefined;
  vi.useRealTimers();
}
const mount = (_fixture: _Fixture) => {
  _fixture.editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, LatexInputPriority],
    content: "<p>Writing</p>",
  });
  return _fixture.editor.view.dom;
};

describe("editing priority over speculative rendering", () => {
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
    afterLatexInputQuiet(work, root);
    afterLatexInputQuiet(cancelled, root)();
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
    afterLatexInputQuiet(work, root);
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
    expect(latexInputQuietDelay()).toBe(0);
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
