import { render as _fixtureRender, act } from "../../../test/render";
import type { ComponentProps, ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, disabled, onClick }: ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  PopoverDescription: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
  PopoverPopup: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  PopoverTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  PopoverTrigger: () => null,
}));

import { ContextualConfirmation } from "./contextual-confirmation";

describe("ContextualConfirmation", () => {
  async function _cleanupFixture0(_fixture: _Fixture) {
    _clearOwnedDOM(_fixture);
    vi.unstubAllGlobals();
  }

  it("uses the quiet action slot for a second explicit choice", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const root = _fixture.stack.use(
      await _fixtureRender(null, {
        container: document.body.appendChild(_ownDOM(_fixture, document.createElement("div"))),
        router: false,
      }),
    );
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    const onConfirm = vi.fn();
    await act(
      async () =>
        await root.rerender(
          <ContextualConfirmation
            open
            onOpenChange={onOpenChange}
            title="Choose runtime"
            description="Current Python is missing scientific packages."
            confirmLabel="Use managed"
            secondaryAction={{ label: "Use current", onSelect }}
            onConfirm={onConfirm}
          />,
        ),
    );

    const buttons = Array.from(document.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Use current", "Use managed"]);
    await act(() => buttons[0]!.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => await root.unmount());
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

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
