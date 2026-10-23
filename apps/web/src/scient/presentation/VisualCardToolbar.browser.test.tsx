import "../../index.css";
import { userEvent } from "vitest/browser";
import { TooltipProvider } from "~/components/ui/tooltip";

import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { VisualCardToolbar } from "./VisualCardToolbar";

async function _cleanupFixture1(_fixture: _Fixture) {
  if (_fixture.root0) await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = null;
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

describe("visual-card toolbar", () => {
  it("suppresses the movement tooltip only while pointer dragging", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));

    const card = document.createElement("div");
    card.dataset.scientVisualCard = "true";
    card.style.cssText = "position:relative;width:800px;height:400px";
    const container = document.createElement("div");
    card.append(container);
    document.body.append(_ownDOM(_fixture, card));
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: container, router: false }),
    );
    await act(
      async () =>
        await _fixture.root0?.rerender(
          <TooltipProvider delay={0}>
            <VisualCardToolbar label="Figure actions" appearance="command-group" movement="direct">
              <span>Action</span>
            </VisualCardToolbar>
          </TooltipProvider>,
        ),
    );

    const toolbar = container.querySelector<HTMLElement>("[aria-label='Figure actions']")!;
    const handle = toolbar.querySelector<HTMLButtonElement>("[data-scient-toolbar-move]")!;
    const visibleTooltip = () =>
      [...document.querySelectorAll<HTMLElement>('[data-slot="tooltip-popup"]')].find((node) =>
        node.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      );
    const captured = new Set<number>();
    handle.setPointerCapture = vi.fn((pointerId: number) => captured.add(pointerId));
    handle.hasPointerCapture = vi.fn((pointerId: number) => captured.has(pointerId));
    handle.releasePointerCapture = vi.fn((pointerId: number) => captured.delete(pointerId));
    const pointer = (type: string) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 20,
          clientY: 20,
          isPrimary: true,
          pointerId: 7,
        }),
      );

    await userEvent.hover(handle);
    await expect.poll(visibleTooltip).toBeDefined();
    expect(visibleTooltip()?.textContent).toBe("Drag to move");
    await act(() => pointer("pointerdown"));
    await expect.poll(visibleTooltip).toBeUndefined();
    await act(() => pointer("pointerup"));
    await userEvent.unhover(handle);
    await userEvent.hover(handle);
    await expect.poll(visibleTooltip).toBeDefined();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: null as Screen | null,
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
