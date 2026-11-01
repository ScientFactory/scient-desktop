import { render as _fixtureRender } from "../../../test/render";
import "../../index.css";

import { expect, it, vi } from "vite-plus/test";

import { SideChatCitationContext } from "~/scient/chat/sideChatCitation";
import { SelectionCitationToolbar } from "./AssistantSelectionToolbar";

it.each([
  { pointer: { x: 700, y: 350 }, expected: { x: 240, y: 224 } },
  { pointer: { x: 215, y: 215 }, expected: { x: 215, y: 215 } },
])("anchors model selection to ink bounds for pointer $pointer", async ({ pointer, expected }) => {
  await using _fixture = _createFixture();

  const viewport = document.createElement("div");
  viewport.style.cssText = "position:fixed;left:50px;top:50px;width:300px;height:400px";
  document.body.append(viewport);
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: viewport, router: false }),
  );
  const sourceAnchor = {
    source: viewport,
    viewport,
    range: document.createRange(),
    resolveRects: () => [new DOMRect(200, 200, 40, 20)],
  };
  const citation = { text: "Selected model source" };
  const onCite = vi.fn(() => true);
  const selectionReady = vi.fn();
  try {
    await root.rerender(
      <SelectionCitationToolbar
        viewport={viewport}
        capture={() => ({ citation, sourceAnchor })}
        onCite={onCite}
        preserveSelection
        subscribeSelection={() => {
          selectionReady();
          return () => {};
        }}
      />,
    );
    // The model has no DOM text range; its own ink bounds locate the selection.
    await expect.poll(() => selectionReady.mock.calls.length).toBe(1);
    viewport.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
    );
    viewport.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        clientX: pointer.x,
        clientY: pointer.y,
      }),
    );
    const action = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Ask in chat"]');
    const bar = () => action()?.closest<HTMLElement>('[role="group"]');
    await expect.poll(() => bar()?.style.left).toBe(`${expected.x}px`);
    expect(bar()!.style.top).toBe(`${expected.y}px`);
    action()!.click();
    expect(onCite).toHaveBeenCalledWith(citation, sourceAnchor, "chat");
  } finally {
    await root.unmount();
    viewport.remove();
  }
});

it("offers both chats when the conversation has side chats", async () => {
  await using _fixture = _createFixture();

  const viewport = document.createElement("div");
  viewport.style.cssText = "position:fixed;left:50px;top:50px;width:300px;height:400px";
  document.body.append(viewport);
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: viewport, router: false }),
  );
  const sourceAnchor = {
    source: viewport,
    viewport,
    range: document.createRange(),
    resolveRects: () => [new DOMRect(200, 200, 40, 20)],
  };
  const citation = { text: "Selected text" };
  const onCite = vi.fn(() => true);
  try {
    await root.rerender(
      <SideChatCitationContext value={() => undefined}>
        <SelectionCitationToolbar
          viewport={viewport}
          capture={() => ({ citation, sourceAnchor })}
          onCite={onCite}
        />
      </SideChatCitationContext>,
    );
    viewport.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
    );
    viewport.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    const action = (name: string) =>
      [...document.querySelectorAll("button")].find((button) => button.textContent === name);
    await expect.poll(() => action("Ask in side chat")).toBeDefined();
    expect(action("Ask in chat")).toBeDefined();
    action("Ask in side chat")!.click();
    expect(onCite).toHaveBeenCalledWith(citation, sourceAnchor, "side-chat");
  } finally {
    await root.unmount();
    viewport.remove();
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
