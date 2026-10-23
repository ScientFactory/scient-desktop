import { render as _fixtureRender, type Screen, act } from "../../test/render";
import { createRef } from "react";

import { expect, it, vi } from "vite-plus/test";
import { CommandPaletteContent } from "./CommandPaletteContent";

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}

it("keeps autofocus and delivers Enter to the caller's input ownership guard after remount", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const ref = createRef<HTMLInputElement>();
  const submit = vi.fn();
  for (const key of ["first", "replacement"]) {
    await act(
      async () =>
        await _fixture.root0.rerender(
          <CommandPaletteContent
            key={key}
            inputProps={{ ref, placeholder: "Project path" }}
            containerProps={{
              onKeyDownCapture: (event) => {
                if (event.target !== ref.current || event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                submit();
              },
            }}
          >
            {null}
          </CommandPaletteContent>,
        ),
    );
    const input = _fixture.container.querySelector("input")!;
    expect(ref.current).toBe(input);
    await expect.poll(() => document.activeElement).toBe(input);
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
  }
  expect(submit).toHaveBeenCalledTimes(2);
  await act(async () => await _fixture.root0.rerender(null));
  expect(ref.current).toBeNull();
});

it("preserves React callback-ref cleanup", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const cleanup = vi.fn();
  const ref = vi.fn(() => cleanup);
  await act(
    async () =>
      await _fixture.root0.rerender(
        <CommandPaletteContent inputProps={{ ref }}>{null}</CommandPaletteContent>,
      ),
  );
  expect(ref).toHaveBeenCalledWith(_fixture.container.querySelector("input"));
  await act(async () => await _fixture.root0.rerender(null));
  expect(cleanup).toHaveBeenCalledOnce();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
