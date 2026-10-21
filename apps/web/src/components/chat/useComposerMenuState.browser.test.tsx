import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerMenuState } from "./useComposerMenuState";

function MenuStateProbe({ _fixture, hidden }: { hidden: boolean } & { _fixture: _Fixture }) {
  const [open, updateOpen] = useComposerMenuState(hidden);
  useLayoutEffect(() => {
    _fixture.publishSetOpen(updateOpen);
    _fixture.publishOpen(open);
    if (open) return _fixture.closePopup;
  }, [_fixture, open, updateOpen]);
  return null;
}

const menu = (_fixture: _Fixture, hidden: boolean) => (
  <StrictMode>
    <MenuStateProbe _fixture={_fixture} hidden={hidden} />
  </StrictMode>
);

describe("useComposerMenuState", () => {
  it("closes an open popup when its trigger hides and does not reopen when it returns", async () => {
    await using _fixture = _createFixture();

    await using screen = await render(menu(_fixture, false));
    await act(() => _fixture.setOpen(true));
    expect(_fixture.committedOpen.at(-1)).toBe(true);

    await screen.rerender(menu(_fixture, true));
    expect(_fixture.committedOpen.at(-1)).toBe(false);
    expect(_fixture.closePopup).toHaveBeenCalledTimes(1);

    const afterClose = _fixture.committedOpen.length;
    await screen.rerender(menu(_fixture, false));
    expect(_fixture.committedOpen).toHaveLength(afterClose);
    expect(_fixture.committedOpen.at(-1)).toBe(false);

    await act(() => _fixture.setOpen(true));
    expect(_fixture.committedOpen.at(-1)).toBe(true);
    await act(() => _fixture.setOpen(false));
    expect(_fixture.committedOpen.at(-1)).toBe(false);
    expect(_fixture.closePopup).toHaveBeenCalledTimes(2);
  });

  it("does not commit an open popup requested while its trigger is hidden", async () => {
    await using _fixture = _createFixture();

    await using screen = await render(menu(_fixture, true));
    await act(() => _fixture.setOpen(true));
    await screen.rerender(menu(_fixture, false));

    expect(_fixture.committedOpen.every((open) => !open)).toBe(true);
    expect(_fixture.closePopup).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const committedOpen: boolean[] = [];
  const closePopup = vi.fn<() => void>();
  let _published_setOpen = undefined! as ReturnType<typeof useComposerMenuState>[1];

  const stack = new AsyncDisposableStack();
  return {
    committedOpen,
    closePopup,
    publishOpen(open: boolean) {
      committedOpen.push(open);
    },
    get setOpen() {
      return _published_setOpen;
    },
    publishSetOpen(next: typeof _published_setOpen) {
      _published_setOpen = next;
    },
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
