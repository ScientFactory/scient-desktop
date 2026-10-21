import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { FileSurfaceFailure } from "./fileSurfaceChrome";

describe("file surface failure interactions", () => {
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

  const tryAgain = (_fixture: _Fixture) =>
    [..._fixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );

  it("retries on request and ignores clicks while a retry is pending", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onRetry = vi.fn();
    await act(
      async () =>
        await _fixture.root0.rerender(
          <FileSurfaceFailure title="Couldn't open" description="" onRetry={onRetry} />,
        ),
    );
    await act(() => tryAgain(_fixture)?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    await act(
      async () =>
        await _fixture.root0.rerender(
          <FileSurfaceFailure title="Couldn't open" description="" onRetry={onRetry} retrying />,
        ),
    );
    expect(tryAgain(_fixture)?.disabled).toBe(true);
    await act(() => tryAgain(_fixture)?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("reveals the raw error only when Details is opened", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () =>
        await _fixture.root0.rerender(
          <FileSurfaceFailure title="Couldn't open" description="" details="EACCES: denied" />,
        ),
    );
    expect(_fixture.container.textContent).not.toContain("EACCES");
    const details = [..._fixture.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Details",
    );
    expect(details?.getAttribute("aria-expanded")).toBe("false");

    await act(() => details?.click());

    expect(details?.getAttribute("aria-expanded")).toBe("true");
    expect(_fixture.container.querySelector("pre")?.textContent).toBe("EACCES: denied");
  });
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
